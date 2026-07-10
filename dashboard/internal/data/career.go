package data

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

var (
	reReportLink     = regexp.MustCompile(`\[(\d+)\]\(([^)]+)\)`)
	reScoreValue     = regexp.MustCompile(`(\d+\.?\d*)/5`)
	reArchetype      = regexp.MustCompile(`(?i)\*\*(?:Arquetipo|Archetype)(?:\s+(?:detectado|detected))?\*\*\s*\|\s*(.+)`)
	reTlDr           = regexp.MustCompile(`(?i)\*\*TL;DR\*\*\s*\|\s*(.+)`)
	reTlDrColon      = regexp.MustCompile(`(?i)\*\*TL;DR:\*\*\s*(.+)`)
	reRemote         = regexp.MustCompile(`(?i)\*\*Remote\*\*\s*\|\s*(.+)`)
	reComp           = regexp.MustCompile(`(?i)\*\*Comp\*\*\s*\|\s*(.+)`)
	reCompMoneyRange = regexp.MustCompile(`(?i)(USD|EUR|GBP|CAD|AUD|SGD|CHF|\$|€|£)\s*(\d[\d,]*(?:\.\d+)?)([KkMm]?)\s*(?:[-–—]|\bto\b)\s*(?:(USD|EUR|GBP|CAD|AUD|SGD|CHF|\$|€|£)\s*)?(\d[\d,]*(?:\.\d+)?)([KkMm]?)`)
	reArchetypeColon = regexp.MustCompile(`(?i)\*\*(?:Arquetipo|Archetype):\*\*\s*(.+)`)
	reArchetypeYAML  = regexp.MustCompile(`(?m)^archetype:\s*"?([^"\n]+)"?\s*$`)
	reReportURL      = regexp.MustCompile(`(?m)^\*\*URL:\*\*\s*(https?://\S+)`)
	reBatchID        = regexp.MustCompile(`(?m)^\*\*Batch ID:\*\*\s*(\d+)`)
	reDiscardReasons = regexp.MustCompile(`(?s)discard_reasons:\s*\n((?:\s*-\s*.+?\n)+)`)
	reDiscardItem    = regexp.MustCompile(`\s*-\s*([^\n]+)`)
	reNextPackAction = regexp.MustCompile(`(?m)^\*\*(?:Suggests|Action):\*\*\s*([A-Za-z_]+)\s*$`)
)

// resolveReportPath converts a report link from the tracker into a path
// relative to careerOpsPath. Links are normally relative to the tracker
// file's own directory (see merge-tracker.mjs link normalization, #760);
// legacy trackers may still carry root-relative links, so fall back to the
// raw link when the tracker-relative resolution does not exist on disk.
func resolveReportPath(careerOpsPath, trackerPath, link string) string {
	resolved := filepath.Join(filepath.Dir(trackerPath), link)
	if _, err := os.Stat(resolved); err != nil {
		legacy := filepath.Join(careerOpsPath, link)
		if _, err2 := os.Stat(legacy); err2 == nil {
			resolved = legacy
		}
	}
	if rel, err := filepath.Rel(careerOpsPath, resolved); err == nil {
		return rel
	}
	return link
}

// ParseApplications reads applications.md and returns parsed applications.
// It tries both {path}/applications.md and {path}/data/applications.md for compatibility.
func ParseApplications(careerOpsPath string) []model.CareerApplication {
	setStatesRoot(careerOpsPath)

	filePath := filepath.Join(careerOpsPath, "applications.md")
	content, err := os.ReadFile(filePath)
	if err != nil {
		// Fallback: try data/ subdirectory
		filePath = filepath.Join(careerOpsPath, "data", "applications.md")
		content, err = os.ReadFile(filePath)
		if err != nil {
			return nil
		}
	}

	lines := strings.Split(string(content), "\n")
	apps := make([]model.CareerApplication, 0)
	num := 0

	// Map columns by header name rather than fixed position, so a customized or
	// reordered tracker (e.g. an inserted Location column) does not desync the
	// reader. Falls back to the legacy fixed layout when no header is present.
	// This matches the Node tracker tooling, which became header-aware in #954.
	cols := resolveTrackerColumns(lines)

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "# ") || strings.HasPrefix(line, "|---") || strings.HasPrefix(line, "| #") {
			continue
		}
		if !strings.HasPrefix(line, "|") {
			continue
		}

		fields := splitTrackerRow(line)
		if len(fields) < 8 {
			continue
		}

		at := func(name string) string {
			if idx, ok := cols[name]; ok && idx >= 0 && idx < len(fields) {
				return fields[idx]
			}
			return ""
		}

		num++
		trackerNumber := num
		if parsedNumber, err := strconv.Atoi(at("num")); err == nil {
			trackerNumber = parsedNumber
		}
		app := model.CareerApplication{
			Number:  trackerNumber,
			Date:    at("date"),
			Company: at("company"),
			Role:    at("role"),
			Status:  at("status"),
			HasPDF:  strings.Contains(at("pdf"), "\u2705"),
			Source:  "tracker",
		}

		// Parse score from the Score column.
		app.ScoreRaw = at("score")
		if sm := reScoreValue.FindStringSubmatch(at("score")); sm != nil {
			app.Score, _ = strconv.ParseFloat(sm[1], 64)
		}

		// Parse report link. Tracker links are written relative to the
		// tracker file itself (e.g. ../reports/... when the tracker lives in
		// data/), so resolve against the tracker's directory and normalize
		// back to a careerOpsPath-relative path, which is what every
		// consumer joins against. Legacy root-relative links are kept as a
		// fallback when the resolved file does not exist.
		if rm := reReportLink.FindStringSubmatch(at("report")); rm != nil {
			app.ReportNumber = rm[1]
			app.ReportPath = resolveReportPath(careerOpsPath, filePath, rm[2])
		}

		// Notes column, when present.
		app.Notes = at("notes")

		// Lift location / work mode / pay / last-contact out of the notes free-text
		deriveNoteFields(&app)

		apps = append(apps, app)
	}

	// Enrich with job URLs using 5-tier strategy:
	// 1. **URL:** field in report header (newest reports)
	// 2. **Batch ID:** in report -> batch-input.tsv URL lookup
	// 3. report_num -> batch-state completed mapping (legacy)
	// 4. scan-history.tsv (pipeline scan entries matched by company+role)
	// 5. company name fallback from batch-input.tsv
	batchURLs := loadBatchInputURLs(careerOpsPath)
	reportNumURLs := loadJobURLs(careerOpsPath)

	for i := range apps {
		if apps[i].ReportPath == "" {
			continue
		}
		fullReport := filepath.Join(careerOpsPath, apps[i].ReportPath)
		reportContent, err := os.ReadFile(fullReport)
		if err != nil {
			continue
		}
		header := string(reportContent)
		// Only scan the header (first 1000 bytes) for speed
		if len(header) > 1000 {
			header = header[:1000]
		}

		// Strategy 1: **URL:** in report
		if m := reReportURL.FindStringSubmatch(header); m != nil {
			apps[i].JobURL = m[1]
			continue
		}

		// Strategy 2: **Batch ID:** -> batch-input.tsv
		if m := reBatchID.FindStringSubmatch(header); m != nil {
			if url, ok := batchURLs[m[1]]; ok {
				apps[i].JobURL = url
				continue
			}
		}

		// Strategy 3: report_num -> batch-state completed mapping
		if reportNumURLs != nil {
			if url, ok := reportNumURLs[apps[i].ReportNumber]; ok {
				apps[i].JobURL = url
				continue
			}
		}
	}

	// Strategy 4: scan-history.tsv (pipeline scan entries matched by company+role)
	enrichFromScanHistory(careerOpsPath, apps)

	// Strategy 5: company name fallback from batch-input.tsv
	enrichAppURLsByCompany(careerOpsPath, apps)

	apps = appendLiveQueueRows(careerOpsPath, apps)
	enrichNextActions(careerOpsPath, apps)

	return apps
}

type pipelineEntry struct {
	url     string
	company string
	role    string
}

func appendLiveQueueRows(careerOpsPath string, apps []model.CareerApplication) []model.CareerApplication {
	pipelinePending, pipelineByURL := readPipelineEntries(careerOpsPath)
	seenReports, seenURLs := seenDashboardRows(apps)

	for _, app := range readUnmergedTrackerAdditions(careerOpsPath) {
		reportKey := canonicalReportNum(app.ReportNumber)
		if reportKey != "" && seenReports[reportKey] {
			continue
		}
		if app.JobURL != "" && seenURLs[app.JobURL] {
			continue
		}
		apps = append(apps, app)
		if reportKey != "" {
			seenReports[reportKey] = true
		}
		if app.JobURL != "" {
			seenURLs[app.JobURL] = true
		}
	}

	for _, app := range readBatchStateRows(careerOpsPath, pipelineByURL) {
		reportKey := canonicalReportNum(app.ReportNumber)
		if reportKey != "" && seenReports[reportKey] {
			continue
		}
		if app.JobURL != "" && seenURLs[app.JobURL] {
			continue
		}
		apps = append(apps, app)
		if reportKey != "" {
			seenReports[reportKey] = true
		}
		if app.JobURL != "" {
			seenURLs[app.JobURL] = true
		}
	}

	for _, entry := range pipelinePending {
		if entry.url == "" || seenURLs[entry.url] {
			continue
		}
		app := model.CareerApplication{
			Company:  entry.company,
			Role:     entry.role,
			Status:   "Pending",
			ScoreRaw: "—",
			JobURL:   entry.url,
			Notes:    "Queued in data/pipeline.md",
			Source:   "pipeline",
		}
		if app.Company == "" {
			app.Company = companyFromURL(entry.url)
		}
		if app.Role == "" {
			app.Role = entry.url
		}
		apps = append(apps, app)
		seenURLs[entry.url] = true
	}

	return apps
}

func seenDashboardRows(apps []model.CareerApplication) (map[string]bool, map[string]bool) {
	seenReports := make(map[string]bool)
	seenURLs := make(map[string]bool)
	for _, app := range apps {
		if reportKey := canonicalReportNum(app.ReportNumber); reportKey != "" {
			seenReports[reportKey] = true
		}
		if app.JobURL != "" {
			seenURLs[app.JobURL] = true
		}
	}
	return seenReports, seenURLs
}

func canonicalReportNum(reportNum string) string {
	reportNum = strings.TrimSpace(reportNum)
	if reportNum == "" || reportNum == "-" {
		return ""
	}
	n, err := strconv.Atoi(reportNum)
	if err != nil {
		return reportNum
	}
	return fmt.Sprintf("%03d", n)
}

func readUnmergedTrackerAdditions(careerOpsPath string) []model.CareerApplication {
	additionsDir := filepath.Join(careerOpsPath, "batch", "tracker-additions")
	entries, err := os.ReadDir(additionsDir)
	if err != nil {
		return nil
	}

	var apps []model.CareerApplication
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".tsv") {
			continue
		}
		content, err := os.ReadFile(filepath.Join(additionsDir, entry.Name()))
		if err != nil {
			continue
		}
		line := firstNonEmptyLine(string(content))
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 8 {
			continue
		}

		app := model.CareerApplication{
			Date:     strings.TrimSpace(fields[1]),
			Company:  strings.TrimSpace(fields[2]),
			Role:     strings.TrimSpace(fields[3]),
			Status:   strings.TrimSpace(fields[4]),
			ScoreRaw: strings.TrimSpace(fields[5]),
			HasPDF:   strings.Contains(fields[6], "\u2705"),
			Source:   "tracker-addition",
		}
		if len(fields) > 8 {
			app.Notes = strings.TrimSpace(fields[8])
		}
		if rm := reReportLink.FindStringSubmatch(fields[7]); rm != nil {
			app.ReportNumber = canonicalReportNum(rm[1])
			app.ReportPath = resolveReportPath(careerOpsPath, filepath.Join(careerOpsPath, "data", "applications.md"), rm[2])
			if n, err := strconv.Atoi(app.ReportNumber); err == nil {
				app.Number = n
			}
		}
		if app.Number == 0 {
			if parsedNumber, err := strconv.Atoi(strings.TrimSpace(fields[0])); err == nil {
				app.Number = parsedNumber
			}
		}
		if sm := reScoreValue.FindStringSubmatch(app.ScoreRaw); sm != nil {
			app.Score, _ = strconv.ParseFloat(sm[1], 64)
		}
		if app.ReportPath != "" {
			app.JobURL = readReportURL(careerOpsPath, app.ReportPath)
		}
		deriveNoteFields(&app)
		apps = append(apps, app)
	}
	return apps
}

func firstNonEmptyLine(content string) string {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			return line
		}
	}
	return ""
}

func readReportURL(careerOpsPath, reportPath string) string {
	content, err := os.ReadFile(filepath.Join(careerOpsPath, reportPath))
	if err != nil {
		return ""
	}
	header := string(content)
	if len(header) > 1000 {
		header = header[:1000]
	}
	if m := reReportURL.FindStringSubmatch(header); m != nil {
		return m[1]
	}
	return ""
}

func readBatchStateRows(careerOpsPath string, pipelineByURL map[string]pipelineEntry) []model.CareerApplication {
	statePath := filepath.Join(careerOpsPath, "batch", "batch-state.tsv")
	stateData, err := os.ReadFile(statePath)
	if err != nil {
		return nil
	}

	var apps []model.CareerApplication
	for _, line := range strings.Split(string(stateData), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 9 || fields[0] == "id" {
			continue
		}
		status := strings.TrimSpace(fields[2])
		if status == "" {
			continue
		}
		if isTerminalBatchStatus(status) {
			continue
		}

		url := strings.TrimSpace(fields[1])
		reportNum := canonicalReportNum(fields[5])
		info := pipelineByURL[url]
		app := model.CareerApplication{
			Company:      info.company,
			Role:         info.role,
			Status:       dashboardBatchStatus(status),
			ScoreRaw:     scoreRawFromBatchState(fields[6]),
			ReportNumber: reportNum,
			JobURL:       url,
			Notes:        batchStateNote(status, fields[7]),
			Source:       "batch",
		}
		if app.Company == "" {
			app.Company = companyFromURL(url)
		}
		if app.Role == "" {
			app.Role = url
		}
		if n, err := strconv.Atoi(fields[0]); err == nil {
			app.Number = n
		}
		if reportNum != "" {
			if n, err := strconv.Atoi(reportNum); err == nil {
				app.Number = n
			}
			app.ReportPath = findReportPath(careerOpsPath, reportNum)
		}
		if date := dateFromBatchState(fields[4]); date != "" {
			app.Date = date
		} else {
			app.Date = dateFromBatchState(fields[3])
		}
		if sm := reScoreValue.FindStringSubmatch(app.ScoreRaw); sm != nil {
			app.Score, _ = strconv.ParseFloat(sm[1], 64)
		}
		apps = append(apps, app)
	}
	return apps
}

func dashboardBatchStatus(status string) string {
	switch strings.TrimSpace(status) {
	case "completed":
		return "Evaluated"
	case "processing":
		return "Processing"
	case "failed":
		return "Failed"
	case "skipped":
		return "Skipped"
	case "rate_limited":
		return "Rate Limited"
	case "paused_rate_limit":
		return "Paused"
	default:
		return "Pending"
	}
}

func isTerminalBatchStatus(status string) bool {
	switch strings.TrimSpace(status) {
	case "completed", "skipped":
		return true
	default:
		return false
	}
}

func scoreRawFromBatchState(score string) string {
	score = strings.TrimSpace(score)
	if score == "" || score == "-" {
		return "—"
	}
	if strings.Contains(score, "/5") {
		return score
	}
	return score + "/5"
}

func batchStateNote(status, rawError string) string {
	status = strings.TrimSpace(status)
	rawError = strings.TrimSpace(rawError)
	if rawError != "" && rawError != "-" {
		return rawError
	}
	return "Batch state: " + status
}

func dateFromBatchState(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= len("2006-01-02") {
		return value[:len("2006-01-02")]
	}
	return ""
}

func findReportPath(careerOpsPath, reportNum string) string {
	reportsDir := filepath.Join(careerOpsPath, "reports")
	entries, err := os.ReadDir(reportsDir)
	if err != nil {
		return ""
	}
	prefix := canonicalReportNum(reportNum) + "-"
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if strings.HasPrefix(entry.Name(), prefix) && strings.HasSuffix(entry.Name(), ".md") {
			return filepath.Join("reports", entry.Name())
		}
	}
	return ""
}

func readPipelineEntries(careerOpsPath string) ([]pipelineEntry, map[string]pipelineEntry) {
	pipelinePath := filepath.Join(careerOpsPath, "data", "pipeline.md")
	content, err := os.ReadFile(pipelinePath)
	if err != nil {
		pipelinePath = filepath.Join(careerOpsPath, "pipeline.md")
		content, err = os.ReadFile(pipelinePath)
		if err != nil {
			return nil, map[string]pipelineEntry{}
		}
	}

	byURL := make(map[string]pipelineEntry)
	var pending []pipelineEntry
	for _, line := range strings.Split(string(content), "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "- [") {
			continue
		}
		checked := strings.HasPrefix(trimmed, "- [x]") || strings.HasPrefix(trimmed, "- [X]")
		unchecked := strings.HasPrefix(trimmed, "- [ ]")
		entry := parsePipelineEntry(trimmed)
		if entry.url == "" {
			continue
		}
		byURL[entry.url] = entry
		if unchecked && !checked {
			pending = append(pending, entry)
		}
	}
	return pending, byURL
}

func parsePipelineEntry(line string) pipelineEntry {
	body := strings.TrimSpace(line)
	if strings.HasPrefix(body, "- [ ]") {
		body = strings.TrimSpace(strings.TrimPrefix(body, "- [ ]"))
	} else if strings.HasPrefix(body, "- [x]") {
		body = strings.TrimSpace(strings.TrimPrefix(body, "- [x]"))
	} else if strings.HasPrefix(body, "- [X]") {
		body = strings.TrimSpace(strings.TrimPrefix(body, "- [X]"))
	}
	body = strings.TrimPrefix(body, "~~")
	body = strings.TrimSuffix(body, "~~")

	parts := strings.Split(body, "|")
	for i := range parts {
		parts[i] = strings.TrimSpace(strings.Trim(parts[i], "~"))
	}

	urlIdx := -1
	for i, part := range parts {
		if strings.HasPrefix(part, "http://") || strings.HasPrefix(part, "https://") {
			urlIdx = i
			break
		}
	}
	if urlIdx < 0 {
		fields := strings.Fields(body)
		for _, field := range fields {
			field = strings.Trim(field, "|~")
			if strings.HasPrefix(field, "http://") || strings.HasPrefix(field, "https://") {
				return pipelineEntry{url: field}
			}
		}
		return pipelineEntry{}
	}

	entry := pipelineEntry{url: parts[urlIdx]}
	if len(parts) > urlIdx+1 {
		entry.company = parts[urlIdx+1]
	}
	if len(parts) > urlIdx+2 {
		entry.role = parts[urlIdx+2]
	}
	return entry
}

func companyFromURL(rawURL string) string {
	rawURL = strings.TrimSpace(rawURL)
	rawURL = strings.TrimPrefix(rawURL, "https://")
	rawURL = strings.TrimPrefix(rawURL, "http://")
	host := strings.Split(rawURL, "/")[0]
	host = strings.TrimPrefix(host, "www.")
	if host == "" {
		return "Queued"
	}
	return host
}

// loadBatchInputURLs reads batch-input.tsv and returns a map of batch ID -> job URL.
func loadBatchInputURLs(careerOpsPath string) map[string]string {
	inputPath := filepath.Join(careerOpsPath, "batch", "batch-input.tsv")
	inputData, err := os.ReadFile(inputPath)
	if err != nil {
		return nil
	}
	result := make(map[string]string)
	for _, line := range strings.Split(string(inputData), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 4 || fields[0] == "id" {
			continue
		}
		id := fields[0]
		notes := fields[3]
		// Extract real job URL from notes: "Title @ Company | Match% | https://actual-url"
		if idx := strings.LastIndex(notes, "| "); idx >= 0 {
			u := strings.TrimSpace(notes[idx+2:])
			if strings.HasPrefix(u, "http") {
				result[id] = u
				continue
			}
		}
		// Fallback: use JackJill URL
		if strings.HasPrefix(fields[1], "http") {
			result[id] = fields[1]
		}
	}
	return result
}

// batchEntry holds parsed data from batch-input.tsv.
type batchEntry struct {
	id      string
	url     string
	company string
	role    string
}

// loadJobURLs reads batch TSV files and returns a map of report_num -> job URL.
// Uses two strategies: (1) report_num mapping for completed jobs, (2) company name
// matching as fallback for failed/missing jobs.
func loadJobURLs(careerOpsPath string) map[string]string {
	// Read batch-input.tsv: id \t url \t source \t notes
	inputPath := filepath.Join(careerOpsPath, "batch", "batch-input.tsv")
	inputData, err := os.ReadFile(inputPath)
	if err != nil {
		return nil
	}

	// Parse batch-input: extract job URL, company, and role from notes
	entries := make(map[string]batchEntry) // keyed by id
	for _, line := range strings.Split(string(inputData), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 4 || fields[0] == "id" {
			continue
		}
		e := batchEntry{id: fields[0]}
		notes := fields[3]

		// Extract URL from notes: "Title @ Company | Match% | https://actual-url"
		if idx := strings.LastIndex(notes, "| "); idx >= 0 {
			u := strings.TrimSpace(notes[idx+2:])
			if strings.HasPrefix(u, "http") {
				e.url = u
			}
		}
		// Fallback: use JackJill URL from field 1
		if e.url == "" && strings.HasPrefix(fields[1], "http") {
			e.url = fields[1]
		}

		// Extract company and role: "Role @ Company | Match% | URL"
		notesPart := notes
		if pipeIdx := strings.Index(notesPart, " | "); pipeIdx >= 0 {
			notesPart = notesPart[:pipeIdx]
		}
		if atIdx := strings.LastIndex(notesPart, " @ "); atIdx >= 0 {
			e.role = strings.TrimSpace(notesPart[:atIdx])
			e.company = strings.TrimSpace(notesPart[atIdx+3:])
		}

		if e.url != "" {
			entries[fields[0]] = e
		}
	}

	// Read batch-state.tsv: id \t url \t status \t ... \t report_num \t ...
	statePath := filepath.Join(careerOpsPath, "batch", "batch-state.tsv")
	stateData, err := os.ReadFile(statePath)
	if err != nil {
		return nil
	}

	// Strategy 1: map report_num -> URL only for COMPLETED jobs
	reportToURL := make(map[string]string)
	for _, line := range strings.Split(string(stateData), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 6 || fields[0] == "id" {
			continue
		}
		id := fields[0]
		status := fields[2]
		reportNum := fields[5]
		if status != "completed" || reportNum == "" || reportNum == "-" {
			continue
		}
		if e, ok := entries[id]; ok {
			reportToURL[reportNum] = e.url
			if len(reportNum) < 3 {
				reportToURL[fmt.Sprintf("%03s", reportNum)] = e.url
			}
		}
	}

	return reportToURL
}

func readScanHistory(careerOpsPath string) ([]byte, error) {
	for _, rel := range []string{
		filepath.Join("data", "scan-history.tsv"),
		"scan-history.tsv",
	} {
		scanData, err := os.ReadFile(filepath.Join(careerOpsPath, rel))
		if err == nil {
			return scanData, nil
		}
	}
	return nil, os.ErrNotExist
}

// enrichFromScanHistory fills JobURL and location metadata from scan-history.tsv.
func enrichFromScanHistory(careerOpsPath string, apps []model.CareerApplication) {
	scanData, err := readScanHistory(careerOpsPath)
	if err != nil {
		return
	}

	// Build URL and company indexes from scan-history. The location column is
	// optional for backward compatibility with older 6-column history files.
	type scanEntry struct {
		url      string
		company  string
		title    string
		location string
	}
	byCompany := make(map[string][]scanEntry)
	byURL := make(map[string]scanEntry)
	for _, line := range strings.Split(string(scanData), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 5 || fields[0] == "url" {
			continue
		}
		url := fields[0]
		company := fields[4]
		title := fields[3]
		location := ""
		if len(fields) > 6 {
			location = strings.TrimSpace(fields[6])
		}
		if url == "" || !strings.HasPrefix(url, "http") {
			continue
		}
		key := normalizeCompany(company)
		entry := scanEntry{url: url, company: company, title: title, location: location}
		byURL[url] = entry
		byCompany[key] = append(byCompany[key], entry)
	}

	for i := range apps {
		match, ok := byURL[apps[i].JobURL]
		if !ok {
			key := normalizeCompany(apps[i].Company)
			matches := byCompany[key]
			if len(matches) == 1 {
				match = matches[0]
				ok = true
			} else if len(matches) > 1 {
				// Multiple entries: pick best role match
				appRole := strings.ToLower(apps[i].Role)
				best := matches[0]
				bestScore := 0
				for _, m := range matches {
					score := 0
					mTitle := strings.ToLower(m.title)
					for _, word := range strings.Fields(appRole) {
						if len(word) > 2 && strings.Contains(mTitle, word) {
							score++
						}
					}
					if score > bestScore {
						bestScore = score
						best = m
					}
				}
				match = best
				ok = true
			}
		}
		if !ok {
			continue
		}
		if apps[i].JobURL == "" {
			apps[i].JobURL = match.url
		}
		if match.location != "" {
			applyLocationHint(&apps[i], match.location)
		}
	}
}

// normalizeCompany strips common suffixes and lowercases a company name.
func normalizeCompany(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	for _, suffix := range []string{" inc.", " inc", " llc", " ltd", " corp", " corporation", " technologies", " technology", " group", " co."} {
		s = strings.TrimSuffix(s, suffix)
	}
	return strings.TrimSpace(s)
}

// enrichAppURLsByCompany fills in JobURL for apps that didn't get one via report_num mapping.
// It matches by company name from batch-input.tsv notes.
func enrichAppURLsByCompany(careerOpsPath string, apps []model.CareerApplication) {
	inputPath := filepath.Join(careerOpsPath, "batch", "batch-input.tsv")
	inputData, err := os.ReadFile(inputPath)
	if err != nil {
		return
	}

	// Build company -> []entry index
	type entry struct {
		role string
		url  string
	}
	byCompany := make(map[string][]entry)
	for _, line := range strings.Split(string(inputData), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) < 4 || fields[0] == "id" {
			continue
		}
		notes := fields[3]
		var url string
		if idx := strings.LastIndex(notes, "| "); idx >= 0 {
			u := strings.TrimSpace(notes[idx+2:])
			if strings.HasPrefix(u, "http") {
				url = u
			}
		}
		if url == "" && strings.HasPrefix(fields[1], "http") {
			url = fields[1]
		}
		if url == "" {
			continue
		}
		notesPart := notes
		if pipeIdx := strings.Index(notesPart, " | "); pipeIdx >= 0 {
			notesPart = notesPart[:pipeIdx]
		}
		if atIdx := strings.LastIndex(notesPart, " @ "); atIdx >= 0 {
			role := strings.TrimSpace(notesPart[:atIdx])
			company := strings.TrimSpace(notesPart[atIdx+3:])
			key := normalizeCompany(company)
			byCompany[key] = append(byCompany[key], entry{role: role, url: url})
		}
	}

	for i := range apps {
		if apps[i].JobURL != "" {
			continue
		}
		key := normalizeCompany(apps[i].Company)
		matches := byCompany[key]
		if len(matches) == 1 {
			apps[i].JobURL = matches[0].url
		} else if len(matches) > 1 {
			// Multiple entries for same company: pick best role match
			appRole := strings.ToLower(apps[i].Role)
			best := matches[0].url
			bestScore := 0
			for _, m := range matches {
				score := 0
				mRole := strings.ToLower(m.role)
				// Count matching words
				for _, word := range strings.Fields(appRole) {
					if len(word) > 2 && strings.Contains(mRole, word) {
						score++
					}
				}
				if score > bestScore {
					bestScore = score
					best = m.url
				}
			}
			apps[i].JobURL = best
		}
	}
}

type applicationActionRecord struct {
	ActionState string
	NextAction  string
	DueAfter    string
	Owner       string
	WaitingOn   string
	Reason      string
}

type nextPackRecord struct {
	Path   string
	Action string
}

func enrichNextActions(careerOpsPath string, apps []model.CareerApplication) {
	sm := states()
	packs := loadNextPackPaths(careerOpsPath)
	now := time.Now()

	for i := range apps {
		rec := deriveNextAction(apps[i], now, sm)

		apps[i].ActionState = rec.ActionState
		apps[i].NextAction = rec.NextAction
		apps[i].ActionOwner = rec.Owner
		apps[i].ActionDue = rec.DueAfter
		apps[i].WaitingOn = rec.WaitingOn
		apps[i].ActionReason = rec.Reason
		apps[i].NextPackPath = lookupNextPackPath(packs, apps[i])
		apps[i].NextCommand = nextCommandFor(apps[i])
	}
}

func applicationActionKeys(app model.CareerApplication) []string {
	var keys []string
	add := func(key string) {
		key = strings.TrimSpace(key)
		if key == "" {
			return
		}
		for _, existing := range keys {
			if existing == key {
				return
			}
		}
		keys = append(keys, key)
	}

	if app.Number > 0 {
		add(strconv.Itoa(app.Number))
		add(fmt.Sprintf("%03d", app.Number))
	}
	if app.ReportNumber != "" {
		add(app.ReportNumber)
		add(canonicalReportNum(app.ReportNumber))
	}
	return keys
}

// deriveNextAction computes the dashboard's next-action view-model for an
// application from its stage in templates/states.yml. The stage's owner
// determines the affordance (ground rules in states.yml): an agent stage is a
// draft the automation should generate; a user stage is blocked on a real-world
// action the user must take and report; a company stage is a pure wait with a
// follow-up reminder when the cadence is due; a terminal stage has no action.
// The one policy-aware exception is the Research-first preview at `evaluated`
// (see the agent case), which mirrors modes/next.md so the displayed next step
// matches what the automation will actually draft.
// Pre-evaluation batch statuses are synthesized by the pipeline and handled up
// front. This replaces the old hand-maintained status->action table.
func deriveNextAction(app model.CareerApplication, now time.Time, sm *stateMachine) applicationActionRecord {
	switch NormalizeStatus(app.Status) {
	case "failed", "rate_limited", "paused":
		return applicationActionRecord{
			ActionState: "blocked",
			NextAction:  "none",
			Owner:       "user",
			Reason:      "Evaluation did not complete cleanly; inspect the pipeline state before advancing.",
		}
	case "pending", "processing":
		return applicationActionRecord{
			ActionState: "waiting",
			NextAction:  "none",
			Owner:       "agent",
			WaitingOn:   "evaluation",
			Reason:      "Opportunity is still queued or processing.",
		}
	}

	st, ok := sm.lookupStage(app.Status)
	if !ok {
		return applicationActionRecord{ActionState: "none", NextAction: "none", Owner: "user"}
	}
	reason := collapseWhitespace(st.Description)

	switch st.Owner {
	case "agent":
		// The automation generates the suggested artifact, then auto-advances.
		// Preview exception — Research-first routing (mirrors modes/next.md): at
		// `evaluated`, a row whose report decided "Research first" (encoded in the
		// tracker note prefix) and that has not already qualified (no
		// [qualifying-sent] marker) will have the agent draft a qualifying question,
		// not an application pack. Showing generate_application_pack there would
		// mislabel the real next step. The loop-guard (marker present) keeps a
		// cleared gate showing the application draft.
		action := st.Suggests
		if st.ID == "evaluated" && isResearchFirstNote(app.Notes) && !hasQualifyingSentMarker(app.Notes) {
			action = "draft_qualifying_questions"
		}
		return applicationActionRecord{
			ActionState: "needs_action",
			NextAction:  action,
			Owner:       "agent",
			Reason:      reason,
		}
	case "user":
		// Artifact drafted; blocked on the user's real-world action and report.
		return applicationActionRecord{
			ActionState: "needs_action",
			NextAction:  st.Suggests,
			Owner:       "user",
			Reason:      reason,
		}
	case "company":
		// Pure wait; surface a follow-up reminder once the cadence is due.
		anchor := app.LastContact
		if anchor == "" {
			anchor = app.Date
		}
		due := addDays(anchor, 7)
		if due == "" || !dateAfter(due, now) {
			return applicationActionRecord{
				ActionState: "needs_action",
				NextAction:  "follow_up",
				Owner:       "user",
				DueAfter:    due,
				Reason:      "Application is past the default follow-up cadence.",
			}
		}
		return applicationActionRecord{
			ActionState: "waiting",
			NextAction:  "follow_up",
			Owner:       "company",
			DueAfter:    due,
			WaitingOn:   "company response",
			Reason:      reason,
		}
	default: // owner: none -- terminal
		return applicationActionRecord{ActionState: "none", NextAction: "none", Owner: "none"}
	}
}

// collapseWhitespace flattens the multi-line stage description from states.yml
// into a single reason line.
func collapseWhitespace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// isResearchFirstNote reports whether the tracker note's current decision is
// "Research first". Re-evaluation markers are appended to notes, so a later
// APPLY or CONSIDER decision must supersede an older Research-first prefix.
func isResearchFirstNote(notes string) bool {
	normalized := strings.ToLower(strings.TrimSpace(notes))
	if marker := strings.LastIndex(normalized, "[re-evaluated "); marker >= 0 {
		afterMarker := normalized[marker:]
		if end := strings.Index(afterMarker, "]"); end >= 0 {
			current := strings.TrimSpace(afterMarker[end+1:])
			if strings.HasPrefix(current, "apply:") || strings.HasPrefix(current, "consider:") {
				return false
			}
			if strings.HasPrefix(current, "research first:") {
				return true
			}
		}
	}
	return strings.HasPrefix(normalized, "research first")
}

// hasQualifyingSentMarker reports whether the note carries the
// [qualifying-sent YYYY-MM-DD] marker written when a row enters Qualifying Sent.
// Its presence means the row already went through the subloop, so an evaluated
// row that returned with a cleared gate drafts the application, not another
// question (the loop-guard from modes/next.md).
func hasQualifyingSentMarker(notes string) bool {
	return strings.Contains(strings.ToLower(notes), "[qualifying-sent")
}

func addDays(date string, days int) string {
	parsed, err := time.Parse("2006-01-02", strings.TrimSpace(date))
	if err != nil {
		return ""
	}
	return parsed.AddDate(0, 0, days).Format("2006-01-02")
}

func dateAfter(date string, now time.Time) bool {
	parsed, err := time.Parse("2006-01-02", strings.TrimSpace(date))
	if err != nil {
		return false
	}
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	return parsed.After(today)
}

func loadNextPackPaths(careerOpsPath string) map[string]nextPackRecord {
	dir := filepath.Join(careerOpsPath, "output", "next-packs")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}

	packs := make(map[string]nextPackRecord)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		prefix := entry.Name()
		if idx := strings.Index(prefix, "-"); idx >= 0 {
			prefix = prefix[:idx]
		}
		if prefix == "" {
			continue
		}
		relPath := filepath.Join("output", "next-packs", entry.Name())
		record := nextPackRecord{
			Path:   relPath,
			Action: readNextPackAction(filepath.Join(dir, entry.Name())),
		}
		packs[prefix] = record
		if n, err := strconv.Atoi(prefix); err == nil {
			packs[strconv.Itoa(n)] = record
			packs[fmt.Sprintf("%03d", n)] = record
		}
	}
	return packs
}

func readNextPackAction(path string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	match := reNextPackAction.FindStringSubmatch(string(content))
	if len(match) < 2 {
		return ""
	}
	return strings.TrimSpace(match[1])
}

func lookupNextPackPath(packs map[string]nextPackRecord, app model.CareerApplication) string {
	if len(packs) == 0 {
		return ""
	}
	for _, key := range applicationActionKeys(app) {
		if pack := packs[key]; pack.Path != "" && nextPackMatchesAction(pack, app.NextAction) {
			return pack.Path
		}
	}
	return ""
}

func nextPackMatchesAction(pack nextPackRecord, nextAction string) bool {
	return pack.Action == "" || nextAction == "" || pack.Action == nextAction
}

func nextCommandFor(app model.CareerApplication) string {
	if app.Number > 0 {
		return fmt.Sprintf("/career-ops next %d", app.Number)
	}
	if app.ReportNumber != "" {
		return fmt.Sprintf("/career-ops next %s", app.ReportNumber)
	}
	if app.Company != "" && app.Role != "" {
		return fmt.Sprintf("/career-ops next %s %s", app.Company, app.Role)
	}
	return "/career-ops next"
}

// ComputeMetrics calculates aggregate metrics from applications.
func ComputeMetrics(apps []model.CareerApplication) model.PipelineMetrics {
	m := model.PipelineMetrics{
		Total:    len(apps),
		ByStatus: make(map[string]int),
	}

	var totalScore float64
	var scored int

	for _, app := range apps {
		status := NormalizeStatus(app.Status)
		m.ByStatus[status]++

		if app.Score > 0 {
			totalScore += app.Score
			scored++
			if app.Score > m.TopScore {
				m.TopScore = app.Score
			}
		}
		if app.HasPDF {
			m.WithPDF++
		}
		if status != "skip" && status != "rejected" && status != "discarded" && status != "accepted" {
			m.Actionable++
		}
	}

	if scored > 0 {
		m.AvgScore = totalScore / float64(scored)
	}

	return m
}

// NormalizeStatus normalizes raw status text to a canonical dashboard group.
// Lifecycle stages are resolved through templates/states.yml (via the state
// machine) and collapsed to their dashboard_group, so the finer stage vocabulary
// (application_ready, interview_ready, ...) maps back onto the coarse funnel
// buckets the dashboard renders. Pre-evaluation batch statuses are synthesized by
// the pipeline and are not part of the state machine, so they are handled here.
func NormalizeStatus(raw string) string {
	s := stripStatusDecorations(raw)

	switch s {
	case "processing":
		return "processing"
	case "pending":
		return "pending"
	case "failed":
		return "failed"
	case "rate limited", "rate_limited":
		return "rate_limited"
	case "paused", "paused_rate_limit":
		return "paused"
	}

	if st, ok := states().lookupStage(raw); ok {
		return st.DashboardGroup
	}
	return s
}

// LoadReportSummary extracts key fields from a report file.
func LoadReportSummary(careerOpsPath, reportPath string) (archetype, tldr, remote, comp string) {
	fullPath := filepath.Join(careerOpsPath, reportPath)
	content, err := os.ReadFile(fullPath)
	if err != nil {
		return
	}
	text := string(content)

	if m := reArchetype.FindStringSubmatch(text); m != nil {
		archetype = cleanTableCell(m[1])
	} else if m := reArchetypeColon.FindStringSubmatch(text); m != nil {
		archetype = cleanTableCell(m[1])
	} else if m := reArchetypeYAML.FindStringSubmatch(text); m != nil {
		archetype = strings.TrimSpace(m[1])
	}

	// Try table-format TL;DR first (most reports), then colon format
	if m := reTlDr.FindStringSubmatch(text); m != nil {
		tldr = cleanTableCell(m[1])
	} else if m := reTlDrColon.FindStringSubmatch(text); m != nil {
		tldr = cleanTableCell(m[1])
	}

	if m := reRemote.FindStringSubmatch(text); m != nil {
		remote = cleanTableCell(m[1])
	}

	comp = extractCompEstimate(text)
	if comp == "" {
		if m := reComp.FindStringSubmatch(text); m != nil {
			legacy := cleanTableCell(m[1])
			if strings.ContainsAny(legacy, "$€£") || reCompMoneyRange.MatchString(legacy) {
				comp = legacy
			}
		}
	}

	// Truncate long fields
	if len(tldr) > 120 {
		tldr = tldr[:117] + "..."
	}

	return
}

func extractCompEstimate(text string) string {
	section := compensationSection(text)
	lines := strings.Split(section, "\n")

	for _, line := range lines {
		if !looksLikeCompensationLine(line) {
			continue
		}
		if payRange := extractCompRangeFromLine(line); payRange != "" {
			return payRange
		}
	}

	for _, line := range lines {
		if isCompensationNoiseLine(line) {
			continue
		}
		if payRange := extractCompRangeFromLine(line); payRange != "" {
			return payRange
		}
	}

	return ""
}

func compensationSection(text string) string {
	lines := strings.Split(text, "\n")
	start := -1
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		lower := strings.ToLower(trimmed)
		if strings.HasPrefix(lower, "##") && strings.Contains(lower, "compensation") {
			start = i
			break
		}
	}
	if start == -1 {
		return text
	}

	end := len(lines)
	for i := start + 1; i < len(lines); i++ {
		trimmed := strings.TrimSpace(lines[i])
		if strings.HasPrefix(trimmed, "## ") {
			end = i
			break
		}
	}
	return strings.Join(lines[start:end], "\n")
}

func looksLikeCompensationLine(line string) bool {
	if isCompensationNoiseLine(line) {
		return false
	}
	lower := strings.ToLower(line)
	for _, hint := range []string{
		"salary",
		"base pay",
		"pay range",
		"compensation",
		"total comp",
		"package",
		"ote",
	} {
		if strings.Contains(lower, hint) {
			return true
		}
	}
	return false
}

func isCompensationNoiseLine(line string) bool {
	lower := strings.ToLower(line)
	for _, noise := range []string{
		"comp score",
		"funding",
		"valuation",
		"investment",
		"series ",
		"raised ",
		"runway",
		" arr",
		"revenue",
		"market cap",
		"tender offer",
	} {
		if strings.Contains(lower, noise) {
			return true
		}
	}
	return false
}

func extractCompRangeFromLine(line string) string {
	m := reCompMoneyRange.FindStringSubmatch(line)
	if m == nil {
		return ""
	}

	currency := formatCompCurrency(m[1])
	lowSuffix := m[3]
	highSuffix := m[6]
	if lowSuffix == "" && highSuffix != "" {
		lowSuffix = highSuffix
	}
	if highSuffix == "" && lowSuffix != "" {
		highSuffix = lowSuffix
	}

	low := formatCompAmount(m[2], lowSuffix)
	high := formatCompAmount(m[5], highSuffix)
	if low == "" || high == "" {
		return ""
	}

	// Uniform ISO-code prefix (e.g. "USD 150K-200K") so every PAY cell starts
	// the same way and the column reads cleanly. formatCompCurrency maps the
	// $/€/£ symbols to USD/EUR/GBP, so the prefix is always a 3-letter code.
	return currency + " " + low + "-" + high
}

func formatCompCurrency(raw string) string {
	switch strings.ToUpper(raw) {
	case "$", "USD":
		return "USD"
	case "€", "EUR":
		return "EUR"
	case "£", "GBP":
		return "GBP"
	default:
		return strings.ToUpper(raw)
	}
}

func formatCompAmount(raw, suffix string) string {
	v, err := strconv.ParseFloat(strings.ReplaceAll(raw, ",", ""), 64)
	if err != nil {
		return ""
	}

	switch strings.ToUpper(suffix) {
	case "K":
		return compactWhole(v) + "K"
	case "M":
		return compactNumber(v) + "M"
	}

	switch {
	case v >= 1_000_000:
		return compactNumber(v/1_000_000) + "M"
	case v >= 1_000:
		return compactWhole(v/1_000) + "K"
	default:
		return compactNumber(v)
	}
}

func compactNumber(v float64) string {
	s := strconv.FormatFloat(v, 'f', 1, 64)
	return strings.TrimSuffix(s, ".0")
}

// compactWhole rounds to the nearest integer, so pay ranges render as whole-K
// values ("61.3K" -> "61K", "191.5K" -> "192K") for a consistent PAY column.
func compactWhole(v float64) string {
	return strconv.FormatFloat(math.Round(v), 'f', 0, 64)
}

// splitTrackerRow splits a tracker table line into trimmed cell values, using
// the same delimiter logic as ParseApplications: a mixed "| " + tab-separated
// body, or a pure pipe-delimited row. Field 0 is the first real column (num), so
// the returned indices match the legacy layout (Status is field 5).
func splitTrackerRow(line string) []string {
	line = strings.TrimSpace(line)
	var fields []string
	if strings.Contains(line, "\t") {
		// Mixed format: starts with "| " then tab-separated.
		line = strings.TrimPrefix(line, "|")
		line = strings.TrimSpace(line)
		for _, p := range strings.Split(line, "\t") {
			fields = append(fields, strings.TrimSpace(strings.Trim(p, "|")))
		}
	} else {
		// Pure pipe format.
		line = strings.Trim(line, "|")
		for _, p := range strings.Split(line, "|") {
			fields = append(fields, strings.TrimSpace(p))
		}
	}
	return fields
}

// trackerHeaderAliases maps a lowercased header cell to a canonical field name.
// Mirrors HEADER_ALIASES in tracker-parse.mjs (including the Spanish aliases) so
// the Go data layer tolerates the same customized layouts as the Node tracker
// tooling after #954.
var trackerHeaderAliases = map[string]string{
	"#": "num", "num": "num", "date": "date",
	"company": "company", "empresa": "company",
	"via": "via", "role": "role", "puesto": "role",
	"location": "location", "score": "score", "status": "status",
	"pdf": "pdf", "report": "report", "notes": "notes",
}

// legacyTrackerColumns is the original fixed layout in splitTrackerRow field
// space (num=0 … notes=8), used when no recognizable header row is present.
var legacyTrackerColumns = map[string]int{
	"num": 0, "date": 1, "company": 2, "role": 3, "score": 4,
	"status": 5, "pdf": 6, "report": 7, "notes": 8,
}

// detectTrackerColumns scans for the table header row and maps canonical field
// names to column indices in splitTrackerRow field space. It returns nil unless
// the essential columns are all present, so a stray pipe line cannot yield a
// bogus mapping and the caller falls back to legacyTrackerColumns. Mirrors
// detectColumns in tracker-parse.mjs (#954).
func detectTrackerColumns(lines []string) map[string]int {
	for _, line := range lines {
		if !strings.HasPrefix(strings.TrimSpace(line), "|") {
			continue
		}
		cells := splitTrackerRow(line)
		m := make(map[string]int)
		for i, c := range cells {
			if name, ok := trackerHeaderAliases[strings.ToLower(c)]; ok {
				// Unconditional assign: with a duplicated header name the LAST
				// occurrence wins, matching detectColumns in tracker-parse.mjs
				// (which this function mirrors) — first-wins here made the two
				// runtimes map the same header row differently.
				m[name] = i
			}
		}
		complete := true
		for _, k := range []string{"num", "company", "role", "score", "status"} {
			if _, ok := m[k]; !ok {
				complete = false
				break
			}
		}
		if complete {
			return m
		}
	}
	return nil
}

// resolveTrackerColumns returns the header-detected column map, falling back to
// the legacy fixed layout when no header row is found.
func resolveTrackerColumns(lines []string) map[string]int {
	if m := detectTrackerColumns(lines); m != nil {
		return m
	}
	return legacyTrackerColumns
}

// UpdateApplicationStatus updates the status of an application in applications.md.
func UpdateApplicationStatus(careerOpsPath string, app model.CareerApplication, newStatus string) error {
	return UpdateApplicationStatusAndNotes(careerOpsPath, app, newStatus, "")
}

// replaceStatusInLine rewrites only the Status cell of a tracker row, leaving
// every other cell untouched. The previous implementation used
// strings.Replace(line, oldStatus, …, 1), which replaces the first occurrence of
// the status text anywhere in the row — so a status word appearing as a
// substring of an earlier cell (e.g. Company "Applied Materials") was rewritten
// instead of the Status cell, corrupting that cell while the status appeared to
// stay unchanged (#1180). Matching is whole-cell (never a substring) and, as the
// old comment claimed but the code did not, case-insensitive.
//
// statusField is the Status column index in splitTrackerRow field space (5 in
// the legacy layout), resolved from the table header so a customized layout
// (e.g. an inserted Location column) targets the right cell.
func replaceStatusInLine(line, oldStatus, newStatus string, statusField int) string {
	want := strings.TrimSpace(oldStatus)

	// Mixed "| " + tab-separated format (mirrors ParseApplications). The body is
	// tab-split, so cell index equals the field index.
	if strings.Contains(line, "\t") {
		prefix, body, found := strings.Cut(line, "|")
		if !found {
			return line
		}
		cells := strings.Split(body, "\t")
		if idx := statusCellIndex(cells, statusField, want); idx >= 0 {
			cells[idx] = spliceCellValue(cells[idx], newStatus)
			return prefix + "|" + strings.Join(cells, "\t")
		}
		return line
	}

	// Pure pipe format. strings.Split keeps the segments between pipes; content
	// cell N is segment N+1 (segment 0 is the empty text before the leading
	// pipe), so the Status field maps to segment statusField+1.
	segments := strings.Split(line, "|")
	if idx := statusCellIndex(segments, statusField+1, want); idx >= 0 {
		segments[idx] = spliceCellValue(segments[idx], newStatus)
		return strings.Join(segments, "|")
	}
	return line
}

// statusCellIndex returns the index of the Status cell. It prefers the canonical
// column (canonicalIdx, matching ParseApplications) and verifies it by value; if
// that doesn't match — e.g. a custom tracker layout — it falls back to the first
// cell that equals want exactly. Matching is whole-cell and case-insensitive,
// never a substring, so a status word inside an earlier cell is never hit.
// Returns -1 when nothing matches, so the caller leaves the row untouched rather
// than corrupt a guess.
func statusCellIndex(cells []string, canonicalIdx int, want string) int {
	if canonicalIdx < len(cells) && strings.EqualFold(strings.TrimSpace(cells[canonicalIdx]), want) {
		return canonicalIdx
	}
	for i, c := range cells {
		if strings.EqualFold(strings.TrimSpace(c), want) {
			return i
		}
	}
	return -1
}

// spliceCellValue swaps a cell's inner value while preserving its surrounding
// whitespace, so "| Applied |" becomes "| Interview |" rather than "|Interview|".
func spliceCellValue(cell, newVal string) string {
	trimmed := strings.TrimSpace(cell)
	if trimmed == "" {
		if len(cell) >= 2 {
			half := len(cell) / 2
			return cell[:half] + newVal + cell[half:]
		}
		return " " + newVal + " "
	}
	start := strings.Index(cell, trimmed)
	return cell[:start] + newVal + cell[start+len(trimmed):]
}

// cleanTableCell removes trailing pipes and whitespace from a table cell value.
func cleanTableCell(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimRight(s, "|")
	return strings.TrimSpace(s)
}

// StatusPriority returns the sort priority for a status (lower = higher priority).
func StatusPriority(status string) int {
	switch NormalizeStatus(status) {
	case "processing":
		return 0
	case "pending":
		return 1
	case "failed", "rate_limited", "paused":
		return 2
	case "interview":
		return 3
	case "offer":
		return 4
	case "responded":
		return 5
	case "applied":
		return 6
	case "evaluated":
		return 7
	case "accepted":
		return 8
	case "skip":
		return 9
	case "rejected":
		return 10
	case "discarded":
		return 11
	default:
		return 12
	}
}

// ComputeProgressMetrics computes progress-oriented analytics from applications.
func ComputeProgressMetrics(apps []model.CareerApplication) model.ProgressMetrics {
	pm := model.ProgressMetrics{}

	// Count by normalized status
	statusCounts := make(map[string]int)
	var totalScore float64
	var scored int

	for _, app := range apps {
		norm := NormalizeStatus(app.Status)
		statusCounts[norm]++

		if app.Score > 0 {
			totalScore += app.Score
			scored++
			if app.Score > pm.TopScore {
				pm.TopScore = app.Score
			}
		}

		if norm == "offer" || norm == "accepted" {
			pm.TotalOffers++
		}
		if norm != "skip" && norm != "rejected" && norm != "discarded" && norm != "accepted" {
			pm.ActiveApps++
		}
	}

	if scored > 0 {
		pm.AvgScore = totalScore / float64(scored)
	}

	// Funnel: each stage counts all apps that reached at least that stage.
	// An app in "interview" has passed through evaluated -> applied -> responded ->
	// interview; an "accepted" app also passed through offer. Stages map back to
	// their dashboard_group via NormalizeStatus, so the finer stage vocabulary
	// (application_ready, interview_ready, ...) rolls up into these buckets.
	total := len(apps)
	accepted := statusCounts["accepted"]
	offer := statusCounts["offer"] + accepted
	interview := statusCounts["interview"] + offer
	responded := statusCounts["responded"] + interview
	applied := statusCounts["applied"] + responded + statusCounts["rejected"]

	pm.FunnelStages = []model.FunnelStage{
		{Label: "Evaluated", Count: total, Pct: 100.0},
		{Label: "Applied", Count: applied, Pct: safePct(applied, total)},
		{Label: "Responded", Count: responded, Pct: safePct(responded, applied)},
		{Label: "Interview", Count: interview, Pct: safePct(interview, applied)},
		{Label: "Offer", Count: offer, Pct: safePct(offer, applied)},
		{Label: "Accepted", Count: accepted, Pct: safePct(accepted, applied)},
	}

	// Rates (relative to applied)
	if applied > 0 {
		pm.ResponseRate = float64(responded) / float64(applied) * 100
		pm.InterviewRate = float64(interview) / float64(applied) * 100
		pm.OfferRate = float64(offer) / float64(applied) * 100
	}

	// Score distribution
	buckets := [5]int{} // 0: 4.5-5.0, 1: 4.0-4.4, 2: 3.5-3.9, 3: 3.0-3.4, 4: <3.0
	for _, app := range apps {
		if app.Score <= 0 {
			continue
		}
		switch {
		case app.Score >= 4.5:
			buckets[0]++
		case app.Score >= 4.0:
			buckets[1]++
		case app.Score >= 3.5:
			buckets[2]++
		case app.Score >= 3.0:
			buckets[3]++
		default:
			buckets[4]++
		}
	}
	pm.ScoreBuckets = []model.ScoreBucket{
		{Label: "4.5-5.0", Count: buckets[0]},
		{Label: "4.0-4.4", Count: buckets[1]},
		{Label: "3.5-3.9", Count: buckets[2]},
		{Label: "3.0-3.4", Count: buckets[3]},
		{Label: "  <3.0", Count: buckets[4]},
	}

	// Weekly activity: group by ISO week from Date field, show last 8 weeks.
	weekCounts := make(map[string]int)
	for _, app := range apps {
		if app.Date == "" {
			continue
		}
		t, err := time.Parse("2006-01-02", app.Date)
		if err != nil {
			continue
		}
		year, week := t.ISOWeek()
		key := fmt.Sprintf("%d-W%02d", year, week)
		weekCounts[key]++
	}

	// Sort weeks and take last 8
	var weeks []string
	for w := range weekCounts {
		weeks = append(weeks, w)
	}
	sort.Strings(weeks)
	if len(weeks) > 8 {
		weeks = weeks[len(weeks)-8:]
	}

	for _, w := range weeks {
		pm.WeeklyActivity = append(pm.WeeklyActivity, model.WeekActivity{
			Week:  w,
			Count: weekCounts[w],
		})
	}

	return pm
}

// safePct returns the percentage of part/whole, or 0 if whole is 0.
func safePct(part, whole int) float64 {
	if whole == 0 {
		return 0
	}
	return float64(part) / float64(whole) * 100
}

// UpdateApplicationStatusAndNotes updates both the status and notes of an application in applications.md.
func UpdateApplicationStatusAndNotes(careerOpsPath string, app model.CareerApplication, newStatus string, newNotes string) error {
	filePath := filepath.Join(careerOpsPath, "applications.md")
	content, err := os.ReadFile(filePath)
	if err != nil {
		filePath = filepath.Join(careerOpsPath, "data", "applications.md")
		content, err = os.ReadFile(filePath)
		if err != nil {
			return err
		}
	}

	lines := strings.Split(string(content), "\n")
	found := false

	colmap := resolveTrackerColumns(lines)
	statusIdx, statusOk := colmap["status"]
	if newStatus != "" && !statusOk {
		return fmt.Errorf("status column not found in tracker")
	}
	notesIdx, notesOk := colmap["notes"]
	if newNotes != "" && !notesOk {
		return fmt.Errorf("notes column not found in tracker, cannot append notes")
	}

	for i, line := range lines {
		if !strings.HasPrefix(strings.TrimSpace(line), "|") {
			continue
		}
		if app.ReportNumber != "" && strings.Contains(line, fmt.Sprintf("[%s]", app.ReportNumber)) {
			l := line
			if newStatus != "" {
				l = replaceStatusInLine(l, app.Status, newStatus, statusIdx)
			}
			if newNotes != "" {
				l = replaceNotesInLine(l, app.Notes, newNotes, notesIdx)
			}
			lines[i] = l
			found = true
			break
		}
	}

	if !found {
		return fmt.Errorf("application not found: report %s", app.ReportNumber)
	}

	return os.WriteFile(filePath, []byte(strings.Join(lines, "\n")), 0644)
}

func replaceNotesInLine(line, oldNotes, newNotes string, notesField int) string {
	if notesField < 0 {
		return line
	}
	if strings.Contains(line, "\t") {
		prefix, body, found := strings.Cut(line, "|")
		if !found {
			return line
		}
		cells := strings.Split(body, "\t")
		if notesField < len(cells) {
			cells[notesField] = spliceCellValue(cells[notesField], newNotes)
			return prefix + "|" + strings.Join(cells, "\t")
		}
		return line
	}

	segments := strings.Split(line, "|")
	idx := notesField + 1
	if idx < len(segments) {
		segments[idx] = spliceCellValue(segments[idx], newNotes)
		return strings.Join(segments, "|")
	}
	return line
}

// LoadReportDiscardReasons parses predicted discard reasons from a report file.
func LoadReportDiscardReasons(careerOpsPath, reportPath string) []string {
	if reportPath == "" {
		return nil
	}
	p := reportPath
	if strings.Contains(p, "](") {
		idx := strings.Index(p, "](")
		p = p[idx+2:]
		p = strings.TrimSuffix(p, ")")
	}
	fullPath := filepath.Join(careerOpsPath, p)
	content, err := os.ReadFile(fullPath)
	if err != nil {
		return nil
	}
	text := string(content)

	match := reDiscardReasons.FindStringSubmatch(text)
	if len(match) < 2 {
		return nil
	}

	itemsMatch := reDiscardItem.FindAllStringSubmatch(match[1], -1)
	var reasons []string
	for _, item := range itemsMatch {
		reasons = append(reasons, strings.TrimSpace(item[1]))
	}
	return reasons
}

// SaveAnonymousStat records an anonymized win stat to data/reported-hires.tsv.
func SaveAnonymousStat(careerOpsPath string, role string, weeks int) error {
	dirPath := filepath.Join(careerOpsPath, "data")
	if err := os.MkdirAll(dirPath, 0755); err != nil {
		return err
	}
	filePath := filepath.Join(dirPath, "reported-hires.tsv")
	f, err := os.OpenFile(filePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()

	fi, err := f.Stat()
	if err == nil && fi.Size() == 0 {
		_, _ = f.WriteString("Date\tRoleType\tWeeksToHire\n")
	}

	dateStr := time.Now().Format("2006-01-02")
	_, err = f.WriteString(fmt.Sprintf("%s\t%s\t%d\n", dateStr, role, weeks))
	return err
}

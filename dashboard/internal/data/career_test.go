package data

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

// Regression for #1180: a status word appearing as a substring of an earlier
// cell (Company "Applied Materials" contains "Applied") must not be rewritten;
// only the Status column changes.
func TestUpdateApplicationStatusOnlyRewritesStatusColumn(t *testing.T) {
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatalf("failed to create data dir: %v", err)
	}

	applications := `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 7 | 2026-06-23 | Applied Materials | Staff Android Engineer | 4.2/5 | Applied | ✅ | [7](reports/007.md) | substring trap |
`
	path := filepath.Join(dataDir, "applications.md")
	if err := os.WriteFile(path, []byte(applications), 0o644); err != nil {
		t.Fatalf("failed to write tracker: %v", err)
	}

	apps := ParseDashboardRows(tempDir)
	if len(apps) != 1 {
		t.Fatalf("expected 1 parsed application, got %d", len(apps))
	}

	if err := UpdateApplicationStatus(tempDir, apps[0], "Interview"); err != nil {
		t.Fatalf("UpdateApplicationStatus: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	out := string(got)

	if !strings.Contains(out, "| Applied Materials |") {
		t.Errorf("Company cell was corrupted, file now:\n%s", out)
	}
	if !strings.Contains(out, "| Interview |") {
		t.Errorf("Status cell was not updated to Interview, file now:\n%s", out)
	}
	if strings.Contains(out, "Interview Materials") {
		t.Errorf("status word was replaced inside the Company cell, file now:\n%s", out)
	}

	reparsed := ParseDashboardRows(tempDir)
	if reparsed[0].Company != "Applied Materials" {
		t.Errorf("company = %q, want \"Applied Materials\"", reparsed[0].Company)
	}
	if reparsed[0].Status != "Interview" {
		t.Errorf("status = %q, want \"Interview\"", reparsed[0].Status)
	}
}

func TestParseDashboardRowsUsesTrackerNumberColumn(t *testing.T) {
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatalf("failed to create data dir: %v", err)
	}

	applications := `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 140 | 2026-04-16 | Arize AI | AI Engineer, Instrumentation | 4.7/5 | Evaluated | ✅ | [140](reports/140-arize-ai-engineer-instrumentation-2026-04-16.md) | Strong fit |
| 143 | 2026-04-16 | Arize AI | AI Sales Engineer, US | 4.1/5 | Evaluated | ❌ | [143](reports/143-arize-ai-sales-engineer-us-2026-04-16.md) | Good fit |
`

	applicationsPath := filepath.Join(dataDir, "applications.md")
	if err := os.WriteFile(applicationsPath, []byte(applications), 0o644); err != nil {
		t.Fatalf("failed to write applications tracker: %v", err)
	}

	apps := ParseDashboardRows(tempDir)
	if len(apps) != 2 {
		t.Fatalf("expected 2 parsed applications, got %d", len(apps))
	}

	if apps[0].Number != 140 {
		t.Fatalf("expected first application number to be 140, got %d", apps[0].Number)
	}
	if apps[1].Number != 143 {
		t.Fatalf("expected second application number to be 143, got %d", apps[1].Number)
	}
	if apps[0].ReportNumber != "140" || apps[1].ReportNumber != "143" {
		t.Fatalf("expected report numbers to stay aligned with tracker IDs, got %q and %q", apps[0].ReportNumber, apps[1].ReportNumber)
	}
}

func TestParseDashboardRowsResolvesTrackerRelativeReportLinks(t *testing.T) {
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	reportsDir := filepath.Join(tempDir, "reports")
	for _, dir := range []string{dataDir, reportsDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("failed to create dir %s: %v", dir, err)
		}
	}

	// Tracker links are written relative to the tracker file itself
	// (merge-tracker.mjs normalization): ../reports/... when the tracker
	// lives under data/. Legacy trackers may still carry root-relative
	// links; both must resolve to the same on-disk report.
	applications := `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-06-03 | Acme | Engineer | 4.0/5 | Evaluated | ✅ | [1](../reports/001-acme-2026-06-03.md) | Tracker-relative link |
| 2 | 2026-06-03 | Legacy Co | Engineer | 3.0/5 | Evaluated | ❌ | [2](reports/002-legacy-2026-06-03.md) | Legacy root-relative link |
`

	if err := os.WriteFile(filepath.Join(dataDir, "applications.md"), []byte(applications), 0o644); err != nil {
		t.Fatalf("failed to write applications tracker: %v", err)
	}
	for _, name := range []string{"001-acme-2026-06-03.md", "002-legacy-2026-06-03.md"} {
		if err := os.WriteFile(filepath.Join(reportsDir, name), []byte("# Report\n"), 0o644); err != nil {
			t.Fatalf("failed to write report %s: %v", name, err)
		}
	}

	apps := ParseDashboardRows(tempDir)
	if len(apps) != 2 {
		t.Fatalf("expected 2 parsed applications, got %d", len(apps))
	}

	wantFirst := filepath.Join("reports", "001-acme-2026-06-03.md")
	if apps[0].ReportPath != wantFirst {
		t.Fatalf("expected tracker-relative link to resolve to %q, got %q", wantFirst, apps[0].ReportPath)
	}
	wantSecond := filepath.Join("reports", "002-legacy-2026-06-03.md")
	if apps[1].ReportPath != wantSecond {
		t.Fatalf("expected legacy root-relative link to resolve to %q, got %q", wantSecond, apps[1].ReportPath)
	}

	// Every consumer joins ReportPath against careerOpsPath — both rows
	// must point at files that exist.
	for i, app := range apps {
		if _, err := os.Stat(filepath.Join(tempDir, app.ReportPath)); err != nil {
			t.Fatalf("row %d: resolved report path %q does not exist: %v", i, app.ReportPath, err)
		}
	}
}

// writeTracker writes applications.md under data/ and returns the temp root and
// the tracker path.
func writeTracker(t *testing.T, body string) (string, string) {
	t.Helper()
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	path := filepath.Join(dataDir, "applications.md")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write tracker: %v", err)
	}
	return tempDir, path
}

const insertedColumnTracker = `# Applications Tracker

| # | Date | Company | Role | Location | Score | Status | PDF | Report | Notes |
|---|------|---------|------|----------|-------|--------|-----|--------|-------|
| 1 | 2026-06-01 | Acme | VP Marketing | Remote | 4.5/5 | Applied | ✅ | [1](reports/001.md) | hot lead |
`

// A tracker with a Location column inserted before Score (the customized layout
// the Node tracker tooling supports since #954) must not desync the Go reader.
// Without header-aware mapping, Status reads the Score cell and the report link
// reads the PDF cell, so ReportNumber comes back empty.
func TestParseDashboardRowsMapsColumnsByHeader(t *testing.T) {
	tempDir, _ := writeTracker(t, insertedColumnTracker)

	apps := ParseDashboardRows(tempDir)
	if len(apps) != 1 {
		t.Fatalf("expected 1 application, got %d", len(apps))
	}
	a := apps[0]
	if a.Company != "Acme" {
		t.Errorf("Company = %q, want \"Acme\"", a.Company)
	}
	if a.Role != "VP Marketing" {
		t.Errorf("Role = %q, want \"VP Marketing\"", a.Role)
	}
	if a.Status != "Applied" {
		t.Errorf("Status = %q, want \"Applied\"", a.Status)
	}
	if a.ScoreRaw != "4.5/5" {
		t.Errorf("ScoreRaw = %q, want \"4.5/5\"", a.ScoreRaw)
	}
	if !a.HasPDF {
		t.Errorf("HasPDF = false, want true")
	}
	if a.ReportNumber != "1" {
		t.Errorf("ReportNumber = %q, want \"1\"", a.ReportNumber)
	}
}

// End-to-end status update on the inserted-column layout: parse, update, and
// re-parse. Only the Status cell may change; every other cell stays intact.
func TestUpdateApplicationStatusInsertedColumn(t *testing.T) {
	tempDir, path := writeTracker(t, insertedColumnTracker)

	apps := ParseDashboardRows(tempDir)
	if len(apps) != 1 {
		t.Fatalf("expected 1 application, got %d", len(apps))
	}
	if err := UpdateApplicationStatus(tempDir, apps[0], "Interview"); err != nil {
		t.Fatalf("UpdateApplicationStatus: %v", err)
	}

	out, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	got := string(out)
	if !strings.Contains(got, "| Interview |") {
		t.Errorf("Status cell not updated to Interview, file now:\n%s", got)
	}
	if strings.Count(got, "Interview") != 1 {
		t.Errorf("write touched an unintended cell; %d occurrences of Interview:\n%s", strings.Count(got, "Interview"), got)
	}
	for _, cell := range []string{"| Acme |", "| VP Marketing |", "| Remote |", "| 4.5/5 |", "| ✅ |"} {
		if !strings.Contains(got, cell) {
			t.Errorf("expected intact cell %q missing after write:\n%s", cell, got)
		}
	}

	reparsed := ParseDashboardRows(tempDir)
	if reparsed[0].Status != "Interview" {
		t.Errorf("reparsed Status = %q, want \"Interview\"", reparsed[0].Status)
	}
	if reparsed[0].ScoreRaw != "4.5/5" {
		t.Errorf("reparsed ScoreRaw = %q, want \"4.5/5\"", reparsed[0].ScoreRaw)
	}
}

// resolveTrackerColumns detects the header layout, and falls back to the legacy
// fixed layout when no recognizable header row is present.
func TestResolveTrackerColumns(t *testing.T) {
	header := strings.Split(insertedColumnTracker, "\n")
	cols := resolveTrackerColumns(header)
	if cols["status"] != 6 {
		t.Errorf("status index = %d, want 6 (inserted Location column)", cols["status"])
	}
	if cols["score"] != 5 {
		t.Errorf("score index = %d, want 5", cols["score"])
	}

	headerless := []string{"| 1 | 2026-06-01 | Acme | VP Marketing | 4.5/5 | Applied | ✅ | [1](reports/001.md) | note |"}
	fallback := resolveTrackerColumns(headerless)
	if fallback["status"] != 5 {
		t.Errorf("fallback status index = %d, want 5 (legacy layout)", fallback["status"])
	}
}

// A duplicated header name resolves to its LAST occurrence, matching
// detectColumns in tracker-parse.mjs — the JS and Go readers must map an
// identical header row identically.
func TestResolveTrackerColumnsDuplicateHeaderLastWins(t *testing.T) {
	dup := strings.Split(`| # | Notes | Company | Role | Score | Status | PDF | Report | Notes |
|---|-------|---------|------|-------|--------|-----|--------|-------|
| 1 | stray | Acme | Engineer | 4.0/5 | Applied | ✅ | — | real note |`, "\n")
	cols := resolveTrackerColumns(dup)
	if cols["notes"] != 8 {
		t.Errorf("notes index = %d, want 8 (last occurrence wins, like tracker-parse.mjs)", cols["notes"])
	}
}

// A Via column (intermediary channel, #1596) between Company and Role maps by
// header name; later columns keep their correct indices.
func TestResolveTrackerColumnsVia(t *testing.T) {
	viaTracker := strings.Split(`| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|-----|------|-------|--------|-----|--------|-------|
| 1 | 2026-01-05 | ? | Hays | Data Engineer | 4.2/5 | Applied | ✅ | — | fintech, Leeds |`, "\n")
	cols := resolveTrackerColumns(viaTracker)
	if cols["via"] != 3 {
		t.Errorf("via index = %d, want 3", cols["via"])
	}
	if cols["role"] != 4 {
		t.Errorf("role index = %d, want 4 (shifted by Via column)", cols["role"])
	}
	if cols["status"] != 6 {
		t.Errorf("status index = %d, want 6", cols["status"])
	}
}

func TestParseDashboardRowsEnrichesLocationFromDataScanHistory(t *testing.T) {
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	reportsDir := filepath.Join(tempDir, "reports")
	for _, dir := range []string{dataDir, reportsDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("failed to create dir %s: %v", dir, err)
		}
	}

	applications := `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 4 | 2026-06-20 | Hume AI | Senior Platform Engineer | 3.4/5 | Evaluated | ❌ | [004](../reports/004-hume-ai.md) | Research first: senior platform role with location ambiguity. |
| 30 | 2026-06-20 | Vercel | Forward-Deployed Engineer | 3.50/5 | Evaluated | ✅ | [030](../reports/030-vercel.md) | Research first: customer-facing FDE tenure and London/Berlin setup need recruiter confirmation. |
`
	if err := os.WriteFile(filepath.Join(dataDir, "applications.md"), []byte(applications), 0o644); err != nil {
		t.Fatalf("failed to write applications tracker: %v", err)
	}
	if err := os.WriteFile(filepath.Join(reportsDir, "030-vercel.md"), []byte("**URL:** https://job-boards.greenhouse.io/vercel/jobs/5778418004\n"), 0o644); err != nil {
		t.Fatalf("failed to write report: %v", err)
	}

	scanHistory := "url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n" +
		"https://job-boards.greenhouse.io/humeai/jobs/5064248008\t2026-06-20\tgreenhouse-api\tSenior Platform Engineer\tHume AI\tadded\tNew York, New York, United States\n" +
		"https://job-boards.greenhouse.io/vercel/jobs/5778418004\t2026-06-20\tgreenhouse-api\tForward-Deployed Engineer\tVercel\tadded\tHybrid - London, Berlin\n"
	if err := os.WriteFile(filepath.Join(dataDir, "scan-history.tsv"), []byte(scanHistory), 0o644); err != nil {
		t.Fatalf("failed to write scan history: %v", err)
	}

	apps := ParseDashboardRows(tempDir)
	if len(apps) != 2 {
		t.Fatalf("expected 2 parsed applications, got %d", len(apps))
	}

	if apps[0].WorkMode != "Full" || apps[0].Location != "New York, New York, United States" {
		t.Fatalf("Hume location = %q/%q, want Full/New York, New York, United States", apps[0].WorkMode, apps[0].Location)
	}
	if apps[1].JobURL != "https://job-boards.greenhouse.io/vercel/jobs/5778418004" {
		t.Fatalf("Vercel JobURL = %q", apps[1].JobURL)
	}
	if apps[1].WorkMode != "Hybrid" || apps[1].Location != "London, Berlin" {
		t.Fatalf("Vercel location = %q/%q, want Hybrid/London, Berlin", apps[1].WorkMode, apps[1].Location)
	}
}

func TestParseDashboardRowsIncludesLiveQueueRows(t *testing.T) {
	tempDir := t.TempDir()
	for _, dir := range []string{
		filepath.Join(tempDir, "data"),
		filepath.Join(tempDir, "reports"),
		filepath.Join(tempDir, "batch", "tracker-additions"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("failed to create dir %s: %v", dir, err)
		}
	}

	applications := `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-06-20 | Acme | Evaluated Role | 4.0/5 | Evaluated | ✅ | [001](../reports/001-acme.md) | Existing tracker row |
`
	if err := os.WriteFile(filepath.Join(tempDir, "data", "applications.md"), []byte(applications), 0o644); err != nil {
		t.Fatalf("failed to write applications tracker: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tempDir, "reports", "001-acme.md"), []byte("**URL:** https://jobs.example.com/1\n"), 0o644); err != nil {
		t.Fatalf("failed to write report 001: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tempDir, "reports", "002-beta.md"), []byte("**URL:** https://jobs.example.com/2\n"), 0o644); err != nil {
		t.Fatalf("failed to write report 002: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tempDir, "reports", "005-epsilon.md"), []byte("**URL:** https://jobs.example.com/5\n"), 0o644); err != nil {
		t.Fatalf("failed to write report 005: %v", err)
	}

	addition := "2\t2026-06-22\tBeta\tUnmerged Role\tEvaluated\t3.5/5\t❌\t[002](reports/002-beta.md)\tUnmerged tracker addition\n"
	if err := os.WriteFile(filepath.Join(tempDir, "batch", "tracker-additions", "2.tsv"), []byte(addition), 0o644); err != nil {
		t.Fatalf("failed to write tracker addition: %v", err)
	}

	pipeline := `# Pipeline

## Pending
- [ ] https://jobs.example.com/2 | Beta | Unmerged Role
- [ ] https://jobs.example.com/3 | Gamma | Pending Role
- [ ] https://jobs.example.com/4 | Delta | Processing Role
- [x] https://jobs.example.com/5 | Epsilon | Terminal Completed Role
- [x] https://jobs.example.com/6 | Zeta | Terminal Skipped Role
`
	if err := os.WriteFile(filepath.Join(tempDir, "data", "pipeline.md"), []byte(pipeline), 0o644); err != nil {
		t.Fatalf("failed to write pipeline: %v", err)
	}

	state := "id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n" +
		"1\thttps://jobs.example.com/1\tcompleted\t2026-06-22T06:00:00Z\t2026-06-22T06:10:00Z\t001\t4.0\t-\t0\n" +
		"2\thttps://jobs.example.com/2\tcompleted\t2026-06-22T07:00:00Z\t2026-06-22T07:10:00Z\t002\t3.5\t-\t0\n" +
		"4\thttps://jobs.example.com/4\tprocessing\t2026-06-22T08:00:00Z\t-\t004\t-\t-\t0\n" +
		"5\thttps://jobs.example.com/5\tcompleted\t2026-06-22T08:10:00Z\t2026-06-22T08:12:00Z\t005\t2.5\t-\t0\n" +
		"6\thttps://jobs.example.com/6\tskipped\t2026-06-22T08:12:00Z\t2026-06-22T08:14:00Z\t006\t2.0\tbelow-min-score\t0\n"
	if err := os.WriteFile(filepath.Join(tempDir, "batch", "batch-state.tsv"), []byte(state), 0o644); err != nil {
		t.Fatalf("failed to write batch state: %v", err)
	}

	apps := ParseDashboardRows(tempDir)
	if len(apps) != 5 {
		t.Fatalf("expected tracker + tracker addition + unmerged completed batch + processing + pending rows, got %d: %+v", len(apps), apps)
	}

	byURL := map[string]modelSource{}
	for _, app := range apps {
		byURL[app.JobURL] = modelSource{source: string(app.Source), status: NormalizeStatus(app.Status), company: app.Company, role: app.Role}
	}
	if byURL["https://jobs.example.com/1"].source != "tracker" {
		t.Fatalf("expected existing report URL to remain tracker row, got %+v", byURL["https://jobs.example.com/1"])
	}
	if got := byURL["https://jobs.example.com/2"]; got.source != "tracker-addition" || got.status != "unmerged_complete" {
		t.Fatalf("expected URL 2 to come from unmerged tracker addition, got %+v", got)
	}
	if got := byURL["https://jobs.example.com/4"]; got.source != "batch" || got.status != "processing" || got.role != "Processing Role" {
		t.Fatalf("expected URL 4 to come from batch state with pipeline role, got %+v", got)
	}
	if got := byURL["https://jobs.example.com/3"]; got.source != "pipeline" || got.status != "pending" || got.company != "Gamma" {
		t.Fatalf("expected URL 3 to come from pending pipeline row, got %+v", got)
	}
	if got := byURL["https://jobs.example.com/5"]; got.source != "batch" || got.status != "unmerged_complete" {
		t.Fatalf("completed batch URL 5 without a tracker row should remain visible as unmerged work: %+v", got)
	}
	if _, ok := byURL["https://jobs.example.com/6"]; ok {
		t.Fatalf("terminal skipped batch URL 6 should come from tracker merge, not batch-state fallback: %+v", byURL["https://jobs.example.com/6"])
	}
}

func TestBatchQueueFailureNotesExposeReasonAndRecoveryCommand(t *testing.T) {
	tests := []struct {
		status string
		error  string
		want   []string
	}{
		{status: "failed", error: "worker exited 1", want: []string{"worker exited 1", "--retry-failed"}},
		{status: "paused_rate_limit", error: "quota reset at 09:00", want: []string{"quota reset at 09:00", "--resume-paused"}},
		{status: "rate_limited", error: "HTTP 429", want: []string{"HTTP 429", "retry"}},
	}

	for _, tt := range tests {
		t.Run(tt.status, func(t *testing.T) {
			note := batchStateNote(tt.status, tt.error)
			for _, want := range tt.want {
				if !strings.Contains(note, want) {
					t.Fatalf("batchStateNote(%q) = %q, want substring %q", tt.status, note, want)
				}
			}
		})
	}
}

func TestApplicationMetricsIgnoreSyntheticQueueRows(t *testing.T) {
	apps := []model.DashboardRow{
		{Company: "Tracked", Status: "Evaluated", Score: 4.5, Source: "tracker"},
		{Company: "Pending", Status: "Pending", Source: "pipeline"},
		{Company: "Complete", Status: "Unmerged Complete", Score: 4.0, Source: "batch"},
	}

	metrics := ComputeMetrics(apps)
	if metrics.Total != 1 || metrics.ByStatus["evaluated"] != 1 {
		t.Fatalf("pipeline metrics counted synthetic queue work: %+v", metrics)
	}

	progress := ComputeProgressMetrics(apps)
	if len(progress.FunnelStages) == 0 || progress.FunnelStages[0].Count != 1 {
		t.Fatalf("progress metrics counted synthetic queue work: %+v", progress)
	}
	if progress.AvgScore != 4.5 {
		t.Fatalf("progress average = %.1f, want tracker-only 4.5", progress.AvgScore)
	}
}

func TestUpdateApplicationStatusRejectsSyntheticQueueRows(t *testing.T) {
	tempDir := t.TempDir()
	dataDir := filepath.Join(tempDir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dataDir, "applications.md")
	tracker := `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 2 | 2026-06-22 | Beta | Unmerged Role | 3.5/5 | Evaluated | ❌ | [002](../reports/002-beta.md) | Existing tracker row |
`
	if err := os.WriteFile(path, []byte(tracker), 0o644); err != nil {
		t.Fatal(err)
	}

	app := model.DashboardRow{ReportNumber: "002", Status: "Unmerged Complete", Source: "tracker-addition"}
	if err := UpdateApplicationStatus(tempDir, app, "Applied"); err == nil {
		t.Fatal("expected synthetic queue mutation to be rejected")
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != tracker {
		t.Fatal("synthetic queue mutation changed the tracker")
	}
}

type modelSource struct {
	source  string
	status  string
	company string
	role    string
}

func TestParseDashboardRowsEnrichesNextActionsAndPacks(t *testing.T) {
	tempDir := t.TempDir()
	for _, dir := range []string{
		filepath.Join(tempDir, "data"),
		filepath.Join(tempDir, "reports"),
		filepath.Join(tempDir, "output", "next-packs"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("failed to create dir %s: %v", dir, err)
		}
	}

	applications := `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 42 | 2026-06-20 | Acme | Applied AI Engineer | 4.2/5 | Evaluated | ✅ | [42](../reports/042-acme.md) | Strong fit |
| 43 | 2026-06-01 | Beta | Platform Engineer | 4.0/5 | Applied | ✅ | [43](../reports/043-beta.md) | Already applied |
| 44 | 2026-06-22 | Gamma | Data Engineer | 3.2/5 | Evaluated | ❌ | [44](../reports/044-gamma.md) | Weak fit |
`
	if err := os.WriteFile(filepath.Join(tempDir, "data", "applications.md"), []byte(applications), 0o644); err != nil {
		t.Fatalf("failed to write tracker: %v", err)
	}
	for _, name := range []string{"042-acme.md", "043-beta.md", "044-gamma.md"} {
		if err := os.WriteFile(filepath.Join(tempDir, "reports", name), []byte("**URL:** https://jobs.example.com/"+name+"\n"), 0o644); err != nil {
			t.Fatalf("failed to write report %s: %v", name, err)
		}
	}
	if err := os.WriteFile(filepath.Join(tempDir, "output", "next-packs", "042-acme.md"), []byte("# Next Pack\n\n**Suggests:** generate_application_pack\n"), 0o644); err != nil {
		t.Fatalf("failed to write next pack: %v", err)
	}
	if err := os.WriteFile(filepath.Join(tempDir, "output", "next-packs", "043-beta.md"), []byte("# Old Next Pack\n\n**Suggests:** generate_application_pack\n"), 0o644); err != nil {
		t.Fatalf("failed to write stale next pack: %v", err)
	}

	apps := ParseDashboardRows(tempDir)
	if len(apps) != 3 {
		t.Fatalf("expected 3 parsed apps, got %d", len(apps))
	}

	// Row 42: Evaluated is agent-owned, so the automation drafts an application
	// pack; the matching generated pack is surfaced for the row.
	if apps[0].ActionState != "needs_action" || apps[0].NextAction != "generate_application_pack" {
		t.Fatalf("evaluated row next action = %q/%q", apps[0].ActionState, apps[0].NextAction)
	}
	if apps[0].ActionOwner != "agent" {
		t.Fatalf("evaluated row owner = %q, want agent", apps[0].ActionOwner)
	}
	if apps[0].NextPackPath != filepath.Join("output", "next-packs", "042-acme.md") {
		t.Fatalf("next pack path = %q", apps[0].NextPackPath)
	}
	if apps[0].NextCommand != "/career-ops next 42" {
		t.Fatalf("next command = %q", apps[0].NextCommand)
	}

	// Row 43: Applied is company-owned and its application date is past the default
	// follow-up cadence, so the dashboard surfaces a follow-up reminder. The stale
	// pack (a mismatched action) must not be surfaced.
	if apps[1].ActionState != "needs_action" || apps[1].NextAction != "follow_up" {
		t.Fatalf("applied row next action = %q/%q", apps[1].ActionState, apps[1].NextAction)
	}
	if apps[1].NextPackPath != "" {
		t.Fatalf("stale next pack with mismatched action should not be surfaced, got %q", apps[1].NextPackPath)
	}

	// Row 44: Evaluated regardless of score -- the apply/discard gate is automation
	// policy, not a dashboard decision, so the dashboard still routes to drafting.
	if apps[2].ActionState != "needs_action" || apps[2].NextAction != "generate_application_pack" {
		t.Fatalf("low-score evaluated row next action = %q/%q", apps[2].ActionState, apps[2].NextAction)
	}
}

func TestLoadReportSummaryExtractsCompensationRange(t *testing.T) {
	tempDir := t.TempDir()
	reportsDir := filepath.Join(tempDir, "reports")
	if err := os.MkdirAll(reportsDir, 0o755); err != nil {
		t.Fatalf("failed to create reports dir: %v", err)
	}

	report := `# Evaluation: RunPod -- Senior Software Engineer

## D) Compensation and Demand

| Source | Data | Relevance |
|---|---|---|
| RunPod official Greenhouse posting | Base pay range is $150,000-$200,000 plus stock options and standard benefits. | Direct source for this role. Strong transparency. |
| Funding | RunPod raised $20M seed in May 2024. | Company signal, not pay. |

**Comp score: 4.0/5.**
`
	if err := os.WriteFile(filepath.Join(reportsDir, "runpod.md"), []byte(report), 0o644); err != nil {
		t.Fatalf("failed to write report: %v", err)
	}

	_, _, _, comp := LoadReportSummary(tempDir, filepath.Join("reports", "runpod.md"))
	if comp != "USD 150K-200K" {
		t.Fatalf("comp = %q, want USD 150K-200K", comp)
	}
}

func TestLoadReportSummaryNormalizesCurrencyToISOCode(t *testing.T) {
	tempDir := t.TempDir()
	reportsDir := filepath.Join(tempDir, "reports")
	if err := os.MkdirAll(reportsDir, 0o755); err != nil {
		t.Fatalf("failed to create reports dir: %v", err)
	}

	report := `# Evaluation: Hume AI -- Senior Platform Engineer

## D) Compensation and Demand

| Data point | Signal | Interpretation |
|---|---|---|
| Hume JD salary: USD 180,000-230,000 | Stated on Greenhouse. | Strong transparency. |

Comp score: 4.0/5.
`
	if err := os.WriteFile(filepath.Join(reportsDir, "hume.md"), []byte(report), 0o644); err != nil {
		t.Fatalf("failed to write report: %v", err)
	}

	_, _, _, comp := LoadReportSummary(tempDir, filepath.Join("reports", "hume.md"))
	if comp != "USD 180K-230K" {
		t.Fatalf("comp = %q, want USD 180K-230K", comp)
	}
}

// TestNormalizeStatusMapsStagesToDashboardGroups asserts that every lifecycle
// stage in templates/states.yml (including the fine-grained _ready stages and the
// new accepted terminal) collapses to its dashboard_group, and that the
// pipeline-synthesized batch statuses stay outside the state machine.
func TestNormalizeStatusMapsStagesToDashboardGroups(t *testing.T) {
	cases := map[string]string{
		"Evaluated":         "evaluated",
		"Application Ready": "evaluated",
		"Qualifying Ready":  "evaluated",
		"Qualifying Sent":   "evaluated",
		"Applied":           "applied",
		"Outreach Ready":    "applied",
		"Responded":         "responded",
		"Interview Ready":   "interview",
		"Interview":         "interview", // legacy alias
		"Offer":             "offer",
		"Offer Ready":       "offer",
		"Accepted":          "accepted",
		"Rejected":          "rejected",
		"Discarded":         "discarded",
		"SKIP":              "skip",
		"aplicado":          "applied", // legacy Spanish alias
		"processing":        "processing",
		"pending":           "pending",
		"failed":            "failed",
	}
	for raw, want := range cases {
		if got := NormalizeStatus(raw); got != want {
			t.Errorf("NormalizeStatus(%q) = %q, want %q", raw, got, want)
		}
	}
}

// TestDeriveNextActionByOwner asserts the dashboard's next-action view-model is
// driven purely by the stage's owner/suggests from templates/states.yml.
func TestDeriveNextActionByOwner(t *testing.T) {
	sm := states()
	now := time.Now()
	cases := []struct {
		status     string
		wantState  string
		wantAction string
		wantOwner  string
	}{
		{"Evaluated", "needs_action", "generate_application_pack", "agent"},
		{"Application Ready", "needs_action", "send_application", "user"},
		{"Qualifying Ready", "needs_action", "send_qualifying_questions", "user"},
		{"Responded", "needs_action", "generate_interview_cheatsheet", "agent"},
		{"Interview Ready", "needs_action", "attend_interview_and_report", "user"},
		{"Offer", "needs_action", "generate_negotiation_prep", "agent"},
		{"Accepted", "none", "none", "none"},
		{"SKIP", "none", "none", "none"},
	}
	for _, tc := range cases {
		rec := deriveNextAction(model.DashboardRow{Status: tc.status}, now, sm)
		if rec.ActionState != tc.wantState || rec.NextAction != tc.wantAction || rec.Owner != tc.wantOwner {
			t.Errorf("deriveNextAction(%q) = %q/%q/%q, want %q/%q/%q",
				tc.status, rec.ActionState, rec.NextAction, rec.Owner,
				tc.wantState, tc.wantAction, tc.wantOwner)
		}
	}
}

// TestStatusPriorityRanksAcceptedAsPositiveTerminal asserts the accepted group
// sorts after the active pipeline but ahead of the negative terminals.
func TestStatusPriorityRanksAcceptedAsPositiveTerminal(t *testing.T) {
	if !(StatusPriority("Evaluated") < StatusPriority("Accepted")) {
		t.Errorf("accepted should sort after evaluated")
	}
	if !(StatusPriority("Accepted") < StatusPriority("SKIP")) {
		t.Errorf("accepted should sort ahead of skip")
	}
}

// TestDeriveNextActionResearchFirstPreview asserts that an evaluated row whose
// note carries the "Research first" decision previews the qualifying-question
// draft (mirroring modes/next.md routing), while a normal note or a later
// APPLY/CONSIDER re-evaluation keeps the application draft and a row that already
// qualified (loop-guard marker) reverts to the application draft.
func TestDeriveNextActionResearchFirstPreview(t *testing.T) {
	sm := states()
	now := time.Now()
	cases := []struct {
		name       string
		notes      string
		wantAction string
	}{
		{"research-first previews the gating question", "Research first: strong fit, but visa/relocation needs confirmation.", "draft_qualifying_questions"},
		{"normal evaluated row drafts the application", "APPLY: strong remote Europe fit.", "generate_application_pack"},
		{"later re-evaluation supersedes research-first", "Research first: visa path needs confirmation.; [re-evaluated 2026-07-09] CONSIDER: viable stretch; location is not a pre-application gate.", "generate_application_pack"},
		{"already-qualified row reverts to the application", "Research first: ... [qualifying-sent 2026-07-08]", "generate_application_pack"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := deriveNextAction(model.DashboardRow{Status: "Evaluated", Notes: tc.notes}, now, sm)
			if rec.NextAction != tc.wantAction || rec.Owner != "agent" {
				t.Errorf("deriveNextAction = %q/%q, want %q/agent", rec.NextAction, rec.Owner, tc.wantAction)
			}
		})
	}
}

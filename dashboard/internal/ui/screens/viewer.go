package screens

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/lipgloss/table"
	"github.com/charmbracelet/x/ansi"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

// ViewerClosedMsg is emitted when the viewer is dismissed.
type ViewerClosedMsg struct{}

// ViewerOpenCoverLetterMsg is emitted when the user requests to open the cover letter PDF.
type ViewerOpenCoverLetterMsg struct{ Path string }

// ViewerUpdateStatusMsg is emitted when a status update is requested from the viewer.
type ViewerUpdateStatusMsg struct {
	App       model.DashboardRow
	NewStatus string
}

// ViewerModel implements an integrated file viewer screen.
type ViewerModel struct {
	lines           []string
	renderedLines   []string
	title           string
	linkBaseDir     string
	scrollOffset    int
	width           int
	height          int
	theme           theme.Theme
	app             model.DashboardRow
	careerOpsPath   string
	coverLetterPath string
	cvPDFPath       string
	statusPicker    bool
	statusCursor    int
}

// NewViewerModel creates a new file viewer for the given path.
func NewViewerModel(t theme.Theme, careerOpsPath, path, title string, width, height int, app model.DashboardRow) ViewerModel {
	content, err := os.ReadFile(path)
	if err != nil {
		content = []byte("Error reading file: " + err.Error())
	}

	var lines []string
	if len(content) > 0 {
		lines = strings.Split(string(content), "\n")
	}
	if isDetailsTitle(title) {
		lines = buildDetailsLines(careerOpsPath, lines, app)
	}

	m := ViewerModel{
		lines:           lines,
		title:           title,
		linkBaseDir:     filepath.Dir(path),
		width:           width,
		height:          height,
		theme:           t,
		app:             app,
		careerOpsPath:   careerOpsPath,
		coverLetterPath: parseCoverLetterPath(lines, careerOpsPath),
		cvPDFPath:       resolveViewerPDFPath(careerOpsPath, app),
	}
	m.rebuildRender()
	return m
}

func isDetailsTitle(title string) bool {
	return title == "DETAILS" || strings.HasPrefix(title, "DETAILS: ")
}

func buildDetailsLines(careerOpsPath string, reportLines []string, app model.DashboardRow) []string {
	var lines []string

	if snapshotLines := extractDetailsSnapshotLines(reportLines); len(snapshotLines) > 0 {
		lines = append(lines, snapshotLines...)
		lines = append(lines, "")
	}

	if nextLines := loadDetailsNextPackLines(careerOpsPath, app); len(nextLines) > 0 {
		lines = append(lines, "## Next Step", "")
		lines = append(lines, cleanDetailsNextPackLines(nextLines)...)
		lines = append(lines, "")
	} else if detail := detailsAppNextStepLine(app); detail != "" {
		lines = append(lines, "## Next Step", "", detail, "")
	}

	if len(lines) > 0 {
		lines = append(lines, "---", "")
	}
	deepDiveLines := stripDetailsLeadSections(stripLeadingReportHeader(stripLeadingReportHeading(reportLines)))
	lines = append(lines, "## Deep Dive", "")
	if tldr := extractDetailsTlDr(deepDiveLines); tldr != "" {
		lines = append(lines, "**TL;DR:** "+tldr, "")
	}
	lines = append(lines, deepDiveLines...)

	return lines
}

func extractDetailsTlDr(lines []string) string {
	for _, line := range lines {
		if !isTableLine(line) || isTableSeparator(line) {
			continue
		}
		cells := parseTableCells(line)
		if len(cells) < 2 || normalizeDetailsLabel(cells[0]) != "tl;dr" {
			continue
		}
		if tldr := cleanDetailsText(cells[1]); tldr != "" {
			return tldr
		}
	}

	for _, line := range lines {
		key, value, ok := splitMetadataLine(strings.TrimSpace(line))
		if !ok || normalizeDetailsLabel(key) != "tl;dr" {
			continue
		}
		if tldr := cleanDetailsText(value); tldr != "" {
			return tldr
		}
	}

	return ""
}

func extractDetailsSnapshotLines(lines []string) []string {
	for i, line := range lines {
		text, ok := markdownHeadingText(strings.TrimSpace(line))
		if !ok || !strings.EqualFold(strings.TrimSpace(text), "Decision Snapshot") {
			continue
		}
		end := skipMarkdownSection(lines, i)
		if end <= i+1 {
			return nil
		}
		return trimBlankMarkdownLines(lines[i+1 : end])
	}
	return nil
}

func stripDetailsLeadSections(lines []string) []string {
	var out []string
	for i := 0; i < len(lines); {
		trimmed := strings.TrimSpace(lines[i])
		text, ok := markdownHeadingText(trimmed)
		if ok && detailsLeadSection(text) {
			i = skipMarkdownSection(lines, i)
			continue
		}
		out = append(out, lines[i])
		i++
	}
	return trimBlankMarkdownLines(out)
}

func detailsLeadSection(text string) bool {
	text = strings.TrimSpace(text)
	return strings.EqualFold(text, "Decision Snapshot") ||
		strings.EqualFold(text, "Machine Summary")
}

func trimBlankMarkdownLines(lines []string) []string {
	start := 0
	for start < len(lines) && strings.TrimSpace(lines[start]) == "" {
		start++
	}
	end := len(lines)
	for end > start && strings.TrimSpace(lines[end-1]) == "" {
		end--
	}
	return lines[start:end]
}

func cleanDetailsNextPackLines(lines []string) []string {
	out := make([]string, 0, len(lines))
	meta := detailsNextPackMeta{}
	for _, line := range lines {
		if keep, handled := meta.readLine(line); handled {
			if keep {
				out = append(out, line)
			}
			continue
		}
		out = append(out, line)
	}
	if summary := meta.summaryLine(); summary != "" {
		out = append([]string{summary, ""}, trimBlankMarkdownLines(out)...)
	}
	return trimBlankMarkdownLines(out)
}

type detailsNextPackMeta struct {
	decision        string
	legacyNextStep  string
	hasAuthoredStep bool
	owner           string
	suggests        string
}

func (m *detailsNextPackMeta) readLine(line string) (bool, bool) {
	key, value, ok := splitMetadataLine(strings.TrimSpace(line))
	if !ok {
		return false, false
	}
	switch normalizeDetailsLabel(key) {
	case "decision":
		m.decision = value
		return false, true
	case "next step":
		m.hasAuthoredStep = true
		return true, true
	case "next human action", "next checkpoint":
		m.legacyNextStep = value
		return false, true
	case "owner":
		m.owner = value
		return false, true
	case "suggests":
		m.suggests = value
		return false, true
	case "stage", "score", "report", "current status", "selected because",
		"pipeline stage", "performed by", "action type":
		return false, true
	default:
		return false, false
	}
}

func (m detailsNextPackMeta) summaryLine() string {
	if m.hasAuthoredStep {
		return ""
	}

	human := cleanDetailsText(m.legacyNextStep)
	if human != "" {
		return "**Next step:** " + detailsSentence(human)
	}

	action := detailsActionLabel(m.suggests)
	actionSource := m.suggests
	if action == "" {
		action = detailsDecisionLabel(m.decision)
		actionSource = m.decision
	}
	if action == "" {
		return ""
	}
	if strings.EqualFold(normalizeDetailsLabel(m.owner), "agent") && detailsAgentCanPerform(actionSource) {
		action += " with an agent"
	}
	return "**Next step:** " + detailsSentence(action)
}

func detailsActionLabel(value string) string {
	switch normalizeDetailsLabel(value) {
	case "generate_approach_plan":
		return "Generate the Approach Plan"
	case "execute_approach":
		return "Try the selected approach, then report back"
	case "review_approach":
		return "Review the next approach"
	case "generate_application_pack":
		return "Generate the application"
	case "send_application":
		return "Send the generated application"
	case "draft_qualifying_questions":
		return "Draft a qualifying question"
	case "send_qualifying_questions":
		return "Send the qualifying question"
	case "draft_outreach":
		return "Draft outreach"
	case "send_outreach":
		return "Send the outreach"
	case "follow_up":
		return "Send a follow-up"
	case "generate_interview_cheatsheet":
		return "Generate the interview cheatsheet"
	case "regenerate_cheatsheet":
		return "Regenerate the interview cheatsheet"
	case "attend_interview_and_report":
		return "Attend the interview, then report back"
	case "generate_negotiation_prep":
		return "Generate negotiation prep"
	case "negotiate_and_report":
		return "Negotiate, then report back"
	case "none":
		return ""
	default:
		return detailsTokenLabel(value)
	}
}

func detailsDecisionLabel(value string) string {
	switch normalizeDetailsLabel(value) {
	case "draft application pack":
		return "Generate the application"
	case "draft qualifying question":
		return "Draft a qualifying question"
	case "send", "send application":
		return "Send the generated application"
	case "follow up":
		return "Send a follow-up"
	case "prep":
		return "Prepare for the next step"
	case "negotiate":
		return "Negotiate"
	case "close":
		return "Close this opportunity"
	default:
		return detailsTokenLabel(value)
	}
}

func detailsAgentCanPerform(value string) bool {
	switch normalizeDetailsLabel(value) {
	case "generate_approach_plan",
		"generate approach plan",
		"review_approach",
		"review approach":
		return true
	case "generate_application_pack",
		"draft application pack",
		"draft_qualifying_questions",
		"draft qualifying question",
		"draft_outreach",
		"generate_interview_cheatsheet",
		"regenerate_cheatsheet",
		"generate_negotiation_prep",
		"prep":
		return true
	default:
		return false
	}
}

func detailsTokenLabel(value string) string {
	value = cleanDetailsText(value)
	parts := strings.Fields(strings.NewReplacer("_", " ", "-", " ").Replace(value))
	for i, part := range parts {
		if part == "" {
			continue
		}
		parts[i] = strings.ToUpper(part[:1]) + part[1:]
	}
	return strings.Join(parts, " ")
}

func detailsSentence(s string) string {
	s = cleanDetailsText(s)
	if s == "" {
		return ""
	}
	switch s[len(s)-1] {
	case '.', '!', '?':
		return s
	default:
		return s + "."
	}
}

func detailsAppNextStepLine(app model.DashboardRow) string {
	summary := detailsAppNextStepSummary(app)
	if summary == "" {
		return ""
	}
	return "**Next step:** " + summary
}

func detailsAppNextStepSummary(app model.DashboardRow) string {
	action := detailsAppActionSentence(app)
	if action == "" {
		return ""
	}
	var parts []string
	parts = append(parts, action)
	if command := detailsAppRunCommand(app); command != "" {
		parts = append(parts, "Run: "+command+".")
	}
	if pack := detailsAppPackReference(app); pack != "" {
		parts = append(parts, "Open: "+pack+".")
	}
	if app.ActionDue != "" {
		parts = append(parts, "Due: "+app.ActionDue+".")
	}
	return strings.Join(parts, " ")
}

func detailsAppActionSentence(app model.DashboardRow) string {
	switch {
	case actionStateIs(app, "waiting", "snoozed"):
		if app.WaitingOn != "" {
			return "Wait for " + strings.TrimSuffix(app.WaitingOn, ".") + "."
		}
		return "Wait for a response."
	case app.NextAction == "" || app.NextAction == "none":
		return ""
	}

	agentSuffix := ""
	if strings.EqualFold(app.ActionOwner, "agent") {
		agentSuffix = " with an agent"
	}

	switch app.NextAction {
	case "generate_approach_plan":
		return "Generate the Approach Plan" + agentSuffix + "."
	case "execute_approach":
		return "Try the selected approach, then report back."
	case "review_approach":
		if strings.Contains(strings.ToLower(app.ActionReason), "cold") {
			return "Review the stale approach and choose another route, deprioritization, or discard."
		}
		return "Review the next approach."
	case "generate_application_pack":
		return "Generate the application" + agentSuffix + "."
	case "send_application":
		return "Send the generated application."
	case "draft_qualifying_questions":
		return "Draft a qualifying question" + agentSuffix + "."
	case "send_qualifying_questions":
		return "Send the qualifying question."
	case "draft_outreach":
		return "Draft outreach" + agentSuffix + "."
	case "send_outreach":
		return "Send the outreach."
	case "follow_up":
		return "Send a follow-up."
	case "generate_interview_cheatsheet":
		return "Generate the interview cheatsheet" + agentSuffix + "."
	case "regenerate_cheatsheet":
		return "Regenerate the interview cheatsheet" + agentSuffix + "."
	case "attend_interview_and_report":
		return "Attend the interview, then report back."
	case "generate_negotiation_prep":
		return "Generate negotiation prep" + agentSuffix + "."
	case "negotiate_and_report":
		return "Negotiate, then report back."
	default:
		label := detailsActionLabel(app.NextAction)
		if label == "" {
			return ""
		}
		return label + "."
	}
}

func detailsAppRunCommand(app model.DashboardRow) string {
	if app.NextCommand == "" || !needsManualAction(app) || canOpenNextArtifact(app) {
		return ""
	}
	return app.NextCommand
}

func detailsAppPackReference(app model.DashboardRow) string {
	if !canOpenNextArtifact(app) {
		return ""
	}
	return app.NextPackPath
}

func normalizeDetailsLabel(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, "*`:_ ")
	return strings.ToLower(s)
}

func cleanDetailsText(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, "| ")
	s = strings.TrimSpace(reBold.ReplaceAllString(s, "$1"))
	return s
}

func loadDetailsNextPackLines(careerOpsPath string, app model.DashboardRow) []string {
	if careerOpsPath == "" || app.NextPackPath == "" {
		return nil
	}
	packPath := filepath.Join(careerOpsPath, filepath.FromSlash(app.NextPackPath))
	content, err := os.ReadFile(packPath)
	if err != nil {
		return nil
	}
	lines := stripLeadingNextPackHeading(strings.Split(string(content), "\n"))
	return absolutizeLocalMarkdownLinks(lines, filepath.Dir(packPath), careerOpsPath)
}

// absolutizeLocalMarkdownLinks preserves the source directory of links from a
// next-pack before its lines are merged into a report-backed DETAILS view. A
// pack-relative link such as ../cv-acme.pdf would otherwise be resolved against
// reports/ and silently point at the wrong file.
func absolutizeLocalMarkdownLinks(lines []string, baseDir, careerOpsPath string) []string {
	out := make([]string, len(lines))
	for i, line := range lines {
		out[i] = reLink.ReplaceAllStringFunc(line, func(raw string) string {
			parts := reLink.FindStringSubmatch(raw)
			if len(parts) < 3 {
				return raw
			}
			absPath, ok := resolveLocalHyperlinkPath(parts[2], baseDir, careerOpsPath)
			if !ok {
				return raw
			}
			root, err := filepath.Abs(careerOpsPath)
			if err != nil {
				return raw
			}
			rel, err := filepath.Rel(root, absPath)
			if err != nil {
				return raw
			}
			return "[" + parts[1] + "](repo:" + filepath.ToSlash(rel) + ")"
		})
	}
	return out
}

func stripLeadingNextPackHeading(lines []string) []string {
	i := 0
	for i < len(lines) && strings.TrimSpace(lines[i]) == "" {
		i++
	}
	if i < len(lines) {
		if text, ok := markdownHeadingText(strings.TrimSpace(lines[i])); ok &&
			strings.HasPrefix(strings.ToLower(text), "next:") {
			i++
		}
	}
	for i < len(lines) && strings.TrimSpace(lines[i]) == "" {
		i++
	}
	return lines[i:]
}

func stripLeadingReportHeading(lines []string) []string {
	i := 0
	for i < len(lines) && strings.TrimSpace(lines[i]) == "" {
		i++
	}
	if i < len(lines) && isEvaluationHeading(strings.TrimSpace(lines[i])) {
		i++
	}
	for i < len(lines) && strings.TrimSpace(lines[i]) == "" {
		i++
	}
	return lines[i:]
}

func stripLeadingReportHeader(lines []string) []string {
	i := 0
	for i < len(lines) && strings.TrimSpace(lines[i]) == "" {
		i++
	}
	for i < len(lines) {
		trimmed := strings.TrimSpace(lines[i])
		if trimmed == "" || trimmed == "---" || trimmed == "***" {
			i++
			continue
		}
		if _, _, ok := splitMetadataLine(trimmed); ok {
			i++
			continue
		}
		break
	}
	for i < len(lines) && strings.TrimSpace(lines[i]) == "" {
		i++
	}
	return lines[i:]
}

// parseCoverLetterPath scans the report lines for a "PDF generated: output/..." line
// inside a "## Cover Letter Draft" section and returns the relative path if the file exists.
func parseCoverLetterPath(lines []string, careerOpsPath string) string {
	inCoverSection := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "## Cover Letter Draft") {
			inCoverSection = true
			continue
		}
		if inCoverSection && strings.HasPrefix(trimmed, "## ") {
			break
		}
		if inCoverSection {
			if m := reCoverLetterPDF.FindStringSubmatch(line); m != nil {
				relPath := m[1]
				abs := filepath.Join(careerOpsPath, filepath.FromSlash(relPath))
				if _, err := os.Stat(abs); err == nil {
					return relPath
				}
			}
		}
	}
	return ""
}

func resolveViewerPDFPath(careerOpsPath string, app model.DashboardRow) string {
	if careerOpsPath == "" {
		return ""
	}
	manifest := data.LoadPDFManifest(careerOpsPath)
	candidates := data.ResolvePDFs(careerOpsPath, app, manifest)
	if len(candidates) == 0 {
		return ""
	}
	return filepath.Join(careerOpsPath, filepath.FromSlash(candidates[0]))
}

// rebuildRender recomputes renderedLines from raw lines using the current width.
func (m *ViewerModel) rebuildRender() {
	m.renderedLines = m.renderAll()
	m.clampScrollOffset()
}

func (m *ViewerModel) clampScrollOffset() {
	maxScroll := len(m.renderedLines) - m.bodyHeight()
	if maxScroll < 0 {
		maxScroll = 0
	}
	if m.scrollOffset > maxScroll {
		m.scrollOffset = maxScroll
	}
	if m.scrollOffset < 0 {
		m.scrollOffset = 0
	}
}

func (m ViewerModel) Init() tea.Cmd {
	return nil
}

func (m *ViewerModel) Resize(width, height int) {
	m.width = width
	m.height = height
	m.rebuildRender()
}

func (m ViewerModel) Update(msg tea.Msg) (ViewerModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if m.statusPicker {
			return m.handleStatusPicker(msg)
		}
		if isPageDownKey(msg) {
			jump := m.bodyHeight()
			if jump < 1 {
				jump = 1
			}
			maxScroll := len(m.renderedLines) - m.bodyHeight()
			if maxScroll < 0 {
				maxScroll = 0
			}
			m.scrollOffset += jump
			if m.scrollOffset > maxScroll {
				m.scrollOffset = maxScroll
			}
			return m, nil
		}
		if isPageUpKey(msg) {
			jump := m.bodyHeight()
			if jump < 1 {
				jump = 1
			}
			m.scrollOffset -= jump
			if m.scrollOffset < 0 {
				m.scrollOffset = 0
			}
			return m, nil
		}

		switch msg.String() {
		case "q", "esc":
			return m, func() tea.Msg { return ViewerClosedMsg{} }

		case "c":
			if !m.app.IsTrackedApplication() {
				return m, nil
			}
			m.statusPicker = true
			m.statusCursor = 0
			currentNorm := data.NormalizeStatus(m.app.Status)
			for idx, opt := range statusOptions {
				if data.NormalizeStatus(opt) == currentNorm {
					m.statusCursor = idx
					break
				}
			}
			m.clampScrollOffset()
			return m, nil

		case "down", "j":
			maxScroll := len(m.renderedLines) - m.bodyHeight()
			if maxScroll < 0 {
				maxScroll = 0
			}
			if m.scrollOffset < maxScroll {
				m.scrollOffset++
			}

		case "up", "k":
			if m.scrollOffset > 0 {
				m.scrollOffset--
			}

		case "ctrl+d":
			jump := m.bodyHeight() / 2
			maxScroll := len(m.renderedLines) - m.bodyHeight()
			if maxScroll < 0 {
				maxScroll = 0
			}
			m.scrollOffset += jump
			if m.scrollOffset > maxScroll {
				m.scrollOffset = maxScroll
			}

		case "ctrl+u":
			jump := m.bodyHeight() / 2
			m.scrollOffset -= jump
			if m.scrollOffset < 0 {
				m.scrollOffset = 0
			}

		case "home", "g":
			m.scrollOffset = 0

		case "end", "G":
			maxScroll := len(m.renderedLines) - m.bodyHeight()
			if maxScroll < 0 {
				maxScroll = 0
			}
			m.scrollOffset = maxScroll

		case "L":
			if m.coverLetterPath != "" {
				fullPath := filepath.Join(m.careerOpsPath, filepath.FromSlash(m.coverLetterPath))
				return m, func() tea.Msg { return ViewerOpenCoverLetterMsg{Path: fullPath} }
			}

		case "o":
			if m.app.JobURL != "" {
				return m, func() tea.Msg { return PipelineOpenURLMsg{URL: m.app.JobURL} }
			}

		case "d":
			if m.cvPDFPath != "" {
				return m, func() tea.Msg { return PipelineOpenPDFMsg{Path: m.cvPDFPath} }
			}
		}

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.rebuildRender()
	}

	return m, nil
}

func (m ViewerModel) bodyHeight() int {
	h := m.height - m.headerHeight() - m.footerHeight()
	if m.statusPicker {
		h -= (len(statusOptions) + 1)
	}
	if h < 3 {
		h = 3
	}
	return h
}

func (m ViewerModel) headerHeight() int { return 3 }

func (m ViewerModel) footerHeight() int { return 1 }

func (m ViewerModel) View() string {
	header := m.renderHeader()
	body := m.renderBody()
	if m.statusPicker {
		body = m.overlayStatusPicker(body)
	}
	footer := m.renderFooter()

	return lipgloss.JoinVertical(lipgloss.Left, header, body, footer)
}

func (m ViewerModel) renderHeader() string {
	scrollText := func() string {
		if len(m.renderedLines) == 0 {
			return ""
		}
		pct := 0
		maxScroll := len(m.renderedLines) - m.bodyHeight()
		if maxScroll > 0 {
			pct = m.scrollOffset * 100 / maxScroll
		}
		if m.scrollOffset == 0 {
			return "Top"
		}
		if m.scrollOffset >= maxScroll {
			return "End"
		}
		return func() string {
			s := pct
			return string(rune('0'+s/10%10)) + string(rune('0'+s%10)) + "%"
		}()
	}()
	return strings.Join([]string{
		m.blankTitleRow(),
		m.renderTitleRowRight(m.title, scrollText, m.theme.Blue),
		m.blankTitleRow(),
	}, "\n")
}

func (m ViewerModel) renderBody() string {
	bh := m.bodyHeight()

	if len(m.renderedLines) == 0 {
		emptyStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)
		return m.indentContent(emptyStyle.Render("(empty file)"))
	}

	end := m.scrollOffset + bh
	if end > len(m.renderedLines) {
		end = len(m.renderedLines)
	}
	visible := m.renderedLines[m.scrollOffset:end]

	flat := make([]string, bh)
	copy(flat, visible)

	return strings.Join(flat, "\n")
}

// renderAll converts every raw markdown line into visual terminal lines.
func (m ViewerModel) renderAll() []string {
	var styled []string
	i := 0
	for i < len(m.lines) {
		line := m.lines[i]
		trimmed := strings.TrimSpace(line)

		if m.isEvaluationViewer() && isMachineSummaryHeading(trimmed) {
			i = skipMarkdownSection(m.lines, i)
			continue
		}

		if m.shouldHideLeadingTitleLine(i, trimmed) {
			i++
			if i < len(m.lines) && strings.TrimSpace(m.lines[i]) == "" {
				i++
			}
			continue
		}

		if trimmed == "" {
			appendBlankLine(&styled)
			i++
			continue
		}

		if isMarkdownRule(trimmed) && m.isDetailsViewer() {
			if m.detailsRuleStartsRegion(i) {
				styled = append(styled, m.styleLine(line))
			} else {
				appendBlankLine(&styled)
			}
			i++
			continue
		}

		if isHeadingLine(trimmed) || reBoldOnly.MatchString(trimmed) {
			styled = appendHeadingBlock(styled, m.styleLine(line))
			i++
			continue
		}

		if isTableLine(line) {
			tableStart := i
			for i < len(m.lines) && isTableLine(m.lines[i]) {
				i++
			}
			styled = append(styled, m.renderTableBlock(m.lines[tableStart:i])...)
			continue
		}

		if strings.HasPrefix(trimmed, "```") {
			i++
			var codeLines []string
			for i < len(m.lines) {
				if strings.TrimSpace(m.lines[i]) == "```" {
					i++
					break
				}
				codeLines = append(codeLines, m.lines[i])
				i++
			}
			w := m.fullWidth()
			codeStyle := lipgloss.NewStyle().Background(m.theme.Panel).Foreground(m.theme.Text).Width(w)
			if m.inheritsContentBackground() {
				codeStyle = lipgloss.NewStyle().Foreground(m.theme.Text)
			}
			for _, cl := range codeLines {
				for _, wl := range strings.Split(ansi.Wrap(strings.TrimLeft(cl, " \t"), m.textWidth(), ""), "\n") {
					styled = append(styled, codeStyle.Render(m.indentContent(wl)))
				}
			}
			continue
		}

		if isSpecialBlockLine(trimmed) {
			styled = append(styled, m.styleLine(line))
			i++
			continue
		}

		start := i
		for i < len(m.lines) {
			next := strings.TrimSpace(m.lines[i])
			if next == "" || isSpecialBlockLine(next) {
				break
			}
			i++
		}
		if i > start {
			paraLines := m.lines[start:i]
			for j, line := range paraLines {
				paraLines[j] = strings.TrimSpace(line)
			}
			para := strings.Join(paraLines, " ")
			wrapped := m.wrapParagraph(m.renderInlineElements(para), m.textWidth())
			for _, wl := range wrapped {
				styled = append(styled, m.renderContentLine(wl))
			}
		}
	}

	var flat []string
	for _, s := range styled {
		if strings.IndexByte(s, '\n') >= 0 {
			flat = append(flat, strings.Split(s, "\n")...)
		} else {
			flat = append(flat, s)
		}
	}
	return flat
}

func appendBlankLine(lines *[]string) {
	if len(*lines) == 0 || (*lines)[len(*lines)-1] == "" {
		return
	}
	*lines = append(*lines, "")
}

func appendHeadingBlock(lines []string, heading string) []string {
	if len(lines) > 0 && lines[len(lines)-1] != "" {
		lines = append(lines, "")
	}
	lines = append(lines, strings.Split(heading, "\n")...)
	lines = append(lines, "")
	return lines
}

func (m ViewerModel) shouldHideLeadingTitleLine(index int, trimmed string) bool {
	if index != 0 {
		return false
	}
	if m.isNextStepViewer() && strings.HasPrefix(trimmed, "## Next:") {
		return true
	}
	return m.isEvaluationViewer() && isEvaluationHeading(trimmed)
}

func (m ViewerModel) isNextStepViewer() bool {
	return strings.HasPrefix(m.title, "NEXT STEP: ") ||
		strings.HasPrefix(m.title, "Next Pack -- ")
}

func (m ViewerModel) isDetailsViewer() bool {
	return isDetailsTitle(m.title)
}

func (m ViewerModel) isEvaluationViewer() bool {
	return strings.HasPrefix(m.title, "EVALUATION: ") ||
		m.title == "EVALUATION" ||
		isDetailsTitle(m.title)
}

func isEvaluationHeading(trimmed string) bool {
	text, ok := markdownHeadingText(trimmed)
	return ok && strings.HasPrefix(strings.ToUpper(text), "EVALUATION:")
}

func markdownHeadingText(trimmed string) (string, bool) {
	level, ok := markdownHeadingLevel(trimmed)
	if !ok {
		return "", false
	}
	return strings.TrimSpace(strings.TrimPrefix(trimmed, strings.Repeat("#", level)+" ")), true
}

func markdownHeadingLevel(trimmed string) (int, bool) {
	for level := 6; level >= 1; level-- {
		prefix := strings.Repeat("#", level) + " "
		if strings.HasPrefix(trimmed, prefix) {
			return level, true
		}
	}
	return 0, false
}

func isMachineSummaryHeading(trimmed string) bool {
	text, ok := markdownHeadingText(trimmed)
	return ok && strings.EqualFold(strings.TrimSpace(text), "Machine Summary")
}

func skipMarkdownSection(lines []string, start int) int {
	startLevel, ok := markdownHeadingLevel(strings.TrimSpace(lines[start]))
	if !ok {
		return start + 1
	}

	i := start + 1
	for i < len(lines) {
		trimmed := strings.TrimSpace(lines[i])
		if level, ok := markdownHeadingLevel(trimmed); ok && level <= startLevel {
			break
		}
		i++
	}
	return i
}

func (m ViewerModel) contentInset() int {
	return 2
}

func (m ViewerModel) contentPrefix() string {
	return strings.Repeat(" ", m.contentInset())
}

func (m ViewerModel) fullWidth() int {
	if m.width < 10 {
		return 10
	}
	return m.width
}

func (m ViewerModel) textWidth() int {
	w := m.width - m.contentInset()
	if w < 10 {
		return 10
	}
	return w
}

func (m ViewerModel) indentContent(content string) string {
	return m.contentPrefix() + content
}

func (m ViewerModel) renderContentLine(content string) string {
	line := m.indentContent(content)
	if m.inheritsContentBackground() {
		return inheritTerminalBackground(line)
	}
	return line
}

func inheritTerminalBackground(line string) string {
	return "\x1b[49m" + line + "\x1b[49m"
}

func (m ViewerModel) inheritsContentBackground() bool {
	return m.isNextStepViewer() || m.isEvaluationViewer()
}

func isTableLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	return len(trimmed) > 1 && trimmed[0] == '|'
}

// isTableSeparator checks if a line is a table separator (|---|---|).
func isTableSeparator(line string) bool {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "|") {
		return false
	}
	cleaned := strings.NewReplacer("|", "", "-", "", ":", "", " ", "").Replace(trimmed)
	return cleaned == ""
}

// parseTableCells splits a table line into trimmed cells.
func parseTableCells(line string) []string {
	trimmed := strings.TrimSpace(line)
	// Remove leading and trailing pipes
	if len(trimmed) > 0 && trimmed[0] == '|' {
		trimmed = trimmed[1:]
	}
	if len(trimmed) > 0 && trimmed[len(trimmed)-1] == '|' {
		trimmed = trimmed[:len(trimmed)-1]
	}
	parts := strings.Split(trimmed, "|")
	cells := make([]string, len(parts))
	for i, p := range parts {
		cells[i] = strings.TrimSpace(p)
	}
	return cells
}

func detectAlignment(sep string) lipgloss.Position {
	s := strings.TrimSpace(sep)
	if strings.HasPrefix(s, ":") && strings.HasSuffix(s, ":") {
		return lipgloss.Center
	}
	if strings.HasSuffix(s, ":") {
		return lipgloss.Right
	}
	return lipgloss.Left
}

func (m ViewerModel) renderTableBlock(lines []string) []string {
	if len(lines) == 0 {
		return nil
	}

	var headers []string
	var rawHeaders []string
	var dataRows [][]string
	var alignments []lipgloss.Position

	for _, line := range lines {
		if isTableSeparator(line) {
			if len(alignments) == 0 {
				for _, cell := range parseTableCells(line) {
					alignments = append(alignments, detectAlignment(cell))
				}
			}
			continue
		}
		cells := parseTableCells(line)
		if headers != nil && m.shouldHideTableRow(rawHeaders, cells) {
			continue
		}
		rendered := make([]string, len(cells))
		for i, c := range cells {
			if headers != nil && i == 0 && tableHasFieldHeader(rawHeaders) {
				c = boldTableLabel(c)
			}
			rendered[i] = m.renderInlineElements(c)
		}
		if headers == nil {
			rawHeaders = cells
			headers = rendered
		} else {
			dataRows = append(dataRows, rendered)
		}
	}

	if len(headers) == 0 {
		var result []string
		for _, line := range lines {
			result = append(result, m.styleLine(line))
		}
		return result
	}

	w := m.textWidth()

	borderStyle := lipgloss.NewStyle().Foreground(m.theme.Overlay)
	t := table.New().
		Width(w).
		Wrap(true).
		BorderStyle(borderStyle).
		BorderTop(true).BorderBottom(true).
		BorderLeft(true).BorderRight(true).
		BorderHeader(true).BorderColumn(true)

	t.Headers(headers...)
	if len(dataRows) > 0 {
		t.Rows(dataRows...)
	}

	t.StyleFunc(func(row, col int) lipgloss.Style {
		st := lipgloss.NewStyle().Padding(0, 1)
		if row == table.HeaderRow {
			return st.Bold(true).Foreground(m.theme.Sky)
		}
		if col < len(alignments) {
			st = st.Align(alignments[col])
		}
		return st.Foreground(m.theme.Text)
	})

	rendered := strings.Split(t.String(), "\n")
	for i, line := range rendered {
		rendered[i] = m.indentContent(line)
	}
	return rendered
}

func (m ViewerModel) shouldHideTableRow(headers, cells []string) bool {
	if !m.isDetailsViewer() || !tableHasFieldHeader(headers) || len(cells) == 0 {
		return false
	}
	return normalizeDetailsLabel(cells[0]) == "tl;dr"
}

func tableHasFieldHeader(headers []string) bool {
	return len(headers) > 0 && normalizeDetailsLabel(headers[0]) == "field"
}

func boldTableLabel(cell string) string {
	cell = strings.TrimSpace(cell)
	if cell == "" || reBoldOnly.MatchString(cell) {
		return cell
	}
	return "**" + cell + "**"
}

var (
	reBold           = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	reBoldOnly       = regexp.MustCompile(`^\*\*([^*]+)\*\*$`)
	reLink           = regexp.MustCompile(`\[([^\]]+)\]\(([^)]+)\)`)
	reBareURL        = regexp.MustCompile(`https?://\S*[^\s\)\]\.,;:!?]`)
	reInlineCode     = regexp.MustCompile("`([^`]+)`")
	reListNumber     = regexp.MustCompile(`^(\s*\d+\.\s+)(.*)$`)
	reCoverLetterPDF = regexp.MustCompile(`PDF generated:\s*(output/[^\s]+\.pdf)`)
	reRelPDFPath     = regexp.MustCompile(`output/cv-[^\s\)\]\.,;:!?"']+\.pdf`)
)

func isHeadingLine(line string) bool {
	return strings.HasPrefix(line, "# ") ||
		strings.HasPrefix(line, "## ") ||
		strings.HasPrefix(line, "### ") ||
		strings.HasPrefix(line, "#### ") ||
		strings.HasPrefix(line, "##### ") ||
		strings.HasPrefix(line, "###### ")
}

func isSpecialBlockLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	return isHeadingLine(trimmed) ||
		isMarkdownRule(trimmed) ||
		strings.HasPrefix(trimmed, "> ") ||
		strings.HasPrefix(trimmed, "|") ||
		strings.HasPrefix(trimmed, "```") ||
		strings.HasPrefix(trimmed, "- ") ||
		strings.HasPrefix(trimmed, "* ") ||
		reListNumber.MatchString(trimmed) ||
		reBoldOnly.MatchString(trimmed) ||
		(strings.HasPrefix(trimmed, "**") && strings.Contains(trimmed, ":**"))
}

func isMarkdownRule(trimmed string) bool {
	return trimmed == "---" || trimmed == "***"
}

func (m ViewerModel) detailsRuleStartsRegion(index int) bool {
	for i := index + 1; i < len(m.lines); i++ {
		trimmed := strings.TrimSpace(m.lines[i])
		if trimmed == "" {
			continue
		}
		text, ok := markdownHeadingText(trimmed)
		return ok && isDetailsRegionHeading(text)
	}
	return false
}

func (m ViewerModel) wrapParagraph(text string, width int) []string {
	if width <= 0 {
		return []string{text}
	}
	wrapped := ansi.Wrap(text, width, "")
	return strings.Split(wrapped, "\n")
}

func (m ViewerModel) renderInlineElements(line string) string {
	return m.renderInlineElementsAs(line, m.theme.Subtext)
}

// renderInlineElementsAs walks the raw line once and reapplies baseColor around
// every plain-text span, so resets emitted by inline tokens (code, bold, link,
// bare URL) don't leak through to subsequent text.
func (m ViewerModel) renderInlineElementsAs(line string, baseColor lipgloss.Color) string {
	baseStyle := lipgloss.NewStyle().Foreground(baseColor)
	codeStyle := lipgloss.NewStyle().Foreground(m.theme.Text)
	if !m.inheritsContentBackground() {
		codeStyle = codeStyle.Background(m.theme.Panel)
	}
	boldStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Yellow)
	linkStyle := lipgloss.NewStyle().Foreground(m.theme.Blue)

	var b strings.Builder
	rest := line
	for rest != "" {
		match := findInlineMatch(rest, codeStyle, boldStyle, linkStyle, m.linkBaseDir, m.careerOpsPath)
		if match == nil {
			b.WriteString(baseStyle.Render(rest))
			break
		}
		if match.start > 0 {
			b.WriteString(baseStyle.Render(rest[:match.start]))
		}
		b.WriteString(match.rendered)
		rest = rest[match.end:]
	}
	return b.String()
}

type inlineMatch struct {
	start, end int
	rendered   string
}

func findInlineMatch(s string, codeStyle, boldStyle, linkStyle lipgloss.Style, linkBaseDir, careerOpsPath string) *inlineMatch {
	var best *inlineMatch
	consider := func(loc []int, rendered func() string) {
		if loc == nil || (best != nil && loc[0] >= best.start) {
			return
		}
		best = &inlineMatch{start: loc[0], end: loc[1], rendered: rendered()}
	}

	if loc := reInlineCode.FindStringIndex(s); loc != nil {
		consider(loc, func() string { return codeStyle.Render(s[loc[0]+1 : loc[1]-1]) })
	}
	if loc := reBold.FindStringIndex(s); loc != nil {
		consider(loc, func() string { return boldStyle.Render(s[loc[0]+2 : loc[1]-2]) })
	}
	if loc := reLink.FindStringIndex(s); loc != nil {
		consider(loc, func() string {
			sm := reLink.FindStringSubmatch(s[loc[0]:loc[1]])
			if len(sm) >= 3 {
				return renderOSC8Link(linkStyle.Render(sm[1]), resolveHyperlinkTarget(sm[2], linkBaseDir, careerOpsPath))
			}
			return s[loc[0]:loc[1]]
		})
	}
	if loc := reBareURL.FindStringIndex(s); loc != nil {
		consider(loc, func() string {
			target := s[loc[0]:loc[1]]
			return renderOSC8Link(linkStyle.Render(target), target)
		})
	}
	if loc := reRelPDFPath.FindStringIndex(s); loc != nil {
		consider(loc, func() string {
			relPath := s[loc[0]:loc[1]]
			return renderOSC8Link(linkStyle.Render(relPath), resolveHyperlinkTarget(relPath, careerOpsPath, careerOpsPath))
		})
	}
	return best
}

func renderOSC8Link(label, target string) string {
	if target == "" || strings.ContainsAny(target, "\x00\x07\x1b\r\n") {
		return label
	}
	// OSC 8 hyperlink: ESC ] 8 ; ; URL BEL text ESC ] 8 ; ; BEL
	return "\x1b]8;;" + target + "\x07" + label + "\x1b]8;;\x07"
}

func resolveHyperlinkTarget(target, baseDir, careerOpsPath string) string {
	target = strings.TrimSpace(strings.Trim(target, "<>"))
	if target == "" || strings.HasPrefix(target, "#") || strings.ContainsAny(target, "\x00\x07\x1b\r\n") {
		return ""
	}
	for _, scheme := range []string{"https://", "http://", "mailto:"} {
		if strings.HasPrefix(strings.ToLower(target), scheme) {
			return target
		}
	}
	if strings.HasPrefix(strings.ToLower(target), "file://") {
		absPath, ok := resolveLocalHyperlinkPath(target[len("file://"):], careerOpsPath, careerOpsPath)
		if !ok {
			return ""
		}
		forward := filepath.ToSlash(absPath)
		if !strings.HasPrefix(forward, "/") {
			forward = "/" + forward
		}
		return "file://" + forward
	}
	if strings.HasPrefix(strings.ToLower(target), "repo:") {
		baseDir = careerOpsPath
		target = strings.TrimSpace(target[len("repo:"):])
	}
	absPath, ok := resolveLocalHyperlinkPath(target, baseDir, careerOpsPath)
	if !ok {
		return ""
	}
	forward := filepath.ToSlash(absPath)
	if !strings.HasPrefix(forward, "/") {
		forward = "/" + forward // Windows: C:/... → /C:/...
	}
	return "file://" + forward
}

func resolveLocalHyperlinkPath(target, baseDir, careerOpsPath string) (string, bool) {
	target = strings.TrimSpace(strings.Trim(target, "<>"))
	if target == "" || strings.Contains(target, "://") || strings.HasPrefix(target, "mailto:") || strings.ContainsAny(target, "\x00\x07\x1b\r\n") {
		return "", false
	}
	if baseDir == "" {
		baseDir = careerOpsPath
	}
	if baseDir == "" {
		return "", false
	}
	absPath := filepath.FromSlash(target)
	if !filepath.IsAbs(absPath) {
		absPath = filepath.Join(baseDir, absPath)
	}
	absPath, err := filepath.Abs(absPath)
	if err != nil {
		return "", false
	}
	if careerOpsPath != "" {
		root, rootErr := filepath.Abs(careerOpsPath)
		rel, relErr := filepath.Rel(root, absPath)
		if rootErr != nil || relErr != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return "", false
		}
	}
	if _, err := os.Stat(absPath); err != nil {
		return "", false
	}
	return absPath, true
}

func (m ViewerModel) styleLine(line string) string {
	trimmed := strings.TrimSpace(line)

	if level, ok := markdownHeadingLevel(trimmed); ok {
		content, _ := markdownHeadingText(trimmed)
		return m.renderMarkdownHeading(level, content)
	}
	if isMarkdownRule(trimmed) {
		w := m.fullWidth()
		return lipgloss.NewStyle().Foreground(m.theme.Overlay).Width(w).Render(strings.Repeat("─", w))
	}
	if strings.HasPrefix(trimmed, "> ") {
		content := strings.TrimPrefix(trimmed, "> ")
		w := m.textWidth()
		border := lipgloss.NewStyle().Foreground(m.theme.Overlay).Render("▎ ")
		textStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext).Italic(true)
		wrapped := strings.Split(ansi.Wrap(textStyle.Render(content), w-2, ""), "\n")
		result := make([]string, 0, len(wrapped))
		for i, line := range wrapped {
			if i == 0 {
				result = append(result, m.indentContent(border+line))
			} else {
				result = append(result, m.indentContent(strings.Repeat(" ", ansi.StringWidth(border))+line))
			}
		}
		return strings.Join(result, "\n")
	}
	if key, value, ok := splitMetadataLine(trimmed); ok {
		return m.renderMetadataLine(key, value)
	}
	if sm := reBoldOnly.FindStringSubmatch(trimmed); len(sm) == 2 {
		return m.renderQuestionHeading(sm[1])
	}
	if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") {
		content := trimmed[2:]
		marker := lipgloss.NewStyle().Foreground(m.theme.Blue).Render("• ")
		return m.renderListItem(marker, content)
	}
	if reListNumber.MatchString(trimmed) {
		sm := reListNumber.FindStringSubmatch(trimmed)
		if len(sm) >= 3 {
			marker := lipgloss.NewStyle().Foreground(m.theme.Blue).Render(sm[1])
			return m.renderListItem(marker, sm[2])
		}
	}

	styled := m.renderInlineElementsAs(trimmed, m.theme.Subtext)
	wrapped := strings.Split(ansi.Wrap(styled, m.textWidth(), ""), "\n")
	for i, line := range wrapped {
		wrapped[i] = m.renderContentLine(line)
	}
	return strings.Join(wrapped, "\n")
}

func (m ViewerModel) renderMarkdownHeading(level int, content string) string {
	if m.isDetailsViewer() {
		if isDetailsRegionHeading(content) {
			return m.renderSectionHeading(content, m.theme.Mauve)
		}
		return m.renderDetailsChildHeading(content, level)
	}

	switch level {
	case 1:
		return m.renderSectionHeading(content, m.theme.Blue)
	case 2:
		return m.renderSectionHeading(content, m.theme.Mauve)
	case 3:
		return m.renderSectionHeading(content, m.theme.Sky)
	case 4:
		return m.renderHeadingRow(content, m.theme.Subtext, false)
	default:
		return m.renderHeadingRow(content, m.theme.Overlay, false)
	}
}

func isDetailsRegionHeading(content string) bool {
	content = strings.TrimSpace(content)
	return strings.EqualFold(content, "Next Step") ||
		strings.EqualFold(content, "Current Next Step") ||
		strings.EqualFold(content, "Deep Dive")
}

func (m ViewerModel) renderDetailsChildHeading(content string, level int) string {
	color := m.theme.Sky
	if level <= 2 {
		color = m.theme.Mauve
	}
	if level >= 4 {
		color = m.theme.Subtext
	}

	label := strings.ToUpper(strings.TrimSpace(content))
	labelWidth := m.textWidth() - 2
	if labelWidth < 10 {
		labelWidth = 10
	}
	wrapped := strings.Split(ansi.Wrap(label, labelWidth, ""), "\n")

	markerStyle := lipgloss.NewStyle().Foreground(color)
	labelStyle := lipgloss.NewStyle().Bold(true).Foreground(color)
	rows := make([]string, 0, len(wrapped))
	for i, row := range wrapped {
		marker := markerStyle.Render("│ ")
		if i > 0 {
			marker = markerStyle.Render("  ")
		}
		rows = append(rows, m.renderContentLine(marker+labelStyle.Render(row)))
	}
	return strings.Join(rows, "\n")
}

func splitMetadataLine(trimmed string) (string, string, bool) {
	if !strings.HasPrefix(trimmed, "**") {
		return "", "", false
	}
	idx := strings.Index(trimmed, ":**")
	if idx < 2 {
		return "", "", false
	}
	return trimmed[2:idx], strings.TrimSpace(trimmed[idx+3:]), true
}

func (m ViewerModel) renderSectionHeading(content string, color lipgloss.Color) string {
	return m.renderHeadingRow(strings.ToUpper(content), color, false)
}

func (m ViewerModel) renderHeadingRow(content string, color lipgloss.Color, rightAligned bool) string {
	if rightAligned {
		return m.renderTitleRowRight(content, "", color)
	}
	return m.renderTitleRow(content, color)
}

func (m ViewerModel) renderTitleRow(content string, color lipgloss.Color) string {
	return m.renderTitleRowRight(content, "", color)
}

func (m ViewerModel) renderTitleRowRight(content, rightText string, color lipgloss.Color) string {
	surface := lipgloss.NewStyle().Background(m.theme.Surface)
	leftStyle := lipgloss.NewStyle().Bold(true).Foreground(color).Background(m.theme.Surface)
	rightStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext).Background(m.theme.Surface)

	width := m.fullWidth()
	contentWidth := width - m.contentInset()
	if contentWidth < 1 {
		contentWidth = 1
	}
	leftWidth := contentWidth
	if rightText != "" {
		leftWidth = contentWidth - lipgloss.Width(rightText) - 1
	}
	if leftWidth < 1 {
		leftWidth = 1
		rightText = ""
	}

	leftText := ansi.Truncate(content, leftWidth, "")
	right := rightStyle.Render(rightText)
	gap := contentWidth - lipgloss.Width(leftText) - lipgloss.Width(rightText)
	if rightText != "" && gap < 1 {
		gap = 1
	}
	if rightText == "" && gap < 0 {
		gap = 0
	}

	line := surface.Render(m.contentPrefix()) +
		leftStyle.Render(leftText) +
		surface.Render(strings.Repeat(" ", gap)) +
		right
	if fill := width - lipgloss.Width(line); fill > 0 {
		line += surface.Render(strings.Repeat(" ", fill))
	}
	return line
}

func (m ViewerModel) blankTitleRow() string {
	return ""
}

func (m ViewerModel) renderMetadataLine(key, value string) string {
	raw := key + ": " + value
	wrapped := strings.Split(ansi.Wrap(raw, m.textWidth(), ""), "\n")

	if m.inheritsContentBackground() {
		keyStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Yellow)
		valueStyle := lipgloss.NewStyle().Foreground(m.theme.Text)

		rows := make([]string, 0, len(wrapped))
		for i, row := range wrapped {
			content := valueStyle.Render(row)
			prefix := key + ": "
			if i == 0 && strings.HasPrefix(row, prefix) {
				content = keyStyle.Render(prefix) + valueStyle.Render(strings.TrimPrefix(row, prefix))
			}
			rows = append(rows, m.renderContentLine(content))
		}
		return strings.Join(rows, "\n")
	}

	panelStyle := lipgloss.NewStyle().Background(m.theme.Panel).Foreground(m.theme.Text).Width(m.fullWidth())
	keyStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Yellow).Background(m.theme.Panel)
	valueStyle := lipgloss.NewStyle().Foreground(m.theme.Text).Background(m.theme.Panel)

	rows := make([]string, 0, len(wrapped))
	for i, row := range wrapped {
		content := valueStyle.Render(row)
		prefix := key + ": "
		if i == 0 && strings.HasPrefix(row, prefix) {
			content = keyStyle.Render(prefix) + valueStyle.Render(strings.TrimPrefix(row, prefix))
		}
		rows = append(rows, panelStyle.Render(m.contentPrefix()+content))
	}
	return strings.Join(rows, "\n")
}

func (m ViewerModel) renderQuestionHeading(content string) string {
	if m.inheritsContentBackground() {
		style := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Yellow)
		wrapped := strings.Split(ansi.Wrap(style.Render(content), m.textWidth(), ""), "\n")
		for i, line := range wrapped {
			wrapped[i] = m.renderContentLine(line)
		}
		return strings.Join(wrapped, "\n")
	}
	return m.renderHeadingRow(content, m.theme.Yellow, false)
}

func (m ViewerModel) renderListItem(marker, content string) string {
	markerWidth := ansi.StringWidth(marker)
	textWidth := m.textWidth() - markerWidth
	if textWidth < 10 {
		textWidth = 10
	}
	styled := m.renderInlineElementsAs(content, m.theme.Text)
	lines := strings.Split(ansi.Wrap(styled, textWidth, ""), "\n")
	result := make([]string, 0, len(lines))
	for i, line := range lines {
		if i == 0 {
			result = append(result, m.renderContentLine(marker+line))
		} else {
			result = append(result, m.renderContentLine(strings.Repeat(" ", markerWidth)+line))
		}
	}
	return strings.Join(result, "\n")
}

func (m ViewerModel) renderFooter() string {
	style := lipgloss.NewStyle().
		Foreground(m.theme.Subtext).
		Background(m.theme.Surface).
		Width(m.width).
		Padding(0, 1)

	keyStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text).Background(m.theme.Surface)
	descStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext).Background(m.theme.Surface)

	if m.statusPicker {
		return style.Render(
			keyStyle.Render("↑/↓/j/k") + descStyle.Render(" select  ") +
				keyStyle.Render("Enter") + descStyle.Render(" confirm  ") +
				keyStyle.Render("Esc/q") + descStyle.Render(" cancel"))
	}

	segments := m.footerSegments(keyStyle, descStyle, false)
	separator := descStyle.Render("  ")
	footer := strings.Join(segments, separator)
	budget := m.width - 2
	if budget < 1 {
		budget = 1
	}
	if lipgloss.Width(footer) > budget {
		footer = strings.Join(m.footerSegments(keyStyle, descStyle, true), separator)
	}
	if lipgloss.Width(footer) > budget {
		footer = ansi.Truncate(footer, budget, "")
	}

	return style.Render(footer)
}

func (m ViewerModel) footerSegments(keyStyle, descStyle lipgloss.Style, compact bool) []string {
	segments := []string{
		keyStyle.Render("jk") + descStyle.Render(" scroll"),
	}
	if !compact {
		segments = append(segments,
			keyStyle.Render("^D/^U")+descStyle.Render(" half"),
			keyStyle.Render("Space/b")+descStyle.Render(" page"),
			keyStyle.Render("g/G")+descStyle.Render(" top/end"),
		)
	}
	if m.app.JobURL != "" {
		segments = append(segments, keyStyle.Render("o")+descStyle.Render(" URL"))
	}
	if m.cvPDFPath != "" {
		segments = append(segments, keyStyle.Render("d")+descStyle.Render(" PDF"))
	}
	if m.app.IsTrackedApplication() {
		segments = append(segments, keyStyle.Render("c")+descStyle.Render(" status"))
	}
	if m.coverLetterPath != "" {
		segments = append(segments, keyStyle.Render("L")+descStyle.Render(" cover letter"))
	}
	segments = append(segments, keyStyle.Render("Esc")+descStyle.Render(" back"))
	return segments
}

func (m ViewerModel) handleStatusPicker(msg tea.KeyMsg) (ViewerModel, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		m.statusPicker = false
		m.clampScrollOffset()
		return m, nil

	case "down", "j":
		m.statusCursor++
		if m.statusCursor >= len(statusOptions) {
			m.statusCursor = len(statusOptions) - 1
		}

	case "up", "k":
		m.statusCursor--
		if m.statusCursor < 0 {
			m.statusCursor = 0
		}

	case "enter":
		m.statusPicker = false
		m.clampScrollOffset()
		newStatus := statusOptions[m.statusCursor]
		return m, func() tea.Msg {
			return ViewerUpdateStatusMsg{
				App:       m.app,
				NewStatus: newStatus,
			}
		}
	}
	return m, nil
}

func (m ViewerModel) overlayStatusPicker(body string) string {
	bodyLines := strings.Split(body, "\n")

	pickerWidth := 30
	padStyle := lipgloss.NewStyle().Padding(0, 2)
	borderStyle := lipgloss.NewStyle().
		Foreground(m.theme.Blue).
		Bold(true)

	var picker []string
	picker = append(picker, padStyle.Render(borderStyle.Render("Change status:")))

	for i, opt := range statusOptions {
		style := lipgloss.NewStyle().Foreground(m.theme.Text).Width(pickerWidth)
		if i == m.statusCursor {
			style = style.Background(m.theme.Selection).Bold(true)
		}
		prefix := "  "
		if i == m.statusCursor {
			prefix = "> "
		}
		picker = append(picker, padStyle.Render(style.Render(prefix+opt)))
	}

	bodyLines = append(bodyLines, picker...)
	return strings.Join(bodyLines, "\n")
}

// UpdateAppStatus updates the status of the current application inside the viewer model.
func (m *ViewerModel) UpdateAppStatus(newStatus string) {
	m.app.Status = newStatus
}

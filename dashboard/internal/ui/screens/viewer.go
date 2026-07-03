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
	App       model.CareerApplication
	NewStatus string
}

// ViewerModel implements an integrated file viewer screen.
type ViewerModel struct {
	lines           []string
	renderedLines   []string
	title           string
	scrollOffset    int
	width           int
	height          int
	theme           theme.Theme
	app             model.CareerApplication
	careerOpsPath   string
	coverLetterPath string
	statusPicker    bool
	statusCursor    int
}

// NewViewerModel creates a new file viewer for the given path.
func NewViewerModel(t theme.Theme, careerOpsPath, path, title string, width, height int, app model.CareerApplication) ViewerModel {
	content, err := os.ReadFile(path)
	if err != nil {
		content = []byte("Error reading file: " + err.Error())
	}

	var lines []string
	if len(content) > 0 {
		lines = strings.Split(string(content), "\n")
	}

	m := ViewerModel{
		lines:           lines,
		title:           title,
		width:           width,
		height:          height,
		theme:           t,
		app:             app,
		careerOpsPath:   careerOpsPath,
		coverLetterPath: parseCoverLetterPath(lines, careerOpsPath),
	}
	m.rebuildRender()
	return m
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

func (m ViewerModel) isEvaluationViewer() bool {
	return strings.HasPrefix(m.title, "EVALUATION: ")
}

func isEvaluationHeading(trimmed string) bool {
	text, ok := markdownHeadingText(trimmed)
	return ok && strings.HasPrefix(strings.ToUpper(text), "EVALUATION:")
}

func markdownHeadingText(trimmed string) (string, bool) {
	for _, prefix := range []string{"###### ", "##### ", "#### ", "### ", "## ", "# "} {
		if strings.HasPrefix(trimmed, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(trimmed, prefix)), true
		}
	}
	return "", false
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
	if m.isNextStepViewer() {
		return inheritTerminalBackground(line)
	}
	return line
}

func inheritTerminalBackground(line string) string {
	return "\x1b[49m" + line + "\x1b[49m\x1b[K"
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
		rendered := make([]string, len(cells))
		for i, c := range cells {
			rendered[i] = m.renderInlineElements(c)
		}
		if headers == nil {
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
		trimmed == "---" || trimmed == "***" ||
		strings.HasPrefix(trimmed, "> ") ||
		strings.HasPrefix(trimmed, "|") ||
		strings.HasPrefix(trimmed, "```") ||
		strings.HasPrefix(trimmed, "- ") ||
		strings.HasPrefix(trimmed, "* ") ||
		reListNumber.MatchString(trimmed) ||
		reBoldOnly.MatchString(trimmed) ||
		(strings.HasPrefix(trimmed, "**") && strings.Contains(trimmed, ":**"))
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
	codeStyle := lipgloss.NewStyle().Background(m.theme.Panel).Foreground(m.theme.Text)
	boldStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Yellow)
	linkStyle := lipgloss.NewStyle().Foreground(m.theme.Blue)

	var b strings.Builder
	rest := line
	for rest != "" {
		match := findInlineMatch(rest, codeStyle, boldStyle, linkStyle, m.careerOpsPath)
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

func findInlineMatch(s string, codeStyle, boldStyle, linkStyle lipgloss.Style, careerOpsPath string) *inlineMatch {
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
			if len(sm) >= 2 {
				return linkStyle.Render(sm[1])
			}
			return s[loc[0]:loc[1]]
		})
	}
	if loc := reBareURL.FindStringIndex(s); loc != nil {
		consider(loc, func() string { return linkStyle.Render(s[loc[0]:loc[1]]) })
	}
	if loc := reRelPDFPath.FindStringIndex(s); loc != nil {
		consider(loc, func() string {
			relPath := s[loc[0]:loc[1]]
			styled := linkStyle.Render(relPath)
			if careerOpsPath == "" {
				return styled
			}
			joined := filepath.Join(careerOpsPath, filepath.FromSlash(relPath))
			absPath, err := filepath.Abs(joined)
			if err != nil {
				return styled
			}
			forward := filepath.ToSlash(absPath)
			if !strings.HasPrefix(forward, "/") {
				forward = "/" + forward // Windows: C:/... → /C:/...
			}
			// OSC 8 hyperlink: ESC ] 8 ; ; URL BEL text ESC ] 8 ; ; BEL
			return "\x1b]8;;" + "file://" + forward + "\x07" + styled + "\x1b]8;;\x07"
		})
	}
	return best
}

func (m ViewerModel) styleLine(line string) string {
	trimmed := strings.TrimSpace(line)

	if strings.HasPrefix(trimmed, "# ") && !strings.HasPrefix(trimmed, "## ") {
		content := strings.TrimPrefix(trimmed, "# ")
		return m.renderSectionHeading(content, m.theme.Blue)
	}
	if strings.HasPrefix(trimmed, "## ") && !strings.HasPrefix(trimmed, "### ") {
		content := strings.TrimPrefix(trimmed, "## ")
		return m.renderSectionHeading(content, m.theme.Mauve)
	}
	if strings.HasPrefix(trimmed, "### ") && !strings.HasPrefix(trimmed, "#### ") {
		content := strings.TrimPrefix(trimmed, "### ")
		return m.renderSectionHeading(content, m.theme.Sky)
	}
	if strings.HasPrefix(trimmed, "#### ") && !strings.HasPrefix(trimmed, "##### ") {
		content := strings.TrimPrefix(trimmed, "#### ")
		return m.renderHeadingRow(content, m.theme.Subtext, false)
	}
	if strings.HasPrefix(trimmed, "##### ") && !strings.HasPrefix(trimmed, "###### ") {
		content := strings.TrimPrefix(trimmed, "##### ")
		return m.renderHeadingRow(content, m.theme.Overlay, false)
	}
	if strings.HasPrefix(trimmed, "###### ") {
		content := strings.TrimPrefix(trimmed, "###### ")
		return m.renderHeadingRow(content, m.theme.Overlay, false)
	}
	if trimmed == "---" || trimmed == "***" {
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

	if m.isNextStepViewer() {
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
	if m.isNextStepViewer() {
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

	footer := keyStyle.Render("jk") + descStyle.Render(" scroll  ") +
		keyStyle.Render("^D/^U") + descStyle.Render(" half  ") +
		keyStyle.Render("Space/b") + descStyle.Render(" page  ") +
		keyStyle.Render("g/G") + descStyle.Render(" top/end  ") +
		keyStyle.Render("c") + descStyle.Render(" status  ") +
		keyStyle.Render("Esc") + descStyle.Render(" back")

	if m.coverLetterPath != "" {
		footer += "  " + keyStyle.Render("L") + descStyle.Render(" cover letter")
	}

	return style.Render(footer)
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

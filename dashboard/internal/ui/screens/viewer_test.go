package screens

import (
	"io"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/muesli/termenv"

	"github.com/santifer/career-ops/dashboard/internal/theme"
)

func TestViewerRebuildRenderClampsScrollOffset(t *testing.T) {
	m := ViewerModel{
		lines:        []string{"short"},
		scrollOffset: 20,
		width:        80,
		height:       20,
		theme:        theme.NewTheme("catppuccin-mocha"),
	}

	m.rebuildRender()

	maxScroll := len(m.renderedLines) - m.bodyHeight()
	if maxScroll < 0 {
		maxScroll = 0
	}
	if m.scrollOffset > maxScroll {
		t.Fatalf("expected scrollOffset <= %d after rebuild, got %d", maxScroll, m.scrollOffset)
	}
}

func TestRenderInlineElementsLeavesTrailingPunctuationUnstyled(t *testing.T) {
	match := reBareURL.FindString("Visit https://example.com.")

	if match != "https://example.com" {
		t.Fatalf("expected URL match without trailing period, got %q", match)
	}
}

func TestViewerWrapsFencedCodeLines(t *testing.T) {
	m := ViewerModel{
		lines: []string{
			"```",
			strings.Repeat("x", 40),
			"```",
		},
		width:  20,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	rendered := m.renderAll()
	maxWidth := m.width

	if len(rendered) < 2 {
		t.Fatalf("expected fenced code to wrap into multiple lines, got %d", len(rendered))
	}
	for _, line := range rendered {
		if width := ansi.StringWidth(line); width > maxWidth {
			t.Fatalf("expected fenced code line width <= %d, got %d for %q", maxWidth, width, ansi.Strip(line))
		}
		if plain := ansi.Strip(line); !strings.HasPrefix(plain, "  ") {
			t.Fatalf("expected wrapped code line to keep content inset, got %q", plain)
		}
	}
}

func TestViewerFencedCodeHighlightSpansFullVisualRow(t *testing.T) {
	useTrueColorRenderer(t)

	m := ViewerModel{
		lines: []string{
			"```text",
			"short",
			"```",
		},
		width:  40,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	rendered := m.renderAll()
	if len(rendered) != 1 {
		t.Fatalf("expected one rendered code line, got %d", len(rendered))
	}

	wantWidth := m.width
	if got := ansi.StringWidth(rendered[0]); got != wantWidth {
		t.Fatalf("expected highlighted code row width %d, got %d for %q", wantWidth, got, rendered[0])
	}
	if plain := ansi.Strip(rendered[0]); strings.TrimRight(plain, " ") != "  short" {
		t.Fatalf("expected code text plus styled row padding, got %q", plain)
	}

	if !strings.Contains(rendered[0], "48;2;") {
		t.Fatalf("expected code row to include surface background, got %q", rendered[0])
	}
}

func TestViewerHeaderBackgroundCoversStyledTitleAndScrollText(t *testing.T) {
	useTrueColorRenderer(t)

	m := ViewerModel{
		title:         "EVALUATION: n8n / Community Software Engineer / Remote / Europe",
		renderedLines: []string{"first", "second"},
		width:         80,
		height:        20,
		theme:         theme.NewTheme("catppuccin-mocha"),
	}

	header := m.renderHeader()
	lines := strings.Split(header, "\n")
	if len(lines) != m.headerHeight() {
		t.Fatalf("header height = %d, want %d: %q", len(lines), m.headerHeight(), header)
	}
	if lines[0] != "" || lines[2] != "" {
		t.Fatalf("expected blank header rows to inherit the page background, got %q", header)
	}
	if got := ansi.StringWidth(lines[1]); got != m.width {
		t.Fatalf("title row width = %d, want %d for %q", got, m.width, lines[1])
	}
	if count := strings.Count(header, "48;2;"); count < 4 {
		t.Fatalf("expected header background across title, gap, and scroll text, got %d spans in %q", count, header)
	}
	if plain := ansi.Strip(header); strings.Count(plain, "EVALUATION:") != 1 || !strings.Contains(plain, "Top") {
		t.Fatalf("expected one evaluation title line with scroll label, got %q", plain)
	}
}

func TestViewerSkipsDuplicateNextPackHeading(t *testing.T) {
	m := ViewerModel{
		lines: []string{
			"## Next: Acme -- Backend Engineer (#42)",
			"",
			"**Decision:** apply",
		},
		title:  "NEXT STEP: Send Application / Acme / Backend Engineer / Remote",
		width:  80,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	rendered := ansi.Strip(strings.Join(m.renderAll(), "\n"))
	if strings.Contains(rendered, "Next: Acme") {
		t.Fatalf("expected duplicate next-pack heading to be hidden, got %q", rendered)
	}
	if !strings.HasPrefix(strings.TrimLeft(rendered, " "), "Decision: apply") {
		t.Fatalf("expected body to start with the first useful line, got %q", rendered)
	}
}

func TestViewerSkipsDuplicateEvaluationHeading(t *testing.T) {
	m := ViewerModel{
		lines: []string{
			"# EVALUATION: N8N -- COMMUNITY SOFTWARE ENGINEER | REMOTE | EUROPE",
			"",
			"**Date:** 2026-06-26",
		},
		title:  "EVALUATION: n8n / Community Software Engineer / Remote / Europe",
		width:  80,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	rendered := ansi.Strip(strings.Join(m.renderAll(), "\n"))
	if strings.Contains(rendered, "EVALUATION: N8N") {
		t.Fatalf("expected duplicate evaluation heading to be hidden, got %q", rendered)
	}
	if !strings.HasPrefix(strings.TrimLeft(rendered, " "), "Date: 2026-06-26") {
		t.Fatalf("expected body to start with the first useful line, got %q", rendered)
	}
}

func TestViewerSectionHeadingsUseTitleInsetAndSpacing(t *testing.T) {
	m := ViewerModel{
		lines: []string{
			"Intro paragraph.",
			"",
			"## Apply Note",
			"",
			"  Use the generated application pack.",
		},
		title:  "NEXT STEP: Send Application / Acme / Backend Engineer / Remote",
		width:  48,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}
	m.rebuildRender()

	if len(m.renderedLines) == 0 {
		t.Fatal("expected next-step content to render")
	}
	plain := ansi.Strip(strings.Join(m.renderedLines, "\n"))
	lines := strings.Split(plain, "\n")
	headingIdx := -1
	for i, line := range lines {
		if strings.Contains(line, "APPLY NOTE") {
			headingIdx = i
			break
		}
	}
	if headingIdx < 1 || headingIdx+1 >= len(lines) {
		t.Fatalf("expected heading with surrounding lines, got %q", plain)
	}
	if lines[headingIdx-1] != "" || lines[headingIdx+1] != "" {
		t.Fatalf("expected one blank line around heading, got %q", plain)
	}
	if !strings.HasPrefix(lines[headingIdx], "  APPLY NOTE") {
		t.Fatalf("expected heading to use the title inset, got %q", lines[headingIdx])
	}
	if got := ansi.StringWidth(m.renderedLines[headingIdx]); got != m.width {
		t.Fatalf("next-step section heading width = %d, want %d", got, m.width)
	}
	if !strings.Contains(plain, "\n  Use the generated application pack.") {
		t.Fatalf("expected paragraph raw indentation to collapse to one content inset, got %q", plain)
	}
}

func TestViewerMetadataRowsRenderAsFullWidthBriefRows(t *testing.T) {
	useTrueColorRenderer(t)

	m := ViewerModel{
		width:  48,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	rendered := m.styleLine("**Next human action:** Build one small workflow, then submit the pack.")
	lines := strings.Split(rendered, "\n")
	if len(lines) < 2 {
		t.Fatalf("expected long metadata row to wrap inside the brief panel, got %q", rendered)
	}

	wantWidth := m.width
	for _, line := range lines {
		if got := ansi.StringWidth(line); got != wantWidth {
			t.Fatalf("metadata row width = %d, want %d for %q", got, wantWidth, line)
		}
		if !strings.Contains(line, "48;2;") {
			t.Fatalf("expected metadata row to carry panel background, got %q", line)
		}
	}
}

func TestNextStepMetadataRowsInheritBackground(t *testing.T) {
	useTrueColorRenderer(t)

	m := ViewerModel{
		title:  "NEXT STEP: Send Application / Acme / Backend Engineer / Remote",
		width:  48,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	rendered := m.styleLine("**Decision:** apply")
	if hasFillBackground(rendered) {
		t.Fatalf("expected next-step metadata row to inherit background, got %q", rendered)
	}
	if strings.Contains(rendered, "\x1b[K") {
		t.Fatalf("expected next-step metadata row not to fill the rest of the line, got %q", rendered)
	}
	if plain := ansi.Strip(rendered); plain != "  Decision: apply" {
		t.Fatalf("expected plain inset metadata text, got %q", plain)
	}
}

func TestNextStepFormQuestionsAndParagraphsInheritBackground(t *testing.T) {
	useTrueColorRenderer(t)

	m := ViewerModel{
		lines: []string{
			"## Likely Form Answers",
			"",
			"**Why n8n?**",
			"",
			"n8n sits close to the direction I am deliberately building toward with `workflow` proof.",
			"",
			"- Confirm the role remains software-heavy.",
		},
		title:  "NEXT STEP: Send Application / n8n / Community Software Engineer / Remote",
		width:  72,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	rendered := m.renderAll()
	if len(rendered) < 5 {
		t.Fatalf("expected section, spacer, question, spacer, paragraph; got %d lines: %q", len(rendered), rendered)
	}

	for _, line := range rendered {
		plain := ansi.Strip(line)
		switch {
		case strings.Contains(plain, "LIKELY FORM ANSWERS"):
			if !hasFillBackground(line) {
				t.Fatalf("expected section heading to keep title background, got %q", line)
			}
		case strings.Contains(plain, "Why n8n?"),
			strings.Contains(plain, "n8n sits close"),
			strings.Contains(plain, "Confirm the role"):
			if hasFillBackground(line) {
				t.Fatalf("expected next-step content line to inherit background, got %q", line)
			}
			if strings.Contains(line, "\x1b[K") {
				t.Fatalf("expected next-step content line not to fill the rest of the line, got %q", line)
			}
		}
	}
}

func TestNextStepFencedCodeInheritsBackground(t *testing.T) {
	useTrueColorRenderer(t)

	m := ViewerModel{
		lines: []string{
			"```text",
			"draft answer",
			"```",
		},
		title:  "NEXT STEP: Send Application / Acme / Backend Engineer / Remote",
		width:  48,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	rendered := m.renderAll()
	if len(rendered) != 1 {
		t.Fatalf("expected one rendered code line, got %d", len(rendered))
	}
	if hasFillBackground(rendered[0]) {
		t.Fatalf("expected next-step code block content to inherit background, got %q", rendered[0])
	}
	if plain := ansi.Strip(rendered[0]); plain != "  draft answer" {
		t.Fatalf("expected inset code block text, got %q", plain)
	}
}

func TestViewerTablesUseContentInset(t *testing.T) {
	m := ViewerModel{
		lines: []string{
			"| Field | Assessment |",
			"|---|---|",
			"| Remote setup | USA Remote; eligibility needs verification |",
		},
		width:  54,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	rendered := m.renderAll()
	if len(rendered) == 0 {
		t.Fatal("expected table to render")
	}
	for _, line := range rendered {
		plain := ansi.Strip(line)
		if !strings.HasPrefix(plain, "  ") {
			t.Fatalf("expected table line to start at content inset, got %q", plain)
		}
		if got := ansi.StringWidth(line); got != m.width {
			t.Fatalf("table line width = %d, want %d for %q", got, m.width, line)
		}
	}
}

func TestViewerBoldOnlyLinesRenderAsTitleRows(t *testing.T) {
	m := ViewerModel{
		width:  80,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	rendered := ansi.Strip(m.styleLine("**Why n8n?**"))
	if !strings.HasPrefix(rendered, "  Why n8n?") {
		t.Fatalf("expected bold-only prompt to use the title inset, got %q", rendered)
	}
	if got := ansi.StringWidth(m.styleLine("**Why n8n?**")); got != m.width {
		t.Fatalf("expected bold-only prompt row width %d, got %d", m.width, got)
	}
}

func TestViewerFooterBackgroundCoversHelpText(t *testing.T) {
	useTrueColorRenderer(t)

	m := ViewerModel{
		width:  100,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	footer := m.renderFooter()
	if got := ansi.StringWidth(footer); got != m.width {
		t.Fatalf("footer width = %d, want %d", got, m.width)
	}
	if count := strings.Count(footer, "48;2;"); count < 8 {
		t.Fatalf("expected footer background across styled help spans, got %d background spans in %q", count, footer)
	}
}

func TestViewerRendersInlineMarkdownBeforeParagraphWrapping(t *testing.T) {
	m := ViewerModel{
		lines: []string{
			"See [documentation](https://example.com/really-long-path) before continuing.",
		},
		width:  30,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	rendered := strings.Join(m.renderAll(), "\n")
	plain := ansi.Strip(rendered)

	if strings.Contains(plain, "[") || strings.Contains(plain, "](") {
		t.Fatalf("expected rendered paragraph to hide markdown link syntax, got %q", plain)
	}
	if !strings.Contains(plain, "documentation") {
		t.Fatalf("expected rendered paragraph to keep link text, got %q", plain)
	}
}

func TestViewerEmptyContentRendersPlaceholder(t *testing.T) {
	m := ViewerModel{
		lines:  nil,
		width:  40,
		height: 10,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}
	m.rebuildRender()

	if len(m.renderedLines) != 0 {
		t.Fatalf("expected zero rendered lines for empty content, got %d", len(m.renderedLines))
	}

	body := ansi.Strip(m.renderBody())
	if !strings.Contains(body, "(empty file)") {
		t.Fatalf("expected empty placeholder, got %q", body)
	}
}

func TestViewerSafePageKeysMirrorCtrlPageKeys(t *testing.T) {
	lines := make([]string, 30)
	for i := range lines {
		lines[i] = "- line"
	}
	m := ViewerModel{
		lines:  lines,
		width:  80,
		height: 10,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}
	m.rebuildRender()

	pageRows := m.bodyHeight()
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeySpace})
	if m.scrollOffset != pageRows {
		t.Fatalf("Space moved to offset %d, want %d", m.scrollOffset, pageRows)
	}

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'b'}})
	if m.scrollOffset != 0 {
		t.Fatalf("b should page back to the top, got offset %d", m.scrollOffset)
	}
}

func TestViewerInlineRenderingHandlesMixedTokens(t *testing.T) {
	m := ViewerModel{
		width:  60,
		height: 10,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	rendered := m.renderInlineElementsAs(
		"start `code` mid **bold** then [link](https://example.com) end https://bare.example.com.",
		m.theme.Subtext,
	)
	plain := ansi.Strip(rendered)

	for _, want := range []string{"start ", "code", " mid ", "bold", " then ", "link", " end ", "https://bare.example.com"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("expected plain output to contain %q, got %q", want, plain)
		}
	}
	for _, syntax := range []string{"`", "**", "[", "](", "](http"} {
		if strings.Contains(plain, syntax) {
			t.Fatalf("expected markdown syntax %q to be hidden, got %q", syntax, plain)
		}
	}
	if strings.HasSuffix(plain, ".") == false {
		t.Fatalf("expected trailing punctuation outside the bare URL, got %q", plain)
	}
}

func TestViewerIndentsWrappedBlockquoteLines(t *testing.T) {
	m := ViewerModel{
		width:  24,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	rendered := m.styleLine("> " + strings.Repeat("quoted ", 8))
	lines := strings.Split(ansi.Strip(rendered), "\n")

	if len(lines) < 2 {
		t.Fatalf("expected wrapped blockquote to render multiple lines, got %d", len(lines))
	}
	if !strings.HasPrefix(lines[0], "  ▎ ") {
		t.Fatalf("expected first blockquote line to keep border after content inset, got %q", lines[0])
	}
	if !strings.HasPrefix(lines[1], "    ") {
		t.Fatalf("expected wrapped blockquote continuation to align with text, got %q", lines[1])
	}
}

func useTrueColorRenderer(t *testing.T) {
	t.Helper()

	oldRenderer := lipgloss.DefaultRenderer()
	r := lipgloss.NewRenderer(io.Discard)
	r.SetColorProfile(termenv.TrueColor)
	lipgloss.SetDefaultRenderer(r)
	t.Cleanup(func() {
		lipgloss.SetDefaultRenderer(oldRenderer)
	})
}

func hasFillBackground(s string) bool {
	if strings.Contains(s, "\x1b[48;") {
		return true
	}
	for _, code := range []string{
		"\x1b[40m", "\x1b[41m", "\x1b[42m", "\x1b[43m",
		"\x1b[44m", "\x1b[45m", "\x1b[46m", "\x1b[47m",
		"\x1b[100m", "\x1b[101m", "\x1b[102m", "\x1b[103m",
		"\x1b[104m", "\x1b[105m", "\x1b[106m", "\x1b[107m",
	} {
		if strings.Contains(s, code) {
			return true
		}
	}
	return false
}

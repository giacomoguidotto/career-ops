package screens

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/muesli/termenv"

	"github.com/santifer/career-ops/dashboard/internal/model"
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

func TestDetailsViewerStartsWithDecisionSnapshot(t *testing.T) {
	report := strings.Join([]string{
		"# Evaluation: Acme -- Backend Engineer",
		"",
		"**Date:** 2026-07-09",
		"**Score:** 4.4/5",
		"**Legitimacy:** High Confidence",
		"",
		"---",
		"",
		"## Decision Snapshot",
		"",
		"**Decision:** Apply",
		"**Score:** 4.4/5",
		"**Next action:** Review the tailored CV and send the application.",
		"**Why it matters:** Strong backend fit with one compensation question.",
		"**Top strengths:** API design; production ownership",
		"**Risks to resolve:** Salary band is not stated.",
		"**Legitimacy:** High Confidence",
		"**Application asks:** None (standard form)",
		"",
		"## Machine Summary",
		"",
		"```yaml",
		"machine_only: true",
		"```",
		"",
		"## A) Role Summary",
		"",
		"| Field | Assessment |",
		"|---|---|",
		"| **TL;DR** | Legacy summary should not beat the snapshot. |",
		"",
		"## B) CV Match",
		"",
		"Strong backend fit.",
	}, "\n")

	m := ViewerModel{
		lines:  buildDetailsLines("", strings.Split(report, "\n"), model.CareerApplication{}),
		title:  "DETAILS: Acme / Backend Engineer",
		width:  80,
		height: 30,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	plain := ansi.Strip(strings.Join(m.renderAll(), "\n"))
	if first := firstNonBlankLine(plain); first != "Decision: Apply" {
		t.Fatalf("expected decision snapshot to be first, got %q in:\n%s", first, plain)
	}
	for _, want := range []string{
		"Score: 4.4/5",
		"Next action: Review the tailored CV",
		"DEEP DIVE",
		"A) ROLE SUMMARY",
	} {
		if !strings.Contains(plain, want) {
			t.Fatalf("expected details page to contain %q, got:\n%s", want, plain)
		}
	}
	for _, unwanted := range []string{"DECISION SNAPSHOT", "Machine Summary", "machine_only"} {
		if strings.Contains(plain, unwanted) {
			t.Fatalf("expected details page to drop %q, got:\n%s", unwanted, plain)
		}
	}
	for _, unwanted := range []string{"Date: 2026-07-09"} {
		if strings.Contains(plain, unwanted) {
			t.Fatalf("expected deep dive to hide duplicate report header field %q, got:\n%s", unwanted, plain)
		}
	}
}

func TestDetailsViewerSkipsTopTlDrThenNextStep(t *testing.T) {
	root := t.TempDir()
	reportPath := filepath.Join(root, "reports", "042-acme.md")
	nextPath := filepath.Join(root, "output", "next-packs", "042-acme.md")
	if err := os.MkdirAll(filepath.Dir(reportPath), 0o755); err != nil {
		t.Fatalf("mkdir report: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(nextPath), 0o755); err != nil {
		t.Fatalf("mkdir next pack: %v", err)
	}
	report := strings.Join([]string{
		"# Evaluation: Acme -- Backend Engineer",
		"",
		"## Machine Summary",
		"",
		"```yaml",
		"machine_only: true",
		"```",
		"",
		"## A) Role Summary",
		"",
		"| Field | Assessment |",
		"|---|---|",
		"| **TL;DR** | Useful summary should be first. |",
		"",
		"## B) CV Match",
		"",
		"Strong backend fit.",
	}, "\n")
	if err := os.WriteFile(reportPath, []byte(report), 0o644); err != nil {
		t.Fatalf("write report: %v", err)
	}
	next := strings.Join([]string{
		"## Next: Acme -- Backend Engineer (#42)",
		"",
		"**Next step:** Review the salary field, then submit.",
		"**Stage:** application_ready",
		"**Owner:** user",
		"**Suggests:** send_application",
		"**Score:** 4.2/5 | **Report:** reports/042-acme.md",
		"",
		"### Copy-Paste",
		"",
		"Hello Acme.",
	}, "\n")
	if err := os.WriteFile(nextPath, []byte(next), 0o644); err != nil {
		t.Fatalf("write next pack: %v", err)
	}

	m := NewViewerModel(
		theme.NewTheme("catppuccin-mocha"),
		root,
		reportPath,
		"DETAILS: Acme / Backend Engineer",
		80,
		30,
		model.CareerApplication{
			Company:      "Acme",
			Role:         "Backend Engineer",
			NextPackPath: "output/next-packs/042-acme.md",
		},
	)

	plain := ansi.Strip(strings.Join(m.renderAll(), "\n"))
	first := firstNonBlankLine(plain)
	if first != "NEXT STEP" {
		t.Fatalf("expected next step to be first visible detail, got %q in:\n%s", first, plain)
	}
	for _, want := range []string{
		"NEXT STEP",
		"Next step: Review the salary field, then",
		"submit.",
		"COPY-PASTE",
		"TL;DR: Useful summary should be first.",
		"A) ROLE SUMMARY",
	} {
		if !strings.Contains(plain, want) {
			t.Fatalf("expected details page to contain %q, got:\n%s", want, plain)
		}
	}
	tldrIndex := strings.Index(plain, "TL;DR: Useful summary should be first.")
	roleSummaryIndex := strings.Index(plain, "A) ROLE SUMMARY")
	if tldrIndex < 0 || roleSummaryIndex < 0 || tldrIndex > roleSummaryIndex {
		t.Fatalf("expected TL;DR before role summary, got:\n%s", plain)
	}
	if got := strings.Count(plain, "TL;DR"); got != 1 {
		t.Fatalf("expected TL;DR to appear once, got %d in:\n%s", got, plain)
	}
	if got := strings.Count(plain, "Next step:"); got != 1 {
		t.Fatalf("expected the authored next step exactly once, got %d in:\n%s", got, plain)
	}
	for _, unwanted := range []string{
		"Next: Acme",
		"Machine Summary",
		"machine_only",
		"Decision:",
		"Next human action:",
		"Pipeline stage:",
		"Performed by:",
		"Action type:",
		"Owner:",
		"Suggests:",
		"Score: 4.2/5",
	} {
		if strings.Contains(plain, unwanted) {
			t.Fatalf("expected details page to drop %q, got:\n%s", unwanted, plain)
		}
	}
}

func TestDetailsViewerCollapsesLegacyPackAuditMetadataIntoOneNextStep(t *testing.T) {
	root := t.TempDir()
	reportPath := filepath.Join(root, "reports", "263-jiga.md")
	nextPath := filepath.Join(root, "output", "next-packs", "247-jiga.md")
	if err := os.MkdirAll(filepath.Dir(reportPath), 0o755); err != nil {
		t.Fatalf("mkdir report: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(nextPath), 0o755); err != nil {
		t.Fatalf("mkdir next pack: %v", err)
	}
	if err := os.WriteFile(reportPath, []byte("# Evaluation: Jiga -- Product Engineer\n\n## A) Role Summary\n\nStrong fit.\n"), 0o644); err != nil {
		t.Fatalf("write report: %v", err)
	}
	next := strings.Join([]string{
		"## Next: Jiga -- Product Engineer (#247)",
		"",
		"**Stage:** application_ready",
		"**Owner:** user",
		"**Suggests:** send_application",
		"**Decision:** draft",
		"**Report:** [263](../../reports/263-jiga.md)",
		"**Current status:** Active posting; 4.20/5; current decision `Apply`.",
		"**Next checkpoint:** Review the pack, supply your real favorite ice cream flavor, then submit the application yourself.",
		"**Selected because:** Highest eligible score and clean product fit.",
		"",
		"### Before You Apply",
		"",
		"- Review the message.",
	}, "\n")
	if err := os.WriteFile(nextPath, []byte(next), 0o644); err != nil {
		t.Fatalf("write next pack: %v", err)
	}

	m := NewViewerModel(
		theme.NewTheme("catppuccin-mocha"),
		root,
		reportPath,
		"DETAILS: Jiga / Product Engineer",
		100,
		30,
		model.CareerApplication{NextPackPath: "output/next-packs/247-jiga.md"},
	)

	plain := ansi.Strip(strings.Join(m.renderAll(), "\n"))
	compact := strings.Join(strings.Fields(plain), " ")
	if !strings.Contains(compact, "Next step: Review the pack, supply your real favorite ice cream flavor, then submit the application yourself.") {
		t.Fatalf("expected one short human next-step sentence, got:\n%s", plain)
	}
	for _, unwanted := range []string{"Report:", "Current status:", "Next checkpoint:", "Selected because:"} {
		if strings.Contains(plain, unwanted) {
			t.Fatalf("expected details page to hide legacy audit metadata %q, got:\n%s", unwanted, plain)
		}
	}
}

func TestDetailsViewerFallbackNextStepUsesHumanSentence(t *testing.T) {
	reportLines := []string{
		"# Evaluation: Acme -- Backend Engineer",
		"",
		"## A) Role Summary",
		"",
		"Strong backend fit.",
	}
	app := model.CareerApplication{
		ActionState: "needs_action",
		NextAction:  "generate_application_pack",
		ActionOwner: "agent",
		NextCommand: "/career-ops next 311",
	}
	m := ViewerModel{
		lines:  buildDetailsLines("", reportLines, app),
		title:  "DETAILS: Acme / Backend Engineer",
		width:  120,
		height: 30,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	plain := ansi.Strip(strings.Join(m.renderAll(), "\n"))
	if !strings.Contains(plain, "Next step: Generate the application with an agent. Run: /career-ops next 311.") {
		t.Fatalf("expected fallback next step to be a human sentence, got:\n%s", plain)
	}
	for _, unwanted := range []string{
		"Next action:",
		"Generate application |",
		"run:",
		"owner: agent",
		"|",
	} {
		if strings.Contains(plain, unwanted) {
			t.Fatalf("expected fallback next step to drop raw detail %q, got:\n%s", unwanted, plain)
		}
	}
}

func TestDetailsAppNextStepSummaryCoversKnownActions(t *testing.T) {
	cases := []struct {
		name string
		app  model.CareerApplication
		want string
	}{
		{
			name: "generate application pack",
			app:  model.CareerApplication{ActionState: "needs_action", NextAction: "generate_application_pack", ActionOwner: "agent", NextCommand: "/career-ops next 311"},
			want: "Generate the application with an agent. Run: /career-ops next 311.",
		},
		{
			name: "send application",
			app:  model.CareerApplication{ActionState: "needs_action", NextAction: "send_application", ActionOwner: "user", NextPackPath: "output/next-packs/311-acme.md", NextCommand: "/career-ops next 311"},
			want: "Send the generated application. Open: output/next-packs/311-acme.md.",
		},
		{
			name: "draft qualifying question",
			app:  model.CareerApplication{ActionState: "needs_action", NextAction: "draft_qualifying_questions", ActionOwner: "agent", NextCommand: "/career-ops next 311"},
			want: "Draft a qualifying question with an agent. Run: /career-ops next 311.",
		},
		{
			name: "send qualifying question",
			app:  model.CareerApplication{ActionState: "needs_action", NextAction: "send_qualifying_questions", ActionOwner: "user", NextPackPath: "output/next-packs/311-acme.md", NextCommand: "/career-ops next 311"},
			want: "Send the qualifying question. Open: output/next-packs/311-acme.md.",
		},
		{
			name: "draft outreach",
			app:  model.CareerApplication{ActionState: "needs_action", NextAction: "draft_outreach", ActionOwner: "agent", NextCommand: "/career-ops next 311"},
			want: "Draft outreach with an agent. Run: /career-ops next 311.",
		},
		{
			name: "send outreach",
			app:  model.CareerApplication{ActionState: "needs_action", NextAction: "send_outreach", ActionOwner: "user", NextPackPath: "output/next-packs/311-acme.md", NextCommand: "/career-ops next 311"},
			want: "Send the outreach. Open: output/next-packs/311-acme.md.",
		},
		{
			name: "follow up",
			app:  model.CareerApplication{ActionState: "needs_action", NextAction: "follow_up", ActionOwner: "user", ActionDue: "2026-07-16"},
			want: "Send a follow-up. Due: 2026-07-16.",
		},
		{
			name: "generate interview cheatsheet",
			app:  model.CareerApplication{ActionState: "needs_action", NextAction: "generate_interview_cheatsheet", ActionOwner: "agent", NextCommand: "/career-ops next 311"},
			want: "Generate the interview cheatsheet with an agent. Run: /career-ops next 311.",
		},
		{
			name: "regenerate interview cheatsheet",
			app:  model.CareerApplication{ActionState: "needs_action", NextAction: "regenerate_cheatsheet", ActionOwner: "agent", NextCommand: "/career-ops next 311"},
			want: "Regenerate the interview cheatsheet with an agent. Run: /career-ops next 311.",
		},
		{
			name: "attend interview and report",
			app:  model.CareerApplication{ActionState: "needs_action", NextAction: "attend_interview_and_report", ActionOwner: "user", NextPackPath: "output/next-packs/311-acme.md", NextCommand: "/career-ops next 311"},
			want: "Attend the interview, then report back. Open: output/next-packs/311-acme.md.",
		},
		{
			name: "generate negotiation prep",
			app:  model.CareerApplication{ActionState: "needs_action", NextAction: "generate_negotiation_prep", ActionOwner: "agent", NextCommand: "/career-ops next 311"},
			want: "Generate negotiation prep with an agent. Run: /career-ops next 311.",
		},
		{
			name: "negotiate and report",
			app:  model.CareerApplication{ActionState: "needs_action", NextAction: "negotiate_and_report", ActionOwner: "user", NextPackPath: "output/next-packs/311-acme.md", NextCommand: "/career-ops next 311"},
			want: "Negotiate, then report back. Open: output/next-packs/311-acme.md.",
		},
		{
			name: "waiting with explicit owner",
			app:  model.CareerApplication{ActionState: "waiting", NextAction: "follow_up", ActionOwner: "company", WaitingOn: "company response", NextCommand: "/career-ops next 311"},
			want: "Wait for company response.",
		},
		{
			name: "waiting without explicit owner",
			app:  model.CareerApplication{ActionState: "snoozed", NextAction: "follow_up"},
			want: "Wait for the company response.",
		},
		{
			name: "none",
			app:  model.CareerApplication{ActionState: "none", NextAction: "none", ActionOwner: "none", NextCommand: "/career-ops next 311"},
			want: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := detailsAppNextStepSummary(tc.app)
			if got != tc.want {
				t.Fatalf("detailsAppNextStepSummary() = %q, want %q", got, tc.want)
			}
			for _, raw := range []string{" | ", "owner:", "run:", "pack:"} {
				if strings.Contains(got, raw) {
					t.Fatalf("expected summary to avoid raw token %q, got %q", raw, got)
				}
			}
		})
	}
}

func TestDetailsViewerUsesRegionAndChildHeadingHierarchy(t *testing.T) {
	useTrueColorRenderer(t)

	m := ViewerModel{
		lines: []string{
			"## Next Step",
			"",
			"### Where To Send It",
			"",
			"- **Apply:** https://jobs.example.com/acme",
			"",
			"### Copy-Paste: Cover Paragraph",
			"",
			"Hello Acme.",
			"",
			"---",
			"",
			"## Deep Dive",
			"",
			"## A) Role Summary",
			"",
			"Role summary text.",
			"",
			"## B) Match With CV",
			"",
			"Match text.",
		},
		title:  "DETAILS: Acme / Backend Engineer",
		width:  80,
		height: 30,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	lineContaining := func(needle string) string {
		t.Helper()
		for _, line := range m.renderAll() {
			if strings.Contains(ansi.Strip(line), needle) {
				return line
			}
		}
		t.Fatalf("expected rendered details page to contain %q", needle)
		return ""
	}

	for _, parent := range []string{"NEXT STEP", "DEEP DIVE"} {
		if line := lineContaining(parent); !hasFillBackground(line) {
			t.Fatalf("expected parent heading %q to keep the strong region bar, got %q", parent, line)
		}
	}

	for _, child := range []string{"WHERE TO SEND IT", "COPY-PASTE: COVER PARAGRAPH", "A) ROLE SUMMARY", "B) MATCH WITH CV"} {
		if line := lineContaining(child); hasFillBackground(line) {
			t.Fatalf("expected child heading %q to render below the region hierarchy, got %q", child, line)
		}
	}
}

func TestDetailsViewerOnlyDrawsRulesBeforeParentRegions(t *testing.T) {
	m := ViewerModel{
		lines: []string{
			"## Next Step",
			"",
			"Ready to review.",
			"",
			"---",
			"",
			"## Deep Dive",
			"",
			"## Cover Letter Draft",
			"",
			"Intro note.",
			"",
			"---",
			"",
			"Opening paragraph.",
			"",
			"---",
			"",
			"Gaps flagged:",
		},
		title:  "DETAILS: Acme / Backend Engineer",
		width:  60,
		height: 30,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	plain := ansi.Strip(strings.Join(m.renderAll(), "\n"))
	if got := strings.Count(plain, "─"); got != m.width {
		t.Fatalf("expected exactly one full-width rule before the Deep Dive region, got %d rule glyphs in:\n%s", got, plain)
	}
	for _, want := range []string{"Opening paragraph.", "Gaps flagged:"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("expected nested content %q to remain after suppressing local rules, got:\n%s", want, plain)
		}
	}
}

func TestDetailsViewerDropsMachineSummarySection(t *testing.T) {
	m := ViewerModel{
		lines: []string{
			"# Evaluation: Acme -- Backend Engineer",
			"",
			"## Machine Summary",
			"",
			"```yaml",
			"machine_only: true",
			"```",
			"",
			"## A) Role Summary",
			"",
			"Human-readable role summary.",
		},
		title:  "DETAILS: Acme / Backend Engineer",
		width:  80,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	plain := ansi.Strip(strings.Join(m.renderAll(), "\n"))
	if strings.Contains(plain, "Machine Summary") || strings.Contains(plain, "machine_only") {
		t.Fatalf("expected machine summary section to be hidden, got:\n%s", plain)
	}
	if !strings.Contains(plain, "A) ROLE SUMMARY") || !strings.Contains(plain, "Human-readable role summary") {
		t.Fatalf("expected normal report content to remain, got:\n%s", plain)
	}
}

func firstNonBlankLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			return trimmed
		}
	}
	return ""
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

func TestEvaluationContentInheritsBackgroundExceptHeadings(t *testing.T) {
	useTrueColorRenderer(t)

	m := ViewerModel{
		lines: []string{
			"**Date:** 2026-07-03",
			"",
			"## A) Role Summary",
			"",
			"Use `workflow` proof without overstating experience.",
			"",
			"- Confirm the role remains software-heavy.",
		},
		title:  "EVALUATION: n8n / Community Software Engineer / Remote",
		width:  72,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	rendered := m.renderAll()
	if len(rendered) < 5 {
		t.Fatalf("expected evaluation content to render, got %d lines: %q", len(rendered), rendered)
	}

	for _, line := range rendered {
		plain := ansi.Strip(line)
		switch {
		case strings.Contains(plain, "A) ROLE SUMMARY"):
			if !hasFillBackground(line) {
				t.Fatalf("expected evaluation heading to keep title background, got %q", line)
			}
		case strings.Contains(plain, "Date:"),
			strings.Contains(plain, "Use workflow proof"),
			strings.Contains(plain, "Confirm the role"):
			if hasFillBackground(line) {
				t.Fatalf("expected evaluation content line to inherit background, got %q", line)
			}
			if strings.Contains(line, "\x1b[K") {
				t.Fatalf("expected evaluation content line not to fill the rest of the line, got %q", line)
			}
		}
	}
}

func TestEvaluationFencedCodeInheritsBackground(t *testing.T) {
	useTrueColorRenderer(t)

	m := ViewerModel{
		lines: []string{
			"```yaml",
			"score: 4.2",
			"```",
		},
		title:  "EVALUATION: Acme / Backend Engineer / Remote",
		width:  48,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	rendered := m.renderAll()
	if len(rendered) != 1 {
		t.Fatalf("expected one rendered code line, got %d", len(rendered))
	}
	if hasFillBackground(rendered[0]) {
		t.Fatalf("expected evaluation code block content to inherit background, got %q", rendered[0])
	}
	if plain := ansi.Strip(rendered[0]); plain != "  score: 4.2" {
		t.Fatalf("expected inset evaluation code block text, got %q", plain)
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

func TestViewerFieldTablesBoldFirstColumnLabels(t *testing.T) {
	useTrueColorRenderer(t)

	m := ViewerModel{
		lines: []string{
			"| Field | Assessment |",
			"|---|---|",
			"| Detected archetype | Platform AI |",
			"| **Domain** | Agent tooling |",
		},
		width:  64,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	rendered := m.renderAll()
	plain := ansi.Strip(strings.Join(rendered, "\n"))
	for _, want := range []string{"Detected archetype", "Domain"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("expected rendered table to contain %q, got:\n%s", want, plain)
		}
	}
	for _, line := range rendered {
		if strings.Contains(ansi.Strip(line), "Detected archetype") {
			if !strings.Contains(line, "\x1b[1") {
				t.Fatalf("expected plain first-column field label to render bold, got %q", line)
			}
			return
		}
	}
	t.Fatalf("expected to find Detected archetype row in:\n%s", plain)
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
	if strings.Contains(footer, "\x1b[0m  \x1b[") {
		t.Fatalf("expected shortcut separators to inherit the footer background, got an unstyled gap in %q", footer)
	}
}

func TestNextStepViewerFooterIncludesLinkShortcuts(t *testing.T) {
	m := ViewerModel{
		title:     "NEXT STEP: Send Application / Acme / Backend Engineer / Remote",
		app:       model.CareerApplication{JobURL: "https://jobs.example.com/acme"},
		cvPDFPath: "/tmp/career-ops/output/cv-jane-doe-acme-2026-07-08.pdf",
		width:     120,
		height:    20,
		theme:     theme.NewTheme("catppuccin-mocha"),
	}

	plain := ansi.Strip(m.renderFooter())
	for _, want := range []string{"o URL", "d PDF", "c status", "Esc back"} {
		if !strings.Contains(plain, want) {
			t.Fatalf("expected footer to include %q, got %q", want, plain)
		}
	}
}

func TestNextStepViewerOpenURLShortcut(t *testing.T) {
	m := ViewerModel{
		title:  "NEXT STEP: Send Application / Acme / Backend Engineer / Remote",
		app:    model.CareerApplication{JobURL: "https://jobs.example.com/acme"},
		width:  80,
		height: 20,
		theme:  theme.NewTheme("catppuccin-mocha"),
	}

	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'o'}})
	if cmd == nil {
		t.Fatal("expected o to emit an open-URL command")
	}
	msg := cmd()
	openMsg, ok := msg.(PipelineOpenURLMsg)
	if !ok {
		t.Fatalf("expected PipelineOpenURLMsg, got %T", msg)
	}
	if openMsg.URL != "https://jobs.example.com/acme" {
		t.Fatalf("opened URL = %q", openMsg.URL)
	}
}

func TestNextStepViewerOpenPDFShortcut(t *testing.T) {
	root := t.TempDir()
	writePDFFixture(t, root, "output/cv-jane-doe-globex-2026-06-05.pdf")
	nextPackPath := filepath.Join(root, "output", "next-packs", "042-globex.md")
	if err := os.MkdirAll(filepath.Dir(nextPackPath), 0o755); err != nil {
		t.Fatalf("mkdir next pack: %v", err)
	}
	if err := os.WriteFile(nextPackPath, []byte("## Next: Globex -- Engineer"), 0o644); err != nil {
		t.Fatalf("write next pack: %v", err)
	}

	m := NewViewerModel(
		theme.NewTheme("catppuccin-mocha"),
		root,
		nextPackPath,
		"NEXT STEP: Send Application / Globex / Engineer",
		80,
		20,
		model.CareerApplication{Company: "Globex", Role: "Engineer"},
	)

	_, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'d'}})
	if cmd == nil {
		t.Fatal("expected d to emit an open-PDF command")
	}
	msg := cmd()
	openMsg, ok := msg.(PipelineOpenPDFMsg)
	if !ok {
		t.Fatalf("expected PipelineOpenPDFMsg, got %T", msg)
	}
	if !strings.HasSuffix(openMsg.Path, "cv-jane-doe-globex-2026-06-05.pdf") {
		t.Fatalf("opened PDF path = %q", openMsg.Path)
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

func TestViewerMarkdownLinksEmitWorkingOSC8Targets(t *testing.T) {
	root := t.TempDir()
	reportDir := filepath.Join(root, "reports")
	if err := os.MkdirAll(reportDir, 0o755); err != nil {
		t.Fatalf("mkdir reports: %v", err)
	}
	localTarget := filepath.Join(root, "output", "cv-acme.pdf")
	writePDFFixture(t, root, "output/cv-acme.pdf")

	m := ViewerModel{
		lines:         []string{"[Posting](https://jobs.example.com/acme) [Resume](../output/cv-acme.pdf) [Outside](file:///etc/passwd)"},
		linkBaseDir:   reportDir,
		careerOpsPath: root,
		width:         100,
		height:        20,
		theme:         theme.NewTheme("catppuccin-mocha"),
	}

	rendered := strings.Join(m.renderAll(), "\n")
	if !strings.Contains(rendered, "\x1b]8;;https://jobs.example.com/acme\x07") {
		t.Fatalf("expected external Markdown link to emit an OSC 8 target, got %q", rendered)
	}
	wantLocal := "\x1b]8;;file://" + filepath.ToSlash(localTarget) + "\x07"
	if !strings.Contains(rendered, wantLocal) {
		t.Fatalf("expected local Markdown link target %q, got %q", wantLocal, rendered)
	}
	if strings.Contains(rendered, "\x1b]8;;file:///etc/passwd\x07") {
		t.Fatalf("expected local links outside the career-ops root to stay inert, got %q", rendered)
	}
}

func TestDetailsViewerPreservesNextPackRelativeLinkBase(t *testing.T) {
	root := t.TempDir()
	reportPath := filepath.Join(root, "reports", "042-acme.md")
	if err := os.MkdirAll(filepath.Dir(reportPath), 0o755); err != nil {
		t.Fatalf("mkdir reports: %v", err)
	}
	if err := os.WriteFile(reportPath, []byte("# Evaluation: Acme -- Engineer\n\n## A) Role Summary\n\nGood fit."), 0o644); err != nil {
		t.Fatalf("write report: %v", err)
	}
	writePDFFixture(t, root, "output/cv-acme.pdf")
	packPath := filepath.Join(root, "output", "next-packs", "042-acme.md")
	if err := os.MkdirAll(filepath.Dir(packPath), 0o755); err != nil {
		t.Fatalf("mkdir next pack: %v", err)
	}
	if err := os.WriteFile(packPath, []byte("## Next: Acme -- Engineer (#42)\n\n- **Tailored CV:** [cv-acme.pdf](../cv-acme.pdf)"), 0o644); err != nil {
		t.Fatalf("write next pack: %v", err)
	}

	m := NewViewerModel(
		theme.NewTheme("catppuccin-mocha"),
		root,
		reportPath,
		"DETAILS: Acme / Engineer",
		100,
		30,
		model.CareerApplication{Company: "Acme", Role: "Engineer", NextPackPath: "output/next-packs/042-acme.md"},
	)

	rendered := strings.Join(m.renderedLines, "\n")
	want := "\x1b]8;;file://" + filepath.ToSlash(filepath.Join(root, "output", "cv-acme.pdf")) + "\x07"
	if !strings.Contains(rendered, want) {
		t.Fatalf("expected next-pack-relative CV link target %q, got %q", want, rendered)
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

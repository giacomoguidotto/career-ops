package screens

import (
	"io"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/muesli/termenv"

	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

func tabIndexForFilter(t *testing.T, filter string) int {
	t.Helper()

	for i, tab := range pipelineTabs {
		if tab.filter == filter {
			return i
		}
	}

	t.Fatalf("expected pipeline tabs to include filter %q", filter)
	return -1
}

func TestWithReloadedDataPreservesStateAndSelection(t *testing.T) {
	initialApps := []model.CareerApplication{
		{
			Company:    "Acme",
			Role:       "Backend Engineer",
			Status:     "Evaluated",
			Score:      4.2,
			ReportPath: "reports/001-acme.md",
		},
		{
			Company:    "Beta",
			Role:       "Platform Engineer",
			Status:     "Applied",
			Score:      4.6,
			ReportPath: "reports/002-beta.md",
		},
	}

	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		initialApps,
		model.PipelineMetrics{Total: len(initialApps)},
		"..",
		120,
		40,
	)
	pm.sortMode = sortCompany
	pm.activeTab = tabIndexForFilter(t, filterAll)
	pm.viewMode = "flat"
	pm.applyFilterAndSort()
	pm.cursor = 1
	pm.reportCache["reports/002-beta.md"] = reportSummary{tldr: "cached"}

	refreshedApps := []model.CareerApplication{
		initialApps[0],
		initialApps[1],
		{
			Company:    "Gamma",
			Role:       "AI Engineer",
			Status:     "Interview",
			Score:      4.8,
			ReportPath: "reports/003-gamma.md",
		},
	}

	reloaded := pm.WithReloadedData(refreshedApps, model.PipelineMetrics{Total: len(refreshedApps)})

	if reloaded.sortMode != sortCompany {
		t.Fatalf("expected sort mode %q, got %q", sortCompany, reloaded.sortMode)
	}
	if reloaded.viewMode != "flat" {
		t.Fatalf("expected view mode to stay flat, got %q", reloaded.viewMode)
	}
	if got := len(reloaded.filtered); got != 3 {
		t.Fatalf("expected 3 filtered apps after refresh, got %d", got)
	}
	if app, ok := reloaded.CurrentApp(); !ok || app.ReportPath != "reports/002-beta.md" {
		t.Fatalf("expected selection to stay on beta app, got %+v (ok=%v)", app, ok)
	}
	if reloaded.reportCache["reports/002-beta.md"].tldr != "cached" {
		t.Fatal("expected cached report summaries to survive refresh")
	}
}

func TestRenderAppLineIncludesDateColumn(t *testing.T) {
	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		nil,
		model.PipelineMetrics{},
		"..",
		120,
		40,
	)

	line := pm.renderAppLine(model.CareerApplication{
		Number:  42,
		Date:    "2026-04-13",
		Company: "Anthropic",
		Role:    "Forward Deployed Engineer",
		Status:  "Applied",
		Score:   4.5,
	}, false)

	if !strings.Contains(line, "2026-04-13") {
		t.Fatalf("expected rendered line to include date column, got %q", line)
	}
	if !strings.Contains(line, "#42") {
		t.Fatalf("expected rendered line to include tracker number marker, got %q", line)
	}
}

func TestPendingAndScoredRowsKeepCompanyColumnAligned(t *testing.T) {
	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		nil,
		model.PipelineMetrics{},
		"..",
		140,
		40,
	)

	scored := ansi.Strip(pm.renderAppLine(model.CareerApplication{
		Number:  42,
		Date:    "2026-04-13",
		Company: "Anthropic",
		Role:    "Forward Deployed Engineer",
		Status:  "Evaluated",
		Score:   4.5,
	}, false))
	pending := ansi.Strip(pm.renderAppLine(model.CareerApplication{
		Company: "Vercel",
		Role:    "Pending Engineer",
		Status:  "Pending",
	}, false))

	scoredIdx := strings.Index(scored, "Anthropic")
	pendingIdx := strings.Index(pending, "Vercel")
	if scoredIdx < 0 || pendingIdx < 0 {
		t.Fatalf("expected company names in rendered rows, got scored=%q pending=%q", scored, pending)
	}
	if scoredWidth, pendingWidth := ansi.StringWidth(scored[:scoredIdx]), ansi.StringWidth(pending[:pendingIdx]); scoredWidth != pendingWidth {
		t.Fatalf("company column misaligned: scored starts at width %d in %q, pending starts at width %d in %q", scoredWidth, scored, pendingWidth, pending)
	}
}

func TestColumnWidthsExpandLocationOnWideTerminals(t *testing.T) {
	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		nil,
		model.PipelineMetrics{},
		"..",
		120,
		40,
	)

	if got := pm.columnWidths().loc; got != 20 {
		t.Fatalf("default location width = %d, want 20", got)
	}

	pm.Resize(220, 40)
	if got := pm.columnWidths().loc; got < 40 {
		t.Fatalf("wide terminal location width = %d, want at least 40", got)
	}
}

func TestTabsUnderlineSpansFullWidth(t *testing.T) {
	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		nil,
		model.PipelineMetrics{Total: 73},
		"..",
		120,
		40,
	)

	lines := strings.Split(pm.renderTabs(), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected tabs to render two lines, got %d: %q", len(lines), lines)
	}

	underline := ansi.Strip(lines[1])
	if got := ansi.StringWidth(underline); got != pm.width {
		t.Fatalf("tab underline width = %d, want %d; line=%q", got, pm.width, underline)
	}
	visibleRuleWidth := strings.Count(underline, "━") + strings.Count(underline, "─")
	if visibleRuleWidth < pm.width-2 {
		t.Fatalf("tab underline visible rule width = %d, want at least %d; line=%q", visibleRuleWidth, pm.width-2, underline)
	}
}

func TestPipelineTabsPutQueueFirstButDefaultToAll(t *testing.T) {
	apps := []model.CareerApplication{
		{Company: "Acme", Role: "Pending Engineer", Status: "Pending"},
		{Company: "Beta", Role: "Backend Engineer", Status: "Evaluated", Score: 4.2},
	}

	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "..", 120, 40)

	if pipelineTabs[0].filter != filterQueue {
		t.Fatalf("first tab = %q, want queue", pipelineTabs[0].filter)
	}
	if pipelineTabs[1].filter != filterAll {
		t.Fatalf("second tab = %q, want all", pipelineTabs[1].filter)
	}
	for _, tab := range pipelineTabs {
		if tab.label == "ACTION" || strings.HasPrefix(tab.label, "TOP") {
			t.Fatalf("unexpected dropped tab still present: %+v", tab)
		}
	}
	if got := pipelineTabs[pm.activeTab].filter; got != filterAll {
		t.Fatalf("default active tab = %q, want all", got)
	}
	if got := len(pm.filtered); got != len(apps) {
		t.Fatalf("default all tab filtered %d rows, want %d", got, len(apps))
	}

	tabs := ansi.Strip(pm.renderTabs())
	queueIdx := strings.Index(tabs, "QUEUE")
	allIdx := strings.Index(tabs, "ALL")
	if queueIdx < 0 || allIdx < 0 || queueIdx > allIdx {
		t.Fatalf("expected QUEUE before ALL in rendered tabs, got %q", tabs)
	}
}

func TestMetricsLineRightAlignsSortViewAndShownCount(t *testing.T) {
	useTrueColorRenderer(t)

	apps := []model.CareerApplication{
		{Company: "Acme", Role: "Backend Engineer", Status: "Evaluated", Score: 4.2},
		{Company: "Beta", Role: "Platform Engineer", Status: "Applied", Score: 4.6},
	}
	metrics := model.PipelineMetrics{
		Total: len(apps),
		ByStatus: map[string]int{
			"evaluated": 1,
			"applied":   1,
		},
	}

	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, metrics, "..", 120, 40)
	pm.sortMode = sortScore
	pm.viewMode = "grouped"
	pm.applyFilterAndSort()

	line := pm.renderMetrics()
	plain := ansi.Strip(line)
	right := "[Sort: score]  [View: grouped]  2 shown"

	if got := lipgloss.Width(line); got != pm.width {
		t.Fatalf("metrics line width = %d, want %d; line=%q", got, pm.width, plain)
	}
	if !strings.Contains(plain, "Evaluated:1") || !strings.Contains(plain, "Applied:1") {
		t.Fatalf("expected metrics to remain on the left side, got %q", plain)
	}
	if !strings.HasSuffix(strings.TrimRight(plain, " "), right) {
		t.Fatalf("expected sort/view/count to be right-aligned on metrics row, got %q", plain)
	}

	view := ansi.Strip(pm.View())
	if count := strings.Count(view, "[Sort:"); count != 1 {
		t.Fatalf("expected sort summary to render exactly once, got %d occurrences in %q", count, view)
	}

	viewLines := strings.Split(pm.View(), "\n")
	metricsIdx := -1
	for i, line := range viewLines {
		if strings.Contains(ansi.Strip(line), "[Sort:") {
			metricsIdx = i
			break
		}
	}
	if metricsIdx < 0 || metricsIdx+1 >= len(viewLines) {
		t.Fatalf("expected metrics row plus spacer in rendered view, got %q", ansi.Strip(strings.Join(viewLines, "\n")))
	}
	spacer := viewLines[metricsIdx+1]
	plainSpacer := ansi.Strip(spacer)
	if strings.TrimSpace(plainSpacer) != "" {
		t.Fatalf("expected inherited blank spacer after metrics row, got %q", plainSpacer)
	}
	if got := ansi.StringWidth(plainSpacer); got < pm.width {
		t.Fatalf("expected spacer width at least %d, got %d for %q", pm.width, got, plainSpacer)
	}
	if strings.Contains(spacer, "48;2;") {
		t.Fatalf("expected spacer row to inherit background, got %q", spacer)
	}

	narrow := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, metrics, "..", 56, 40)
	narrow.sortMode = sortScore
	narrow.viewMode = "grouped"
	narrow.applyFilterAndSort()
	narrowLine := ansi.Strip(narrow.renderMetrics())
	if got := lipgloss.Width(narrowLine); got != narrow.width {
		t.Fatalf("narrow metrics line width = %d, want %d; line=%q", got, narrow.width, narrowLine)
	}
	if !strings.HasSuffix(strings.TrimRight(narrowLine, " "), right) {
		t.Fatalf("expected narrow metrics row to preserve right-aligned sort summary, got %q", narrowLine)
	}
}

func TestGroupedDividerSpansFullTableWidth(t *testing.T) {
	apps := []model.CareerApplication{
		{Number: 1, Date: "2026-06-20", Company: "Acme", Role: "Backend Engineer", Status: "Evaluated", Score: 4.0},
	}

	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "..", 160, 40)
	pm.viewMode = "grouped"
	pm.applyFilterAndSort()

	lines := strings.Split(pm.renderBody(), "\n")
	if len(lines) == 0 {
		t.Fatal("expected grouped body to render at least one line")
	}
	if got := lipgloss.Width(lines[0]); got != pm.width {
		t.Fatalf("group divider width = %d, want %d", got, pm.width)
	}
}

func TestSelectedAppLineAppliesBackgroundAcrossStyledCells(t *testing.T) {
	oldRenderer := lipgloss.DefaultRenderer()
	r := lipgloss.NewRenderer(io.Discard)
	r.SetColorProfile(termenv.TrueColor)
	lipgloss.SetDefaultRenderer(r)
	t.Cleanup(func() {
		lipgloss.SetDefaultRenderer(oldRenderer)
	})

	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		nil,
		model.PipelineMetrics{},
		"..",
		160,
		40,
	)
	pm.reportCache["reports/001-acme.md"] = reportSummary{comp: "$150K-200K"}

	line := pm.renderAppLine(model.CareerApplication{
		Number:     1,
		Date:       "2026-06-20",
		Company:    "Acme",
		Role:       "Backend Engineer",
		Status:     "Evaluated",
		Score:      4.0,
		WorkMode:   "Hybrid",
		Location:   "London, Berlin",
		ReportPath: "reports/001-acme.md",
	}, true)

	const selectionSeq = "\x1b[48;2;60;88;116m"
	if count := strings.Count(line, selectionSeq); count < 6 {
		t.Fatalf("selected row emitted selection background %d times, want it across styled cells; line=%q", count, line)
	}
}

func TestSearchFiltersByCompanyRoleAndNotes(t *testing.T) {
	apps := []model.CareerApplication{
		{Company: "Stripe", Role: "Backend Engineer", Status: "Evaluated", Score: 4.6, Notes: "payments infra"},
		{Company: "Anthropic", Role: "AI Safety Engineer", Status: "Applied", Score: 4.8, Notes: "policy work"},
		{Company: "Acme Corp", Role: "Senior PM, Voice AI", Status: "Evaluated", Score: 4.2, Notes: "Series B in Madrid"},
		{Company: "Globex", Role: "Platform Engineer", Status: "Applied", Score: 3.9, Notes: "remote-first"},
	}

	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "..", 120, 40)
	pm.activeTab = tabIndexForFilter(t, filterAll)

	// Match by company substring (case-insensitive).
	pm.searchQuery = "stripe"
	pm.applyFilterAndSort()
	if len(pm.filtered) != 1 || pm.filtered[0].Company != "Stripe" {
		t.Fatalf("expected 1 match for 'stripe', got %+v", pm.filtered)
	}

	// Match by role substring.
	pm.searchQuery = "voice ai"
	pm.applyFilterAndSort()
	if len(pm.filtered) != 1 || pm.filtered[0].Company != "Acme Corp" {
		t.Fatalf("expected 1 match for 'voice ai', got %+v", pm.filtered)
	}

	// Match by notes substring.
	pm.searchQuery = "madrid"
	pm.applyFilterAndSort()
	if len(pm.filtered) != 1 || pm.filtered[0].Company != "Acme Corp" {
		t.Fatalf("expected 1 match for notes 'madrid', got %+v", pm.filtered)
	}

	// Empty query restores everything.
	pm.searchQuery = ""
	pm.applyFilterAndSort()
	if len(pm.filtered) != len(apps) {
		t.Fatalf("expected empty query to restore all rows, got %d/%d", len(pm.filtered), len(apps))
	}
}

func TestSearchComposesWithActiveTab(t *testing.T) {
	apps := []model.CareerApplication{
		{Company: "Stripe", Role: "Backend Engineer", Status: "Evaluated", Score: 4.6},
		{Company: "Stripe", Role: "Frontend Engineer", Status: "Applied", Score: 4.5},
		{Company: "Anthropic", Role: "AI Engineer", Status: "Applied", Score: 4.8},
	}

	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "..", 120, 40)
	pm.activeTab = tabIndexForFilter(t, filterApplied)
	pm.searchQuery = "stripe"
	pm.applyFilterAndSort()

	if len(pm.filtered) != 1 || pm.filtered[0].Role != "Frontend Engineer" {
		t.Fatalf("expected applied+stripe to leave only Frontend Engineer, got %+v", pm.filtered)
	}
}

func TestSearchIsCaseInsensitive(t *testing.T) {
	apps := []model.CareerApplication{
		{Company: "Anthropic", Role: "AI Engineer", Status: "Evaluated", Score: 4.8},
	}

	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "..", 120, 40)
	for _, q := range []string{"anthropic", "ANTHROPIC", "AnThRoPiC"} {
		pm.searchQuery = q
		pm.applyFilterAndSort()
		if len(pm.filtered) != 1 {
			t.Fatalf("expected case-insensitive match for %q, got %d rows", q, len(pm.filtered))
		}
	}
}

func TestSearchEnterCommitsAndEscClearsCommittedQuery(t *testing.T) {
	apps := []model.CareerApplication{
		{Company: "Stripe", Role: "Backend Engineer", Status: "Evaluated", Score: 4.6},
		{Company: "Anthropic", Role: "AI Engineer", Status: "Evaluated", Score: 4.8},
	}

	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "..", 120, 40)

	// Open input and type "stripe".
	pm, _ = pm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'/'}})
	if !pm.searchInput {
		t.Fatal("expected `/` to open search input")
	}
	for _, r := range "stripe" {
		pm, _ = pm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	if pm.searchQuery != "stripe" {
		t.Fatalf("expected query to live-update to 'stripe', got %q", pm.searchQuery)
	}
	if len(pm.filtered) != 1 || pm.filtered[0].Company != "Stripe" {
		t.Fatalf("expected live filter to leave only Stripe, got %+v", pm.filtered)
	}

	// Enter commits — input closes, query stays.
	pm, _ = pm.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if pm.searchInput {
		t.Fatal("expected Enter to close input")
	}
	if pm.searchQuery != "stripe" {
		t.Fatalf("expected Enter to keep committed query, got %q", pm.searchQuery)
	}

	// Esc on a committed query clears the search and restores the full list.
	pm, _ = pm.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if pm.searchQuery != "" {
		t.Fatalf("expected Esc to clear committed query, got %q", pm.searchQuery)
	}
	if len(pm.filtered) != len(apps) {
		t.Fatalf("expected Esc to restore full list, got %d/%d", len(pm.filtered), len(apps))
	}
}

func TestSearchEscInInputCancelsAndClears(t *testing.T) {
	// Use multiple rows so the test catches a regression where Esc clears the query
	// but forgets to re-apply the filter — the visible count would stay at 1
	// otherwise even though the underlying state went stale.
	apps := []model.CareerApplication{
		{Company: "Stripe", Role: "Backend Engineer", Status: "Evaluated", Score: 4.6},
		{Company: "Globex", Role: "Platform Engineer", Status: "Evaluated", Score: 4.0},
		{Company: "Anthropic", Role: "AI Engineer", Status: "Evaluated", Score: 4.8},
	}

	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "..", 120, 40)
	pm.searchInput = true
	pm.searchQuery = "stri"
	pm.applyFilterAndSort()
	if len(pm.filtered) != 1 {
		t.Fatalf("setup expected 1 row matching 'stri', got %d", len(pm.filtered))
	}

	pm, _ = pm.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if pm.searchInput {
		t.Fatal("expected Esc in input mode to close input")
	}
	if pm.searchQuery != "" {
		t.Fatalf("expected Esc in input mode to clear in-progress query, got %q", pm.searchQuery)
	}
	if len(pm.filtered) != len(apps) {
		t.Fatalf("expected Esc to re-expand filtered list to %d rows, got %d", len(apps), len(pm.filtered))
	}
}

func TestSearchResetsCursorOnQueryChange(t *testing.T) {
	apps := []model.CareerApplication{
		{Company: "Acme", Role: "Backend Engineer", Status: "Evaluated", Score: 4.0},
		{Company: "Beta", Role: "Frontend Engineer", Status: "Evaluated", Score: 4.1},
		{Company: "Gamma", Role: "AI Engineer", Status: "Evaluated", Score: 4.2},
	}

	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "..", 120, 40)
	pm.cursor = 2

	pm, _ = pm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'/'}})
	pm, _ = pm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'a'}})

	if pm.cursor != 0 {
		t.Fatalf("expected cursor to reset to 0 on query change, got %d", pm.cursor)
	}
	if pm.scrollOffset != 0 {
		t.Fatalf("expected scrollOffset to reset to 0 on query change, got %d", pm.scrollOffset)
	}
}

func TestSearchStatePreservedAcrossReload(t *testing.T) {
	initial := []model.CareerApplication{
		{Company: "Stripe", Role: "Backend", Status: "Evaluated", Score: 4.6},
		{Company: "Acme", Role: "AI", Status: "Evaluated", Score: 4.0},
	}

	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), initial, model.PipelineMetrics{Total: len(initial)}, "..", 120, 40)
	pm.searchQuery = "stripe"
	pm.applyFilterAndSort()

	refreshed := append([]model.CareerApplication{}, initial...)
	refreshed = append(refreshed, model.CareerApplication{Company: "Globex", Role: "Platform", Status: "Applied", Score: 4.3})

	reloaded := pm.WithReloadedData(refreshed, model.PipelineMetrics{Total: len(refreshed)})

	if reloaded.searchQuery != "stripe" {
		t.Fatalf("expected refresh to preserve search query, got %q", reloaded.searchQuery)
	}
	if len(reloaded.filtered) != 1 || reloaded.filtered[0].Company != "Stripe" {
		t.Fatalf("expected refresh+search to keep filter applied, got %+v", reloaded.filtered)
	}
}

func TestRejectedAndDiscardedTabsFilterCorrectly(t *testing.T) {
	apps := []model.CareerApplication{
		{
			Company:    "Acme",
			Role:       "Backend Engineer",
			Status:     "Rejected",
			Score:      3.4,
			ReportPath: "reports/001-acme.md",
		},
		{
			Company:    "Beta",
			Role:       "Platform Engineer",
			Status:     "Discarded",
			Score:      2.1,
			ReportPath: "reports/002-beta.md",
		},
		{
			Company:    "Gamma",
			Role:       "AI Engineer",
			Status:     "Applied",
			Score:      4.6,
			ReportPath: "reports/003-gamma.md",
		},
	}

	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		apps,
		model.PipelineMetrics{Total: len(apps)},
		"..",
		120,
		40,
	)

	pm.activeTab = tabIndexForFilter(t, filterRejected)
	pm.applyFilterAndSort()
	if len(pm.filtered) != 1 || pm.filtered[0].Status != "Rejected" {
		t.Fatalf("expected rejected tab to isolate rejected rows, got %+v", pm.filtered)
	}

	pm.activeTab = tabIndexForFilter(t, filterDiscarded)
	pm.applyFilterAndSort()
	if len(pm.filtered) != 1 || pm.filtered[0].Status != "Discarded" {
		t.Fatalf("expected discarded tab to isolate discarded rows, got %+v", pm.filtered)
	}
}

func TestQueueTabFiltersPendingAndProcessingRows(t *testing.T) {
	apps := []model.CareerApplication{
		{Company: "Acme", Role: "Evaluated Role", Status: "Evaluated", Score: 4.0, Source: "tracker"},
		{Company: "Beta", Role: "Pending Role", Status: "Pending", Source: "pipeline"},
		{Company: "Gamma", Role: "Processing Role", Status: "Processing", Source: "batch"},
		{Company: "Delta", Role: "Skipped Role", Status: "Skipped", Source: "batch"},
		{Company: "Epsilon", Role: "Completed Role", Status: "Completed", Source: "batch"},
	}

	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "..", 120, 40)
	pm.activeTab = tabIndexForFilter(t, filterQueue)
	pm.applyFilterAndSort()

	if len(pm.filtered) != 2 {
		t.Fatalf("expected queue tab to show 2 queue rows, got %+v", pm.filtered)
	}
	for _, app := range pm.filtered {
		if app.Status != "Pending" && app.Status != "Processing" {
			t.Fatalf("queue tab included non-queue row: %+v", app)
		}
	}
}

func TestStatusPickerDoesNotOpenForQueueRows(t *testing.T) {
	apps := []model.CareerApplication{
		{Company: "Beta", Role: "Pending Role", Status: "Pending", Source: "pipeline"},
	}

	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "..", 120, 40)
	pm, _ = pm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'c'}})

	if pm.statusPicker {
		t.Fatal("status picker should not open for queue-only rows")
	}
}

func TestRenderAppLineIncludesNextColumn(t *testing.T) {
	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		nil,
		model.PipelineMetrics{},
		"..",
		140,
		40,
	)

	line := ansi.Strip(pm.renderAppLine(model.CareerApplication{
		Number:      42,
		Company:     "Acme",
		Role:        "AI Engineer",
		Status:      "Evaluated",
		Score:       4.2,
		ActionState: "needs_action",
		NextAction:  "generate_application_pack",
	}, false))

	if !strings.Contains(line, "Generate application") {
		t.Fatalf("expected rendered row to include next action label, got %q", line)
	}
}

func TestRenderAppLineShowsReadyArtifactAsHumanStep(t *testing.T) {
	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		nil,
		model.PipelineMetrics{},
		"..",
		160,
		40,
	)

	line := ansi.Strip(pm.renderAppLine(model.CareerApplication{
		Number:       42,
		Company:      "Acme",
		Role:         "AI Engineer",
		Status:       "Application Ready",
		Score:        4.2,
		ActionState:  "needs_action",
		NextAction:   "send_application",
		NextPackPath: "output/next-packs/042-acme.md",
	}, false))

	if !strings.Contains(line, "Send application") {
		t.Fatalf("expected generated application pack to become a human send step, got %q", line)
	}
}

func TestNextStepLabelsSeparateAgentActionsFromHumanSteps(t *testing.T) {
	cases := []struct {
		name string
		app  model.CareerApplication
		want string
	}{
		{
			name: "application generation",
			app:  model.CareerApplication{ActionState: "needs_action", NextAction: "generate_application_pack"},
			want: "Generate application",
		},
		{
			name: "application send after artifact",
			app:  model.CareerApplication{ActionState: "needs_action", NextAction: "send_application", NextPackPath: "output/next-packs/042-acme.md"},
			want: "Send application",
		},
		{
			name: "qualifying question draft",
			app:  model.CareerApplication{ActionState: "needs_action", NextAction: "draft_qualifying_questions"},
			want: "Draft gating question",
		},
		{
			name: "qualifying question send after artifact",
			app:  model.CareerApplication{ActionState: "needs_action", NextAction: "send_qualifying_questions", NextPackPath: "output/next-packs/084-vercel.md"},
			want: "Send gating question",
		},
		{
			name: "interview cheatsheet generation",
			app:  model.CareerApplication{ActionState: "needs_action", NextAction: "generate_interview_cheatsheet"},
			want: "Generate interview cheatsheet",
		},
		{
			name: "interview after cheatsheet",
			app:  model.CareerApplication{ActionState: "needs_action", NextAction: "attend_interview_and_report", NextPackPath: "output/next-packs/042-acme.md"},
			want: "Interview",
		},
		{
			name: "waiting row",
			app:  model.CareerApplication{ActionState: "waiting", NextAction: "follow_up", WaitingOn: "company response", NextPackPath: "output/next-packs/042-acme.md"},
			want: "Wait for response",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := nextActionLabel(tc.app); got != tc.want {
				t.Fatalf("nextActionLabel() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestPreviewShowsNextCommandAndPackPath(t *testing.T) {
	pm := previewModelWith(t, model.CareerApplication{
		Company:      "Acme",
		Role:         "AI Engineer",
		Status:       "Application Ready",
		ActionState:  "needs_action",
		NextAction:   "send_application",
		NextPackPath: "output/next-packs/042-acme.md",
		NextCommand:  "/career-ops next 42",
	})

	preview := pm.renderPreview()
	if !strings.Contains(preview, "Next step:") || !strings.Contains(preview, "n: open output/next-packs/042-acme.md") {
		t.Fatalf("expected preview to show next pack opener, got %q", preview)
	}
	if strings.Contains(preview, "c: copy artifact") {
		t.Fatalf("preview should not advertise artifact copying, got %q", preview)
	}
	if strings.Contains(preview, "/career-ops next 42") {
		t.Fatalf("preview should prefer existing pack path over generation command, got %q", preview)
	}
}

func TestNextKeyOpensExistingPack(t *testing.T) {
	apps := []model.CareerApplication{
		{
			Company:      "Acme",
			Role:         "AI Engineer",
			Status:       "Application Ready",
			ActionState:  "needs_action",
			NextAction:   "send_application",
			NextPackPath: "output/next-packs/042-acme.md",
		},
	}
	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "/tmp/career-ops", 120, 40)

	_, cmd := pm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'n'}})
	if cmd == nil {
		t.Fatal("expected n to emit an open-pack command")
	}
	msg := cmd()
	openMsg, ok := msg.(PipelineOpenReportMsg)
	if !ok {
		t.Fatalf("expected PipelineOpenReportMsg, got %T", msg)
	}
	if openMsg.Path != "/tmp/career-ops/output/next-packs/042-acme.md" {
		t.Fatalf("opened path = %q", openMsg.Path)
	}
}

func TestEnterUsesHumanEvaluationTitle(t *testing.T) {
	apps := []model.CareerApplication{
		{
			Company:    "n8n",
			Role:       "Community Software Engineer / Remote / Europe",
			Status:     "Evaluated",
			ReportPath: "reports/143-n8n.md",
			WorkMode:   "Remote",
			Location:   "Europe",
		},
	}
	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "/tmp/career-ops", 120, 40)

	_, cmd := pm.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("expected Enter to emit an open-report command")
	}
	msg := cmd()
	openMsg, ok := msg.(PipelineOpenReportMsg)
	if !ok {
		t.Fatalf("expected PipelineOpenReportMsg, got %T", msg)
	}
	want := "EVALUATION: n8n / Community Software Engineer / Remote / Europe"
	if openMsg.Title != want {
		t.Fatalf("opened title = %q, want %q", openMsg.Title, want)
	}
}

func TestNextKeyUsesHumanNextStepTitle(t *testing.T) {
	apps := []model.CareerApplication{
		{
			Company:      "n8n",
			Role:         "Community Software Engineer / Remote / Europe",
			Status:       "Application Ready",
			ActionState:  "needs_action",
			NextAction:   "send_application",
			NextPackPath: "output/next-packs/042-n8n.md",
			WorkMode:     "Remote",
			Location:     "Europe",
		},
	}
	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "/tmp/career-ops", 120, 40)

	_, cmd := pm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'n'}})
	if cmd == nil {
		t.Fatal("expected n to emit an open-pack command")
	}
	msg := cmd()
	openMsg, ok := msg.(PipelineOpenReportMsg)
	if !ok {
		t.Fatalf("expected PipelineOpenReportMsg, got %T", msg)
	}
	want := "NEXT STEP: Send Application / n8n / Community Software Engineer / Remote / Europe"
	if openMsg.Title != want {
		t.Fatalf("opened title = %q, want %q", openMsg.Title, want)
	}
}

func TestNextKeyDoesNotOpenAgentGenerationStep(t *testing.T) {
	apps := []model.CareerApplication{
		{
			Company:      "Acme",
			Role:         "AI Engineer",
			Status:       "Evaluated",
			ActionState:  "needs_action",
			NextAction:   "generate_application_pack",
			NextCommand:  "/career-ops next 42",
			NextPackPath: "",
		},
	}
	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "/tmp/career-ops", 120, 40)

	updated, cmd := pm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'n'}})
	if cmd != nil {
		t.Fatal("expected n to avoid opening a page before the artifact exists")
	}
	if !strings.Contains(updated.flash, "/career-ops next 42") {
		t.Fatalf("expected n to explain the generation command, got flash %q", updated.flash)
	}
}

func TestCopyKeyOpensStatusPickerEvenWhenArtifactIsReady(t *testing.T) {
	apps := []model.CareerApplication{
		{
			Company:      "Acme",
			Role:         "AI Engineer",
			Status:       "Application Ready",
			ActionState:  "needs_action",
			NextAction:   "send_application",
			NextPackPath: "output/next-packs/missing.md",
		},
	}
	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "/tmp/career-ops", 120, 40)

	updated, cmd := pm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'c'}})
	if cmd != nil {
		t.Fatal("c should no longer emit a copy command")
	}
	if !updated.statusPicker {
		t.Fatal("c should open the status picker for tracker rows")
	}
}

func TestHelpBarWrapsCommandsWithinWidth(t *testing.T) {
	apps := []model.CareerApplication{
		{
			Company:      "Acme",
			Role:         "AI Engineer",
			Status:       "Application Ready",
			ActionState:  "needs_action",
			NextAction:   "send_application",
			NextPackPath: "output/next-packs/042-acme.md",
		},
	}
	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "/tmp/career-ops", 96, 40)

	help := pm.renderHelp()
	lines := strings.Split(help, "\n")
	if len(lines) < 2 {
		t.Fatalf("expected help bar to wrap on narrow terminals, got %q", help)
	}
	for _, line := range lines {
		if got := lipgloss.Width(line); got != pm.width {
			t.Fatalf("help line width = %d, want %d; line=%q", got, pm.width, line)
		}
	}

	plain := ansi.Strip(help)
	if strings.Contains(plain, "copy") {
		t.Fatalf("help bar should not advertise copy commands, got %q", plain)
	}
	if !strings.Contains(plain, "n artifact") {
		t.Fatalf("help bar should keep the artifact opener when available, got %q", plain)
	}
	if !strings.Contains(plain, "c status") {
		t.Fatalf("help bar should describe c as status editing, got %q", plain)
	}
}

func TestShortPipelineListPinsFooterToViewportBottom(t *testing.T) {
	apps := []model.CareerApplication{
		{
			Number:      98,
			Date:        "2026-06-26",
			Company:     "Fin",
			Role:        "Senior Engineer, AI Developer",
			Status:      "Discarded",
			Score:       3.9,
			Location:    "Dublin, Ireland",
			WorkMode:    "Full",
			PayRange:    "EUR 97K-117K",
			LastContact: "2026-07-01",
			Notes:       "Discarded 2026-07-01: posting removed/expired.",
		},
	}
	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "..", 220, 24)
	pm.activeTab = tabIndexForFilter(t, filterDiscarded)
	pm.viewMode = "grouped"
	pm.applyFilterAndSort()

	view := pm.View()
	lines := strings.Split(view, "\n")
	if got := lipgloss.Height(view); got != pm.height {
		t.Fatalf("view height = %d, want %d:\n%s", got, pm.height, ansi.Strip(view))
	}
	if got := ansi.Strip(lines[len(lines)-1]); !strings.Contains(got, "q quit") {
		t.Fatalf("expected footer on final viewport row, got %q", got)
	}
	if got := ansi.Strip(lines[len(lines)-2]); !strings.Contains(got, "Outcome:") {
		t.Fatalf("expected preview footer directly above help footer, got %q", got)
	}

	locIdx := -1
	for i, line := range lines {
		if strings.Contains(ansi.Strip(line), "Loc:") {
			locIdx = i
			break
		}
	}
	if locIdx < 2 {
		t.Fatalf("expected preview footer with location details, got:\n%s", ansi.Strip(view))
	}
	if got := strings.TrimSpace(ansi.Strip(lines[locIdx-2])); got != "" {
		t.Fatalf("expected blank spacer above preview footer for a short list, got %q", got)
	}
}

// Regression: with no committed search query, Esc must NOT close the screen.
// The help bar advertises only `q quit`, so Esc quitting silently was a bug
// that surfaced as accidental exits when users hit Esc to "back out" of the UI.
func TestEscWithoutQueryIsNoOp(t *testing.T) {
	apps := []model.CareerApplication{
		{Company: "Stripe", Role: "Backend Engineer", Status: "Evaluated", Score: 4.6},
	}

	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "..", 120, 40)
	if pm.searchQuery != "" {
		t.Fatalf("setup expected empty search query, got %q", pm.searchQuery)
	}

	pm, cmd := pm.Update(tea.KeyMsg{Type: tea.KeyEsc})
	if cmd != nil {
		// PipelineClosedMsg used to fire here; ensure it doesn't anymore.
		if msg := cmd(); msg != nil {
			if _, ok := msg.(PipelineClosedMsg); ok {
				t.Fatalf("expected Esc with no query to be a no-op, got PipelineClosedMsg")
			}
			t.Fatalf("expected Esc with no query to return nil cmd, got %T", msg)
		}
	}
	if pm.searchInput {
		t.Fatal("Esc with no query should not toggle searchInput")
	}
}

func TestGroupedPageNavigationMovesByVisibleRows(t *testing.T) {
	apps := []model.CareerApplication{
		{Company: "A", Role: "A", Status: "Interview", Score: 5.0, ReportPath: "reports/a.md", WorkMode: "Remote", Location: "Madrid"},
		{Company: "B", Role: "B", Status: "Offer", Score: 4.9, ReportPath: "reports/b.md", WorkMode: "Remote", Location: "Madrid"},
		{Company: "C", Role: "C", Status: "Responded", Score: 4.8, ReportPath: "reports/c.md", WorkMode: "Remote", Location: "Madrid"},
		{Company: "D", Role: "D", Status: "Applied", Score: 4.7, ReportPath: "reports/d.md", WorkMode: "Remote", Location: "Madrid"},
		{Company: "E", Role: "E", Status: "Evaluated", Score: 4.6, ReportPath: "reports/e.md", WorkMode: "Remote", Location: "Madrid"},
		{Company: "F", Role: "F", Status: "SKIP", Score: 4.5, ReportPath: "reports/f.md", WorkMode: "Remote", Location: "Madrid"},
		{Company: "G", Role: "G", Status: "Rejected", Score: 4.4, ReportPath: "reports/g.md", WorkMode: "Remote", Location: "Madrid"},
		{Company: "H", Role: "H", Status: "Discarded", Score: 4.3, ReportPath: "reports/h.md", WorkMode: "Remote", Location: "Madrid"},
	}

	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "..", 120, 20)
	pm.viewMode = "grouped"
	pm.applyFilterAndSort()
	for _, app := range apps {
		pm.reportCache[app.ReportPath] = reportSummary{
			archetype: "Forward Deployed Engineer",
			tldr:      "strong applied AI fit",
			comp:      "$180K-220K",
			remote:    "Remote-friendly",
		}
	}

	expectedForward := pm.cursorForVisualLine(pm.cursorLineEstimate() + pm.pageRows())
	pm, _ = pm.Update(tea.KeyMsg{Type: tea.KeyCtrlF})
	if pm.cursor != expectedForward {
		t.Fatalf("Ctrl+F in grouped view moved to cursor %d, want %d", pm.cursor, expectedForward)
	}

	pm.cursor = 6
	pm.adjustScroll()
	expectedBackward := pm.cursorForVisualLine(pm.cursorLineEstimate() - pm.pageRows())
	pm, _ = pm.Update(tea.KeyMsg{Type: tea.KeyCtrlB})
	if pm.cursor != expectedBackward {
		t.Fatalf("Ctrl+B in grouped view moved to cursor %d, want %d", pm.cursor, expectedBackward)
	}
}

func TestPipelineSafePageKeysMirrorCtrlPageKeys(t *testing.T) {
	apps := make([]model.CareerApplication, 20)
	for i := range apps {
		apps[i] = model.CareerApplication{
			Company: "Company",
			Role:    "Role",
			Status:  "Evaluated",
			Score:   float64(20 - i),
		}
	}

	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "..", 120, 20)
	pm.viewMode = "flat"
	pm.applyFilterAndSort()

	pageRows := pm.pageRows()
	pm, _ = pm.Update(tea.KeyMsg{Type: tea.KeySpace})
	if pm.cursor != pageRows {
		t.Fatalf("Space moved to cursor %d, want %d", pm.cursor, pageRows)
	}

	pm, _ = pm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'b'}})
	if pm.cursor != 0 {
		t.Fatalf("b should page back to the first row, got cursor %d", pm.cursor)
	}
}

// Regression: typing during search input must not synchronously fan out to
// loadCurrentReport. Reading reports per keystroke caused visible UI lag, so
// the load is deferred to commit (Enter) / cancel (Esc) instead.
func TestSearchTypingDoesNotLoadReports(t *testing.T) {
	apps := []model.CareerApplication{
		{Company: "Stripe", Role: "Backend Engineer", Status: "Evaluated", Score: 4.6, ReportPath: "reports/001-stripe.md"},
		{Company: "Anthropic", Role: "AI Engineer", Status: "Evaluated", Score: 4.8, ReportPath: "reports/002-anthropic.md"},
	}

	pm := NewPipelineModel(theme.NewTheme("catppuccin-mocha"), apps, model.PipelineMetrics{Total: len(apps)}, "..", 120, 40)

	pm, _ = pm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'/'}})
	if !pm.searchInput {
		t.Fatal("expected `/` to open search input")
	}

	// Typing must not trigger PipelineLoadReportMsg.
	for _, r := range "stri" {
		var cmd tea.Cmd
		pm, cmd = pm.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
		if cmd != nil {
			if msg := cmd(); msg != nil {
				if _, ok := msg.(PipelineLoadReportMsg); ok {
					t.Fatalf("typing rune %q should not emit PipelineLoadReportMsg", string(r))
				}
			}
		}
	}

	// Backspace must not trigger PipelineLoadReportMsg either.
	pm, cmd := pm.Update(tea.KeyMsg{Type: tea.KeyBackspace})
	if cmd != nil {
		if msg := cmd(); msg != nil {
			if _, ok := msg.(PipelineLoadReportMsg); ok {
				t.Fatal("Backspace during search input should not emit PipelineLoadReportMsg")
			}
		}
	}

	// Ctrl+U must not trigger PipelineLoadReportMsg either.
	pm, cmd = pm.Update(tea.KeyMsg{Type: tea.KeyCtrlU})
	if cmd != nil {
		if msg := cmd(); msg != nil {
			if _, ok := msg.(PipelineLoadReportMsg); ok {
				t.Fatal("Ctrl+U during search input should not emit PipelineLoadReportMsg")
			}
		}
	}
}

func previewModelWith(t *testing.T, app model.CareerApplication) PipelineModel {
	t.Helper()

	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		[]model.CareerApplication{app},
		model.PipelineMetrics{Total: 1},
		"..",
		120,
		40,
	)
	pm.applyFilterAndSort()
	pm.cursor = 0
	return pm
}

func TestPreviewKeepsDiscardReasonWhenTlDrIsCached(t *testing.T) {
	app := model.CareerApplication{
		Company:    "Acme",
		Role:       "Backend Engineer",
		Status:     "Descartado 2026-03-12",
		Notes:      "took too long to respond",
		ReportPath: "reports/001-acme.md",
	}
	pm := previewModelWith(t, app)
	pm.reportCache[app.ReportPath] = reportSummary{tldr: "great team, fast pace"}

	preview := pm.renderPreview()

	if !strings.Contains(preview, "great team, fast pace") {
		t.Fatalf("expected preview to keep the cached TL;DR, got %q", preview)
	}
	// Regression for #787: before the Outcome line, a cached TL;DR replaced the
	// notes entirely and the discard reason disappeared from the preview.
	if !strings.Contains(preview, "took too long to respond") {
		t.Fatalf("expected preview to keep the discard reason alongside the TL;DR, got %q", preview)
	}
	if !strings.Contains(preview, "Descartado 2026-03-12") {
		t.Fatalf("expected preview to show the closing status, got %q", preview)
	}
}

func TestPreviewOutcomeShownWithoutReportSummary(t *testing.T) {
	pm := previewModelWith(t, model.CareerApplication{
		Company: "Beta",
		Role:    "Platform Engineer",
		Status:  "SKIP",
		Notes:   "geo blocker",
	})

	preview := pm.renderPreview()

	if !strings.Contains(preview, "Outcome:") || !strings.Contains(preview, "geo blocker") {
		t.Fatalf("expected outcome line with notes for skipped app, got %q", preview)
	}
	if strings.Count(preview, "geo blocker") != 1 {
		t.Fatalf("expected notes to appear exactly once, got %q", preview)
	}
}

func TestPreviewOutcomeOmittedForActiveApps(t *testing.T) {
	app := model.CareerApplication{
		Company:    "Gamma",
		Role:       "AI Engineer",
		Status:     "Applied 2026-04-01",
		Notes:      "warm intro via referral",
		ReportPath: "reports/003-gamma.md",
	}
	pm := previewModelWith(t, app)
	pm.reportCache[app.ReportPath] = reportSummary{tldr: "strong fit"}

	preview := pm.renderPreview()

	if strings.Contains(preview, "Outcome:") {
		t.Fatalf("expected no outcome line for an active app, got %q", preview)
	}
}

func TestPreviewOutcomeForStatusWithoutNotes(t *testing.T) {
	pm := previewModelWith(t, model.CareerApplication{
		Company: "Delta",
		Role:    "SRE",
		Status:  "**Rejected** 2026-05-02",
	})

	preview := pm.renderPreview()

	if !strings.Contains(preview, "Rejected 2026-05-02") {
		t.Fatalf("expected outcome to show the bare closing status, got %q", preview)
	}
	if strings.Contains(preview, "Loading preview...") {
		t.Fatalf("expected outcome line to replace the loading placeholder, got %q", preview)
	}
}

func TestWithReloadedDataPreservesCursorWhenAppRemoved(t *testing.T) {
	initialApps := []model.CareerApplication{
		{
			Company:    "Acme",
			Role:       "Backend Engineer",
			Status:     "Applied",
			Score:      4.2,
			ReportPath: "reports/001-acme.md",
		},
		{
			Company:    "Beta",
			Role:       "Platform Engineer",
			Status:     "Applied",
			Score:      4.6,
			ReportPath: "reports/002-beta.md",
		},
		{
			Company:    "Gamma",
			Role:       "AI Engineer",
			Status:     "Applied",
			Score:      4.8,
			ReportPath: "reports/003-gamma.md",
		},
	}

	pm := NewPipelineModel(
		theme.NewTheme("catppuccin-mocha"),
		initialApps,
		model.PipelineMetrics{Total: len(initialApps)},
		"..",
		120,
		40,
	)
	pm.activeTab = tabIndexForFilter(t, filterApplied)
	pm.applyFilterAndSort()
	pm.cursor = 1

	refreshedApps := []model.CareerApplication{
		initialApps[0],
		{
			Company:    "Beta",
			Role:       "Platform Engineer",
			Status:     "Rejected", // Changed!
			Score:      4.6,
			ReportPath: "reports/002-beta.md",
		},
		initialApps[2],
	}

	reloaded := pm.WithReloadedData(refreshedApps, model.PipelineMetrics{Total: len(refreshedApps)})

	if got := len(reloaded.filtered); got != 2 {
		t.Fatalf("expected 2 filtered apps after refresh, got %d", got)
	}
	if reloaded.cursor < 0 || reloaded.cursor >= len(reloaded.filtered) {
		t.Fatalf("expected cursor to be within [0, %d], got %d", len(reloaded.filtered)-1, reloaded.cursor)
	}
}

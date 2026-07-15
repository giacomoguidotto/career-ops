package screens

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

// PipelineClosedMsg is emitted when the pipeline screen is dismissed.
type PipelineClosedMsg struct{}

// PipelineOpenReportMsg is emitted when a report should be opened in FileViewer.
type PipelineOpenReportMsg struct {
	Path   string
	Title  string
	JobURL string
	App    model.DashboardRow
}

// PipelineOpenURLMsg is emitted when a job URL should be opened in browser.
type PipelineOpenURLMsg struct {
	URL string
}

// PipelineOpenPDFMsg is emitted when a generated CV PDF should be opened
// with the OS default handler. Path is absolute.
type PipelineOpenPDFMsg struct {
	Path string
}

// PipelineGeneratePDFMsg requests a PDF regeneration via generate-pdf.mjs
// from the application's recorded source HTML. Paths are relative to
// CareerOpsPath (as recorded in the manifest).
type PipelineGeneratePDFMsg struct {
	CareerOpsPath string
	ReportNumber  string
	HTMLPath      string
	PDFPath       string
	Format        string
}

// PipelinePDFGeneratedMsg reports the outcome of a regeneration. On success
// Err is empty and Path holds the absolute path of the (already opened) PDF.
type PipelinePDFGeneratedMsg struct {
	Err  string
	Path string
}

// PipelineLoadReportMsg requests lazy loading of a report summary.
type PipelineLoadReportMsg struct {
	CareerOpsPath string
	ReportPath    string
}

// PipelineUpdateStatusMsg requests a status update for an application.
type PipelineUpdateStatusMsg struct {
	CareerOpsPath string
	App           model.DashboardRow
	NewStatus     string
}

// PipelineUpdateStatusAndNotesMsg requests updating both status and notes.
type PipelineUpdateStatusAndNotesMsg struct {
	CareerOpsPath string
	App           model.DashboardRow
	NewStatus     string
	NewNotes      string
}

// PipelineRefreshMsg requests a full tracker reload from disk.
type PipelineRefreshMsg struct{}

// PipelineOpenProgressMsg is emitted when the progress screen should open.
type PipelineOpenProgressMsg struct{}

type reportSummary struct {
	archetype string
	tldr      string
	remote    string
	comp      string
}

const storyTemplateURL = "https://github.com/santifer/career-ops/issues/new?template=i-got-hired.yml"

// Sort modes
const (
	sortScore    = "score"
	sortDate     = "date"
	sortCompany  = "company"
	sortStatus   = "status"
	sortLocation = "location"
	sortPay      = "pay"
	sortLast     = "last"
)

// Filter modes
const (
	filterAll        = "all"
	filterEvaluated  = "evaluated"
	filterApproached = "approached"
	filterApplied    = filterApproached // compatibility for persisted/test tab references
	filterInterview  = "interview"
	filterOffer      = "offer"
	filterAccepted   = "accepted"
	filterSkip       = "skip"
	filterRejected   = "rejected"
	filterDiscarded  = "discarded"
	filterQueue      = "queue"
)

type pipelineTab struct {
	filter string
	label  string
}

var pipelineTabs = []pipelineTab{
	{filterQueue, "QUEUE"},
	{filterAll, "ALL"},
	{filterEvaluated, "EVALUATED"},
	{filterApproached, "APPROACHED"},
	{filterInterview, "INTERVIEW"},
	{filterOffer, "OFFER"},
	{filterAccepted, "ACCEPTED"},
	{filterRejected, "REJECTED"},
	{filterDiscarded, "DISCARDED"},
	{filterSkip, "SKIP"},
}

func pipelineTabIndex(filter string) int {
	for i, tab := range pipelineTabs {
		if tab.filter == filter {
			return i
		}
	}
	return 0
}

func normalizePipelineTabIndex(index int) int {
	if index >= 0 && index < len(pipelineTabs) {
		return index
	}
	return pipelineTabIndex(filterAll)
}

var sortCycle = []string{sortScore, sortDate, sortCompany, sortStatus, sortLocation, sortPay, sortLast}

// ColumnID identifies an optional table column in the pipeline view.
type ColumnID int

const (
	// Optional columns — user-toggleable via the column picker (C key).
	ColDate        ColumnID = iota // tracker date
	ColLocation                    // LOCATION city+state
	ColPay                         // PAY range
	ColHasReport                   // RPT: ✓/—
	ColHasPDF                      // PDF: ✓/—
	ColLastContact                 // LAST contact date
	ColNext                        // NEXT STEP action
)

// colDef describes one optional column for the picker UI.
type colDef struct {
	id          ColumnID
	header      string
	hint        string
	width       int
	onByDefault bool
}

var optionalCols = []colDef{
	{ColDate, "DATE", "", 10, true},
	{ColLocation, "LOCATION", "", 20, true},
	{ColPay, "PAY", "", 16, true},
	{ColHasReport, "RPT", "✓/—", 4, false},
	{ColHasPDF, "PDF", "✓/—", 4, false},
	{ColLastContact, "LAST", "", 10, false},
	{ColNext, "NEXT STEP", "action", 22, true},
}

// Approached is intentionally absent: entering it requires a typed, confirmed
// Approach Attempt through record-approach.mjs, not a bare status mutation.
var statusOptions = []string{"Evaluated", "Approach Ready", "Responded", "Interview Ready", "Offer", "Offer Ready", "Accepted", "Rejected", "Discarded", "SKIP"}

// statusGroupOrder defines display order for grouped view.
var statusGroupOrder = []string{"processing", "pending", "failed", "rate_limited", "paused", "unmerged_complete", "interview", "offer", "accepted", "responded", "approached", "evaluated", "skip", "rejected", "discarded"}

// PipelineModel implements the career pipeline dashboard screen.
type PipelineModel struct {
	apps          []model.DashboardRow
	filtered      []model.DashboardRow
	metrics       model.PipelineMetrics
	cursor        int
	scrollOffset  int
	sortMode      string
	activeTab     int
	viewMode      string // "grouped" or "flat"
	width, height int
	theme         theme.Theme
	careerOpsPath string
	reportCache   map[string]reportSummary
	// Status picker sub-state
	statusPicker bool
	statusCursor int
	// PDF picker sub-state — shown when one application matches several
	// generated CVs (role variants from the same company).
	pdfPicker  bool
	pdfCursor  int
	pdfChoices []string // root-relative paths, newest first
	// flash is a one-shot notice rendered in place of the help bar; any
	// keypress clears it.
	flash string
	// Search sub-state — narrows the active tab by substring on company/role/notes.
	searchInput bool   // true while the user is typing the query
	searchQuery string // committed (or in-progress) lowercased query
	// Column picker sub-state — opened with C, closed with esc.
	colPicker    bool
	colPickerIdx int
	visibleCols  map[ColumnID]bool

	// Hired win flow sub-state (Issue 1447)
	hiredApp  model.DashboardRow
	hiredStep int // 0 = inactive, 1 = celebration, 2 = story invite, 3 = anonymous stat

	// Discard reason picker sub-state (Issue 1380)
	discardApp      model.DashboardRow
	discardStatus   string // "Discarded" or "SKIP"
	discardStep     int    // 0 = inactive, 1 = pick reason, 2 = custom reason input
	discardOptions  []string
	discardCursor   int
	discardInputVal string
}

// NewPipelineModel creates a new pipeline screen.
func NewPipelineModel(t theme.Theme, apps []model.DashboardRow, metrics model.PipelineMetrics, careerOpsPath string, width, height int) PipelineModel {
	visible := make(map[ColumnID]bool)
	for _, col := range optionalCols {
		visible[col.id] = col.onByDefault
	}
	m := PipelineModel{
		apps:          apps,
		metrics:       metrics,
		sortMode:      sortScore,
		activeTab:     pipelineTabIndex(filterAll),
		viewMode:      "grouped",
		width:         width,
		height:        height,
		theme:         t,
		careerOpsPath: careerOpsPath,
		reportCache:   make(map[string]reportSummary),
		visibleCols:   visible,
	}
	m.applyFilterAndSort()
	return m
}

// Init implements tea.Model.
func (m PipelineModel) Init() tea.Cmd {
	return nil
}

// Resize updates dimensions.
func (m *PipelineModel) Resize(width, height int) {
	m.width = width
	m.height = height
}

// Width returns the current width.
func (m PipelineModel) Width() int { return m.width }

// Height returns the current height.
func (m PipelineModel) Height() int { return m.height }

// CopyReportCache copies the report cache from another pipeline model.
func (m *PipelineModel) CopyReportCache(other *PipelineModel) {
	for k, v := range other.reportCache {
		m.reportCache[k] = v
	}
}

// EnrichReport caches report summary data for preview.
func (m *PipelineModel) EnrichReport(reportPath, archetype, tldr, remote, comp string) {
	m.reportCache[reportPath] = reportSummary{
		archetype: archetype,
		tldr:      tldr,
		remote:    remote,
		comp:      comp,
	}
}

// WithReloadedData rebuilds the pipeline with fresh tracker data while preserving
// the current UI state so manual refresh feels seamless.
func (m PipelineModel) WithReloadedData(apps []model.DashboardRow, metrics model.PipelineMetrics) PipelineModel {
	selectedIdentity := ""
	selectedScrollOffset := m.scrollOffset
	if app, ok := m.CurrentApp(); ok {
		selectedIdentity = dashboardRowIdentity(app)
	}

	reloaded := NewPipelineModel(m.theme, apps, metrics, m.careerOpsPath, m.width, m.height)
	reloaded.sortMode = m.sortMode
	reloaded.activeTab = normalizePipelineTabIndex(m.activeTab)
	reloaded.viewMode = m.viewMode
	// Preserve search state across refresh — otherwise pressing `r` silently drops a
	// committed query and the user loses their place mid-investigation.
	reloaded.searchQuery = m.searchQuery
	reloaded.searchInput = m.searchInput
	// Preserve user's column visibility choices across refresh.
	reloaded.visibleCols = m.visibleCols
	reloaded.applyFilterAndSort()
	reloaded.CopyReportCache(&m)

	for i, app := range reloaded.filtered {
		if selectedIdentity != "" && dashboardRowIdentity(app) == selectedIdentity {
			reloaded.cursor = i
			reloaded.restoreScrollOffset(selectedScrollOffset)
			return reloaded
		}
	}

	if len(reloaded.filtered) == 0 {
		reloaded.cursor = 0
		reloaded.scrollOffset = 0
		return reloaded
	}

	if m.cursor >= len(reloaded.filtered) {
		reloaded.cursor = len(reloaded.filtered) - 1
	} else if m.cursor > 0 {
		reloaded.cursor = m.cursor
	}
	reloaded.restoreScrollOffset(selectedScrollOffset)
	return reloaded
}

func (m *PipelineModel) restoreScrollOffset(offset int) {
	m.scrollOffset = offset
	maxOffset := lipgloss.Height(m.renderBody()) - m.bodyViewportRows()
	if maxOffset < 0 {
		maxOffset = 0
	}
	if m.scrollOffset > maxOffset {
		m.scrollOffset = maxOffset
	}
	if m.scrollOffset < 0 {
		m.scrollOffset = 0
	}
	m.adjustScroll()
}

func dashboardRowIdentity(app model.DashboardRow) string {
	if !app.IsTrackedApplication() {
		if app.JobURL != "" {
			return "queue:url:" + app.JobURL
		}
		if app.ReportNumber != "" {
			return "queue:report:" + app.ReportNumber
		}
		return "queue:" + string(app.Source) + ":" + app.Company + ":" + app.Role
	}
	if app.ReportNumber != "" {
		return "tracker:report:" + app.ReportNumber
	}
	if app.Number > 0 {
		return fmt.Sprintf("tracker:number:%d", app.Number)
	}
	return "tracker:" + app.Company + ":" + app.Role
}

// CurrentApp returns the currently selected application, if any.
func (m PipelineModel) CurrentApp() (model.DashboardRow, bool) {
	if m.cursor < 0 || m.cursor >= len(m.filtered) {
		return model.DashboardRow{}, false
	}
	return m.filtered[m.cursor], true
}

// Update handles input for the pipeline screen.
func (m PipelineModel) Update(msg tea.Msg) (PipelineModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		m.flash = ""
		if m.hiredStep > 0 {
			return m.handleHiredFlow(msg)
		}
		if m.discardStep > 0 {
			return m.handleDiscardFlow(msg)
		}
		if m.colPicker {
			return m.handleColPicker(msg)
		}
		if m.statusPicker {
			return m.handleStatusPicker(msg)
		}
		if m.pdfPicker {
			return m.handlePDFPicker(msg)
		}
		if m.searchInput {
			return m.handleSearchInput(msg)
		}
		return m.handleKey(msg)
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	case PipelinePDFGeneratedMsg:
		if msg.Err != "" {
			m.flash = "PDF regeneration failed: " + msg.Err
		} else {
			m.flash = "PDF regenerated and opened: " + filepath.Base(msg.Path)
		}
		return m, nil
	}
	return m, nil
}

func (m PipelineModel) handleKey(msg tea.KeyMsg) (PipelineModel, tea.Cmd) {
	if isPageDownKey(msg) {
		if len(m.filtered) > 0 {
			m = m.moveCursorByVisualRows(m.pageRows())
			return m, m.loadCurrentReport()
		}
		return m, nil
	}

	if isPageUpKey(msg) {
		if len(m.filtered) > 0 {
			m = m.moveCursorByVisualRows(-m.pageRows())
			return m, m.loadCurrentReport()
		}
		return m, nil
	}

	switch msg.String() {
	case "esc":
		// While a search is committed, Esc clears the search (matches vim's `:nohl`
		// ergonomics). With no query, Esc is a no-op — q is the only quit key, which
		// keeps the help bar honest and avoids accidental exits.
		if m.searchQuery != "" {
			m.searchQuery = ""
			m.applyFilterAndSort()
			m.cursor = 0
			m.scrollOffset = 0
			return m, m.loadCurrentReport()
		}
		return m, nil

	case "q":
		return m, func() tea.Msg { return PipelineClosedMsg{} }

	case "/":
		// Open search input. Pre-fill with the current query so refining is one keystroke away.
		m.searchInput = true
		return m, nil

	case "down", "j":
		if len(m.filtered) > 0 {
			m.cursor++
			if m.cursor >= len(m.filtered) {
				m.cursor = len(m.filtered) - 1
			}
			m.adjustScroll()
			return m, m.loadCurrentReport()
		}

	case "up", "k":
		if len(m.filtered) > 0 {
			m.cursor--
			if m.cursor < 0 {
				m.cursor = 0
			}
			m.adjustScroll()
			return m, m.loadCurrentReport()
		}

	case "s":
		// Cycle sort mode
		for i, s := range sortCycle {
			if s == m.sortMode {
				m.sortMode = sortCycle[(i+1)%len(sortCycle)]
				break
			}
		}
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0

	case "f", "right", "l":
		m.activeTab++
		if m.activeTab >= len(pipelineTabs) {
			m.activeTab = 0
		}
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0

	case "left", "h":
		m.activeTab--
		if m.activeTab < 0 {
			m.activeTab = len(pipelineTabs) - 1
		}
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0

	case "v":
		if m.viewMode == "grouped" {
			m.viewMode = "flat"
		} else {
			m.viewMode = "grouped"
		}

	case "enter":
		if app, ok := m.CurrentApp(); ok && app.ReportPath != "" {
			fullPath := filepath.Join(m.careerOpsPath, app.ReportPath)
			title := detailsViewerTitle(app)
			jobURL := app.JobURL
			return m, func() tea.Msg {
				return PipelineOpenReportMsg{Path: fullPath, Title: title, JobURL: jobURL, App: app}
			}
		}

	case "o":
		if app, ok := m.CurrentApp(); ok && app.JobURL != "" {
			return m, func() tea.Msg {
				return PipelineOpenURLMsg{URL: app.JobURL}
			}
		}

	case "d":
		if app, ok := m.CurrentApp(); ok {
			manifest := data.LoadPDFManifest(m.careerOpsPath)
			candidates := data.ResolvePDFs(m.careerOpsPath, app, manifest)
			if len(candidates) == 0 {
				m.flash = "No CV PDF found for this application — generate one with /career-ops pdf"
			} else {
				return m, m.openPDFCmd(candidates[0]) // newest first
			}
		}

	case "D":
		if app, ok := m.CurrentApp(); ok {
			manifest := data.LoadPDFManifest(m.careerOpsPath)
			entry, found := manifest.Lookup(app)
			// Manifest lookup requires a report number; fall back to PDF-path
			// index when the manifest was written without --report (common case).
			if !found || entry.HTMLPath == "" {
				byPath := data.LoadPDFEntriesByPath(m.careerOpsPath)
				candidates := data.ResolvePDFs(m.careerOpsPath, app, manifest)
				for _, c := range candidates {
					if e, ok := byPath[c]; ok && e.HTMLPath != "" {
						entry = e
						found = true
						break
					}
				}
			}
			if !found || entry.HTMLPath == "" {
				m.flash = "No source HTML found for this application — run /career-ops pdf first"
				return m, nil
			}
			if _, err := os.Stat(filepath.Join(m.careerOpsPath, filepath.FromSlash(entry.HTMLPath))); err != nil {
				m.flash = "Source HTML missing: " + entry.HTMLPath
				return m, nil
			}
			m.flash = "Regenerating PDF via generate-pdf.mjs — this takes a few seconds..."
			path, report := m.careerOpsPath, entry.ReportNumber
			html, pdf, format := entry.HTMLPath, entry.PDFPath, entry.Format
			return m, func() tea.Msg {
				return PipelineGeneratePDFMsg{
					CareerOpsPath: path,
					ReportNumber:  report,
					HTMLPath:      html,
					PDFPath:       pdf,
					Format:        format,
				}
			}
		}

	case "p":
		return m, func() tea.Msg { return PipelineOpenProgressMsg{} }

	case "r":
		return m, func() tea.Msg { return PipelineRefreshMsg{} }

	case "C":
		m.colPicker = true
		m.colPickerIdx = 0
		return m, nil

	case "c":
		if app, ok := m.CurrentApp(); ok && app.IsTrackedApplication() {
			m.statusPicker = true
			m.statusCursor = 0
		}

	case "home", "g":
		if len(m.filtered) > 0 {
			m.cursor = 0
			m.scrollOffset = 0
			return m, m.loadCurrentReport()
		}

	case "end", "G":
		if len(m.filtered) > 0 {
			m.cursor = len(m.filtered) - 1
			m.adjustScroll()
			return m, m.loadCurrentReport()
		}

	case "ctrl+d":
		if len(m.filtered) > 0 {
			m = m.moveCursorByVisualRows(m.halfPageRows())
			return m, m.loadCurrentReport()
		}

	case "ctrl+u":
		if len(m.filtered) > 0 {
			m = m.moveCursorByVisualRows(-m.halfPageRows())
			return m, m.loadCurrentReport()
		}
	}

	return m, nil
}

func isPageDownKey(msg tea.KeyMsg) bool {
	switch msg.Type {
	case tea.KeyPgDown, tea.KeyCtrlF, tea.KeySpace:
		return true
	case tea.KeyRunes:
		return string(msg.Runes) == " "
	}
	return false
}

func isPageUpKey(msg tea.KeyMsg) bool {
	switch msg.Type {
	case tea.KeyPgUp, tea.KeyCtrlB:
		return true
	case tea.KeyRunes:
		return string(msg.Runes) == "b"
	}
	return false
}

// handleSearchInput consumes keys while the search input bar is open.
// Esc cancels (closes input AND clears query). Enter commits (closes input,
// keeps query, refreshes filtered list). Backspace + printable chars edit
// the query and live-update the filter so the user sees results as they type.
//
// Report previews are NOT lazy-loaded on every keystroke — that would trigger
// a synchronous os.ReadFile per rune/backspace/ctrl+u and stutter live
// typing. Instead the load fires once when the user commits (Enter) or
// cancels (Esc); subsequent cursor movement in handleKey loads as before.
func (m PipelineModel) handleSearchInput(msg tea.KeyMsg) (PipelineModel, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.searchInput = false
		m.searchQuery = ""
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0
		return m, m.loadCurrentReport()

	case "enter":
		m.searchInput = false
		// Query already applied during typing; load the preview for the
		// committed first match (skipped during typing for perf).
		return m, m.loadCurrentReport()

	case "backspace":
		if len(m.searchQuery) > 0 {
			// Drop the last UTF-8 rune so multi-byte characters delete cleanly.
			runes := []rune(m.searchQuery)
			m.searchQuery = string(runes[:len(runes)-1])
			m.applyFilterAndSort()
			m.cursor = 0
			m.scrollOffset = 0
		}
		return m, nil

	case "ctrl+u":
		// vim-flavored: clear the in-progress query without leaving search mode.
		m.searchQuery = ""
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0
		return m, nil
	}

	// Append printable runes (ignore other special keys like arrows / ctrl-combos).
	if r := msg.Runes; len(r) > 0 {
		m.searchQuery += strings.ToLower(string(r))
		m.applyFilterAndSort()
		m.cursor = 0
		m.scrollOffset = 0
		return m, nil
	}
	return m, nil
}

func (m PipelineModel) handleStatusPicker(msg tea.KeyMsg) (PipelineModel, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		m.statusPicker = false
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
		if app, ok := m.CurrentApp(); ok {
			newStatus := statusOptions[m.statusCursor]
			norm := data.NormalizeStatus(newStatus)
			if norm == "accepted" {
				m.hiredApp = app
				m.hiredStep = 1
				return m, func() tea.Msg {
					return PipelineUpdateStatusMsg{
						CareerOpsPath: m.careerOpsPath,
						App:           app,
						NewStatus:     newStatus,
					}
				}
			}
			if norm == "discarded" || norm == "skip" {
				return m.StartDiscardReasonFlow(app, newStatus)
			}
			return m, func() tea.Msg {
				return PipelineUpdateStatusMsg{
					CareerOpsPath: m.careerOpsPath,
					App:           app,
					NewStatus:     newStatus,
				}
			}
		}
	}
	return m, nil
}

// handlePDFPicker consumes keys while the PDF picker overlay is open.
func (m PipelineModel) handlePDFPicker(msg tea.KeyMsg) (PipelineModel, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		m.pdfPicker = false
		return m, nil

	case "down", "j":
		m.pdfCursor++
		if m.pdfCursor >= len(m.pdfChoices) {
			m.pdfCursor = len(m.pdfChoices) - 1
		}

	case "up", "k":
		m.pdfCursor--
		if m.pdfCursor < 0 {
			m.pdfCursor = 0
		}

	case "enter", "d":
		m.pdfPicker = false
		if m.pdfCursor >= 0 && m.pdfCursor < len(m.pdfChoices) {
			return m, m.openPDFCmd(m.pdfChoices[m.pdfCursor])
		}
	}
	return m, nil
}

func (m PipelineModel) StartHiredFlow(app model.DashboardRow) (PipelineModel, tea.Cmd) {
	m.hiredApp = app
	m.hiredStep = 1
	return m, nil
}

func (m PipelineModel) StartDiscardReasonFlow(app model.DashboardRow, status string) (PipelineModel, tea.Cmd) {
	m.discardApp = app
	m.discardStatus = status
	m.discardStep = 1

	reasons := data.LoadReportDiscardReasons(m.careerOpsPath, app.ReportPath)
	reasons = append(reasons, "Salary below target", "Wrong location/timezone", "Not a fit for target archetypes", "Wrong company size / structure", "Other...")

	keys := make(map[string]bool)
	var list []string
	for _, entry := range reasons {
		if entry == "" {
			continue
		}
		if _, seen := keys[entry]; !seen {
			keys[entry] = true
			list = append(list, entry)
		}
	}
	m.discardOptions = list
	m.discardCursor = 0
	return m, nil
}

func (m PipelineModel) handleHiredFlow(msg tea.KeyMsg) (PipelineModel, tea.Cmd) {
	switch m.hiredStep {
	case 1: // win screen
		if msg.String() == "enter" {
			m.hiredStep = 2
		}
	case 2: // story invite
		switch msg.String() {
		case "y", "Y":
			m.hiredStep = 3
			return m, func() tea.Msg {
				return PipelineOpenURLMsg{URL: storyTemplateURL}
			}
		case "n", "N", "enter", "esc":
			m.hiredStep = 3
		}
	case 3: // anonymous stat
		switch msg.String() {
		case "y", "Y":
			weeks := m.calculateWeeksToHire()
			if err := data.SaveAnonymousStat(m.careerOpsPath, m.hiredApp.Role, weeks); err != nil {
				m.flash = "Could not record anonymous stat: " + err.Error()
			}
			m.hiredStep = 0
		case "n", "N", "enter", "esc":
			m.hiredStep = 0
		}
	}
	return m, nil
}

func (m PipelineModel) handleDiscardFlow(msg tea.KeyMsg) (PipelineModel, tea.Cmd) {
	if m.discardStep == 1 {
		switch msg.String() {
		case "esc", "q":
			m.discardStep = 0
			return m, nil
		case "down", "j":
			m.discardCursor++
			if m.discardCursor >= len(m.discardOptions) {
				m.discardCursor = len(m.discardOptions) - 1
			}
		case "up", "k":
			m.discardCursor--
			if m.discardCursor < 0 {
				m.discardCursor = 0
			}
		case "enter":
			selected := m.discardOptions[m.discardCursor]
			if selected == "Other..." {
				m.discardStep = 2
				m.discardInputVal = ""
			} else {
				reasonNotes := fmt.Sprintf("%s: %s", strings.ToUpper(m.discardStatus), selected)
				m.discardStep = 0
				return m, func() tea.Msg {
					return PipelineUpdateStatusAndNotesMsg{
						CareerOpsPath: m.careerOpsPath,
						App:           m.discardApp,
						NewStatus:     m.discardStatus,
						NewNotes:      reasonNotes,
					}
				}
			}
		}
	} else if m.discardStep == 2 {
		switch msg.String() {
		case "esc":
			m.discardStep = 1
			return m, nil
		case "backspace", "ctrl+h":
			runes := []rune(m.discardInputVal)
			if len(runes) > 0 {
				m.discardInputVal = string(runes[:len(runes)-1])
			}
		case "enter":
			reasonNotes := fmt.Sprintf("%s: %s", strings.ToUpper(m.discardStatus), strings.TrimSpace(m.discardInputVal))
			m.discardStep = 0
			return m, func() tea.Msg {
				return PipelineUpdateStatusAndNotesMsg{
					CareerOpsPath: m.careerOpsPath,
					App:           m.discardApp,
					NewStatus:     m.discardStatus,
					NewNotes:      reasonNotes,
				}
			}
		default:
			if len(msg.Runes) > 0 {
				m.discardInputVal += string(msg.Runes)
			}
		}
	}
	return m, nil
}

func (m PipelineModel) calculateWeeksToHire() int {
	if m.hiredApp.Date == "" {
		return 1
	}
	appDate, err := time.Parse("2006-01-02", m.hiredApp.Date)
	if err != nil {
		return 1
	}
	days := int(time.Since(appDate).Hours() / 24)
	weeks := (days + 3) / 7
	if weeks < 1 {
		weeks = 1
	}
	return weeks
}

// handleColPicker consumes keys while the column picker overlay is open.
func (m PipelineModel) handleColPicker(msg tea.KeyMsg) (PipelineModel, tea.Cmd) {
	switch msg.String() {
	case "esc", "q", "C":
		m.colPicker = false
		return m, nil

	case "down", "j":
		m.colPickerIdx++
		if m.colPickerIdx >= len(optionalCols) {
			m.colPickerIdx = len(optionalCols) - 1
		}

	case "up", "k":
		m.colPickerIdx--
		if m.colPickerIdx < 0 {
			m.colPickerIdx = 0
		}

	case " ":
		col := optionalCols[m.colPickerIdx]
		m.visibleCols[col.id] = !m.visibleCols[col.id]
	}
	return m, nil
}

// openPDFCmd emits a PipelineOpenPDFMsg for a root-relative PDF path.
func (m PipelineModel) openPDFCmd(relPath string) tea.Cmd {
	fullPath := filepath.Join(m.careerOpsPath, filepath.FromSlash(relPath))
	return func() tea.Msg {
		return PipelineOpenPDFMsg{Path: fullPath}
	}
}

func (m PipelineModel) loadCurrentReport() tea.Cmd {
	app, ok := m.CurrentApp()
	if !ok || app.ReportPath == "" {
		return nil
	}
	if _, cached := m.reportCache[app.ReportPath]; cached {
		return nil
	}
	path := m.careerOpsPath
	report := app.ReportPath
	return func() tea.Msg {
		return PipelineLoadReportMsg{CareerOpsPath: path, ReportPath: report}
	}
}

// matchesSearch reports whether app contains the query as a case-insensitive
// substring of its company, role, or notes. Empty query matches everything.
// Lowercases both sides so callers don't have to remember the contract.
func matchesSearch(app model.DashboardRow, query string) bool {
	if query == "" {
		return true
	}
	q := strings.ToLower(query)
	if strings.Contains(strings.ToLower(app.Company), q) {
		return true
	}
	if strings.Contains(strings.ToLower(app.Role), q) {
		return true
	}
	if strings.Contains(strings.ToLower(app.Notes), q) {
		return true
	}
	if strings.Contains(strings.ToLower(app.JobURL), q) {
		return true
	}
	return false
}

// applyFilterAndSort rebuilds the filtered list from apps.
func (m *PipelineModel) applyFilterAndSort() {
	var filtered []model.DashboardRow
	m.activeTab = normalizePipelineTabIndex(m.activeTab)

	currentFilter := pipelineTabs[m.activeTab].filter
	for _, app := range m.apps {
		if !matchesSearch(app, m.searchQuery) {
			continue
		}
		if rowMatchesFilter(app, currentFilter) {
			filtered = append(filtered, app)
		}
	}

	// Sort
	less := m.sortLess()
	sort.SliceStable(filtered, func(i, j int) bool {
		return less(filtered[i], filtered[j])
	})

	// In grouped mode, always sort by status priority first, then by selected sort within groups
	if m.viewMode == "grouped" {
		sort.SliceStable(filtered, func(i, j int) bool {
			pi := data.StatusPriority(filtered[i].Status)
			pj := data.StatusPriority(filtered[j].Status)
			if pi != pj {
				return pi < pj
			}
			// Within same group, use selected sort
			return less(filtered[i], filtered[j])
		})
	}

	m.filtered = filtered
}

// sortLess returns the comparator for the active sort mode. Shared by the flat
// sort and the within-group tiebreaker in grouped view.
func (m PipelineModel) sortLess() func(a, b model.DashboardRow) bool {
	switch m.sortMode {
	case sortDate:
		return func(a, b model.DashboardRow) bool { return a.Date > b.Date }
	case sortCompany:
		return func(a, b model.DashboardRow) bool {
			return strings.ToLower(a.Company) < strings.ToLower(b.Company)
		}
	case sortStatus:
		return func(a, b model.DashboardRow) bool {
			return data.StatusPriority(a.Status) < data.StatusPriority(b.Status)
		}
	case sortLocation:
		// Remote-first, then hybrid, then onsite; alphabetical city as tiebreaker.
		return func(a, b model.DashboardRow) bool {
			ra, rb := workModeRank(a.WorkMode), workModeRank(b.WorkMode)
			if ra != rb {
				return ra < rb
			}
			return a.Location < b.Location
		}
	case sortPay:
		// Highest band ceiling first; unknown pay (0) sinks to the bottom.
		return func(a, b model.DashboardRow) bool { return a.PayMax > b.PayMax }
	case sortLast:
		// Most recent contact first; empty dates sink to the bottom.
		return func(a, b model.DashboardRow) bool { return a.LastContact > b.LastContact }
	default: // sortScore
		return func(a, b model.DashboardRow) bool { return a.Score > b.Score }
	}
}

// workModeRank orders work modes remote-first for the location sort.
func workModeRank(mode string) int {
	switch mode {
	case "Remote":
		return 0
	case "RemoteFlex":
		return 1
	case "Hybrid":
		return 2
	case "Full":
		return 3
	default:
		return 4
	}
}

// chromeRowsFixed returns the number of fixed chrome rows above/below the body.
// Shared by View() and adjustScroll() so additions stay in sync.
func (m PipelineModel) chromeRowsFixed() int {
	rows := 6 + lipgloss.Height(m.renderHelp()) // header + tabs(2) + metrics/action row + spacer + column header + help
	if m.searchInput || m.searchQuery != "" {
		rows++
	}
	return rows
}

func (m PipelineModel) pageRows() int {
	rows := m.bodyViewportRows()
	if rows < 1 {
		return 1
	}
	return rows
}

func (m PipelineModel) halfPageRows() int {
	rows := m.pageRows() / 2
	if rows < 1 {
		return 1
	}
	return rows
}

func (m PipelineModel) bodyViewportRows() int {
	preview := m.renderPreview()
	previewLines := 0
	if preview != "" {
		previewLines = lipgloss.Height(preview)
	}
	rows := m.height - m.chromeRowsFixed() - previewLines
	if rows < 3 {
		return 3
	}
	return rows
}

func (m PipelineModel) moveCursorByVisualRows(delta int) PipelineModel {
	if len(m.filtered) == 0 || delta == 0 {
		return m
	}
	m.cursor = m.cursorForVisualLine(m.cursorLineEstimate() + delta)
	m.adjustScroll()
	return m
}

func (m PipelineModel) cursorForVisualLine(target int) int {
	if len(m.filtered) == 0 {
		return 0
	}
	if target <= 0 {
		return 0
	}
	if m.viewMode != "grouped" {
		if target >= len(m.filtered) {
			return len(m.filtered) - 1
		}
		return target
	}

	line := 0
	prevStatus := ""
	for i, app := range m.filtered {
		norm := data.NormalizeStatus(app.Status)
		if norm != prevStatus {
			if line >= target {
				return i
			}
			line++ // group header
			prevStatus = norm
		}
		if line >= target {
			return i
		}
		line++
	}
	return len(m.filtered) - 1
}

// adjustScroll updates scrollOffset so the cursor stays visible.
func (m *PipelineModel) adjustScroll() {
	availHeight := m.pageRows()
	if availHeight < 5 {
		availHeight = 5
	}
	line := m.cursorLineEstimate()
	margin := 3

	if line >= m.scrollOffset+availHeight-margin {
		m.scrollOffset = line - availHeight + margin + 1
	}
	if line < m.scrollOffset+margin {
		m.scrollOffset = line - margin
	}
	if m.scrollOffset < 0 {
		m.scrollOffset = 0
	}
}

func (m PipelineModel) cursorLineEstimate() int {
	if m.viewMode != "grouped" {
		return m.cursor
	}
	// Account for group headers
	line := 0
	prevStatus := ""
	for i, app := range m.filtered {
		norm := data.NormalizeStatus(app.Status)
		if norm != prevStatus {
			line++ // group header
			prevStatus = norm
		}
		if i == m.cursor {
			return line
		}
		line++
	}
	return line
}

// -- View --

// View renders the pipeline screen.
func (m PipelineModel) View() string {
	if m.hiredStep > 0 {
		return m.overlayHiredFlow()
	}

	header := m.renderHeader()
	tabs := m.renderTabs()
	metricsBar := m.renderMetrics()
	searchBar := m.renderSearchBar()
	body := m.renderBody()
	preview := m.renderPreview()
	help := m.renderHelp()

	// Apply scroll to body
	bodyLines := strings.Split(body, "\n")
	if m.scrollOffset > 0 && m.scrollOffset < len(bodyLines) {
		bodyLines = bodyLines[m.scrollOffset:]
	}

	// Calculate available height for body
	previewLines := 0
	if preview != "" {
		previewLines = lipgloss.Height(preview)
	}
	availHeight := m.height - m.chromeRowsFixed() - previewLines
	if availHeight < 3 {
		availHeight = 3
	}
	if len(bodyLines) > availHeight {
		bodyLines = bodyLines[:availHeight]
	}
	body = strings.Join(bodyLines, "\n")

	// Column picker overlay
	if m.colPicker {
		body = m.overlayColPicker(body)
	}

	// Status picker overlay
	if m.statusPicker {
		body = m.overlayStatusPicker(body)
	}

	// PDF picker overlay
	if m.pdfPicker {
		body = m.overlayPDFPicker(body)
	}

	// Discard reason picker overlay
	if m.discardStep > 0 {
		body = m.overlayDiscardFlow(body)
	}

	sections := []string{header, tabs, metricsBar, m.blankInheritedLine()}
	if searchBar != "" {
		sections = append(sections, searchBar)
	}
	sections = append(sections, m.renderColumnHeader(), body)

	footerSections := []string{}
	if preview != "" {
		footerSections = append(footerSections, preview)
	}
	footerSections = append(footerSections, help)

	if spacerRows := m.footerSpacerRows(sections, footerSections...); spacerRows > 0 {
		sections = append(sections, m.blankInheritedLines(spacerRows))
	}
	sections = append(sections, footerSections...)
	return lipgloss.JoinVertical(lipgloss.Left, sections...)
}

// renderSearchBar returns an empty string when there is no active or in-progress
// search; otherwise it renders a vim-style status line showing the query and the
// match count. While in input mode, a trailing cursor is appended.
func (m PipelineModel) renderSearchBar() string {
	if !m.searchInput && m.searchQuery == "" {
		return ""
	}

	prompt := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue).Background(m.theme.Surface).Render("/")
	queryStyle := lipgloss.NewStyle().Foreground(m.theme.Text).Background(m.theme.Surface)
	hintStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext).Background(m.theme.Surface)

	display := queryStyle.Render(m.searchQuery)
	if m.searchInput {
		display += lipgloss.NewStyle().Foreground(m.theme.Blue).Background(m.theme.Surface).Render("█")
	}

	tabFiltered := m.countForFilter(pipelineTabs[m.activeTab].filter)
	matchInfo := hintStyle.Render(fmt.Sprintf("  %d/%d matching", len(m.filtered), tabFiltered))

	hint := ""
	if m.searchInput {
		hint = hintStyle.Render("   Enter: keep   Esc: cancel   Ctrl+U: clear")
	} else {
		hint = hintStyle.Render("   Esc: clear   /: edit")
	}

	return m.renderBarLine(prompt+m.barSpace(1)+display+matchInfo+hint, 2)
}

func (m PipelineModel) renderHeader() string {
	right := lipgloss.NewStyle().Foreground(m.theme.Subtext).Background(m.theme.Surface)
	avg := fmt.Sprintf("%.1f", m.metrics.AvgScore)
	info := right.Render(fmt.Sprintf("%d offers | Avg %s/5", m.metrics.Total, avg))

	title := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Blue).Background(m.theme.Surface).Render("CAREER PIPELINE")

	return m.renderBarLineRight(title, info, 2)
}

func (m PipelineModel) renderTabs() string {
	var tabs []string
	var underParts []string

	for i, tab := range pipelineTabs {
		// Count items for this tab
		count := m.countForFilter(tab.filter)
		label := fmt.Sprintf(" %s (%d) ", tab.label, count)

		if i == m.activeTab {
			style := lipgloss.NewStyle().
				Bold(true).
				Foreground(m.theme.Blue).
				Background(m.theme.Surface).
				Padding(0, 0)
			tabs = append(tabs, style.Render(label))
			underParts = append(underParts, strings.Repeat("━", lipgloss.Width(label)))
		} else {
			style := lipgloss.NewStyle().
				Foreground(m.theme.Subtext).
				Background(m.theme.Surface).
				Padding(0, 0)
			tabs = append(tabs, style.Render(label))
			underParts = append(underParts, strings.Repeat("─", lipgloss.Width(label)))
		}
	}

	row := lipgloss.JoinHorizontal(lipgloss.Top, tabs...)
	contentWidth := m.width - 2
	if contentWidth < 0 {
		contentWidth = 0
	}
	if lipgloss.Width(row) > contentWidth {
		row = ansi.Truncate(row, contentWidth, "")
	}
	underlineText := strings.Join(underParts, "")
	if lipgloss.Width(underlineText) > contentWidth {
		underlineText = string([]rune(underlineText)[:contentWidth])
	}
	if fill := contentWidth - lipgloss.Width(underlineText); fill > 0 {
		underlineText += strings.Repeat("─", fill)
	}
	underline := lipgloss.NewStyle().
		Foreground(m.theme.Overlay).
		Background(m.theme.Surface).
		Render(underlineText)

	return m.renderBarLine(row, 1) + "\n" + m.barSpace(1) + underline + m.barSpace(1)
}

func (m PipelineModel) countForFilter(filter string) int {
	count := 0
	for _, app := range m.apps {
		if rowMatchesFilter(app, filter) {
			count++
		}
	}
	return count
}

func rowMatchesFilter(row model.DashboardRow, filter string) bool {
	switch filter {
	case filterAll:
		return row.IsTrackedApplication()
	case filterQueue:
		return !row.IsTrackedApplication()
	default:
		return row.IsTrackedApplication() && data.NormalizeStatus(row.Status) == filter
	}
}

func (m PipelineModel) renderMetrics() string {
	var parts []string
	statusColors := m.statusColorMap()

	for _, status := range statusGroupOrder {
		count, ok := m.metrics.ByStatus[status]
		if !ok || count == 0 {
			continue
		}
		color := statusColors[status]
		s := lipgloss.NewStyle().Foreground(color).Background(m.theme.Surface)
		parts = append(parts, s.Render(fmt.Sprintf("%s:%d", statusLabel(status), count)))
	}

	return m.renderBarLineRight(strings.Join(parts, m.barSpace(2)), m.renderSortSummary(), 2)
}

func (m PipelineModel) renderSortSummary() string {
	style := lipgloss.NewStyle().Foreground(m.theme.Subtext).Background(m.theme.Surface)
	sortLabel := fmt.Sprintf("[Sort: %s]", m.sortMode)
	viewLabel := fmt.Sprintf("[View: %s]", m.viewMode)
	count := fmt.Sprintf("%d shown", len(m.filtered))

	return style.Render(fmt.Sprintf("%s  %s  %s", sortLabel, viewLabel, count))
}

func (m PipelineModel) renderBody() string {
	if len(m.filtered) == 0 {
		emptyStyle := lipgloss.NewStyle().
			Foreground(m.theme.Subtext).
			Padding(1, 2)
		return emptyStyle.Render("No offers match this filter")
	}

	var lines []string
	prevStatus := ""
	padStyle := lipgloss.NewStyle().Padding(0, 2)

	for i, app := range m.filtered {
		norm := data.NormalizeStatus(app.Status)

		// Group header in grouped mode
		if m.viewMode == "grouped" && norm != prevStatus {
			count := m.countByNormStatus(norm)
			headerStyle := lipgloss.NewStyle().
				Bold(true).
				Foreground(m.theme.Subtext)
			label := fmt.Sprintf("── %s (%d) ", strings.ToUpper(statusLabel(norm)), count)
			line := label + strings.Repeat("─", max(0, m.tableContentWidth()-lipgloss.Width(label)))
			lines = append(lines, padStyle.Render(headerStyle.Render(line)))
			prevStatus = norm
		}

		selected := i == m.cursor
		line := m.renderAppLine(app, selected)
		lines = append(lines, line)
	}

	return strings.Join(lines, "\n")
}

// colWidths holds per-column rune budgets for the table.
type colWidths struct {
	num, score, company, status, role, next int
	// optional columns — 0 means the column is hidden
	date, loc, pay, rpt, pdf, last int
}

func (m PipelineModel) colVisible(id ColumnID) bool {
	if m.visibleCols == nil {
		// Fall back to default for callers before init (tests, etc.)
		for _, col := range optionalCols {
			if col.id == id {
				return col.onByDefault
			}
		}
		return false
	}
	return m.visibleCols[id]
}

func (m PipelineModel) columnWidths() colWidths {
	c := colWidths{num: 5, score: 5, company: 16, status: 12}
	if m.colVisible(ColDate) {
		c.date = 10
	}
	if m.colVisible(ColLocation) {
		c.loc = m.locationColumnWidth()
	}
	if m.colVisible(ColPay) {
		c.pay = 16
	}
	if m.colVisible(ColNext) {
		c.next = 22
	}
	if m.colVisible(ColHasReport) {
		c.rpt = 4
	}
	if m.colVisible(ColHasPDF) {
		c.pdf = 4
	}
	if m.colVisible(ColLastContact) {
		c.last = 10
	}
	fixed := func() int {
		return c.num + c.score + c.date + c.company + c.status + c.next + c.loc + c.pay + c.rpt + c.pdf + c.last
	}
	if m.width-fixed()-14 < 15 && c.pay > 0 {
		c.pay = 0
	}
	c.role = m.width - fixed() - 14 // separators + outer padding
	if c.role < 15 {
		c.role = 15
	}
	return c
}

func (m PipelineModel) locationColumnWidth() int {
	switch {
	case m.width >= 220:
		return 40
	case m.width >= 180:
		return 32
	case m.width >= 150:
		return 28
	default:
		return 20
	}
}

func (m PipelineModel) tableContentWidth() int {
	if m.width <= 4 {
		return max(0, m.width)
	}
	return m.width - 4
}

func (m PipelineModel) withSelectedBackground(style lipgloss.Style, selected bool) lipgloss.Style {
	if selected {
		return style.Background(m.theme.Selection)
	}
	return style
}

func (m PipelineModel) selectedBackgroundText(text string) string {
	return lipgloss.NewStyle().Background(m.theme.Selection).Render(text)
}

func (m PipelineModel) workModeColor(mode string) lipgloss.Color {
	switch mode {
	case "Remote":
		return m.theme.Green
	case "RemoteFlex":
		return m.theme.Sky
	case "Hybrid":
		return m.theme.Yellow
	case "Full":
		return m.theme.Red
	default:
		return m.theme.Subtext
	}
}

func (m PipelineModel) renderLocCell(app model.DashboardRow, width int, selected bool) string {
	text := app.WorkMode
	if app.Location != "" {
		if text != "" {
			text += " · " + app.Location
		} else {
			text = app.Location
		}
	}
	if text == "" {
		text = "—"
	}
	style := m.withSelectedBackground(
		lipgloss.NewStyle().Foreground(m.workModeColor(app.WorkMode)).Width(width),
		selected,
	)
	return style.Render(truncateRunes(text, width))
}

func (m PipelineModel) renderCheckCell(yes bool, width int, selected bool) string {
	text := "—"
	color := m.theme.Subtext
	if yes {
		text = "✓"
		color = m.theme.Green
	}
	return m.withSelectedBackground(lipgloss.NewStyle().Foreground(color).Width(width), selected).Render(text)
}

// renderPayCell prefers the pay range parsed from notes and falls back to the
// report-cache comp estimate (the pre-column behavior). POSTED bands render
// green; estimates stay yellow.
func (m PipelineModel) renderPayCell(app model.DashboardRow, width int, selected bool) string {
	text := app.PayRange
	color := m.theme.Yellow
	if app.PaySource == "POSTED" {
		color = m.theme.Green
	}
	if text == "" {
		if summary, ok := m.reportCache[app.ReportPath]; ok && summary.comp != "" {
			text = summary.comp
		}
	}
	if text == "" {
		return m.withSelectedBackground(lipgloss.NewStyle().Width(width), selected).Render("")
	}
	return m.withSelectedBackground(lipgloss.NewStyle().Foreground(color).Width(width), selected).Render(truncateRunes(text, width-1))
}

// renderColumnHeader labels the table columns; widths mirror renderAppLine.
func (m PipelineModel) renderColumnHeader() string {
	cw := m.columnWidths()
	h := lipgloss.NewStyle().Foreground(m.theme.Subtext).Bold(true)
	cell := func(label string, width int) string {
		return h.Width(width).Render(truncateRunes(label, width))
	}

	segments := []string{
		cell("#", cw.num),
		cell("FIT", cw.score),
	}
	if cw.date > 0 {
		segments = append(segments, cell("APPLIED", cw.date))
	}
	segments = append(segments, cell("COMPANY", cw.company))
	segments = append(segments, cell("ROLE", cw.role))
	segments = append(segments, cell("STATUS", cw.status))
	if cw.next > 0 {
		segments = append(segments, cell("NEXT STEP", cw.next))
	}
	if cw.loc > 0 {
		segments = append(segments, cell("LOCATION", cw.loc))
	}
	if cw.pay > 0 {
		segments = append(segments, cell("PAY", cw.pay))
	}
	if cw.rpt > 0 {
		segments = append(segments, cell("RPT", cw.rpt))
	}
	if cw.pdf > 0 {
		segments = append(segments, cell("PDF", cw.pdf))
	}
	if cw.last > 0 {
		segments = append(segments, cell("LAST", cw.last))
	}

	padStyle := lipgloss.NewStyle().Padding(0, 2)
	return padStyle.Render(" " + strings.Join(segments, " "))
}

func (m PipelineModel) renderAppLine(app model.DashboardRow, selected bool) string {
	padStyle := lipgloss.NewStyle().Padding(0, 2)
	cw := m.columnWidths()

	// Tracker number (fixed width)
	numText := "#—"
	if app.Number > 0 {
		numText = fmt.Sprintf("#%d", app.Number)
	}
	numStyle := m.withSelectedBackground(lipgloss.NewStyle().Foreground(m.theme.Blue).Bold(true).Width(cw.num), selected)

	// Score with color
	scoreStyle := m.withSelectedBackground(m.scoreStyle(app.Score).Width(cw.score), selected)
	scoreText := "—"
	if app.Score > 0 {
		scoreText = fmt.Sprintf("%.1f", app.Score)
	}
	score := scoreStyle.Render(scoreText)

	// Company (truncate)
	company := truncateRunes(app.Company, cw.company)
	companyStyle := m.withSelectedBackground(lipgloss.NewStyle().Foreground(m.theme.Text).Width(cw.company), selected)

	// Date (fixed width)
	dateText := app.Date
	if dateText == "" {
		dateText = "—"
	}
	dateStyle := m.withSelectedBackground(lipgloss.NewStyle().Foreground(m.theme.Subtext).Width(cw.date), selected)

	// Role (truncate)
	role := truncateRunes(app.Role, cw.role)
	roleStyle := m.withSelectedBackground(lipgloss.NewStyle().Foreground(m.theme.Subtext).Width(cw.role), selected)

	// Status with color -- fixed column
	norm := data.NormalizeStatus(app.Status)
	statusColor := m.statusColorMap()[norm]
	if statusColor == "" {
		statusColor = m.theme.Subtext
	}
	statusStyle := m.withSelectedBackground(lipgloss.NewStyle().Foreground(statusColor).Width(cw.status), selected)
	statusText := statusStyle.Render(statusLabel(norm))
	nextStyle := m.withSelectedBackground(lipgloss.NewStyle().Foreground(m.nextActionColor(app)).Width(cw.next), selected)
	nextText := nextStyle.Render(truncateRunes(nextActionLabel(app), cw.next))

	segments := []string{
		numStyle.Render(truncateRunes(numText, cw.num)),
		score,
	}
	if cw.date > 0 {
		segments = append(segments, dateStyle.Render(truncateRunes(dateText, cw.date)))
	}
	segments = append(segments, companyStyle.Render(company))
	segments = append(segments, roleStyle.Render(role))
	segments = append(segments, statusText)
	if cw.next > 0 {
		segments = append(segments, nextText)
	}

	if cw.loc > 0 {
		segments = append(segments, m.renderLocCell(app, cw.loc, selected))
	}
	if cw.pay > 0 {
		segments = append(segments, m.renderPayCell(app, cw.pay, selected))
	}
	if cw.rpt > 0 {
		segments = append(segments, m.renderCheckCell(app.ReportPath != "", cw.rpt, selected))
	}
	if cw.pdf > 0 {
		segments = append(segments, m.renderCheckCell(app.HasPDF, cw.pdf, selected))
	}
	if cw.last > 0 {
		lastText := "—"
		if app.LastContact != "" {
			lastText = formatTimeAgo(app.LastContact)
		}
		lastStyle := m.withSelectedBackground(lipgloss.NewStyle().Foreground(m.theme.Subtext).Width(cw.last), selected)
		if app.LastContact != "" && app.LastContact != app.Date {
			lastStyle = m.withSelectedBackground(lastStyle.Foreground(m.theme.Text), selected)
		}
		segments = append(segments, lastStyle.Render(truncateRunes(lastText, cw.last)))
	}

	if selected {
		line := m.selectedBackgroundText(" ") + strings.Join(segments, m.selectedBackgroundText(" "))
		if fill := m.tableContentWidth() - lipgloss.Width(line); fill > 0 {
			line += m.selectedBackgroundText(strings.Repeat(" ", fill))
		}
		return padStyle.Render(line)
	}
	line := " " + strings.Join(segments, " ")
	return padStyle.Render(line)
}

func (m PipelineModel) renderPreview() string {
	app, ok := m.CurrentApp()
	if !ok {
		return ""
	}

	padStyle := lipgloss.NewStyle().Padding(0, 2)
	divider := lipgloss.NewStyle().Foreground(m.theme.Overlay)

	var lines []string
	lines = append(lines, padStyle.Render(divider.Render(strings.Repeat("─", m.width-4))))

	labelStyle := lipgloss.NewStyle().Foreground(m.theme.Sky).Bold(true)
	valueStyle := lipgloss.NewStyle().Foreground(m.theme.Text)
	dimStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	// Quick facts derived from notes — available even when there is no report,
	// and the only place narrow terminals see location/pay/last-contact.
	var facts []string
	if app.WorkMode != "" || app.Location != "" {
		loc := app.WorkMode
		if app.Location != "" {
			if loc != "" {
				loc += " · " + app.Location
			} else {
				loc = app.Location
			}
		}
		facts = append(facts, labelStyle.Render("Loc: ")+valueStyle.Render(loc))
	}
	if app.PayRange != "" {
		pay := app.PayRange
		if app.PaySource != "" {
			pay += " (" + app.PaySource + ")"
		}
		facts = append(facts, labelStyle.Render("Pay: ")+valueStyle.Render(pay))
	}
	if app.LastContact != "" {
		facts = append(facts, labelStyle.Render("Last contact: ")+
			valueStyle.Render(fmt.Sprintf("%s (%s)", app.LastContact, formatTimeAgo(app.LastContact))))
	}
	if len(facts) > 0 {
		lines = append(lines, padStyle.Render(strings.Join(facts, "   ")))
	}

	nextDetail := nextActionDetail(app)
	if nextDetail != "" {
		lines = append(lines, padStyle.Render(
			labelStyle.Render("Next step: ")+valueStyle.Render(truncateRunes(nextDetail, m.width-15))))
	}

	queueNotesShown := false
	if !app.IsTrackedApplication() {
		if app.ActionReason != "" {
			lines = append(lines, padStyle.Render(
				labelStyle.Render("Queue action: ")+valueStyle.Render(truncateRunes(app.ActionReason, m.width-18))))
		}
		if app.Notes != "" {
			lines = append(lines, padStyle.Render(
				labelStyle.Render("Queue reason: ")+valueStyle.Render(truncateRunes(app.Notes, m.width-18))))
			queueNotesShown = true
		}
	}

	outcome := previewOutcome(app)

	// Check report cache
	if summary, ok := m.reportCache[app.ReportPath]; ok {
		if summary.archetype != "" {
			lines = append(lines, padStyle.Render(
				labelStyle.Render("Archetype: ")+valueStyle.Render(summary.archetype)))
		}
		if summary.tldr != "" {
			lines = append(lines, padStyle.Render(
				labelStyle.Render("TL;DR: ")+valueStyle.Render(summary.tldr)))
		}
		if summary.comp != "" {
			lines = append(lines, padStyle.Render(
				labelStyle.Render("Comp: ")+valueStyle.Render(summary.comp)))
		}
		if summary.remote != "" {
			lines = append(lines, padStyle.Render(
				labelStyle.Render("Remote: ")+valueStyle.Render(summary.remote)))
		}
	} else if app.Notes != "" && outcome == "" && !queueNotesShown {
		// Fallback: show notes (the outcome line below already carries them)
		notes := truncateRunes(app.Notes, m.width-10)
		lines = append(lines, padStyle.Render(dimStyle.Render(notes)))
	} else if outcome == "" {
		lines = append(lines, padStyle.Render(dimStyle.Render("Loading preview...")))
	}

	// Closed-out postings: surface what happened as the last preview line.
	// The notes-only fallback above disappears once a report summary is
	// cached, which is exactly when the discard reason got lost (#787).
	if outcome != "" {
		// Width budget: 4 cols padding + 9 for the "Outcome: " label + slack,
		// mirroring the m.width-10 budget of the notes fallback above.
		lines = append(lines, padStyle.Render(
			labelStyle.Render("Outcome: ")+valueStyle.Render(truncateRunes(outcome, m.width-14))))
	}

	return strings.Join(lines, "\n")
}

// previewOutcome returns "what happened" to a closed-out application — the raw
// status (which often carries the decision date, e.g. "descartado 2026-03-12")
// plus the tracker notes holding the reason. Returns "" for apps still in play.
func previewOutcome(app model.DashboardRow) string {
	switch data.NormalizeStatus(app.Status) {
	case "discarded", "skip", "rejected":
	default:
		return ""
	}
	outcome := strings.TrimSpace(strings.ReplaceAll(app.Status, "**", ""))
	if app.Notes != "" {
		outcome += " — " + app.Notes
	}
	return outcome
}

func needsManualAction(app model.DashboardRow) bool {
	state := strings.ToLower(strings.TrimSpace(app.ActionState))
	return state == "needs_action" || state == "blocked"
}

func actionStateIs(app model.DashboardRow, states ...string) bool {
	current := strings.ToLower(strings.TrimSpace(app.ActionState))
	for _, state := range states {
		if current == state {
			return true
		}
	}
	return false
}

func canOpenNextArtifact(app model.DashboardRow) bool {
	return app.NextPackPath != "" && needsManualAction(app) && artifactBackedNextAction(app.NextAction)
}

// artifactBackedNextAction reports whether a suggested action produces or uses a
// copy-paste pack the user can open. Every real suggests value from
// templates/states.yml is pack-backed; only the empty/"none" terminal case is not.
func artifactBackedNextAction(action string) bool {
	return action != "" && action != "none"
}

func nextActionLabel(app model.DashboardRow) string {
	if actionStateIs(app, "waiting", "snoozed") {
		return "Waiting for response"
	}
	if app.NextAction == "" || app.NextAction == "none" {
		return "-"
	}

	switch app.NextAction {
	case "generate_approach_plan":
		return "Generate approaches"
	case "execute_approach":
		return "Approach it"
	case "review_approach":
		if strings.Contains(strings.ToLower(app.ActionReason), "cold") {
			return "Stale review"
		}
		return "Review due"
	case "generate_application_pack":
		return "Generate application"
	case "send_application":
		return "Send application"
	case "draft_qualifying_questions":
		return "Draft gating question"
	case "send_qualifying_questions":
		return "Send gating question"
	case "draft_outreach":
		return "Draft outreach"
	case "send_outreach":
		return "Send outreach"
	case "follow_up":
		return "Follow up"
	case "generate_interview_cheatsheet":
		return "Generate interview cheatsheet"
	case "regenerate_cheatsheet":
		return "Regenerate cheatsheet"
	case "attend_interview_and_report":
		return "Interview"
	case "generate_negotiation_prep":
		return "Generate negotiation prep"
	case "negotiate_and_report":
		return "Negotiate offer"
	default:
		return app.NextAction
	}
}

func nextActionDetail(app model.DashboardRow) string {
	label := nextActionLabel(app)
	if label == "-" {
		return ""
	}

	var parts []string
	parts = append(parts, label)
	if canOpenNextArtifact(app) {
		parts = append(parts, "pack: "+app.NextPackPath)
	} else if app.NextCommand != "" && needsManualAction(app) {
		parts = append(parts, "run: "+app.NextCommand)
	}
	if app.ActionDue != "" {
		parts = append(parts, "due: "+app.ActionDue)
	}
	if app.ActionOwner != "" && app.ActionOwner != "external" {
		parts = append(parts, "owner: "+app.ActionOwner)
	}
	if app.WaitingOn != "" && !needsManualAction(app) {
		parts = append(parts, "waiting on: "+app.WaitingOn)
	}
	if app.AttemptCount > 0 {
		parts = append(parts, fmt.Sprintf("attempts: %d via %s", app.AttemptCount, strings.Join(app.AttemptChannels, ",")))
		parts = append(parts, fmt.Sprintf("latest: %s %s to %s (%s)", app.LatestAttemptType, app.LatestAttemptDate, app.LatestAttemptRecipient, app.LatestAttemptResult))
	}
	if app.FormalSubmitted {
		parts = append(parts, "formal: submitted")
	}
	return strings.Join(parts, " | ")
}

func detailsViewerTitle(app model.DashboardRow) string {
	parts := opportunityTitleParts(app)
	if len(parts) == 0 {
		return "DETAILS"
	}
	if id := opportunityTitleID(app); id != "" {
		parts = append([]string{id}, parts...)
	}
	return "DETAILS: " + strings.Join(parts, " / ")
}

func opportunityTitleID(app model.DashboardRow) string {
	if app.Number > 0 {
		return fmt.Sprintf("#%d", app.Number)
	}
	if app.ReportNumber != "" {
		return "#" + strings.TrimPrefix(app.ReportNumber, "#")
	}
	return ""
}

func opportunityTitleParts(app model.DashboardRow) []string {
	var parts []string
	if app.Company != "" {
		parts = append(parts, app.Company)
	}
	if app.Role != "" {
		parts = append(parts, app.Role)
	}
	if loc := titleLocationSummary(app); loc != "" && !strings.Contains(strings.ToLower(app.Role), strings.ToLower(loc)) {
		parts = append(parts, loc)
	}
	return parts
}

func titleLocationSummary(app model.DashboardRow) string {
	var parts []string
	if app.WorkMode != "" {
		parts = append(parts, app.WorkMode)
	}
	if app.Location != "" {
		parts = append(parts, app.Location)
	}
	return strings.Join(parts, " / ")
}

func (m PipelineModel) nextActionColor(app model.DashboardRow) lipgloss.Color {
	if canOpenNextArtifact(app) {
		return m.theme.Green
	}
	if actionStateIs(app, "waiting", "snoozed") {
		return m.theme.Subtext
	}
	if app.NextAction != "" && app.NextAction != "none" {
		return m.theme.Yellow
	}
	switch strings.ToLower(strings.TrimSpace(app.ActionState)) {
	case "needs_action":
		return m.theme.Yellow
	case "blocked":
		return m.theme.Red
	case "waiting", "snoozed":
		return m.theme.Subtext
	default:
		return m.theme.Overlay
	}
}

func (m PipelineModel) renderHelp() string {
	keyStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Text).Background(m.theme.Surface)
	descStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext).Background(m.theme.Surface)

	if m.flash != "" {
		flashStyle := lipgloss.NewStyle().
			Foreground(m.theme.Yellow).
			Background(m.theme.Surface).
			Width(m.width).
			Padding(0, 1)
		return flashStyle.Render(m.flash)
	}

	if m.colPicker {
		return m.renderBarLine(
			keyStyle.Render("↑↓/jk")+descStyle.Render(" navigate  ")+
				keyStyle.Render("SPACE")+descStyle.Render(" toggle  ")+
				keyStyle.Render("Esc/C")+descStyle.Render(" close"),
			1)
	}

	if m.statusPicker || m.pdfPicker {
		return m.renderBarLine(
			keyStyle.Render("↑↓/jk")+descStyle.Render(" navigate  ")+
				keyStyle.Render("Enter")+descStyle.Render(" confirm  ")+
				keyStyle.Render("Esc")+descStyle.Render(" cancel"),
			1)
	}

	if m.searchInput {
		return m.renderBarLine(
			keyStyle.Render("type")+descStyle.Render(" filter live  ")+
				keyStyle.Render("Enter")+descStyle.Render(" keep  ")+
				keyStyle.Render("Ctrl+U")+descStyle.Render(" clear  ")+
				keyStyle.Render("Esc")+descStyle.Render(" cancel"),
			1)
	}

	brand := lipgloss.NewStyle().Foreground(m.theme.Overlay).Background(m.theme.Surface).Render("career-ops by santifer.io")

	segment := func(key, desc string) string {
		return keyStyle.Render(key) + descStyle.Render(" "+desc)
	}

	groups := []string{
		segment("Enter", "details"),
		segment("o", "URL"),
		segment("d", "PDF"),
		segment("D", "regen PDF"),
		segment("c", "status"),
		segment("C", "columns"),
		segment("p", "progress"),
		segment("jk", "nav"),
		segment("hl", "tabs"),
		segment("^D/^U", "half"),
		segment("Space/b", "page"),
		segment("g/G", "top/end"),
		segment("/", "search"),
		segment("s", "sort"),
		segment("r", "refresh"),
		segment("v", "view"),
		segment("q", "quit"),
	}

	return m.renderCommandRows(groups, 1, brand)
}

func (m PipelineModel) renderCommandRows(groups []string, padding int, brand string) string {
	rows := m.packCommandRows(groups, padding)
	if len(rows) == 0 {
		return m.renderBarLine("", padding)
	}

	rendered := make([]string, 0, len(rows))
	for i, row := range rows {
		if i == len(rows)-1 && brand != "" {
			contentWidth := m.width - (padding * 2)
			if contentWidth < 1 {
				contentWidth = 1
			}
			if lipgloss.Width(row)+lipgloss.Width(brand)+1 <= contentWidth {
				rendered = append(rendered, m.renderBarLineRight(row, brand, padding))
				continue
			}
		}
		rendered = append(rendered, m.renderBarLine(row, padding))
	}
	return strings.Join(rendered, "\n")
}

func (m PipelineModel) packCommandRows(groups []string, padding int) []string {
	contentWidth := m.width - (padding * 2)
	if contentWidth < 1 {
		contentWidth = 1
	}

	separator := m.barSpace(2)
	var rows []string
	row := ""
	for _, group := range groups {
		if lipgloss.Width(group) > contentWidth {
			group = ansi.Truncate(group, contentWidth, "")
		}

		if row == "" {
			row = group
			continue
		}

		next := row + separator + group
		if lipgloss.Width(next) <= contentWidth {
			row = next
			continue
		}
		rows = append(rows, row)
		row = group
	}
	if row != "" {
		rows = append(rows, row)
	}
	return rows
}

func (m PipelineModel) barSpace(width int) string {
	if width <= 0 {
		return ""
	}
	return lipgloss.NewStyle().Background(m.theme.Surface).Render(strings.Repeat(" ", width))
}

func (m PipelineModel) blankInheritedLine() string {
	return strings.Repeat(" ", m.width)
}

func (m PipelineModel) blankInheritedLines(rows int) string {
	if rows <= 0 {
		return ""
	}
	lines := make([]string, rows)
	for i := range lines {
		lines[i] = m.blankInheritedLine()
	}
	return strings.Join(lines, "\n")
}

func (m PipelineModel) footerSpacerRows(sections []string, footerSections ...string) int {
	if m.height <= 0 {
		return 0
	}
	rows := 0
	for _, section := range sections {
		rows += lipgloss.Height(section)
	}
	for _, section := range footerSections {
		rows += lipgloss.Height(section)
	}
	if rows >= m.height {
		return 0
	}
	return m.height - rows
}

func (m PipelineModel) renderBarLine(content string, padding int) string {
	line := m.barSpace(padding) + content
	if fill := m.width - lipgloss.Width(line); fill > 0 {
		line += m.barSpace(fill)
	}
	return line
}

func (m PipelineModel) renderBarLineRight(left, right string, padding int) string {
	contentWidth := m.width - (padding * 2)
	if contentWidth < 1 {
		contentWidth = 1
	}

	rightWidth := lipgloss.Width(right)
	if rightWidth > contentWidth {
		right = ansi.Truncate(right, contentWidth, "")
		rightWidth = lipgloss.Width(right)
		left = ""
	}

	leftWidth := lipgloss.Width(left)
	if right != "" && leftWidth+rightWidth+1 > contentWidth {
		maxLeft := contentWidth - rightWidth - 1
		if maxLeft < 0 {
			maxLeft = 0
		}
		left = ansi.Truncate(left, maxLeft, "")
		leftWidth = lipgloss.Width(left)
	} else if right == "" && leftWidth > contentWidth {
		left = ansi.Truncate(left, contentWidth, "")
		leftWidth = lipgloss.Width(left)
	}

	gap := contentWidth - leftWidth - rightWidth
	if gap < 1 {
		gap = 0
		if left != "" && right != "" {
			gap = 1
		}
	}
	line := m.barSpace(padding) + left + m.barSpace(gap) + right
	if fill := m.width - lipgloss.Width(line); fill > 0 {
		line += m.barSpace(fill)
	}
	return line
}

func (m PipelineModel) overlayStatusPicker(body string) string {
	// Render status picker inline at bottom of body
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

	// Append picker to body
	bodyLines = append(bodyLines, picker...)
	return strings.Join(bodyLines, "\n")
}

func (m PipelineModel) overlayDiscardFlow(body string) string {
	bodyLines := strings.Split(body, "\n")

	pickerWidth := 50
	padStyle := lipgloss.NewStyle().Padding(0, 2)
	borderStyle := lipgloss.NewStyle().
		Foreground(m.theme.Blue).
		Bold(true)

	var picker []string
	if m.discardStep == 1 {
		picker = append(picker, padStyle.Render(borderStyle.Render(fmt.Sprintf("Select %s Reason:", m.discardStatus))))
		for i, opt := range m.discardOptions {
			style := lipgloss.NewStyle().Foreground(m.theme.Text).Width(pickerWidth)
			if i == m.discardCursor {
				style = style.Background(m.theme.Overlay).Bold(true)
			}
			prefix := "  "
			if i == m.discardCursor {
				prefix = "> "
			}
			picker = append(picker, padStyle.Render(style.Render(prefix+opt)))
		}
	} else if m.discardStep == 2 {
		picker = append(picker, padStyle.Render(borderStyle.Render(fmt.Sprintf("Enter custom %s reason (ESC to cancel):", m.discardStatus))))
		style := lipgloss.NewStyle().Foreground(m.theme.Text).Width(pickerWidth).Background(m.theme.Overlay)
		picker = append(picker, padStyle.Render(style.Render("> "+m.discardInputVal+"█")))
	}

	bodyLines = append(bodyLines, picker...)
	return strings.Join(bodyLines, "\n")
}

func (m PipelineModel) overlayHiredFlow() string {
	borderStyle := lipgloss.NewStyle().
		Border(lipgloss.DoubleBorder()).
		BorderForeground(m.theme.Blue).
		Padding(1, 2)

	var winContent string
	switch m.hiredStep {
	case 1:
		winContent = lipgloss.JoinVertical(lipgloss.Center,
			lipgloss.NewStyle().Foreground(m.theme.Green).Bold(true).Render("🎉 CONGRATULATIONS! 🎉"),
			"",
			lipgloss.NewStyle().Foreground(m.theme.Text).Render("You landed the job!"),
			lipgloss.NewStyle().Foreground(m.theme.Text).Render(fmt.Sprintf("%s @ %s", m.hiredApp.Role, m.hiredApp.Company)),
			"",
			lipgloss.NewStyle().Foreground(m.theme.Subtext).Render("This moment belongs entirely to you. Celebrate the win!"),
			"",
			lipgloss.NewStyle().Foreground(m.theme.Blue).Render("Press [ Enter ] to continue..."),
		)
	case 2:
		winContent = lipgloss.JoinVertical(lipgloss.Center,
			lipgloss.NewStyle().Foreground(m.theme.Green).Bold(true).Render("Share your story? 🚀"),
			"",
			lipgloss.NewStyle().Foreground(m.theme.Text).Render("We'd love to hear your story on GitHub!"),
			lipgloss.NewStyle().Foreground(m.theme.Text).Render("Your story helps others in the community see what's possible."),
			"",
			lipgloss.NewStyle().Foreground(m.theme.Blue).Render("Press [ Y ] to open template in browser / [ N ] to skip"),
		)
	case 3:
		weeks := m.calculateWeeksToHire()
		winContent = lipgloss.JoinVertical(lipgloss.Center,
			lipgloss.NewStyle().Foreground(m.theme.Green).Bold(true).Render("Opt-in Anonymous Stat? 📊"),
			"",
			lipgloss.NewStyle().Foreground(m.theme.Text).Render("Help us count community hires in the public README:"),
			lipgloss.NewStyle().Foreground(m.theme.Subtext).Render(fmt.Sprintf("- Role: %s", m.hiredApp.Role)),
			lipgloss.NewStyle().Foreground(m.theme.Subtext).Render(fmt.Sprintf("- Weeks to hire: %d", weeks)),
			"",
			lipgloss.NewStyle().Foreground(m.theme.Text).Render("No names, no companies, and no salaries are shared."),
			"",
			lipgloss.NewStyle().Foreground(m.theme.Blue).Render("Press [ Y ] to opt-in / [ N ] to keep completely local"),
		)
	}

	box := borderStyle.Render(winContent)
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, box)
}

// overlayPDFPicker renders the PDF chooser inline at the bottom of the body,
// mirroring overlayStatusPicker. Choices show the PDF filename only — the
// directory is always output/ and the role variant lives in the name.
func (m PipelineModel) overlayPDFPicker(body string) string {
	bodyLines := strings.Split(body, "\n")

	pickerWidth := m.width - 8
	if pickerWidth < 30 {
		pickerWidth = 30
	}
	padStyle := lipgloss.NewStyle().Padding(0, 2)
	borderStyle := lipgloss.NewStyle().
		Foreground(m.theme.Blue).
		Bold(true)

	var picker []string
	picker = append(picker, padStyle.Render(borderStyle.Render("Open CV PDF:")))

	for i, choice := range m.pdfChoices {
		style := lipgloss.NewStyle().Foreground(m.theme.Text).Width(pickerWidth)
		if i == m.pdfCursor {
			style = style.Background(m.theme.Selection).Bold(true)
		}
		prefix := "  "
		if i == m.pdfCursor {
			prefix = "> "
		}
		name := truncateRunes(filepath.Base(filepath.FromSlash(choice)), pickerWidth-2)
		picker = append(picker, padStyle.Render(style.Render(prefix+name)))
	}

	bodyLines = append(bodyLines, picker...)
	return strings.Join(bodyLines, "\n")
}

// overlayColPicker renders the column visibility picker inline at the bottom
// of the body. SPACE toggles the focused column; ESC or C closes.
func (m PipelineModel) overlayColPicker(body string) string {
	bodyLines := strings.Split(body, "\n")
	pickerWidth := 36
	padStyle := lipgloss.NewStyle().Padding(0, 2)
	borderStyle := lipgloss.NewStyle().Foreground(m.theme.Blue).Bold(true)
	dimStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	var picker []string
	picker = append(picker, padStyle.Render(borderStyle.Render("─── Columns (SPACE toggle · ESC close) ───")))

	for i, col := range optionalCols {
		on := m.visibleCols[col.id]
		check := "[ ]"
		checkColor := m.theme.Subtext
		if on {
			check = "[✓]"
			checkColor = m.theme.Green
		}
		style := lipgloss.NewStyle().Foreground(m.theme.Text).Width(pickerWidth)
		if i == m.colPickerIdx {
			style = style.Background(m.theme.Selection).Bold(true)
		}
		checkStr := lipgloss.NewStyle().Foreground(checkColor).Render(check)
		label := col.header
		if col.hint != "" {
			label += "  " + dimStyle.Render(col.hint)
		}
		row := checkStr + " " + label
		picker = append(picker, padStyle.Render(style.Render(row)))
	}

	bodyLines = append(bodyLines, picker...)
	return strings.Join(bodyLines, "\n")
}

// -- Helpers --

func (m PipelineModel) scoreStyle(score float64) lipgloss.Style {
	switch {
	case score <= 0:
		return lipgloss.NewStyle().Foreground(m.theme.Subtext)
	case score >= 4.2:
		return lipgloss.NewStyle().Foreground(m.theme.Green).Bold(true)
	case score >= 3.8:
		return lipgloss.NewStyle().Foreground(m.theme.Yellow)
	case score >= 3.0:
		return lipgloss.NewStyle().Foreground(m.theme.Text)
	default:
		return lipgloss.NewStyle().Foreground(m.theme.Red)
	}
}

func (m PipelineModel) statusColorMap() map[string]lipgloss.Color {
	return map[string]lipgloss.Color{
		"processing":        m.theme.Mauve,
		"pending":           m.theme.Yellow,
		"failed":            m.theme.Red,
		"rate_limited":      m.theme.Yellow,
		"paused":            m.theme.Yellow,
		"unmerged_complete": m.theme.Green,
		"interview":         m.theme.Green,
		"offer":             m.theme.Green,
		"accepted":          m.theme.Pink,
		"approached":        m.theme.Sky,
		"responded":         m.theme.Blue,
		"evaluated":         m.theme.Text,
		"skip":              m.theme.Red,
		"rejected":          m.theme.Subtext,
		"discarded":         m.theme.Subtext,
	}
}

func (m PipelineModel) countByNormStatus(status string) int {
	count := 0
	for _, app := range m.filtered {
		if data.NormalizeStatus(app.Status) == status {
			count++
		}
	}
	return count
}

// formatTimeAgo renders an ISO date as a relative duration in calendar days:
// "today", "yesterday", or "Nd ago". Tracker dates are day-granular (no
// time-of-day), so we never report sub-day hours — doing so would fabricate
// precision the data doesn't have (e.g. an entry dated today would otherwise
// read "13h ago" simply because it's 1pm, not because contact was 13h back).
func formatTimeAgo(dateStr string) string {
	t, err := time.ParseInLocation("2006-01-02", dateStr, time.Local)
	if err != nil {
		return dateStr // not a date — show it untouched rather than lie
	}
	now := time.Now()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.Local)
	contactDay := time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.Local)
	// Round to the nearest day so DST transitions don't skew the count.
	days := int(math.Round(today.Sub(contactDay).Hours() / 24))
	switch {
	case days <= 0:
		return "today"
	case days == 1:
		return "yesterday"
	default:
		return fmt.Sprintf("%dd ago", days)
	}
}

// truncateRunes truncates a string to at most maxRunes runes, appending "..." if truncated.
func truncateRunes(s string, maxRunes int) string {
	runes := []rune(s)
	if len(runes) <= maxRunes {
		return s
	}
	if maxRunes <= 3 {
		return string(runes[:maxRunes])
	}
	return string(runes[:maxRunes-3]) + "..."
}

func statusLabel(norm string) string {
	switch norm {
	case "processing":
		return "Processing"
	case "pending":
		return "Pending"
	case "failed":
		return "Failed"
	case "rate_limited":
		return "Rate Limited"
	case "paused":
		return "Paused"
	case "unmerged_complete":
		return "Unmerged"
	case "interview":
		return "Interview"
	case "offer":
		return "Offer"
	case "accepted":
		return "Accepted"
	case "responded":
		return "Responded"
	case "approached":
		return "Approached"
	case "evaluated":
		return "Evaluated"
	case "skip":
		return "Skip"
	case "rejected":
		return "Rejected"
	case "discarded":
		return "Discarded"
	default:
		return norm
	}
}

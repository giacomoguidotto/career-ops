package model

// CareerApplication represents a single job application from the tracker.
type CareerApplication struct {
	Number       int
	Date         string
	Company      string
	Role         string
	Status       string
	Score        float64
	ScoreRaw     string
	HasPDF       bool
	ReportPath   string
	ReportNumber string
	Notes        string
	JobURL       string // URL of the original job posting
	// Derived from Notes free-text and scan-history metadata.
	Location    string  // City/region text for dashboard display
	WorkMode    string  // "Remote" | "RemoteFlex" | "Hybrid" | "Full" (onsite), "" when unknown
	PayRange    string  // first $-range found in the notes, e.g. "$140-210K"
	PayMax      float64 // top of PayRange in dollars (sort key), 0 when unknown
	PaySource   string  // "POSTED" when the JD listed it, "est" for estimates, "" unknown
	LastContact string  // max YYYY-MM-DD found in notes (falls back to applied date)
	// Enrichment (lazy loaded from report)
	Archetype    string
	TlDr         string
	Remote       string
	CompEstimate string
	// Source identifies where this dashboard row came from. Empty is treated as
	// "tracker" for older tests/fixtures.
	Source string
	// Next-action view-model, derived from the row's stage in templates/states.yml.
	ActionState  string // needs_action | waiting | blocked | none
	NextAction   string // the stage's suggests action, e.g. generate_application_pack | send_application | follow_up | none
	ActionOwner  string // agent | user | company | none
	ActionDue    string // YYYY-MM-DD when a waiting action becomes relevant
	WaitingOn    string
	ActionReason string
	NextPackPath string // output/next-packs/... when a generated pack exists
	NextCommand  string // /career-ops next {num}
}

// PipelineMetrics holds aggregate stats for the pipeline dashboard.
type PipelineMetrics struct {
	Total      int
	ByStatus   map[string]int
	AvgScore   float64
	TopScore   float64
	WithPDF    int
	Actionable int
}

// ProgressMetrics holds job search progress analytics.
type ProgressMetrics struct {
	// Funnel
	FunnelStages []FunnelStage

	// Score distribution
	ScoreBuckets []ScoreBucket

	// Timeline (weekly activity)
	WeeklyActivity []WeekActivity

	// Rates
	ResponseRate  float64 // Responded / Applied
	InterviewRate float64 // Interview / Applied
	OfferRate     float64 // Offer / Applied

	// Averages
	AvgScore    float64
	TopScore    float64
	TotalOffers int
	ActiveApps  int // not skip/rejected/discarded
}

// FunnelStage represents one stage of the application funnel.
type FunnelStage struct {
	Label string
	Count int
	Pct   float64 // percentage of total
}

// ScoreBucket represents a score range and its count.
type ScoreBucket struct {
	Label string // e.g., "4.5-5.0", "4.0-4.4", "3.5-3.9", "3.0-3.4", "<3.0"
	Count int
}

// WeekActivity represents application activity for a given ISO week.
type WeekActivity struct {
	Week  string // e.g., "2026-W14", "2026-W13"
	Count int
}

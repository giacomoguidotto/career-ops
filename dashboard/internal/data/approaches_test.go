package data

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

func TestDashboardProjectsApproachAttemptsAndExternalWait(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	today := time.Now().UTC().Format("2006-01-02")
	tracker := `# Opportunities Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|---|---|---|---|---|---|---|---|
| 42 | 2026-07-01 | Acme | Product Engineer | 4.5/5 | Approached | yes |  |  |
`
	if err := os.WriteFile(filepath.Join(root, "data", "applications.md"), []byte(tracker), 0o644); err != nil {
		t.Fatal(err)
	}
	attempts := fmt.Sprintf(`# Approach Attempts

| id | opportunity | date | type | channel | recipient | result | followUpTo | notes |
|---|---|---|---|---|---|---|---|---|
| A001 | 42 | %s | founder_outreach | email | Ada Founder | sent |  | video |
| A002 | 42 | %s | formal_application | ats | Acme hiring team | submitted |  |  |
`, today, today)
	if err := os.WriteFile(filepath.Join(root, "data", "approach-attempts.md"), []byte(attempts), 0o644); err != nil {
		t.Fatal(err)
	}

	rows := ParseDashboardRows(root)
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	row := rows[0]
	if row.AttemptCount != 2 || row.LatestAttemptDate != today {
		t.Fatalf("attempt projection = count %d latest %q", row.AttemptCount, row.LatestAttemptDate)
	}
	if !row.FormalSubmitted {
		t.Fatal("formal application attempt should set FormalSubmitted")
	}
	if len(row.AttemptChannels) != 2 || row.AttemptChannels[0] != "ats" || row.AttemptChannels[1] != "email" {
		t.Fatalf("channels = %#v, want [ats email]", row.AttemptChannels)
	}
	if row.ActionState != "waiting" || row.ActionOwner != "external" || row.WaitingOn != "external response" {
		t.Fatalf("attention = %q/%q/%q", row.ActionState, row.ActionOwner, row.WaitingOn)
	}
}

func TestDashboardWaitAttentionUsesConfiguredCadence(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	profile := "followup_cadence:\n  applied_first_days: 3\n  applied_subsequent_days: 5\n  applied_max_followups: 1\n"
	if err := os.WriteFile(filepath.Join(root, "config", "profile.yml"), []byte(profile), 0o644); err != nil {
		t.Fatal(err)
	}
	cadence := loadApproachCadence(root)
	if cadence.FirstDays != 3 || cadence.SubsequentDays != 5 || cadence.MaxFollowups != 1 {
		t.Fatalf("cadence = %+v", cadence)
	}
	row := model.DashboardRow{Status: "Approached", AttemptCount: 2, FollowupAttemptCount: 1, LatestAttemptDate: "2026-07-10"}
	record := deriveNextActionWithCadence(row, time.Date(2026, 7, 11, 0, 0, 0, 0, time.UTC), states(), cadence)
	if record.ActionState != "needs_action" || !strings.Contains(record.Reason, "configured follow-up limit") {
		t.Fatalf("configured cold attention = %+v", record)
	}
}

func TestPinnedReviewDateOverridesColdAttentionUntilANewerFollowup(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	pins := "# Follow-ups\n\n- next #42 2026-07-20 (set 2026-07-10)\n"
	if err := os.WriteFile(filepath.Join(root, "data", "follow-ups.md"), []byte(pins), 0o644); err != nil {
		t.Fatal(err)
	}
	override := loadApproachReviewOverrides(root)[42]
	cold := applicationActionRecord{ActionState: "needs_action", NextAction: "review_approach", Owner: "user"}
	row := model.DashboardRow{Number: 42, FollowupAttemptCount: 2, LatestFollowupAttemptDate: "2026-07-10"}
	record := applyApproachReviewOverride(cold, row, time.Date(2026, 7, 14, 0, 0, 0, 0, time.UTC), override)
	if record.ActionState != "waiting" || record.DueAfter != "2026-07-20" {
		t.Fatalf("active pin = %+v", record)
	}
	row.LatestFollowupAttemptDate = "2026-07-11"
	if got := applyApproachReviewOverride(cold, row, time.Date(2026, 7, 14, 0, 0, 0, 0, time.UTC), override); got.ActionState != "needs_action" {
		t.Fatalf("newer follow-up should clear pin, got %+v", got)
	}
}

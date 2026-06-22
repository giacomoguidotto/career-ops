package screens

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/santifer/career-ops/dashboard/internal/model"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

func TestProgressSafePageKeysMirrorCtrlPageKeys(t *testing.T) {
	weeks := make([]model.WeekActivity, 20)
	for i := range weeks {
		weeks[i] = model.WeekActivity{Week: "2026-W01", Count: i + 1}
	}
	m := NewProgressModel(
		theme.NewTheme("catppuccin-mocha"),
		model.ProgressMetrics{
			FunnelStages: []model.FunnelStage{
				{Label: "Evaluated", Count: 20, Pct: 100},
			},
			ScoreBuckets: []model.ScoreBucket{
				{Label: "4.0-4.4", Count: 10},
			},
			WeeklyActivity: weeks,
		},
		80,
		10,
	)

	pageRows := m.viewportHeight()
	m, _ = m.Update(tea.KeyMsg{Type: tea.KeySpace})
	if m.scrollOffset != pageRows {
		t.Fatalf("Space moved to offset %d, want %d", m.scrollOffset, pageRows)
	}

	m, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'b'}})
	if m.scrollOffset != 0 {
		t.Fatalf("b should page back to the top, got offset %d", m.scrollOffset)
	}
}

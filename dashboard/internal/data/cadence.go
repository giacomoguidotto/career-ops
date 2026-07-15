package data

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/santifer/career-ops/dashboard/internal/model"
	"gopkg.in/yaml.v3"
)

type approachCadence struct {
	FirstDays      int
	SubsequentDays int
	MaxFollowups   int
}

type approachReviewOverride struct {
	Date    string
	SetDate string
}

var approachReviewOverridePattern = regexp.MustCompile(`(?i)^-\s+next\s+#(\d+)\s+(\d{4}-\d{2}-\d{2})(?:\s+\(set\s+(\d{4}-\d{2}-\d{2})\))?\s*$`)

func defaultApproachCadence() approachCadence {
	return approachCadence{FirstDays: 7, SubsequentDays: 7, MaxFollowups: 2}
}

func loadApproachCadence(careerOpsPath string) approachCadence {
	cadence := defaultApproachCadence()
	content, err := os.ReadFile(filepath.Join(careerOpsPath, "config", "profile.yml"))
	if err != nil {
		return cadence
	}
	var profile struct {
		FollowupCadence struct {
			FirstDays      *int `yaml:"applied_first_days"`
			SubsequentDays *int `yaml:"applied_subsequent_days"`
			MaxFollowups   *int `yaml:"applied_max_followups"`
		} `yaml:"followup_cadence"`
	}
	if yaml.Unmarshal(content, &profile) != nil {
		return cadence
	}
	if value := profile.FollowupCadence.FirstDays; value != nil && *value >= 0 {
		cadence.FirstDays = *value
	}
	if value := profile.FollowupCadence.SubsequentDays; value != nil && *value >= 0 {
		cadence.SubsequentDays = *value
	}
	if value := profile.FollowupCadence.MaxFollowups; value != nil && *value >= 0 {
		cadence.MaxFollowups = *value
	}
	return cadence
}

func loadApproachReviewOverrides(careerOpsPath string) map[int]approachReviewOverride {
	result := map[int]approachReviewOverride{}
	content, err := os.ReadFile(filepath.Join(careerOpsPath, "data", "follow-ups.md"))
	if err != nil {
		return result
	}
	for _, raw := range strings.Split(string(content), "\n") {
		match := approachReviewOverridePattern.FindStringSubmatch(strings.TrimSpace(raw))
		if match == nil {
			continue
		}
		number, err := strconv.Atoi(match[1])
		if err != nil {
			continue
		}
		setDate := match[3]
		if setDate == "" {
			setDate = match[2]
		}
		result[number] = approachReviewOverride{Date: match[2], SetDate: setDate}
	}
	return result
}

func applyApproachReviewOverride(record applicationActionRecord, app model.DashboardRow, now time.Time, override approachReviewOverride) applicationActionRecord {
	if app.LatestFollowupAttemptDate != "" && app.LatestFollowupAttemptDate > override.SetDate {
		return record
	}
	record.NextAction = "review_approach"
	record.DueAfter = override.Date
	if dateAfter(override.Date, now) {
		record.ActionState = "waiting"
		record.Owner = "external"
		record.WaitingOn = "external response"
		record.Reason = "Approach review date is pinned by the user."
		return record
	}
	record.ActionState = "needs_action"
	record.Owner = "user"
	record.WaitingOn = ""
	record.Reason = "Pinned Approach review is due; generate the best next route from confirmed attempts."
	return record
}

package data

import (
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

type approachAttempt struct {
	ID          string
	Opportunity int
	Date        string
	Type        string
	Channel     string
	Recipient   string
	Result      string
}

func loadApproachAttempts(careerOpsPath string) map[int][]approachAttempt {
	path := filepath.Join(careerOpsPath, "data", "approach-attempts.md")
	content, err := os.ReadFile(path)
	if err != nil {
		return map[int][]approachAttempt{}
	}
	byOpportunity := map[int][]approachAttempt{}
	for _, raw := range strings.Split(string(content), "\n") {
		line := strings.TrimSpace(raw)
		if !strings.HasPrefix(line, "| A") {
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) < 10 {
			continue
		}
		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
		}
		opportunity, err := strconv.Atoi(parts[2])
		if err != nil {
			continue
		}
		byOpportunity[opportunity] = append(byOpportunity[opportunity], approachAttempt{
			ID:          parts[1],
			Opportunity: opportunity,
			Date:        parts[3],
			Type:        parts[4],
			Channel:     parts[5],
			Recipient:   parts[6],
			Result:      parts[7],
		})
	}
	return byOpportunity
}

func enrichApproachAttempts(careerOpsPath string, apps []model.DashboardRow) {
	byOpportunity := loadApproachAttempts(careerOpsPath)
	for index := range apps {
		attempts := byOpportunity[apps[index].Number]
		if len(attempts) == 0 {
			continue
		}
		sort.SliceStable(attempts, func(i, j int) bool {
			if attempts[i].Date == attempts[j].Date {
				return attempts[i].ID < attempts[j].ID
			}
			return attempts[i].Date < attempts[j].Date
		})
		latest := attempts[len(attempts)-1]
		channels := map[string]bool{}
		followups := 0
		latestFollowupDate := ""
		formal := false
		for _, attempt := range attempts {
			if attempt.Channel != "" {
				channels[attempt.Channel] = true
			}
			if attempt.Type == "follow_up" {
				followups++
				if attempt.Date > latestFollowupDate {
					latestFollowupDate = attempt.Date
				}
			}
			if attempt.Type == "formal_application" {
				formal = true
			}
		}
		channelList := make([]string, 0, len(channels))
		for channel := range channels {
			channelList = append(channelList, channel)
		}
		sort.Strings(channelList)

		apps[index].AttemptCount = len(attempts)
		apps[index].FollowupAttemptCount = followups
		apps[index].LatestFollowupAttemptDate = latestFollowupDate
		if len(apps[index].LatestFollowupAttemptDate) >= 10 {
			apps[index].LatestFollowupAttemptDate = apps[index].LatestFollowupAttemptDate[:10]
		}
		apps[index].LatestAttemptID = latest.ID
		apps[index].LatestAttemptDate = latest.Date
		if len(apps[index].LatestAttemptDate) >= 10 {
			apps[index].LatestAttemptDate = apps[index].LatestAttemptDate[:10]
		}
		apps[index].LatestAttemptType = latest.Type
		apps[index].LatestAttemptChannel = latest.Channel
		apps[index].LatestAttemptRecipient = latest.Recipient
		apps[index].LatestAttemptResult = latest.Result
		apps[index].AttemptChannels = channelList
		apps[index].FormalSubmitted = formal
		if latest.Date > apps[index].LastContact {
			apps[index].LastContact = latest.Date
		}
	}
}

package data

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"
)

// stage mirrors one entry in templates/states.yml. That file is the single
// source of truth for the per-application lifecycle state machine; the dashboard
// derives normalization, routing, grouping, and sort order from it rather than
// re-encoding any of it here.
type stage struct {
	ID             string   `yaml:"id"`
	Label          string   `yaml:"label"`
	Owner          string   `yaml:"owner"`
	Suggests       string   `yaml:"suggests"`
	OnDemand       []string `yaml:"on_demand"`
	NextStates     []string `yaml:"next_states"`
	DashboardGroup string   `yaml:"dashboard_group"`
	Aliases        []string `yaml:"aliases"`
	Description    string   `yaml:"description"`
}

type statesDoc struct {
	Version int     `yaml:"version"`
	States  []stage `yaml:"states"`
}

// stateMachine is an indexed, read-only view of templates/states.yml.
type stateMachine struct {
	stages  []stage
	byID    map[string]stage
	byLabel map[string]stage
	byAlias map[string]stage
}

var (
	statesMu    sync.Mutex
	statesCache *stateMachine
	statesRoot  string
)

// setStatesRoot records the career-ops repo root so the state machine loads from
// its templates/states.yml. Safe to call repeatedly; it is a no-op once the
// machine has been loaded.
func setStatesRoot(careerOpsPath string) {
	statesMu.Lock()
	defer statesMu.Unlock()
	if careerOpsPath != "" && statesCache == nil {
		statesRoot = careerOpsPath
	}
}

// states returns the cached state machine, loading it on first use.
func states() *stateMachine {
	statesMu.Lock()
	defer statesMu.Unlock()
	if statesCache == nil {
		statesCache = loadStateMachine(locateStatesFile(statesRoot))
	}
	return statesCache
}

// locateStatesFile resolves templates/states.yml, preferring the repo root passed
// by ParseApplications, then self-locating from the source tree (for `go test`),
// then the working directory.
func locateStatesFile(root string) string {
	rel := filepath.Join("templates", "states.yml")
	if root != "" {
		if p := filepath.Join(root, rel); fileExists(p) {
			return p
		}
	}
	if _, file, _, ok := runtime.Caller(0); ok {
		if p := findUpwards(filepath.Dir(file), rel); p != "" {
			return p
		}
	}
	if wd, err := os.Getwd(); err == nil {
		if p := findUpwards(wd, rel); p != "" {
			return p
		}
	}
	return ""
}

func findUpwards(start, rel string) string {
	dir := start
	for {
		if p := filepath.Join(dir, rel); fileExists(p) {
			return p
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func loadStateMachine(path string) *stateMachine {
	sm := &stateMachine{
		byID:    map[string]stage{},
		byLabel: map[string]stage{},
		byAlias: map[string]stage{},
	}
	if path == "" {
		return sm
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return sm
	}
	var doc statesDoc
	if err := yaml.Unmarshal(content, &doc); err != nil {
		return sm
	}
	for _, st := range doc.States {
		sm.stages = append(sm.stages, st)
		if st.ID != "" {
			sm.byID[strings.ToLower(st.ID)] = st
		}
		if st.Label != "" {
			sm.byLabel[strings.ToLower(st.Label)] = st
		}
		for _, a := range st.Aliases {
			if key := strings.ToLower(strings.TrimSpace(a)); key != "" {
				sm.byAlias[key] = st
			}
		}
	}
	return sm
}

// stripStatusDecorations lowercases raw status text and removes markdown bold and
// a trailing date so it can be matched against the state machine.
func stripStatusDecorations(raw string) string {
	s := strings.ReplaceAll(raw, "**", "")
	s = strings.TrimSpace(strings.ToLower(s))
	if idx := strings.Index(s, " 202"); idx > 0 {
		s = strings.TrimSpace(s[:idx])
	}
	return s
}

// lookupStage resolves raw status text to its canonical stage, matching by id,
// label, and alias (exact first, then a substring fallback for messy legacy
// values). The second return is false when the text is not a lifecycle stage.
func (sm *stateMachine) lookupStage(raw string) (stage, bool) {
	s := stripStatusDecorations(raw)
	if s == "" {
		return stage{}, false
	}
	if st, ok := sm.byID[s]; ok {
		return st, true
	}
	if st, ok := sm.byLabel[s]; ok {
		return st, true
	}
	if st, ok := sm.byAlias[s]; ok {
		return st, true
	}
	if st, ok := sm.byID[strings.ReplaceAll(s, " ", "_")]; ok {
		return st, true
	}
	for _, st := range sm.stages {
		for _, tok := range st.matchTokens() {
			if tok != "" && strings.Contains(s, tok) {
				return st, true
			}
		}
	}
	return stage{}, false
}

func (st stage) matchTokens() []string {
	toks := []string{strings.ToLower(st.ID), strings.ToLower(st.Label)}
	for _, a := range st.Aliases {
		toks = append(toks, strings.ToLower(strings.TrimSpace(a)))
	}
	return toks
}

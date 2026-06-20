package data

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

// The tracker's Notes column is free-text, but evaluations write it with stable
// conventions: work mode ("Remote US", "Charlotte NC (Hybrid)"), a pay range
// ("$140-210K (POSTED)" / "~$150-220K (est)") and event dates ("Rejected
// 2026-06-04"). These regexes lift that structure back out so the dashboard can
// show Location / Pay / Last-contact columns without a tracker schema change.
var (
	// Pay amounts across the currencies career-ops users actually see, optionally
	// a range: "$140-210K", "€130-160K", "£175-225K", "CHF 165-185K",
	// "$174,986-209,983", "~$124.2-198.7K". payCeiling stays currency-naive (it
	// reads the numbers), so PayMax sorts by magnitude across currencies.
	reMoneySpan = regexp.MustCompile(`~?(?:[$€£]|CHF ?|EUR ?|USD ?|GBP ?)\d[\d,]*(?:\.\d+)?[KkMm]?(?:\s*[-–]\s*(?:[$€£])?\d[\d,]*(?:\.\d+)?[KkMm]?)?`)
	// ISO dates embedded in notes ("Rejected 2026-06-04", "viewed 2026-06-04")
	reISODate = regexp.MustCompile(`\b20\d{2}-\d{2}-\d{2}\b`)
	// "City ST" / "City, ST" with a strict two-letter US state code so prose like
	// "Sams AI" or "Kerin Colby DONE" can't false-positive.
	reCityState = regexp.MustCompile(`\b([A-Z][A-Za-z.'-]+(?: [A-Z][A-Za-z.'-]+){0,2}),? (A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b`)
	// International cities, checked only when no US "City, ST" matches, so
	// European/other non-US roles still surface a Location. Cities only (not bare
	// country names) to avoid prose false-positives like "Portugal eligible" or
	// "remote in Germany", which describe eligibility, not the job's location.
	reCityIntl = regexp.MustCompile(`(?i)\b(Porto|Lisbon|London|Berlin|Munich|Hamburg|Frankfurt|Cologne|D(?:ü|u)sseldorf|Stuttgart|Z(?:ü|u)rich|Geneva|Lausanne|Basel|Dublin|Cork|Amsterdam|Rotterdam|Eindhoven|Utrecht|Paris|Lyon|Madrid|Barcelona|Valencia|Stockholm|Gothenburg|Malm(?:ö|o)|Copenhagen|Oslo|Helsinki|Milan|Rome|Turin|Vienna|Brussels|Ghent|Antwerp|Luxembourg|Warsaw|Krak(?:ó|o)w|Wroc(?:ł|l)aw|Tallinn|Riga|Vilnius|Prague|Brno|Budapest|Bucharest|Sofia|Athens|Bengaluru|Bangalore|Singapore|Sydney|Toronto|Vancouver|Tel Aviv|S(?:ã|a)o Paulo)\b`)
	// Individual amounts inside an already-matched span: "140", "210K", "209,983"
	reMoneyPart = regexp.MustCompile(`(\d[\d,]*(?:\.\d+)?)\s*([KkMm]?)`)
	// Estimate markers: "(est)", "(est;", "market est)" or "market" as its own
	// word — but not "(EST/CST" timezones, "interest)" or "marketing".
	reEstHint = regexp.MustCompile(`\(est[),;. ]|\best\)|\bmarket\b`)
)

func locationHintWorkMode(raw string) string {
	lower := strings.ToLower(raw)
	switch {
	case strings.Contains(lower, "hybrid"):
		return "Hybrid"
	case strings.Contains(lower, "remote-friendly") ||
		strings.Contains(lower, "remote-first") ||
		strings.Contains(lower, "remote first"):
		return "RemoteFlex"
	case strings.Contains(lower, "remote") || strings.Contains(lower, "remotely"):
		return "Remote"
	case strings.Contains(lower, "onsite") ||
		strings.Contains(lower, "on-site") ||
		strings.Contains(lower, "in-office"):
		return "Full"
	default:
		return ""
	}
}

func stripLeadingLocationMode(raw string) string {
	s := strings.TrimSpace(raw)
	lower := strings.ToLower(s)
	for _, prefix := range []string{
		"remote-friendly",
		"remote-first",
		"remote first",
		"remote",
		"remotely",
		"hybrid",
		"in-office",
		"on-site",
		"onsite",
	} {
		if !strings.HasPrefix(lower, prefix) {
			continue
		}
		rest := strings.TrimSpace(s[len(prefix):])
		rest = strings.Trim(rest, " \t-–—,;:()")
		if strings.HasPrefix(strings.ToLower(rest), "in ") {
			rest = strings.TrimSpace(rest[3:])
		}
		return strings.Trim(rest, " \t-–—,;:()")
	}
	return s
}

func cleanLocationHint(raw string) string {
	s := stripLeadingLocationMode(raw)
	for _, suffix := range []string{"(Remote)", "(Hybrid)", "(Onsite)", "(On-site)", "(In-office)"} {
		if strings.HasSuffix(strings.ToLower(s), strings.ToLower(suffix)) {
			s = strings.TrimSpace(s[:len(s)-len(suffix)])
			break
		}
	}
	s = strings.Trim(s, " \t-–—,;:()")
	switch strings.ToLower(s) {
	case "", "remote", "remotely", "hybrid", "onsite", "on-site", "in-office":
		return ""
	default:
		return s
	}
}

func applyLocationHint(app *model.CareerApplication, raw string) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return
	}

	location := cleanLocationHint(raw)
	workMode := locationHintWorkMode(raw)
	if workMode == "" && location != "" {
		workMode = "Full"
	}
	if location != "" {
		app.Location = location
	}
	if workMode != "" {
		app.WorkMode = workMode
	}
}

// payCeiling converts a matched pay span to its top dollar amount for sorting:
// "$140-210K" → 210000, "$174,986-209,983" → 209983, "$170K" → 170000.
func payCeiling(span string) float64 {
	top := 0.0
	for _, p := range reMoneyPart.FindAllStringSubmatch(span, -1) {
		v, err := strconv.ParseFloat(strings.ReplaceAll(p[1], ",", ""), 64)
		if err != nil {
			continue
		}
		switch strings.ToLower(p[2]) {
		case "k":
			v *= 1_000
		case "m":
			v *= 1_000_000
		}
		if v > top {
			top = v
		}
	}
	return top
}

// deriveNoteFields populates Location, WorkMode, PayRange, PaySource and
// LastContact from the application's Notes (plus Role for work-mode keywords).
func deriveNoteFields(app *model.CareerApplication) {
	lower := strings.ToLower(app.Role + " " + app.Notes)

	// Location: first "City, ST" in the notes, falling back to the role title
	// (some tracker rows carry the city there, e.g. "... — Charlotte, NC"). When
	// no US "City, ST" is present, fall back to an international city/country so
	// European and other non-US roles still show a Location.
	if m := reCityState.FindStringSubmatch(app.Notes); m != nil {
		app.Location = m[1] + ", " + m[2]
	} else if m := reCityState.FindStringSubmatch(app.Role); m != nil {
		app.Location = m[1] + ", " + m[2]
	} else if m := reCityIntl.FindString(app.Notes); m != "" {
		app.Location = m
	} else if m := reCityIntl.FindString(app.Role); m != "" {
		app.Location = m
	}

	// Work mode: hybrid beats remote ("Remote/hybrid" means office days exist);
	// "remote-first" / "remote + flex" is softer than fully remote;
	// a bare city+state with no keyword implies fully on-site.
	switch {
	case strings.Contains(lower, "hybrid"):
		app.WorkMode = "Hybrid"
	case strings.Contains(lower, "remote") &&
		(strings.Contains(lower, "flex") ||
			strings.Contains(lower, "remote-first") ||
			strings.Contains(lower, "remote first")):
		app.WorkMode = "RemoteFlex"
	case strings.Contains(lower, "remote"):
		app.WorkMode = "Remote"
	case strings.Contains(lower, "onsite") || strings.Contains(lower, "on-site") || strings.Contains(lower, "in-office"):
		app.WorkMode = "Full"
	case app.Location != "":
		app.WorkMode = "Full"
	}

	// Pay: prefer the first $-range; fall back to the first lone $-amount
	// (e.g. "$170K min floor") only when no range exists.
	matches := reMoneySpan.FindAllString(app.Notes, -1)
	for _, mm := range matches {
		if strings.ContainsAny(mm, "-–") {
			app.PayRange = mm
			break
		}
	}
	if app.PayRange == "" && len(matches) > 0 {
		app.PayRange = matches[0]
	}
	app.PayMax = payCeiling(app.PayRange)
	if app.PayRange != "" {
		switch {
		case strings.Contains(lower, "(posted"):
			app.PaySource = "POSTED"
		case reEstHint.MatchString(lower):
			app.PaySource = "est"
		}
	}

	// Last contact: the most recent ISO date mentioned anywhere in the notes
	// (rejections, recruiter views, phone screens), else the applied date.
	last := app.Date
	for _, d := range reISODate.FindAllString(app.Notes, -1) {
		if d > last {
			last = d
		}
	}
	app.LastContact = last
}

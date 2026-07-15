# Mode: tracker: Opportunity Tracker

Read and display `data/applications.md`.

**Tracker Format:**

```markdown
| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
```

With the optional Via column (intermediary channel, #1596) after Company:

```markdown
| # | Date | Company | Via | Role | Score | Status | PDF | Report | Notes |
```

- `Via` = the agency/recruiter firm the application goes through; `—` for direct applications. Add the column to an existing tracker with `node merge-tracker.mjs --migrate-via` (all scripts auto-detect both layouts).
- **Unknown end employer** (recruiter hasn't named the client yet): Company = `?` (the structural marker — never the word "Confidential", which is locale-dependent and collides with real firm names), Via = the agency, and a distinguishing descriptor in Notes (e.g. `fintech, Leeds`). Display it to the user as "Confidential (via {Via})".
- The row's identity is its `#` (report number) — Company is display data and changes at most once, at reveal.

Possible states (single source of truth: `templates/states.yml`):

Spine: `Evaluated` → `Approach Ready` → `Approached` → `Responded` → `Interview Ready` → `Offer` → `Offer Ready` → `Accepted`. Terminals: `Rejected` / `Discarded` / `SKIP`.

- `Evaluated` = opportunity evaluated with report; agent drafts a ranked Approach Plan
- `Approach Ready` = plan drafted; waiting for the user to execute one or more routes and report exactly what happened
- `Approached` = at least one confirmed Approach Attempt exists; waiting, review due, and stale are derived from attempt history
- `Responded` = company responded (not yet interview); agent drafts a cheatsheet
- `Interview Ready` = cheatsheet drafted; waiting for the user to interview and report (loops for extra rounds)
- `Offer` = job offer received; agent drafts negotiation prep
- `Offer Ready` = negotiation prep drafted; waiting for the user to negotiate/decide
- `Accepted` = offer accepted (happy-path terminal)
- `Rejected` = rejected by company
- `Discarded` = discarded by candidate or offer closed
- `SKIP` = doesn't fit, don't apply

Each state declares an `owner` in `states.yml`: `agent` stages are drafted by
automation; `user` stages wait on the user reporting a real-world action;
`external` stages are a pure wait. Write EXACTLY one label above into the Status
column (no bold, no dates, no extra text).

If the user asks to update a state, edit the corresponding row.

## User-reported candidacy events

A plain-language report such as "I just applied to #313", "I sent the outreach",
or "the recruiter replied" is an instruction to record confirmed reality, not
merely news to acknowledge.

1. Resolve the exact row and record only the confirmed action through the
   canonical writer, for example:
   `node record-approach.mjs 313 formal_application --channel ats --recipient "BLP Digital hiring team" --occurred-at 2026-07-09 --result submitted --json`.
   The first Attempt moves the Opportunity to `Approached`; later Attempts keep
   that Stage. Drafts and recommendations never create Attempts.
   Do not use `node set-status.mjs` to create `Approached`; the Attempt writer
   owns that factual transition.
2. Read the writer's `candidacyCoordination` result, including
   `sameCompanyApplications`, then inspect the updated attempt ledger.
   Same-company rows are research leads, not an automatic cluster.
3. Execute the canonical research, fallback, and persistence contract in
   `modes/next.md` -> Candidacy Coordination. Read or update
   `data/candidacy-clusters.md`; do not abbreviate the Hiring-surface review just
   because the user event already changed one Stage.
4. Run `node candidacy-select.mjs --json` after persisting the review. Report its
   eligible/suppressed result for the affected company and resolve any
   `researchRequired` membership drift before recommending another Application.
5. The newly approached Opportunity becomes the active Primary Opportunity for its
   Hiring surface unless a more progressed member already reserves the cluster.
   Record the Outreach anchor when the user also confirms a first touch.
6. Reconcile guidance, not facts: this coordination review never changes a
   sibling Application's Stage. It suppresses conflicting implicit packs and
   duplicate first-touch outreach through `modes/next.md` and `modes/contact.md`.
   If a sibling pack already exists, flag it as an interactive alternate instead
   of telling the candidate to send it automatically.

Report the recorded Attempt, derived review timing, Primary Opportunity, any
suppressed siblings, and the evidence/fallback used. Initial Outreach belongs to
the cluster's contact history; it is not a cadence Follow-up.

**Salary observations:** when the user reports a confirmed compensation figure for a row ("recruiter said 84k", "offer letter says 92k", "signed at 90k"), append one `actual` observation line to `data/salary-observations.tsv` (create the file if missing; format per `docs/SCRIPTS.md` → salary-gap) with the source tier matching how the figure arrived: `recruiter-verbal` for a spoken figure, `offer-letter` for a written offer, `contract` for a signed contract. The log is append-only — a new figure is a new line, never an edit of a prior one. Then echo that application's gap in one line (advertised vs actual vs desired); `node salary-gap.mjs --summary` shows the full picture.

**Reveal workflow (#1596):** when the user learns the end employer of a `?` row ("the Hays role is Barclays"):

1. Edit the row's Company cell in place (`?` → real name). Never renumber.
2. Update the report: append the company to the H1 title, fill the header fields, and set `company_confidential: false` (+ real `company:`) in the Machine Summary YAML. **Never rename the report file** — the number is the identity, links stay stable.
3. Run the cross-channel check: `node verify-pipeline.mjs`. If the same company+role now exists under a different Via (agency + direct, or two agencies), warn the user loudly — **never auto-merge**; both submissions really happened and the user decides which channel owns the candidacy.

Be honest about timing: this check catches damage after the fact. The preventive check happens in `apply` mode, before authorizing an agency submission.

Also show statistics:
- Total applications
- Breakdown by state
- Average score
- % with PDF generated
- % with report generated
- If `data/salary-observations.tsv` has confirmed `actual` observations, include the output of `node salary-gap.mjs --summary` (advertised→actual gaps, desired attainment)

For the full lifetime stats view (cumulative funnel, scanner totals, portal
coverage, follow-up compliance), run `node stats.mjs --summary` and present its
output. Zero tokens — never recompute these numbers manually.

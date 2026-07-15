# Mode: apply — Live Application Assistant

> Apply `voice-dna.md` (if present) to free-text answers and cover-letter fields — full guardrail, conversational voice included (Tier 1 + Tier 2). See `_shared.md` → Voice DNA.

> Before authoring any pre-response text, run `modes/communication-planner.md`.
> The planner owns register, objective, proof anchors, evidence sufficiency, and
> route order. This mode executes the formal-application route it receives.

Interactive mode for when the candidate is filling out an application form in Chrome. It reads what is on the screen, loads the previous context of the job, and generates personalized responses for each form question.

## Requirements

- **Best with Playwright in visible mode**: In visible mode, the candidate sees the browser and the agent can interact with the page.
- **Without Playwright**: the candidate shares a screenshot or pastes the questions manually.

## Workflow

```text
1. DETECT      → Read active Chrome tab (screenshot/URL/title)
2. IDENTIFY    → Extract company + role from the page
3. SEARCH      → Match against existing reports in reports/
4. LOAD        → Read full report + Section H / Application Answers (if they exist)
5. PREFLIGHT   → Confirm posting liveness + company/role match before drafting
5b. PRE-SCAN   → Scan page for knock-out questions (degree, experience, work authorization/visa, sponsorship, salary floors)
6. ANALYZE     → Identify ALL visible form questions
6b. INSTRUCTIONS → Capture + honor the posting's explicit application asks (blurb, favorite X, subject-line keyword, channel)
7. PLAN        → Apply the shared Communication Planner to register, proof, and route timing
8. GENERATE    → For each question, generate a personalized response in the posting's register
9. PRESENT     → Show formatted responses for copy-paste
10. PERSIST    → Save the final filled/submitted answers into the report
```

## Step 5 — Preflight gate

Before generating any application answers, verify that the form still points to the intended active job. This gate runs after the page has been detected, the company/role has been identified, and the matching report has been loaded.

**Cross-channel check (#1596):** before drafting — and ALWAYS before the user authorizes an agency to submit on their behalf — check `data/applications.md` for an existing row with the same company+role under a different Via (agency vs direct, or two agencies). A double submission burns the candidate with both the agency and the employer. If found, stop and ask the user which channel owns the candidacy. If the end employer is still unknown (Company `?`), the check still runs in degraded form — it is never silently skipped:

1. Ask the user (or the recruiter, via the user) for the client company name first — the reveal is the cheapest fix and unlocks the full check.
2. If the name is not available, check the tracker for `?` rows with the same Via + a similar role (the same agency re-blasting one listing) and for similar-role rows at plausible-match companies; surface anything close.
3. Then STOP and require explicit user acknowledgment before the agency is authorized: "The end employer is unknown, so I cannot verify you haven't already applied to this company directly. Authorize anyway?" Never proceed on silence — the reveal-time check only catches damage after the fact.

**candidacy coordination preflight:** read `data/candidacy-clusters.md` when it
exists and inspect `data/applications.md` for same-company progressed rows before
drafting. If no current classification exists or its evidence is stale, execute
the canonical research, fallback, and persistence contract in `modes/next.md` ->
Candidacy Coordination before continuing.

Run `node candidacy-select.mjs --json` after that inspection. If the target is in
`suppressed`, apply the reserved-cluster rule below. If its company appears in
`researchRequired`, complete the Hiring-surface research, update the registry,
and rerun the selector before drafting. Never infer eligibility from score or
company size after the selector has excluded a row.

- If the target belongs to a reserved Candidacy cluster, stop and show the
  Primary Application, its Stage, and the Outreach anchor. Treat this Application
  as an interactive alternate; require the user to explicitly override before
  preparing a second Application pack.
- If the canonical review establishes an independent Hiring surface, record it
  and proceed independently.
- Even after an override, carry forward the cluster's contact history. Never
  suggest a second immediate connection note to the same person for the sibling
  Application; `modes/contact.md` owns the Outreach-anchor rule.

1. Read the visible URL, page title, company, role, and any closed/expired signals.
2. If a URL is available, verify liveness with Playwright:
   - active posting evidence: title/role + job description or form fields + submit/apply path
   - closed posting evidence: expired/closed/no longer accepting applications, missing JD with only nav/footer, hard redirect to generic careers/search, or 404/410
3. Compare the visible company and role against the matched report.
4. If company or title changed materially, stop before drafting and ask:
   "The form appears to be for [visible company] — [visible role], but the matched report is [report company] — [report role]. Do you want me to re-evaluate, adapt with this mismatch, or stop?"
5. If the posting appears closed, refuse to generate final copy unless the candidate explicitly overrides with a known reason.
6. If liveness cannot be verified because the candidate only pasted questions or a screenshot, state that limitation and ask the candidate to confirm the company, role, and active posting before drafting.

Do not continue to Step 6 until this preflight is resolved.

## Step 5b — Pre-scan for knock-out questions

Read the entire page/form to scan for knock-out questions BEFORE generating full responses. These are questions designed to automatically disqualify candidates who do not meet critical criteria.

1. Common knock-out question areas to target:
   - **Minimum years of experience** (e.g., "Do you have at least 5 years of professional software engineering experience?")
   - **Degree requirements** (e.g., "Do you have a Bachelor's degree in Computer Science or a related field?")
   - **Work authorization/Visa sponsorship** (e.g., "Will you now or in the future require visa sponsorship to work in the United States?")
   - **Salary floors/expectations** (e.g., "What is your target salary / expectation?")
2. Check these questions against the candidate's `config/profile.yml` or `cv.md` parameters.
3. If a knock-out question is detected where the candidate's profile represents a potential mismatch (e.g., candidate needs sponsorship and the form automatically filters out sponsorship-needy applicants, or candidate's salary expectations mismatch the visible JD/form floors):
   - Highlight the specific knock-out question to the candidate immediately.
   - Present a clear warning block:
     `⚠️ KNOCK-OUT WARNING: The form asks "[question text]". Based on your profile/CV, answering "[profile answer]" may trigger immediate automatic rejection by the ATS. How would you like to answer this, or do you want to skip applying?`
   - Stop and wait for the candidate's confirmation before drafting any further answers.
4. If no knock-out questions are found, or the candidate resolves the warning, proceed to Step 6.

**Applying to several roles in one sitting?** This preflight verifies the single form in front of you. Before a multi-role session — especially against scanner entries marked `**Verification:** unconfirmed (batch mode)` — run the `pipeline` mode **Liveness sweep** first (`node check-liveness.mjs --file <urls>`). It drops the dead postings from `data/pipeline.md` in one batch so you never open a tab on an expired role.

## Step 1 — Detect the job

**With Playwright:** Take a snapshot of the active page. Read title, URL, and visible content.

**Without Playwright:** Ask the candidate to:
- Share a screenshot of the form (Read tool can read images)
- Or paste the form questions as text
- Or say company + role so we can search for it

## Step 2 — Identify and search for context

1. Extract company name and role title from the page
2. Search in `reports/` by company name (case-insensitive grep)
3. If there is a match → load the full report
4. If there is a Section H or `## Application Answers` → load previous answers as a base
5. If there is NO match → notify and offer to run a quick auto-pipeline

## Step 3 — Detect changes in the role

If the role on screen differs from the one evaluated:
- **Notify the candidate**: "The role has changed from [X] to [Y]. Do you want me to re-evaluate or adapt the responses to the new title?"
- **If adapt**: Adjust responses to the new role without re-evaluating, only after the candidate explicitly accepts the mismatch
- **If re-evaluate**: Execute full A-F evaluation, update report, regenerate Section H
- **Update tracker**: Change role title in applications.md if applicable

## Step 6 — Analyze form questions

Identify ALL visible questions:
- Free text fields (cover letter, why this role, etc.)
- Dropdowns (how did you hear, work authorization, etc.)
- Yes/No (relocation, visa, etc.)
- Salary fields (range, expectation)
- Upload fields (resume, cover letter PDF)

### YC Jobs / Work at a Startup form contract

For applications opened from `ycombinator.com/companies/.../jobs/...`,
`ycombinator.com/jobs/...`, or `workatastartup.com`, the live visible form wins
over every cached example or provider fallback. Re-read the modal/page whenever
it is accessible; YC may change the form.

When the live form is unavailable behind sign-in, use the current YC fallback
contract instead of guessing a conventional ATS form:

- one free-text reach-out message to the named contact or company, with the
  visible requirement to write at least 50 characters;
- a relocation checkbox only when the modal visibly presents the
  location-preference mismatch;
- the human reviews the message and clicks `Send`; the agent never sends it.

Do not invent ATS fields such as Resume, LinkedIn, Portfolio, GitHub, Current
location, work authorization, visa sponsorship, or separate motivation/project
questions merely because they are common elsewhere. YC account/profile data is
not part of the job-specific reach-out modal unless the live page visibly asks
for it. Fold every explicit posting ask into the one reach-out message, leaving
a clearly labelled candidate slot for any unknown personal fact. If the live YC
form differs from this fallback, mirror the live fields exactly and update the
pack rather than preserving the fallback.

Classify each question:
- **Already answered in Section H or `## Application Answers`** → adapt the existing response
- **New question** → generate response from the report + cv.md

For each field, preserve the application form contract:
- `field_type`: `text`, `textarea`, `select`, `radio`, `checkbox`, `number`, `file`, or `unknown`
- `required`: `yes`, `no`, or `unknown`
- `limit`: exact character/word limit if visible; otherwise `unknown`
- `options`: visible options for select/radio/checkbox fields
- `needs_candidate_confirmation`: `yes` for legal, demographic, work authorization, visa, relocation, salary, disability, veteran, sponsorship, background-check, or self-identification questions only when the field cannot be resolved from the source policy below

Never invent answers for legal, demographic, work-authorization, visa/sponsorship, salary, disability, veteran, background-check, relocation, or self-identification fields. If the answer is not present in `config/profile.yml`, visible context, the matched report, or a current official source, mark it as needing candidate confirmation and provide the safest question to ask the candidate.

### Step 6a — Resolve obvious fields before asking

Use the in-scope sources before asking the candidate. `config/profile.yml`,
`cv.md`, the matched report, and current official sources can resolve routine
fields that would otherwise create useless confirmation loops.

- **Work authorization:** If the profile says the candidate is an EU citizen with
  no sponsorship needed for EU/EEA/Switzerland, and the role country is in
  EU/EEA/Switzerland, verify the current rule from an official source and answer
  the form directly. For Switzerland, mention permit/registration admin only in a
  free-text note; a yes/no eligibility field should get the resolved yes/no
  answer.
- **Languages:** If a language is absent from `cv.md` and `config/profile.yml`,
  and the form offers `None`, select `None`. Ask only when the user has hinted at
  an unrecorded level or the form lacks a `None`/equivalent option.
- **Salary:** Use `config/profile.yml` compensation policy plus the report's
  role/location estimate and market notes. Provide a concrete range in the
  requested currency. Mark it for review rather than confirmation unless it falls
  below the profile floor or the form asks for a binding commitment.
- **Personal identifiers:** Name, email, LinkedIn, portfolio, GitHub, location,
  resume path, and CV PDF path come from `config/profile.yml`, `cv.md`, and the
  report/PDF output. Fill them directly.


## Step 6b — Honor explicit application instructions

Some postings tell the applicant exactly what to send. These override the generic form-filling logic and are **mandatory** — a submission that ignores them reads as "didn't read the posting" and is often an intentional filter.

1. Gather the explicit instructions from every source available:
   - the matched report's `## Application Instructions` section and Machine Summary `application_instructions` / `apply_tone` (when driving from `next`/a report),
   - the live page/JD in front of you (a "Message to the team", "Anything else?", or free-text box often restates the ask).
2. Treat each of these as a required item, not a nice-to-have:
   - **Content asks:** "send a short blurb about yourself", "tell us why", "share a link to something you built".
   - **Channel asks:** "email us at ...", "put [keyword] in the subject", "apply here, not via LinkedIn".
   - **Personality / culture asks:** quirky or personal prompts — "your favorite ice cream flavor", a fun fact, a hot take. Answer them for real and in good humour; these are deliberate culture-fit filters. Never drop them because they feel unprofessional, and never fabricate a fact the candidate hasn't given — if it's a genuine personal preference (favorite flavor, etc.), leave a clearly labelled `[your answer]` slot for the candidate to fill.
3. Before presenting responses, verify every captured instruction maps to a drafted answer. If any is unaddressed, either draft it or flag it as needing the candidate's input. A pack that silently omits an explicit ask is incomplete.


## Step 7 — Generate responses

For each question, generate the response following:

1. **Report context**: Use proof points from block B, STAR stories from block F
2. **Previous Section H / Application Answers**: If a draft or final response exists, use it as a base and refine
3. **"I'm choosing you" tone**: Same auto-pipeline framework
4. **Match the posting's register**: Read the JD's tone (`apply_tone` from the report, or infer it from the page) and mirror it. A casual, playful ask from a tiny founder-led team gets a warm, human, first-person note — short sentences, contractions, real personality — not a formal cover-letter register. A formal enterprise JD gets a composed, professional register. Never default every answer to the same corporate voice; read the room the posting sets.
5. **Specificity**: Reference something specific from the JD visible on screen
6. **career-ops proof point**: Include in "Additional info" if there is a field for it
7. **Recruiter-side risk map**: Use `modes/heuristics/recruiter-side.md` to identify what doubt the question is trying to resolve (motivation, stack fit, logistics, comp, work-auth, availability, seniority) and answer that doubt directly.
8. **Disclosure discipline**: Answer logistics questions truthfully when asked, but do not volunteer sensitive or HR-only details in unrelated motivation/fit answers.
9. **Paste-ready answer discipline**: The response itself must contain only what
   the candidate should paste, type, select, or upload. Keep rationale, source
   citations, source-check dates, legal/admin nuance, confidence notes, blockers,
   and user-review instructions outside the answer, in notes. For yes/no,
   radio, dropdown, and language fields, give only the exact option text such as
   `Yes`, `No`, or `None`. For salary fields, give only the concrete range plus
   currency/comp basis, with calibration context in notes.

**Output format:**

```text
## Responses for [Company] — [Role]

Based on: Report #NNN | Score: X.X/5 | Archetype: [type]

---

### 1. [Exact form question]
> [Paste-ready response, exact selection, or upload file/artifact. If the field needs confirmation, write "Ask candidate: ..."]

### 2. [Next question]
> [Response]

...

---

Notes:
- [Any observations about the role, changes, etc.]
- [Personalization suggestions the candidate should review]
```

## Step 8 — Persist application snapshot

After the final answers are filled into the form or handed to the candidate for copy-paste, update the matched report with an additive `## Application Answers` section. If the candidate later confirms submission, update that same section from `filled` to `submitted`.

The section must include:
- `**Date:** YYYY-MM-DD`
- `**State:** filled` or `**State:** submitted`
- Free-text answers exactly as submitted
- Dropdown/radio/checkbox selections made
- Number or short-answer fields such as compensation, availability, start date, and work authorization
- Files used, including CV, cover letter, portfolio, or other uploads with version/path when known

Write the section at the end of the report, or replace only the existing `## Application Answers` section if it already exists. Do not rename, reorder, or edit the existing A-H report blocks or `## Keywords extracted`.

Use `application-answers.mjs` when possible to format/upsert the section:

```bash
node application-answers.mjs --report reports/NNN-company-role-date.md --input answers.json --state filled
```

## Step 9 — Post-apply (optional)

If the candidate confirms that they submitted the application:
1. Update status to `Applied` via the canonical CLI: `node set-status.mjs <report#> Applied` (advancing from `Application Ready` if the pack was drafted, or directly from `Evaluated`; never hand-edit the table)
2. Seed the follow-up schedule: run `node followup-seed.mjs {num} --json` (where `{num}` is the tracker row number). If the candidate applied on a different day than today, pass `--date YYYY-MM-DD` with the actual submission date. It's idempotent, so re-running is safe.
3. Refresh the report's `## Application Answers` section with the final field values and `**State:** submitted`
4. Suggest next step: run the `contact` mode (`/career-ops contact` where available) for LinkedIn outreach

## Scroll handling

If the form has more questions than the visible ones:
- Ask the candidate to scroll and share another screenshot
- Or paste the remaining questions
- Process in iterations until the entire form is covered

## Known ATS Quirks

Field-tested across ~12 Playwright-driven applications (Ashby, Greenhouse, Lever, Workable). These quirks silently break an apply run if not accounted for.

### Ashby — email-based candidate dedup

- **Symptom:** Submitting a second application at the same company silently fails or merges into the existing candidate record. Ashby deduplicates by email per company.
- **Agent:** Before filling the email field, check whether an earlier report for the same company already exists in `reports/`. If it does, warn the candidate and pre-fill a `+tag` alias (e.g., `user+teamname@domain.com`) as the suggested value.
- **Candidate:** Confirms or changes the email before the form is submitted.

### Lever — hCaptcha intercepts checkbox/radio clicks

- **Symptom:** Programmatic `click()` on checkboxes or radio buttons triggers an hCaptcha challenge mid-form, blocking the rest of the fill.
- **Agent:** Fill `<input type="text">`, `<textarea>`, and `<select>` fields only. Skip all checkboxes, radio buttons, and the captcha widget. List the skipped fields with their recommended values so the candidate can tick them.
- **Candidate:** Completes the checkboxes, solves the captcha, and clicks Submit.

### Workable — SPA re-renders break form refs

- **Symptom:** Workable's SPA re-renders form components between fills, invalidating element references. Sequential `fill()` calls hit stale-element errors.
- **Agent:** Copy each answer to the clipboard and present a numbered paste list. If Playwright is active, dispatch `Ctrl+V` per field with a fresh element query before each paste — do not cache refs across fields.
- **Candidate:** Pastes remaining answers manually if clipboard dispatch fails, then submits.

### React-select autocomplete widgets

- **Symptom:** `react-select` (common in Greenhouse, Ashby, Lever for location/department fields) destroys and recreates its internal DOM on every keystroke. Cached refs go stale instantly.
- **Agent:** Type character-by-character with short delays (~100 ms). Re-snapshot after every selection to pick up the new DOM state. Never cache element references across interactions.
- **Candidate:** Verifies each selected value is correct before moving on; corrects any mis-selection inline.

### Huge native `<select>` elements (1 000+ options)

- **Symptom:** Country, university, or field-of-study dropdowns contain thousands of `<option>` entries. Snapshotting them floods context and stalls the agent.
- **Agent:** Use `select_option` directly by value or visible label. Never snapshot the full option list. If the exact label is unknown, ask the candidate for the value instead of dumping options into context.
- **Candidate:** Provides the correct label when the agent cannot infer it from `config/profile.yml`.

### Job-board host ≠ application host — re-check the URL after "Apply"

- **Symptom:** The posting is discovered on one ATS, but clicking **Apply** hands off to a *different* ATS for the actual form. Enterprise career sites (commonly Phenom-, iCIMS-, or Radancy-hosted) frequently redirect into a Workday, Greenhouse, or SmartRecruiters application flow. Choosing fill tactics from the *board* URL applies the wrong quirks.
- **Agent:** After the Step 5 preflight, follow the Apply button/redirect and read the URL of the page that actually renders the form fields. Match your fill tactics to *that* host — not the board the job was discovered on. A `myworkdayjobs.com` handoff in particular means the Workday quirk below applies.
- **Candidate:** Confirms the destination page looks like the right company/role before the agent starts filling.

### Workday — set-value doesn't register on React fields

- **Symptom:** Setting a Workday text field's value programmatically (without real keystrokes) leaves it visually filled but empty to Workday's validation — the React `onChange` never fires, so Save throws "required" on a visibly-filled field. Yes/No dropdowns also vary their option order per question, so a positional click can select the wrong answer (e.g. "No" on *are you authorized to work?*).
- **Agent:** For required text fields, **type** real keystrokes (focus → select-all → type), or verify each value registered before Save. Survey the whole step top-to-bottom first (the address block is often below the fold) and fill from the candidate's saved profile (`config/profile.yml` / `cv.md`) proactively, rather than discovering fields via validation errors. For dropdowns, use **type-ahead** (open → type the option text → confirm the highlight) instead of positional clicks, and verify each selection.
- **Candidate:** Reviews the filled step — especially work-authorization/sponsorship dropdowns and any EEO/legal attestations — before Save/Submit.

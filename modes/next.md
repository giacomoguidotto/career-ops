# Mode: next -- Stage-Driven Advancement

Advance an existing opportunity to its next useful human-review step.

## Purpose

`next` is the post-evaluation orchestrator. It reads the tracker, the canonical
state machine in `templates/states.yml`, reports, and existing modes, then
produces the smallest useful draft pack for the current stage. It does not
discover jobs, evaluate new postings, submit applications, send messages, or
record real-world actions without confirmation.

## Ready Block Contract

Every output must be usable without scavenger-hunting through reports, and
without a second research step before the user can act.

- Put the decision and next human action at the top.
- Include a quick-reference block with the role, score, report, blocker, and the
  exact next step.
- **Linear action order:** order the pack by the current `suggests` action and
  the next human move, not by a fixed application-template order. Put any
  preflight block immediately before the action it governs, then the action the
  user should do now, then conditional follow-on or backup actions. For
  `send_application`, use `### Before You Apply`, `### Fill the Application Form`,
  then outreach sections. For `send_qualifying_questions`, use `### Before You
  Send`, `### Send the Gating Question`, optional `### Send the Backup Gating
  Question`, then a conditional `### Fill the Application Form` only after the
  gate clears. For follow-ups, lead with `### Send the Follow-Up`.
- **Preflight sections:** `### Before You Apply`, `### Before You Send`, and
  `### Before You Follow Up` are not footer summaries. They appear immediately
  before the governed action and contain explicit asks covered, blockers, and
  user-review checks that must happen before acting.
- **Form mirror:** for an application action, `### Fill the Application Form`
  must show the form the user will see when opening the application from the
  dashboard. Start that section with ``Press `o` to open and fill the form:
  {ATS/form URL}``. Then list every captured or likely field in page order, using
  the exact field label, the answer/selection to enter, and the file to upload.
  For simple ATS flows such as Ashby, Greenhouse, and Lever, this form mirror is
  the pack's center of gravity. In a qualifying/gating pack, the form mirror is
  conditional and must appear after the gating-send section, not before it.
- **Form-question table:** inside `### Fill the Application Form`, ALWAYS render
  form fields/questions as a markdown table with exactly these columns:
  `Question`, `Answer`, `Notes`. Use `Question` for the exact visible field label,
  `Answer` for the copy-paste answer, selected option, or upload file, and `Notes`
  for source/confidence/user-review/blocker context.
  Hard rule: the `Answer` cell must contain only what the candidate should paste,
  select, type, or upload. Never put rationale, source notes, source-check dates,
  legal/admin nuance, caveats, confidence levels, blocker text, or review
  instructions in `Answer`; move all of that to `Notes`.
  For yes/no, radio, dropdown, and language fields, `Answer` must be the exact
  option text such as `Yes`, `No`, or `None`. For salary fields, `Answer` must be
  only the concrete range plus currency/comp basis; put calibration and review
  context in `Notes`. For file fields, `Answer` must name the file/artifact to
  upload; if it is not created yet, put the creation blocker in `Notes`, not
  `Answer`.
  Hard rule: Do not render form questions as bullet lists.
- **Provider form contracts:** apply the provider-specific contract owned by
  `modes/apply.md` before drafting a mirror. In particular, the
  `YC Jobs / Work at a Startup form contract` forbids guessing a conventional ATS when sign-in
  blocks inspection: mirror the current single reach-out message and only a
  visibly-present relocation checkbox. The live visible form always overrides
  the fallback when YC changes it.
- **Send actions:** name the send section by intent: `### Send the Gating
  Question` for pre-application qualification, `### Send the Outreach Message`
  for application-related first touches, and `### Send the Follow-Up` for cadence
  follow-ups. Each send section must say when to send it relative to the
  application, who receives it, which channel/social surface to use, whether it
  is a connection note, and the exact character count when the channel has a cap.
  Put the copy-paste draft inside the same section. Backup sections mirror the
  primary intent (`### Send the Backup Gating Question`, `### Send the Backup
  Outreach Message`, or `### Send the Backup Follow-Up`) and only appear when a
  reliable backup destination exists. A sendable message with no real destination
  is an unfinished pack.
- Include copy-paste blocks for anything the user might send or paste into a
  form: email, LinkedIn message, recruiter reply, thank-you note, cover-letter
  paragraph, or application answer.
- **Honor the posting's explicit application instructions.** Read the report's
  `## Application Instructions` section and Machine Summary `application_instructions`
  (re-read the live JD too when the channel is interactive). Every literal ask the
  posting makes — a "short blurb", "your favorite ice cream flavor", "answer this
  one question", "put X in the subject line", "email us at ...", "do NOT apply via
  LinkedIn" — is **mandatory**, including quirky or personal culture-fit prompts.
  A pack that drops an explicit ask (e.g. omits the ice cream flavor) is a defect,
  not a stylistic choice. If an ask needs a fact only the user has, leave a clearly
  labelled `[your answer]` slot rather than silently skipping it.
- **Match the posting's register.** Read `apply_tone` (or infer the JD's register)
  and write the blurb and free-text answers to match it. A casual, playful ask from
  a tiny founder-led team gets a warm, human, first-person note — not a formal
  cover-letter register. A formal enterprise JD gets a composed one. Mirror the
  room; never default every pack to the same corporate voice.
- **Every sendable draft needs a real, discovered destination.** An email draft
  MUST carry a deliverable address in its `To:` line; a LinkedIn or DM draft MUST
  name a real person and link their profile. Run contact discovery
  (`modes/contact.md` step 1: WebSearch for the recruiter, hiring manager, and
  team peers) to find it. Never address a message to a faceless "{Company} team"
  when a named contact is findable.
- **Never fabricate or guess a destination.** Use only an address or profile you
  actually found; do not build `first.last@company.com` from a pattern and do not
  invent a recruiter. If no reliable email exists — common for ATS-only roles —
  do not ship a dangling email draft: drop it, route through the channel that
  works (the ATS form plus a named LinkedIn contact), and say plainly that no
  email address was found. If contact discovery cannot run (headless or no web
  access), say so and mark the destination unresolved instead of shipping a
  generic draft.
- Keep sendable drafts clean: no markdown tables, no analysis inside the draft,
  no placeholders unless a fact truly needs confirmation.
- Make every sendable message read like the user typed it, not a template. Apply
  `voice-dna.md` Tier 2 through `modes/contact.md`: warm human opener,
  contractions, natural flow, no keyword dumps, no em dashes. A pre-apply question
  stays warm and focused on the question itself -- no proof-point dump.
  Founder or hiring-manager notes should sound genuinely excited about the role
  and the work, while still naming only source-backed proof points from the
  CV/profile/report.
- Apply `modes/contact.md` step 7 whenever a sendable contact message appears.
  The pack must embed the primary and backup send guidance in ordered sections,
  not as a separate recommendation block or contact list. Default to one first
  touch, with backup contacts reserved for later.
- Keep the whole pack lean: the form answers, outreach destinations, sendable
  text, and real confirmations are the body. Fold rationale (why this row,
  scoring, strategy) into a single footer line and do not restate the report.
- Resolve obvious fields from the in-scope sources before asking the user.
  `config/profile.yml`, `cv.md`, the report, and current official sources can
  answer routine work-authorization, language, and compensation fields. Ask only
  when the answer depends on private intent, an unrecorded fact, contradictory
  sources, or a legal edge the current official source check cannot settle.
- Work authorization for EU/EEA/Switzerland roles: when the profile says the
  candidate is an EU citizen with no sponsorship needed for EU/EEA/Switzerland,
  and the current official source check supports the country, provide the form
  answer directly. Note any permit/registration admin in the field note only when
  the form has free text.
- Language proficiency dropdowns: when a language is absent from `cv.md` and
  `config/profile.yml`, and the form offers `None`, select `None`. A missing
  language in the source files is enough evidence for `None` unless the user has
  said otherwise in the current conversation.
- Salary fields: use `config/profile.yml` compensation policy plus the report's
  role/location estimate and market notes. Provide a concrete range in the asked
  currency; mark it for user review, not as a blocker, unless it falls below the
  profile floor or the form asks for a legally binding commitment.
- Keep stage-machine details in the metadata header only. The body must guide the
  user through the next real action; do not include "suggested stage after
  approval" or other state-machine exposition.
- The dashboard's `Next Step` point contains exactly one short human sentence
  from the pack's `**Next step:**` header. Do not replace it with `Current
  status`, `Next checkpoint`, `Selected because`, or a standalone `Report`
  field. Those are audit notes, not next steps, and must not appear in the pack
  header or body.

Completion criterion: the user can execute the first action section immediately,
then move through any conditional application, outreach, or backup sections
without another lookup. Every remaining blocker is a real missing fact,
destination, or decision.

## Inputs

- Optional argument: tracker number, report number, company, role, or `auto`.
- `data/applications.md` -- canonical lifecycle tracker; each row carries one
  `stage`.
- `data/candidacy-clusters.md` -- durable, user-layer coordination between
  related Applications that may share a recruiter, hiring manager, or hiring process.
- `candidacy-select.mjs` -- deterministic, read-only eligibility preflight. Its
  `eligible` array is the exclusive Agent-owned input to implicit selection;
  `suppressed` and `researchRequired` may not be re-added by score ranking.
- `templates/states.yml` -- the canonical state machine and the single source of
  routing truth (stage `owner`, `suggests`, `on_demand`, `next_states`).
- `data/follow-ups.md` -- sent follow-up history, if present.
- `reports/` -- evaluation reports.
- `output/next-packs/` -- generated copy-paste advancement packs.
- `modes/_custom.md` (if present) -- persistent workflow and advancement policy;
  read it before resolving any action because it overrides the defaults below.
- `config/profile.yml`, `modes/_profile.md`, `cv.md`, and `article-digest.md`
  for candidate context.

## State Model

Every application carries exactly ONE `stage` in `data/applications.md`. The stage
is a node in the canonical state machine defined in `templates/states.yml`, and
that table is the single source of routing truth. `next` never re-derives routing;
it looks up the current stage and reads its fields:

- `owner` -- who advances the stage: `agent`, `user`, `company`, or `none`.
- `suggests` -- the proactive next thing: an artifact to draft (agent stages) or a
  real-world action for the user to perform and report (user stages).
- `on_demand` -- reactive assists available on request but never run proactively
  (e.g. `draft_outreach`, `regenerate_cheatsheet`).
- `next_states` -- the only allowed successor stages.

The owner determines how the stage advances:

- `agent` -- `next` may generate the `suggests` artifact and advance to the paired
  `_ready` stage with no human trigger. Advancing records that a DRAFT exists,
  never a real-world action, so it is safe to auto-write.
- `user` -- blocked on the user doing the real-world action and reporting it. `next`
  may draft or prepare, but only the user's report advances the stage.
- `company` -- a pure wait. No task; a due follow-up surfaces as a reminder, not a
  stage change. Advances only when the user reports a company event.
- `none` -- terminal.

The automation invariant: an unattended `auto` run may only ever transition OUT OF
an `agent`-owned stage. In `auto` mode, `next` finds agent-owned stages and runs
their generation step; it never writes a `user`- or `company`-owned advance.

Completion criterion: every routing decision cites the current stage's row in
`templates/states.yml`; `next` never invents a status or an action outside it.

## Workflow

### 1. Check Repo Health

Run:

```bash
node doctor.mjs --json
```

If onboarding is incomplete or required files are missing, stop and report the
missing files.

For scheduled or unattended runs, also inspect `data/pipeline.md`,
`batch/batch-state.tsv` if present, and `batch/batch-runner.pid` if present. If
evaluation or batch work is still active, stop with an idle note instead of
advancing applications.

Completion criterion: the repo is ready for advancement, or the blocker is
explicit.

### 2. Load Current State

Read:

- `data/applications.md`
- `data/candidacy-clusters.md` if present
- `templates/states.yml`
- relevant report files
- `data/follow-ups.md` if present
- `modes/_custom.md` if present
- `config/profile.yml`
- `modes/_profile.md`
- `cv.md`
- `article-digest.md` if present

When follow-up timing matters, run:

```bash
node followup-cadence.mjs
```

Completion criterion: every candidate considered has its tracker stage, score,
report path when available, the stage's `owner`/`suggests` from `templates/states.yml`,
and enough candidate context for the chosen pack.

## Candidacy Coordination

The lifecycle is per Application. Candidacy coordination is a separate dimension
that prevents independent Applications from producing contradictory submissions
or duplicate Outreach when they reach the same recruiter or hiring team. Do not
add a coordination-only Stage such as `Covered`, `Alternate`, or `Clustered`; a
sibling can remain factually `Evaluated` while coordination temporarily removes
it from selection.

Before ranking Agent-owned Applications, group same-company Applications for a Hiring-
surface review. Company-name equality opens the investigation but does not prove
the roles share a cluster. Company size is only a research hint, never the
classifier: a startup often has one founder/recruiter surface, while a large
company may have several independent divisions and recruiters.

For every same-company group containing either multiple agent-owned rows or one
progressed row plus an agent-owned sibling:

1. Read any current classification in `data/candidacy-clusters.md`.
2. Deeply research the org chart and hiring surface before accepting or changing
   it. Check official team/org pages, the department/team/location in each JD,
   named recruiters and hiring managers, leadership ownership, and credible
   public professional profiles. A shared ATS vendor, company name, or careers
   domain alone is not evidence of one recruiter.
3. Partition roles only when evidence supports separate recruiting surfaces,
   such as distinct divisions, teams with separate hiring managers, or different
   assigned recruiters. If the research remains inconclusive, use the fallback:
   treat the roles as one shared cluster.
4. Create or update `data/candidacy-clusters.md` with this table when the file is
   absent or the evidence changed:

   ```markdown
   # Candidacy Clusters

   | Cluster ID | Company | Hiring surface | Confidence | Members | Primary | Outreach anchor | Evidence | Reviewed |
   |---|---|---|---|---|---|---|---|---|
   ```

   `Members`, `Primary`, and `Outreach anchor` use tracker numbers (`#313`). The
   evidence cell carries concise source links or report/contact references, not
   unsupported inference. Re-research when membership, recruiters, or org
   structure changes; the registry is a cache of evidence, not permission to
   skip current research.

Before any implicit selection, run the mandatory machine preflight:

```bash
node candidacy-select.mjs --json
```

- Treat `eligible` as the exclusive Agent-owned candidate set. Never rebuild a
  raw tracker candidate list afterward or re-add anything from `suppressed`.
- If `researchRequired` names a company, do the deep Hiring-surface research
  above, persist the evidence-backed classification or shared fallback in
  `data/candidacy-clusters.md`, and rerun the command. Do not select that
  company's blocked Applications before the rerun clears the research item.
- Rerun after any registry, tracker, Primary, or Outreach-anchor update. The
  preflight is a current-state computation, not a one-time audit artifact.
- The selector deterministically prefers the most progressed Agent-owned stage,
  then current decision, score, and tracker number inside an unreserved cluster.
  Global throughput/score ranking happens only after this per-surface choice.

Apply the classification before score ordering:

- A cluster is reserved once one member reaches `Application Ready`,
  `Qualifying Ready`, `Qualifying Sent`, `Applied`, `Outreach Ready`,
  `Responded`, `Interview Ready`, `Offer`, or `Offer Ready`.
- In every implicit selection path, including unattended `auto` and interactive
  `next` with no target, exclude its Agent-owned siblings. An interactive
  no-target run may label them as alternates for visibility, but must not select
  them or generate Application packs. Do not change their Stages.
- If no member has reserved the cluster, select at most one agent-owned member:
  the most actionable stage first, then the current decision and score. Record
  that member as `Primary` when its pack reserves the cluster.
- A `Rejected`, `Discarded`, or `SKIP` primary releases the cluster so the best
  remaining sibling can become actionable. `Accepted` permanently suppresses
  sibling applications unless the user explicitly reopens the search.
- An explicitly requested sibling is an interactive alternate, not an implicit
  action. Show the active Primary Application and shared contact history, explain
  the conflict, and require an explicit override before drafting a second
  Application pack. This explicit-target-plus-override path is the sole drafting
  escape while the cluster is reserved.
- One Hiring surface has one Outreach anchor. Reuse the existing relationship and
  never draft another immediate connection note to the same person merely because
  the JD differs. Separate outreach is allowed only when research establishes an
  independent recruiter or hiring team.

Completion criterion: `auto` advances no more than one member per unresolved or
shared hiring surface, progressed candidacies suppress conflicting siblings, and
every partition is evidence-backed.

#### Advancement policy precedence

Before selecting or generating an artifact, apply `modes/_custom.md` ->
`Evaluation And Advancement Policy` when that section exists. Its rules override
the default decision routing later in this file. In particular, when that policy
disables automatic qualifying questions:

- `Apply` and `Consider` both route to `generate_application_pack`; `Consider` is
  a lower-priority Application, not another Stage.
- Score controls ordering only. Do not route an otherwise eligible low-scoring
  row to `skip`, `discarded`, or a qualifying question because of score alone.
- When an older tracker sentence conflicts with a later
  `[re-evaluated YYYY-MM-DD]` marker and the report's current Machine Summary, use
  the later marker and current report.
- `Research first` remains internal work. Resolve the safety, legitimacy, or
  contradictory-legal-signal question and rewrite the decision to `Apply`,
  `Consider`, or `Skip` before advancement. Never route `Research first` directly
  to `draft_qualifying_questions`.
- Use `draft_qualifying_questions` only when the user explicitly requests that
  on-demand action for a specific role.

If `_custom.md` is absent or silent on advancement, use the default routing below.

### 3. Resolve the Target

If the user provided an argument:

1. Try exact tracker number.
2. Try report number from the tracker report link or report filename.
3. Try company/role fuzzy match only if the match is unique.
4. If the argument resolves to different tracker and report rows, ask which one
   to use.
5. Inspect that tracker number in `candidacy-select.mjs --json`. If it appears in
   `suppressed`, present the Primary and shared contact history and require the
   explicit override described above. If it is blocked by `research-required`,
   research and persist the Hiring surface before asking for an override.

If no argument or `auto` is provided:

Start only from the latest `candidacy-select.mjs --json` `eligible` array. The
raw set of Agent-owned tracker rows is not a valid selection input.

For an unattended `auto` run, honor the automation invariant: select only
`agent`-owned stages ready for their generation step, highest-value first:

1. `evaluated` rows (draft the application pack), sorted by score and boosted by
   the current report/tracker `APPLY` or `CONSIDER` decision. Resolve the current
   decision using the advancement-policy precedence above. Under the default
   policy only, when `final_decision` is `Research first` and the row has NOT
   already qualified (no `[qualifying-sent …]` marker), draft a qualifying
   question (`draft_qualifying_questions`) and advance it into the qualifying
   subloop. The loop guard keeps a returned `qualifying_sent → evaluated` row
   from re-qualifying forever.
2. `responded` rows (draft the interview cheatsheet).
3. `offer` rows (draft negotiation prep).

Sub-threshold `evaluated` rows may be routed to `skip` or `discarded` only when the
active scoring/advancement policy permits it; that gate is automation policy, not
a stage.

For an interactive run with no target, additionally surface the smallest useful
next step for active non-agent rows: `applied` rows with an overdue follow-up
reminder, `qualifying_sent` rows whose gating question is stale (past
`qualifying_stale_days`, surfaced by `followup-cadence.mjs` as an
apply-or-discard decision), and user-owned `_ready` rows whose waiting artifact
and blocker should be re-presented. Cap the whole set at three.

Do not select `skip`, `rejected`, or `discarded` rows, and never advance a `user`-
or `company`-owned stage in `auto`, unless the user explicitly asks.

Completion criterion: the selected target set is unambiguous and small enough to
produce useful packs.

### 4. Read the Next Action

Look up each selected row's `stage` in `templates/states.yml` and read its `owner`
and `suggests`. That pairing IS the next action; do not infer it from a separate
table:

- `agent` stage -> draft the `suggests` artifact. This is what an `auto` run does.
- `user` stage -> the `suggests` value is the real-world action the user must take;
  re-present the waiting artifact and the blocker, but do not advance the stage.
- `company` stage (`applied`) -> no action. If the follow-up cadence is due, surface
  a follow-up reminder; the user may on-demand request `draft_outreach`.
- `company` stage (`qualifying_sent`) -> no action; a pre-application wait on the
  recruiter's answer. If `followup-cadence.mjs` flags it stale (past
  `qualifying_stale_days`), surface an apply-or-discard decision: recommend
  applying anyway when the gate was marginal (comp/level curiosity), or
  discarding when it was a hard blocker (work authorization, relocation) still
  unanswered. Read the report's `final_decision`/gating notes to judge which.
- `none` stage -> nothing to do.

Use report `Machine Summary`, tracker notes, and follow-up cadence as supporting
evidence, never as an alternate source of routing.

Completion criterion: every selected opportunity resolves to exactly one `suggests`
action drawn from its stage row, with the stage's `owner` stated.

### 5. Produce the Pack

Before drafting, load the behavior owner for the chosen `suggests` action:

| `suggests` action | Load |
|-------------------|------|
| `generate_application_pack` | `modes/apply.md`, `modes/contact.md`, optionally `modes/cover.md` |
| `draft_qualifying_questions` | `modes/contact.md` (recruiter discovery) + the report's `final_decision`/gating notes — draft ONE tight qualifying question |
| `send_qualifying_questions` | the drafted qualifying pack in `output/next-packs/` (verify it is ready to send) |
| `send_application` | the drafted pack in `output/next-packs/` (verify it is ready to send) |
| `draft_outreach`, `send_outreach` | `modes/contact.md` |
| `follow_up` | `modes/followup.md` |
| `generate_interview_cheatsheet`, `regenerate_cheatsheet` | `modes/interview-prep.md`, the report, and `modes/heuristics/recruiter-side.md` |
| `attend_interview_and_report` | the drafted cheatsheet in `output/next-packs/` |
| `generate_negotiation_prep` | report, `config/profile.yml`, `modes/_profile.md`, and current market research |
| `negotiate_and_report` | the drafted negotiation prep in `output/next-packs/` |

Loading a behavior owner means running its relevant steps, not just reading its
file. In particular, `generate_application_pack`, `draft_qualifying_questions`,
and any `draft_outreach`, `send_outreach`, or `follow_up` action MUST run
`modes/contact.md` step 1 (contact discovery) and step 7 (send action sections)
so the pack names a real recruiter or hiring manager, links
their profile, carries a real deliverable address when email is used, and tells
the candidate which target/channel/timing to use first in the ordered send
sections. Do not emit an email draft you have no address to send to. Under the
default advancement policy, when the report's `final_decision` is `Research
first` and the row has not already qualified, draft
`draft_qualifying_questions` instead of the application pack. When `_custom.md`
disables automatic qualifying, follow the precedence section above instead.

Pack contents by `suggests` artifact (agent stages draft these; the paired user
`_ready` stage re-presents the already-drafted artifact plus the exact real-world
action and what to confirm, it does not invent a new pack):

- `generate_application_pack` (at `evaluated`) -> application pack:
  - `### Before You Apply`: explicit asks covered, blockers, and user-review
    checks that must be resolved before opening/submitting the form
  - `### Fill the Application Form`: ``Press `o` to open and fill the form:
    {URL}``, then
    a `Question | Answer | Notes` table containing the fields in page order with
    exact answers, selections, uploads, and user-review notes
  - apply/no-apply recommendation
  - tailored CV/PDF reference
  - copy-paste answers for captured form questions, plus a dedicated answer for
    every explicit application instruction the posting made (including quirky or
    personal culture-fit asks), written in the posting's register
  - standalone "why this role" or cover-letter text only when the form or posting
    explicitly asks for that field
  - outreach action sections when useful, each addressed to the real named
    contact found in discovery. For a founder-led startup with no recruiter and
    multiple visible founders, draft one tailored message per relevant founder
    (typically the CEO plus the technical/eng founder for an engineering role)
    and place them in primary/backup send order.
  - a short line of what to confirm before applying
- `draft_qualifying_questions` (at `evaluated`, when the active advancement
  policy or an explicit user request permits it) -> qualifying pack:
  - `### Before You Send`: the gate being tested, which answer clears it, and
    which answer kills or pauses the application
  - `### Send the Gating Question`: the named recruiter/hiring manager and their
    LinkedIn URL from contact discovery (the question rides the best available
    channel: a LinkedIn DM, or the ATS "additional info" field when no email
    exists)
  - `### Send the Backup Gating Question`: optional, only when a reliable backup
    contact exists; state the wait condition before the second touch
  - ONE tight qualifying/gating question, warm and focused on the question
    itself (work authorization, relocation, seniority calibration, comp floor) —
    no proof-point dump and no application answers yet
  - conditional application form mirror only when useful: after the gating send
    section, show the form URL and the fields that become relevant after the gate
    clears as a `Question | Answer | Notes` table
- `draft_outreach` (on-demand at `applied`) -> outreach pack:
  - primary and optional backup outreach action sections, each addressed to a
    real named contact from discovery. For a founder-led startup with no recruiter
    and multiple visible founders, draft one tailored message per relevant
    founder and place them in primary/backup send order.
- `follow_up` (reminder at `applied`) -> follow-up pack:
  - `### Before You Follow Up`: cadence, previous touch, and any close/deprioritize
    check
  - `### Send the Follow-Up`: the follow-up destination — the address the
    application thread already uses, or the recruiter's email/LinkedIn found in
    discovery
  - follow-up email, only when a real deliverable address exists; otherwise a
    LinkedIn follow-up to the named contact
  - close/deprioritize note if the cadence is cold
- `generate_interview_cheatsheet` / `regenerate_cheatsheet` (at `responded`,
  on-demand at `interview_ready`) -> interview cheatsheet pack:
  - one-page interview cheatsheet
  - recruiter reply and logistics answers when a screen is being scheduled
  - "tell me about yourself" script
  - company-specific talking points
  - likely technical and behavioral questions
  - story-bank mapping and gaps
  - questions to ask each interviewer
  - thank-you email draft when relevant
- `generate_negotiation_prep` (at `offer`) -> negotiation pack:
  - compensation and logistics summary
  - negotiation script
  - questions to ask
  - risk checklist
- closeout (routing a row to `skip` or `discarded`) -> closeout pack:
  - short reason
  - suggested terminal stage
  - optional polite withdrawal note if the user has already engaged

### Pack deep-link contract

Every user-action artifact named in a generated pack MUST be a clickable
Markdown link, not only an inline-code path. For repo-local artifacts, make the
destination relative to the pack file in `output/next-packs/` (for example,
`[Tailored CV](../cv-candidate-acme-2026-07-11.pdf)`). External destinations
must use an absolute `https://` URL. Before saving the pack, resolve every local
Markdown destination from the pack directory and verify that the target exists;
fix or omit any broken link. This applies to CVs/resumes, cover letters, reports,
interview prep, and every other generated artifact.

Save each produced pack to:

```text
output/next-packs/{tracker_num}-{company-slug}.md
```

Use the tracker number when available so the Go dashboard can find the pack and
open it from the selected row. If no tracker number exists, use the report
number. The final response must include the saved path.

**Saving the pack is not the end of the step. The instant an agent-owned pack is
saved you MUST advance its row (step 6). Producing the pack and advancing the row
are one inseparable action — never do the first without the second.** A drafted
pack left on an un-advanced `evaluated`, `responded`, or `offer` row is a bug: the
dashboard keeps showing "generate pack" and every downstream run (including
unattended automations that delegate to this mode) re-drafts the same pack forever.

Pack format:

````markdown
## Next: {Company} -- {Role} (#{tracker_num})

**Decision:** {draft / send / follow up / prep / negotiate / close}
**Next step:** {one short human sentence}
**Stage:** {current stage id}
**Owner:** {agent / user / company / none}
**Suggests:** {suggests action}
**Score:** {score} | **Report:** {report path}

### Before You Apply
- **Explicit asks covered:** {tick off each instruction from the report's `## Application Instructions` -- e.g. "blurb covered; favorite ice cream flavor needs your input; subject line keyword covered".}
- {facts to confirm or blockers before opening/submitting the form -- a few bullets, no report restatement}

### Fill the Application Form
Press `o` to open and fill the form: {ATS/form URL}

| Question | Answer | Notes |
|---|---|---|
| {Exact field label} | {paste-ready answer / exact selection / upload file or artifact} | {source, confidence, user review, blocker, or admin nuance} |
| {Exact field label} | {paste-ready answer / exact selection / upload file or artifact} | {source, confidence, user review, blocker, or admin nuance} |

### Send the Outreach Message
- **When:** {before applying / while applying / after submitting / later}
- **To:** {name} -- {title} | {LinkedIn/YC/email URL}
- **Channel:** {LinkedIn connection note / DM / email / YC / ATS}
- **Connection note:** {yes/no, {N}/{connection_note_max_chars} chars when relevant}
- **Instruction:** {one sentence}

Subject: {email only}

Hi {name},

...

Best,
...

### Send the Backup Outreach Message
- **When:** {condition, e.g. if the primary message goes cold after N business days}
- **To:** {name} -- {title} | {LinkedIn/YC/email URL}
- **Channel:** {LinkedIn connection note / DM / email / YC / ATS}
- **Connection note:** {yes/no, {N}/{connection_note_max_chars} chars when relevant}
- **Instruction:** {one sentence}

...

### Copy-Paste: {Form Answer / Script, if useful}
...

For a qualifying pack, replace the first action run with this order:

### Before You Send
- **Gate:** {question being tested}
- **Apply only if:** {answer that clears the gate}
- **Discard or pause if:** {answer that blocks the application}

### Send the Gating Question
- **When:** before applying.
- **To:** {name} -- {title} | {LinkedIn/email URL}
- **Channel:** {LinkedIn connection note / DM / email / ATS}
- **Connection note:** {yes/no, {N}/{connection_note_max_chars} chars when relevant}
- **Instruction:** {one sentence}

...

### Send the Backup Gating Question
- **When:** {condition, e.g. if the primary question goes cold after N business days}
- **To:** {name} -- {title} | {LinkedIn/email URL}
- **Channel:** {LinkedIn connection note / DM / email / ATS}
- **Connection note:** {yes/no, {N}/{connection_note_max_chars} chars when relevant}
- **Instruction:** {one sentence}

...

### Fill the Application Form
Only after the gate clears, press `o` to open and fill the form: {ATS/form URL}

| Question | Answer | Notes |
|---|---|---|
| {Exact field label} | {paste-ready answer / exact selection / upload file or artifact} | {source, confidence, user review, blocker, or admin nuance} |

_Selected: {one-line why}._
````

Use only those six metadata lines. Do not add `Current status`, `Next
checkpoint`, `Selected because`, or a second standalone `Report` line. Keep
selection rationale in the single footer line and detailed status in the
tracker/report.

Completion criterion: the user can review the pack and decide the next human
approval without the agent needing to act externally.

### 6. Record Only Confirmed Reality

Advance the `stage` in `data/applications.md` only when the transition is allowed
by the current stage's `next_states` and the owner's required trigger has happened:

- Agent stage — ALWAYS advance, no exceptions: after saving the `suggests` artifact
  (step 5) you MUST advance the row to its paired `_ready` stage. This is mandatory
  and unconditional for every agent-owned pack you draft — there is no case where a
  pack is produced and its row is left unadvanced, and this holds in `auto` and when
  an unattended automation delegates to this mode. Run the deterministic advancer
  rather than hand-editing the tracker:

  ```bash
  node advance-stage.mjs {tracker_num}
  ```

  It reads `templates/states.yml`, advances the row (`evaluated → application_ready`
  or, for a drafted qualifying question, `evaluated → qualifying_ready`;
  `responded → interview_ready`; `offer → offer_ready`), and syncs the saved pack's
  `**Stage:**/**Owner:**/**Suggests:**` header to the destination stage so the
  dashboard keeps the pack openable and shows the right next step (e.g. "Send
  application"). The advancer routes an `evaluated` row by the drafted pack's
  `**Suggests:**` artifact — `generate_application_pack` → `application_ready`,
  `draft_qualifying_questions` → `qualifying_ready` — so write that header to match
  the artifact you drafted. This is a safe draft-exists write, allowed in `auto`.
  Never leave a drafted pack on an un-advanced `evaluated`/`responded`/`offer` row.
  To advance every row that already has a drafted pack in one pass, run
  `node advance-stage.mjs --reconcile`.
  The advancer reruns candidacy coordination and refuses suppressed siblings.
  Only after the user explicitly approves a conflicting sibling Application may
  an interactive run use `--coordination-override`; unattended automation must
  never pass that flag. The CLI accepts it only for one explicit tracker number
  on a human TTY, rejects `--reconcile` and `--json`, and requires the user to
  type the tracker number as confirmation.
- User stage: advance only after the user reports the real-world action -- "I sent
  the application" -> `applied`; "I sent the qualifying questions" -> `qualifying_sent`
  (also append a `[qualifying-sent YYYY-MM-DD]` marker to the row's notes — it
  anchors the staleness nudge in `followup-cadence.mjs`); "I sent the outreach" ->
  back to `applied`; "I did the interview" -> `interview_ready`, `offer`, or
  `rejected`; "I accepted" -> `accepted`. Record the date in the date column.
- Company stage (`applied`): advance only when the user reports a company event.
- Company stage (`qualifying_sent`): advance only when the user reports the
  recruiter's answer -- a cleared gate -> `evaluated` (now draft the application
  pack; the `[qualifying-sent …]` marker keeps it from re-qualifying), a dealbreaker
  -> `skip` or `discarded`.
- If the user sent a follow-up, append `data/follow-ups.md`.
- If the user discards an opportunity, set the stage to `discarded` or `skip` only
  when they ask.

Never record drafts as sent or submitted. Never write a status that is not a
`label` in `templates/states.yml`.

Completion criterion: durable writes reflect confirmed reality and every written
stage exists in `templates/states.yml`.

## Output Summary

Before summarizing, run the mandatory reconcile so no drafted pack is ever left
behind. **This is not optional and not a "safety net" you may skip when step 6
looks done — the run is INCOMPLETE until this command has been executed and its
output shown.** It is the single unconditional close of every `next` run,
including `auto` runs and unattended automations that delegate to this mode:

```bash
node advance-stage.mjs --reconcile
```

This advances every agent-owned row that has a drafted pack but was not yet
advanced. It is idempotent: if step 6 already advanced each row, it reports "No
changes needed." Never end a run with a drafted pack still sitting on an
`evaluated`, `responded`, or `offer` row.

The reconcile also enforces `candidacy-select.mjs`: a suppressed sibling remains
unadvanced and is reported as `candidacy-{reason}`. Do not interpret that as a
stranded-pack permission; remove or clearly quarantine the conflicting draft and
report the active Primary. An unattended run never uses
`--coordination-override`.

The reconcile is also enforced deterministically: `node verify-pipeline.mjs`
runs a **stranded-pack check** that flags any next-pack whose row is still in an
agent source stage. If you skip the reconcile, that check fails loudly on the
next health run — so there is no silent way to leave a pack behind. If you are
unsure whether a run advanced cleanly, run `verify-pipeline.mjs` and confirm it
reports "No stranded packs."

End with:

- selected opportunities
- packs produced and their `output/next-packs/` paths
- each row's stage, `owner`, and `suggests` action from `templates/states.yml`
- the stage each drafted row advanced to — confirm none were left un-advanced
- recommended approvals
- any writes performed, or "no files changed"

Do not end by asking to submit or send on the user's behalf.

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
- **Include a `Where To Send It` block.** Anything the pack asks the user to send
  must first say *where it goes*: the apply channel (ATS/form URL) and the human
  destination for each drafted message. A message with no destination is an
  unfinished pack.
- Include copy-paste blocks for anything the user might send or paste into a
  form: email, LinkedIn message, recruiter reply, thank-you note, cover-letter
  paragraph, or application answer.
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
- Keep the whole pack lean: the sendable content, where to send it, and what to
  confirm are the body. Fold rationale (why this row, scoring, strategy) into a
  single footer line and do not restate the report.
- Flag legal, salary, visa, demographic, relocation, sponsorship, background
  check, and self-identification answers as confirmation-needed unless already
  present in `config/profile.yml`.

Completion criterion: the user can copy the sendable text and knows exactly who
to send it to, or can see exactly which missing fact — a destination or a gating
answer — blocks direct use.

## Inputs

- Optional argument: tracker number, report number, company, role, or `auto`.
- `data/applications.md` -- canonical lifecycle tracker; each row carries one
  `stage`.
- `templates/states.yml` -- the canonical state machine and the single source of
  routing truth (stage `owner`, `suggests`, `on_demand`, `next_states`).
- `data/follow-ups.md` -- sent follow-up history, if present.
- `reports/` -- evaluation reports.
- `output/next-packs/` -- generated copy-paste advancement packs.
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
- `templates/states.yml`
- relevant report files
- `data/follow-ups.md` if present
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

### 3. Resolve the Target

If the user provided an argument:

1. Try exact tracker number.
2. Try report number from the tracker report link or report filename.
3. Try company/role fuzzy match only if the match is unique.
4. If the argument resolves to different tracker and report rows, ask which one
   to use.

If no argument or `auto` is provided:

For an unattended `auto` run, honor the automation invariant: select only
`agent`-owned stages ready for their generation step, highest-value first:

1. `evaluated` rows (draft the application pack), sorted by score and boosted by
   report/tracker `APPLY` or strong `Research first` signals.
2. `responded` rows (draft the interview cheatsheet).
3. `offer` rows (draft negotiation prep).

Sub-threshold `evaluated` rows may be routed to `skip` or `discarded` per scoring
policy instead of being drafted; that gate is automation policy, not a stage.

For an interactive run with no target, additionally surface the smallest useful
next step for active non-agent rows: `applied` rows with an overdue follow-up
reminder, and user-owned `_ready` rows whose waiting artifact and blocker should
be re-presented. Cap the whole set at three.

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
- `none` stage -> nothing to do.

Use report `Machine Summary`, tracker notes, and follow-up cadence as supporting
evidence, never as an alternate source of routing.

Completion criterion: every selected opportunity resolves to exactly one `suggests`
action drawn from its stage row, with the stage's `owner` stated.

### 5. Produce the Pack

Before drafting, load the behavior owner for the chosen `suggests` action:

| `suggests` action | Load |
|-------------------|------|
| `generate_application_pack` | `modes/apply.md`, `modes/contact.md`, optionally `modes/cover.md`; run `modes/deep.md` first if the report flags gating questions |
| `send_application` | the drafted pack in `output/next-packs/` (verify it is ready to send) |
| `draft_outreach`, `send_outreach` | `modes/contact.md` |
| `follow_up` | `modes/followup.md` |
| `generate_interview_cheatsheet`, `regenerate_cheatsheet` | `modes/interview-prep.md`, the report, and `modes/heuristics/recruiter-side.md` |
| `attend_interview_and_report` | the drafted cheatsheet in `output/next-packs/` |
| `generate_negotiation_prep` | report, `config/profile.yml`, `modes/_profile.md`, and current market research |
| `negotiate_and_report` | the drafted negotiation prep in `output/next-packs/` |

Loading a behavior owner means running its relevant steps, not just reading its
file. In particular, `generate_application_pack` and any `draft_outreach`,
`send_outreach`, or `follow_up` action MUST run `modes/contact.md` step 1
(contact discovery) so the `Where To Send It` block names a real recruiter or
hiring manager, links their profile, and — when the pack includes an email —
carries a real, deliverable address. Do not emit an email draft you have no
address to send to. If the report flags gating questions, run `modes/deep.md`
first.

Pack contents by `suggests` artifact (agent stages draft these; the paired user
`_ready` stage re-presents the already-drafted artifact plus the exact real-world
action and what to confirm, it does not invent a new pack):

- `generate_application_pack` (at `evaluated`) -> application pack:
  - where-to-send block: the apply/ATS URL, the named recruiter or hiring manager
    with their LinkedIn URL, and a deliverable email address whenever the pack
    includes an email draft (run contact discovery to populate this)
  - apply/no-apply recommendation (deep-research gating first if flagged)
  - tailored CV/PDF reference
  - "why this role" or cover-letter paragraph
  - copy-paste answers for likely form questions
  - recruiter, hiring manager, and peer outreach drafts when useful, each
    addressed to the real named contact found in discovery
  - a short line of what to confirm before applying
- `draft_outreach` (on-demand at `applied`) -> outreach pack:
  - where-to-send block: the named contact(s) and their LinkedIn URLs from
    contact discovery
  - recruiter, hiring manager, and peer outreach drafts, each addressed to a real
    named contact
- `follow_up` (reminder at `applied`) -> follow-up pack:
  - where-to-send block: the follow-up destination — the address the application
    thread already uses, or the recruiter's email/LinkedIn found in discovery
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

Save each produced pack to:

```text
output/next-packs/{tracker_num}-{company-slug}.md
```

Use the tracker number when available so the Go dashboard can find the pack and
open it from the selected row. If no tracker number exists, use the report
number. The final response must include the saved path.

Pack format:

````markdown
## Next: {Company} -- {Role} (#{tracker_num})

**Decision:** {draft / send / follow up / prep / negotiate / close}
**Next human action:** {one sentence}
**Stage:** {current stage id}
**Owner:** {agent / user / company / none}
**Suggests:** {suggests action}
**Score:** {score} | **Report:** {report path}

### Where To Send It
- **Apply:** {ATS/form URL, or the exact submit channel}
- **Contact:** {name} -- {title} | {LinkedIn URL}   (alternates on their own lines)
- **Email:** {deliverable address found in discovery, or `none found -- apply via ATS + LinkedIn`}

### Copy-Paste: {Email / LinkedIn / Form Answer / Script}
To: {recipient email or LinkedIn profile -- required for any message with a destination}
Subject: ...

Hi {name},

...

Best,
...

### Copy-Paste: {Second Sendable Item, if useful}
...

### Before You Send
- {facts to confirm, blockers, and gating answers -- a few bullets, no report restatement}

_Selected: {one-line why}. Suggested stage: {next stage id} — allowed by the current stage's next_states; apply only after you approve._
````

Completion criterion: the user can review the pack and decide the next human
approval without the agent needing to act externally.

### 6. Record Only Confirmed Reality

Advance the `stage` in `data/applications.md` only when the transition is allowed
by the current stage's `next_states` and the owner's required trigger has happened:

- Agent stage: after saving the `suggests` artifact (step 5), advance to the paired
  `_ready` stage by running the deterministic advancer rather than hand-editing the
  tracker:

  ```bash
  node advance-stage.mjs {tracker_num}
  ```

  It reads `templates/states.yml`, advances the row (`evaluated → application_ready`,
  `responded → interview_ready`, `offer → offer_ready`), and syncs the saved pack's
  `**Stage:**/**Owner:**/**Suggests:**` header to the destination stage so the
  dashboard keeps the pack openable and shows the right next step (e.g. "Send
  application"). This is a safe draft-exists write, allowed in `auto`. Never leave a
  drafted pack on an un-advanced `evaluated`/`responded`/`offer` row. To advance
  every row that already has a drafted pack in one pass, run
  `node advance-stage.mjs --reconcile`.
- User stage: advance only after the user reports the real-world action -- "I sent
  the application" -> `applied`; "I sent the outreach" -> back to `applied`; "I did
  the interview" -> `interview_ready`, `offer`, or `rejected`; "I accepted" ->
  `accepted`. Record the date in the date column.
- Company stage (`applied`): advance only when the user reports a company event.
- If the user sent a follow-up, append `data/follow-ups.md`.
- If the user discards an opportunity, set the stage to `discarded` or `skip` only
  when they ask.

Never record drafts as sent or submitted. Never write a status that is not a
`label` in `templates/states.yml`.

Completion criterion: durable writes reflect confirmed reality and every written
stage exists in `templates/states.yml`.

## Output Summary

End with:

- selected opportunities
- packs produced and their `output/next-packs/` paths
- each row's stage, `owner`, and `suggests` action from `templates/states.yml`
- recommended approvals
- any writes performed, or "no files changed"

Do not end by asking to submit or send on the user's behalf.

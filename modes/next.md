# Mode: next -- Status-Driven Advancement

Advance an existing opportunity to its next useful human-review step.

## Purpose

`next` is the post-evaluation orchestrator. It reads the tracker, optional action
state, reports, and existing modes, then produces the smallest useful draft pack
for the current stage. It does not discover jobs, evaluate new postings, submit
applications, send messages, or record real-world actions without confirmation.

## Ready Block Contract

Every output must be usable without scavenger-hunting through reports.

- Put the decision and next human action at the top.
- Include a quick-reference block with the role, score, report, blocker, and the
  exact next step.
- Include copy-paste blocks for anything the user might send or paste into a
  form: email, LinkedIn message, recruiter reply, thank-you note, cover-letter
  paragraph, or application answer.
- Keep sendable drafts clean: no markdown tables, no analysis inside the draft,
  no placeholders unless a fact truly needs confirmation.
- Put notes, risks, and rationale outside the copy-paste block.
- Flag legal, salary, visa, demographic, relocation, sponsorship, background
  check, and self-identification answers as confirmation-needed unless already
  present in `config/profile.yml`.

Completion criterion: the user can copy the sendable text directly, or can see
exactly which missing fact blocks direct use.

## Inputs

- Optional argument: tracker number, report number, company, role, or `auto`.
- `data/applications.md` -- canonical lifecycle tracker.
- `data/application-actions.yml` -- optional action-state sidecar.
- `data/follow-ups.md` -- sent follow-up history, if present.
- `reports/` -- evaluation reports.
- `output/next-packs/` -- generated copy-paste advancement packs.
- `templates/states.yml` -- canonical lifecycle states.
- `config/profile.yml`, `modes/_profile.md`, `cv.md`, and `article-digest.md`
  for candidate context.

## State Model

Lifecycle status stays in `data/applications.md`. Operational readiness lives in
`data/application-actions.yml` when present.

```yaml
version: 1
applications:
  "113":
    action_state: needs_action
    next_action: draft_application_pack
    due_after: null
    owner: user
    waiting_on: null
    report: reports/143-n8n-2026-06-26.md
    status_snapshot: Evaluated
    reason: Strong Europe-remote fit; needs tailored app pack.
    updated_at: 2026-06-30
```

Allowed `action_state` values:

- `needs_action` -- Giacomo or the agent should prepare something now.
- `waiting` -- the ball is with a recruiter, company, or future date.
- `blocked` -- action needs missing input or a feasibility check.
- `snoozed` -- intentionally deferred until `due_after`.
- `none` -- no next action.

Allowed `next_action` values:

- `research_gating_questions`
- `draft_application_pack`
- `draft_outreach`
- `follow_up`
- `reply_recruiter`
- `prep_interview`
- `send_thank_you`
- `negotiation_prep`
- `close_or_discard`
- `none`

Do not create or edit `data/application-actions.yml` unless the user approves
the exact action-state update. If the file is missing, infer lazily.

Completion criterion: lifecycle status and operational state remain separate.

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
- `data/application-actions.yml` if present
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

Completion criterion: every candidate considered has tracker status, score,
report path when available, action state or inferred action state, and enough
candidate context for the chosen pack.

### 3. Resolve the Target

If the user provided an argument:

1. Try exact tracker number.
2. Try report number from the tracker report link or report filename.
3. Try company/role fuzzy match only if the match is unique.
4. If the argument resolves to different tracker and report rows, ask which one
   to use.

If no argument or `auto` is provided, select up to three opportunities:

1. Progressed rows with `action_state: needs_action` or due `snoozed` state.
2. `Applied` rows with overdue follow-up cadence.
3. `Responded`, `Interview`, or `Offer` rows needing reply, prep, thank-you, or
   negotiation work.
4. `Evaluated` rows sorted by score, boosting notes/report decisions containing
   `APPLY` or strong `Research first` signals.
5. Rows below 3.5/5 only with explicit override, tracker/report `APPLY`, or a
   stated strategic reason.

Do not select `SKIP`, `Rejected`, `Discarded`, or `waiting` rows unless the user
explicitly asks.

Completion criterion: the selected target set is unambiguous and small enough to
produce useful packs.

### 4. Infer Next Action

Prefer explicit sidecar state. If no sidecar record exists, infer:

| Lifecycle status | Default action |
|------------------|----------------|
| `Evaluated` with `APPLY` or score >= 3.5 | `draft_application_pack` or `research_gating_questions` |
| `Evaluated` below threshold | `close_or_discard` unless overridden |
| `Applied` | `follow_up` when cadence is due, otherwise `waiting` |
| `Responded` | `reply_recruiter` |
| `Interview` | `prep_interview` or `send_thank_you` |
| `Offer` | `negotiation_prep` |
| `Rejected`, `Discarded`, `SKIP` | `none` |

Use report `Machine Summary.next_action`, tracker notes, and follow-up cadence as
supporting evidence, not as the sole source of truth.

Completion criterion: every selected opportunity has one `next_action`, one
short rationale, and a stated owner: `user`, `company`, or `agent-draft`.

### 5. Produce the Pack

Before drafting, load the behavior owner for the chosen action:

| `next_action` | Load |
|---------------|------|
| `research_gating_questions` | `modes/deep.md` plus the report |
| `draft_application_pack` | `modes/apply.md`, `modes/contact.md`, and optionally `modes/cover.md` |
| `draft_outreach` | `modes/contact.md` |
| `follow_up` | `modes/followup.md` |
| `reply_recruiter` | report, profile, CV, and `modes/heuristics/recruiter-side.md` |
| `prep_interview` | `modes/interview-prep.md` |
| `send_thank_you` | `modes/followup.md` and `modes/interview-prep.md` if prep exists |
| `negotiation_prep` | report, `config/profile.yml`, `modes/_profile.md`, and current market research |
| `close_or_discard` | report and tracker row |

Pack contents by stage:

- `Evaluated` -> application pack:
  - apply/no-apply recommendation
  - tailored CV/PDF reference
  - "why this role" or cover-letter paragraph
  - copy-paste answers for likely form questions
  - recruiter, hiring manager, and peer outreach drafts when useful
  - risk notes and questions to confirm before applying
- `Applied` -> follow-up pack:
  - follow-up email
  - LinkedIn follow-up if no email contact exists
  - contact-finding suggestion
  - close/deprioritize note if the cadence is cold
- `Responded` -> reply and screen pack:
  - recruiter reply email
  - logistics answers to confirm
  - recruiter-screen talking points
  - fast prep checklist
- `Interview` -> interview and post-interview pack:
  - one-page interview cheatsheet
  - "tell me about yourself" script
  - company-specific talking points
  - likely technical and behavioral questions
  - story-bank mapping and gaps
  - questions to ask each interviewer
  - thank-you email draft when relevant
- `Offer` -> negotiation pack:
  - compensation and logistics summary
  - negotiation script
  - questions to ask
  - risk checklist
- `close_or_discard` -> closeout pack:
  - short reason
  - suggested tracker status
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

**Decision:** {apply / research first / follow up / reply / prep / negotiate / close}
**Next human action:** {one sentence}
**Status:** {lifecycle status}
**Score:** {score}
**Report:** {report path}
**Action:** {next_action}
**Owner:** {user/company/agent-draft}

### Quick Reference
- **Company:** ...
- **Role:** ...
- **Why it matters:** ...
- **Main blocker:** ...
- **What to confirm:** ...
- **Deadline or cadence:** ...

### Copy-Paste: {Email / LinkedIn / Form Answer / Script}
Subject: ...

Hi ...,

...

Best,
...

### Copy-Paste: {Second Sendable Item, if useful}
...

### Cheatsheet
- ...

### Risks And Confirmations
- ...

### Why This Was Selected
- ...

### Recommended Approvals
- ...

### Suggested State Update
```yaml
applications:
  "{tracker_num}":
    action_state: ...
    next_action: ...
```
````

Completion criterion: the user can review the pack and decide the next human
approval without the agent needing to act externally.

### 6. Record Only Confirmed Reality

Only after explicit confirmation:

- If the user submitted an application, update `data/applications.md` to
  `Applied` and add the submission date in notes.
- If the user sent a follow-up, append `data/follow-ups.md`.
- If the user wants action-state tracking, create or update
  `data/application-actions.yml`.
- If the user discards an opportunity, update the tracker to `Discarded` or
  `SKIP` only when they ask.

Never record drafts as sent or submitted.

Completion criterion: durable writes reflect confirmed reality or explicitly
approved action-state planning.

## Output Summary

End with:

- selected opportunities
- packs produced and their `output/next-packs/` paths
- action-state inference or sidecar records used
- recommended approvals
- any writes performed, or "no files changed"

Do not end by asking to submit or send on the user's behalf.

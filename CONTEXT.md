# Career-Ops

An AI job-search pipeline that evaluates postings and advances each opportunity
through a single, owner-driven lifecycle state machine. This glossary is the
ubiquitous language of that lifecycle. It is a glossary only — not a spec.

## Language

### Lifecycle state machine

**Application**:
One tracked job opportunity as it moves through the lifecycle (one row in
`data/applications.md`).
_Avoid_: job, posting (that is the raw job description), lead, candidate.

**Stage**:
The single value that says where an Application is in its lifecycle — the node in
the state machine. There is exactly one Stage per Application; it replaced the old
two-layer model (a lifecycle status plus an `action_state`/`next_action` sidecar).
_Avoid_: status, state, action_state, phase.

**Spine**:
The main forward path of Stages — evaluated → application_ready → applied →
responded → interview_ready → offer → offer_ready → accepted — as opposed to
Subloops and Terminal stages.

**Owner**:
The party responsible for advancing a Stage: `agent`, `user`, `company`, or
`none`. The Owner alone determines *how* the Stage advances.
_Avoid_: assignee, actor.

**Agent-owned stage**:
A Stage advanced by one automated generation step: an Automation drafts the
Stage's suggested artifact and advances to the paired Ready stage. Auto-advancing
it is safe because it records that a draft exists, never a real-world action.
(evaluated, responded, offer.)

**User-owned stage**:
A Stage with no automated step, blocked until the user performs the real-world
action and reports it in conversation ("I sent the application", "I did the
interview, here's what happened"). Only that report advances it; an Automation
never may.

**Company-owned stage**:
A pure wait — no task for user or agent. It advances only when the user reports a
company-side event. Time-based nudges are a Reminder, not a task. (applied,
qualifying_sent.)

**Ready stage**:
The User-owned stage paired with an Agent-owned stage: the artifact is drafted and
waiting for the user to act and report. Named with a `_ready` suffix
(application_ready, qualifying_ready, outreach_ready, interview_ready, offer_ready).
_Avoid_: drafted, generated, pending.

**World stage**:
A Stage that reflects externally-verifiable reality (applied, responded,
interview, offer, and the Terminal stages). Entering a World stage always requires
the user's confirmation, in contrast to the safe auto-advance into a Ready stage.

**Terminal stage**:
A Stage with Owner `none` and no successors: accepted, rejected, discarded, skip.

**Subloop**:
A reactive, user-initiated detour off a Stage that drafts an optional artifact and
then returns to the Spine — never a Spine stage itself. Qualifying (a gating
question) off `evaluated`, Outreach off `applied`, and cheatsheet regeneration off
`interview_ready` are Subloops.
_Avoid_: side quest, branch, detour.

**Automation**:
An unattended advancer whose entire job is to run the generation step of
Agent-owned stages; it never touches User- or Company-owned stages. The
sink-neutral generalization of a named scheduled job. In career-ops the concrete
Automation is `next` in `auto` mode; kb-infra binds this role as its Job Hunt
Advance Audit.
_Avoid_: JHAA (that is one binding's name), cron, bot, worker.

**Suggests**:
The proactive next thing a Stage implies — the artifact an Agent-owned stage
generates, or the real-world action a User-owned stage calls for. Replaced the old
`next_action`.

**Dashboard group**:
The coarse funnel bucket a Stage maps to (evaluated, applied, responded, interview,
offer, accepted, plus the terminals). Ready and Subloop stages back-map to their
World stage so the funnel stays coarse while the Stage vocabulary is fine-grained.
_Avoid_: status column, funnel stage, phase.

### Candidacy coordination

**Hiring surface**:
The recruiter, hiring-manager, and organizational path through which one or more
Applications are considered. Applications at the same company may have one shared
Hiring surface or several independent Hiring surfaces. Company size and ATS vendor
are research hints, not classifiers.

**Candidacy cluster**:
Applications that current evidence places on the same Hiring surface. A Candidacy
cluster coordinates selection and Outreach without changing any member's Stage.
Persisted in `data/candidacy-clusters.md`.
_Avoid_: duplicate group, company bucket, lifecycle branch.

**Primary Application**:
The one Application currently reserving a Candidacy cluster. Agent-owned siblings
are not selected while the Primary Application is active unless the user explicitly
overrides the coordination guard.

**Outreach anchor**:
The Application whose existing contact thread and first-touch history is reused by
the Candidacy cluster. It prevents sibling Applications from restarting Outreach
to the same person. It is unrelated to a Stage's Owner.

**Reserved cluster**:
A Candidacy cluster whose Primary Application has reached a Ready, Subloop, or
progressed World stage. Unattended Automation excludes Agent-owned siblings until
the cluster is released or explicitly overridden.

**Candidacy selection preflight**:
The deterministic, read-only computation performed by `candidacy-select.mjs`
before Agent-owned Applications are ranked. It returns the exclusive eligible
set, suppressed siblings, and companies whose Hiring-surface classification must
be researched or refreshed. It does not change any Application's Stage.

### Advancement artifacts

**Application pack**:
The copy-paste artifact an Automation drafts to advance an Application, saved under
`output/next-packs/`.
_Avoid_: next pack (legacy), bundle.

**Outreach**:
An optional message to a person at the company, drafted on demand while `applied`
to provoke a response. A Subloop, not a Spine stage.

**Follow-up**:
A time-gated nudge after applying, surfaced as a Reminder by the follow-up cadence
— never a task, an Owner obligation, or a Stage.

**Cheatsheet**:
The interview-prep artifact generated at the `responded` stage and regenerable on
demand for later rounds from `interview_ready`.

**Negotiation prep**:
The artifact generated at the `offer` stage to support negotiating the offer.

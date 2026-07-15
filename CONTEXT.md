# Career-Ops

An AI job-search pipeline that evaluates postings and advances each opportunity
through a single, owner-driven lifecycle state machine. This glossary is the
ubiquitous language of that lifecycle. It is a glossary only — not a spec.

## Language

### Lifecycle state machine

**Opportunity**:
One tracked job opportunity as it moves through the lifecycle (one row in
`data/applications.md`).
_Avoid_: Application (legacy), job, posting (that is the raw job description), lead, candidate.

**Stage**:
The single value that says where an Opportunity is in its lifecycle: the node in
the state machine. There is exactly one Stage per Opportunity; it replaced the old
two-layer model (a lifecycle status plus an `action_state`/`next_action` sidecar).
_Avoid_: status, state, action_state, phase.

**Spine**:
The main forward path of Stages: evaluated → approach_ready → approached →
responded → interview_ready → offer → offer_ready → accepted — as opposed to
Subloops and Terminal stages.

**Owner**:
The party responsible for advancing a Stage: `agent`, `user`, `external`, or
`none`. The Owner alone determines *how* the Stage advances.
_Avoid_: assignee, actor.

**Agent-owned stage**:
A Stage advanced by one automated generation step: an Automation drafts the
Stage's suggested artifact and advances to the paired Ready stage. Auto-advancing
it is safe because it records that a draft exists, never a real-world action.
(evaluated, responded, offer.)

**User-owned stage**:
A Stage with no automated step, blocked until the user performs the real-world
action and reports it in conversation ("I contacted the founder", "I submitted
the form", "I did the
interview, here's what happened"). Only that report advances it; an Automation
never may.

**External-owned stage**:
A pure wait on a founder, recruiter, referrer, or hiring team. It advances only
when the user reports an external event. Time-based review is derived attention,
not a task or lifecycle change. (`approached`.)

**Ready stage**:
The User-owned stage paired with an Agent-owned stage: the artifact is drafted and
waiting for the user to act and report. Named with a `_ready` suffix
(approach_ready, interview_ready, offer_ready).
_Avoid_: drafted, generated, pending.

**World stage**:
A Stage that reflects externally-verifiable reality (approached, responded,
interview, offer, and the Terminal stages). Entering a World stage always requires
the user's confirmation, in contrast to the safe auto-advance into a Ready stage.

**Terminal stage**:
A Stage with Owner `none` and no successors: accepted, rejected, discarded, skip.

**Subloop**:
A reactive assist available within a Stage, never a lifecycle Stage itself.
Qualifying questions, outreach, referrals, formal applications, personalized
media, and follow-ups are Approach routes or Attempts. Cheatsheet regeneration
is an assist from `interview_ready`.
_Avoid_: side quest, branch, detour.

**Automation**:
An unattended advancer whose entire job is to run the generation step of
Agent-owned stages; it never touches User- or External-owned stages. The
sink-neutral generalization of a named scheduled job. In career-ops the concrete
Automation is `next` in `auto` mode; kb-infra binds this role as its Job Hunt
Advance Audit.
_Avoid_: JHAA (that is one binding's name), cron, bot, worker.

**Suggests**:
The proactive next thing a Stage implies — the artifact an Agent-owned stage
generates, or the real-world action a User-owned stage calls for. Replaced the old
`next_action`.

**Dashboard group**:
The coarse funnel bucket a Stage maps to (evaluated, approached, responded,
interview, offer, accepted, plus the terminals). Ready stages back-map to their
World stage so the funnel stays coarse while the Stage vocabulary is fine-grained.
_Avoid_: status column, funnel stage, phase.

### Candidacy coordination

**Hiring surface**:
The recruiter, hiring-manager, and organizational path through which one or more
Opportunities are considered. Opportunities at the same company may have one shared
Hiring surface or several independent Hiring surfaces. Company size and ATS vendor
are research hints, not classifiers.

**Candidacy cluster**:
Opportunities that current evidence places on the same Hiring surface. A Candidacy
cluster coordinates selection and routes without changing any member's Stage.
Persisted in `data/candidacy-clusters.md`.
_Avoid_: duplicate group, company bucket, lifecycle branch.

**Primary Opportunity**:
The one Opportunity currently reserving a Candidacy cluster. Agent-owned siblings
are not selected while the Primary Opportunity is active unless the user explicitly
overrides the coordination guard.

**Primary Application**:
Compatibility name for the Primary Opportunity in older candidacy-coordination
contracts and projections. New authoring uses Primary Opportunity.

**Outreach anchor**:
The Opportunity whose existing contact thread and first-touch history is reused by
the Candidacy cluster. It prevents sibling Opportunities from restarting outreach
to the same person. It is unrelated to a Stage's Owner.

**Reserved cluster**:
A Candidacy cluster whose Primary Opportunity has reached a Ready or
progressed World stage. Unattended Automation excludes Agent-owned siblings until
the cluster is released or explicitly overridden.

**Candidacy selection preflight**:
The deterministic, read-only computation performed by `candidacy-select.mjs`
before Agent-owned Opportunities are ranked. It returns the exclusive eligible
set, suppressed siblings, and companies whose Hiring-surface classification must
be researched or refreshed. It does not change any Application's Stage.

### Advancement artifacts

**Approach Plan**:
The ranked, copy-paste artifact an Automation drafts for an Opportunity. It
contains the best route, the formal route when available, and any useful
alternatives. It is saved under the compatibility path `output/next-packs/`.
_Avoid_: Application pack, next pack, bundle.

**Approach route**:
A possible way to pursue an Opportunity, such as founder outreach, referral,
formal application, qualifying question, personalized media, or in-person contact.
A route is a recommendation until the user confirms executing it.

**Approach Attempt**:
One append-only, user-confirmed real-world action. It records type, channel,
recipient, an ISO 8601 occurrence date or timestamp at the precision the user
confirmed, result, and optional relation to a prior Attempt. Drafts never
become Attempts.

**Outreach**:
An Approach route or Attempt directed to a person at the company.

**Follow-up**:
A typed Approach Attempt that continues a prior Attempt. Its timing is derived
from the attempt ledger and cadence; it never creates a new lifecycle Stage.

**Cheatsheet**:
The interview-prep artifact generated at the `responded` stage and regenerable on
demand for later rounds from `interview_ready`.

**Negotiation prep**:
The artifact generated at the `offer` stage to support negotiating the offer.

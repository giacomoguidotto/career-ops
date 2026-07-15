# Mode Contract: Communication Planner

Use this contract whenever Career-Ops authors pre-response work: an initial
Approach Plan, formal application, qualifying question, referral request,
outreach message, personalized medium, or follow-up. `next`, `apply`, `contact`,
and `followup` share this one planner instead of deciding tone, proof, and route
order independently.

Career-Ops must work without a Knowledge Bank or automation. Start from the
generic defaults in this file and the repository's in-scope user sources. When an
optional external Communication Strategy is supplied in the current invocation,
apply it as personal strategy. Do not copy it into this repository and do not
turn its absence into a blocker. `voice-dna.md` remains the local source for
unique examples and explicit overrides, never factual claims.

## Planning Sequence

1. Read the report, live posting or captured application instructions, current
   Stage, existing Approach Attempts, current plan, and contact history.
2. Classify the room: recipient, decision-maker proximity, company maturity,
   posting register, explicit asks, channel constraints, deadline, and whether a
   response is needed before another route can proceed.
3. Choose a context-appropriate register. Charisma is always an outcome, but its
   expression changes: warm and playful for an informal founder prompt, composed
   and specific for a formal process, concise and curious for a peer, direct and
   screening-aware for a recruiter.
4. Define one communication objective. Examples: earn a founder conversation,
   clear a feasibility gate, complete a required formal process, prompt a useful
   response, or revive a quiet thread.
5. Select one or two source-backed proof anchors. Prefer a concrete result,
   decision, artifact, or compact story that maps to the recipient's problem.
   Let the reader infer capability. Never paste a skill inventory, keyword dump,
   or unsupported superlative.
6. Run `node approach-evidence.mjs` before claiming that one channel works better
   for this candidate. Personal evidence is sufficient only when every compared
   channel has at least eight comparable resolved observations and at least two
   meaningful progressions, with no material confounder. Passing permits a
   conclusion but does not force one. Below the floor, use generic priors only as
   planning aids and label personal evidence insufficient in the audit.
7. Generate every useful route, then rank them by expected meaningful
   progression, signal-to-noise, recipient access, required process, timing risk,
   and effort. Formal application is one typed route, not the lifecycle itself.
8. Put the best parallel route first. Preserve the formal route whenever useful
   or required. Execute formal immediately when the posting requires it, a
   referral depends on an application ID, or a deadline creates risk. A one-
   business-day wait is allowed only when the parallel route is response-
   dependent and timing is safe.
9. If evidence or destination data cannot support a route, name the missing
   blocker. Never fabricate an address, recipient, claim, response, or action.

## Required Plan Output

Every initial or refreshed plan contains:

- `## Communication Plan`
- `**Strategy:**` one compact line naming register, signal, and first route
- `**Context:**` the room and recipient logic
- `**Register:**` how the message should feel
- `**Objective:**` one result the communication should earn
- `**Proof anchors:**` one or two source-backed anchors
- `**Evidence basis:**` personal sample conclusion or explicit insufficiency
- `**Missing blockers:**` `none` or the exact missing facts/destinations
- `## Ranked Approaches`

Each ranked route states:

- priority and route type
- recipient and real destination
- channel and timing
- why this route is ranked here
- exact action instructions
- copy-paste draft or form content when the route is executable now
- the report-back sentence the user should send after acting

Always include a compact visible strategy line in the generated pack. Keep the
full evidence sample and rates in audit output, not in user-facing prose, unless
insufficiency changes what the user should do.

## Authoring Standard

- Sound like a smart person talking to another person.
- Match the posting and recipient without mimicry.
- Use natural connective tissue, contractions where appropriate, direct `I` and
  `you`, and varied sentence rhythm.
- Show capability through the selected signal. Do not announce charisma, list
  adjectives, or explain that the message is persuasive.
- Preserve quirky or personal application asks. They are opportunities to be
  memorable, not noise to standardize away.
- Remove corporate filler, generic enthusiasm, keyword dumps, and em dashes.
- Keep qualifying questions focused on the gate. Do not force proof into a
  message whose only job is to get a factual answer.
- A message is ready only when it has a real recipient and channel, fits any hard
  character cap, and can be copied without editing unsupported placeholders.

## Wait Review

For an Approached Opportunity, read confirmed attempts and cadence before
refreshing the plan:

- not due: preserve the wait and show the next review date
- due: recommend the best next typed attempt, considering routes already tried
- cold: recommend a different route, deprioritization, or discard for the user to
  decide
- substantive external engagement: hand off to the existing downstream Stage

Do not record the recommendation as an attempt. Do not infer that a message was
sent, an application was submitted, or a recipient replied. Only a user report
creates an Approach Attempt or factual Stage transition.

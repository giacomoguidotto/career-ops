# Mode: contact -- Outreach messages

> Apply `voice-dna.md` (if present) to every generated message — full guardrail, conversational voice included (Tier 1 + Tier 2). See `_shared.md` → Voice DNA.

This mode has two variants that share the same persona engine (recruiter → hard
requirements; hiring manager → impact/vision):

- **LinkedIn power move** (default) — find contacts and draft a ≤300-char message
  tied to a specific application/interview. This is the flow below.
- **Greeting** — a single ultra-short first-touch message for platforms with a hard
  character budget (BOSS Zhipin 打招呼, job-board chat, a cold-email opener). No
  contact discovery. See **Greeting variant** at the end of this file.

**Pick the variant:** use **Greeting** when the user says "greeting" / "打招呼" /
"cold opener", names a chat-style platform (e.g. BOSS Zhipin), or asks for a very
short message; otherwise run the LinkedIn power move below.

## LinkedIn power move (default)

1. **Identify targets** via WebSearch:
   - Hiring manager of the team
   - Assigned recruiter
   - Founders (for an early-stage startup — check the company page/JD; a small team is often founder-led with no recruiter)
   - 2-3 team peers (people with similar roles)
   - Interviewer (if the candidate already has a scheduled interview)

2. **Classify contact type** -- ask the candidate or infer from context:
   - **Recruiter** -- person whose role is talent acquisition, sourcing, or recruiting
   - **Hiring Manager** -- the person who leads the hiring team
   - **Founder** -- a co-founder of an early-stage company; at a tiny startup the founders ARE the hiring team (treat like a Hiring Manager: impact/vision emphasis)
   - **Peer** -- someone with a similar role in the team (indirect referral)
   - **Interviewer** -- someone who will interview the candidate (known date)

3. **Select primary target**: the person who would benefit most from the candidate being there.

   **Founder-led startup exception (multiple decision-makers):** when the company
   is a small startup with no recruiter and several visible founders, there is no
   single gatekeeper -- the founders share hiring. Draft **one message per relevant
   founder** (typically the CEO plus the technical/eng founder for an engineering
   role, or all of them if the team is tiny), each **individually tailored** to
   that person's background and what they own -- never the same text repeated with
   the name swapped. Present them as alternatives, then recommend the first send
   order so the candidate can make one calm move instead of a mass blast.

4. **Classify the message intent, then write it like a human.** Intent decides
   how much to say:

   - **Pre-apply question** (eligibility, location, visa/EOR, logistics, "one
     quick thing before I apply"): warm and focused on the question. Do NOT pitch
     fit or list proof points -- you're asking, not selling. A friendly opener,
     one line of personal context only if the question needs it, then the
     question itself. This is the intent for a "can you consider an EU-based
     candidate?" message.
   - **Fit pitch** (first-touch to earn a conversation): use the persona
     checklist below.
   - **Referral**: see Peer below.

   **Voice (non-negotiable):** the message must read like the candidate typed it,
   not like a filled-in template. Apply `voice-dna.md` Tier 2 (see `_shared.md` →
   Voice DNA): a warm human opener ("Hi Carolina, pleasure to meet"), contractions,
   direct "I"/"you", natural connective tissue ("before I do that though", "I just
   had a small question"), and varied rhythm. NO em dashes, NO keyword dumps (a
   message is not a CV). The persona notes below are a checklist of what to
   *cover* -- never three labelled sentences stitched together.

   ### Recruiter
   - Cover: the direct match (role, relevant experience, availability, location),
     one proof that answers a screening question before they ask it, and an easy
     CTA ("happy to share my CV if this looks aligned"). Woven into natural
     sentences, not a spec sheet.

   ### Hiring Manager
   - Cover: a specific challenge their team is facing (from the JD, blog, or news),
     one concrete result where you solved something similar, and a low-friction
     CTA ("would love to hear how your team is approaching {challenge}").

   ### Peer (referral)
   - Cover: a genuine reference to their work (post, talk, open-source project,
     publication), what you're doing in the same space (NOT a job pitch), and a
     curious CTA ("I've been working on similar problems at {company}, would love
     your take on {topic}"). DO NOT ask for a job; the referral happens naturally
     if the conversation flows.

   ### Interviewer (pre-interview)
   - Cover: something specific from their work or trajectory, a light connection
     to the candidate's experience, and a warm sign-off ("looking forward to our
     conversation on {date}"). Light, prepared, never desperate.

5. **Versions**:
   - EN (default)
   - ES (if Spanish company)

6. **Alternative targets** with justification for why they are good second choices

7. **Linear send action sections**: after drafting, turn the contact research
   into ordered action blocks instead of a contact inventory. Name the section by
   the action intent, not by a fixed outreach template.

   Use these sections whenever outreach appears in an application, qualifying,
   follow-up, or outreach pack:

   - `### Send the Gating Question`: pre-application qualifying question. This is
     the primary section for `draft_qualifying_questions` and
     `send_qualifying_questions`.
   - `### Send the Outreach Message`: application-related first touch, referral
     ask, or fit pitch.
   - `### Send the Follow-Up`: cadence follow-up after an application or previous
     message.
   - Backup sections mirror the primary intent: `### Send the Backup Gating
     Question`, `### Send the Backup Outreach Message`, or `### Send the Backup
     Follow-Up`. Include only when a backup is useful and a reliable destination
     exists. State the condition that unlocks it, usually "if the primary message
     goes cold after N business days".

   Every send section includes timing, recipient, channel, whether it is a
   connection note, exact character count when the channel has a cap, any
   one-line instruction, and the copy-paste draft.

   For `send_application`, the default timing is: fill and submit the ATS
   application first, then send one connection note to the primary target. For
   `draft_qualifying_questions`, send the gate question before applying. For
   `draft_outreach` after an application is already sent, use the best available
   direct channel and keep the note tied to the submitted application.

   Completion criterion: the candidate can read the outreach sections in order
   and know exactly what to send now, what to hold, and when a backup becomes
   appropriate.

**Contact channel preference:** Read `contact_preferences.preferred_channel` from
`config/profile.yml`. If it is absent or set to `"either"`, write the CTA
sentence exactly as specified above — no change. If it is set to `"email"` or
`"phone"`, steer the CTA toward that channel instead of the generic default
(e.g. Recruiter's CTA becomes "Happy to share my CV over email if this aligns
with what you're looking for" rather than defaulting to a call; Hiring
Manager's CTA leans on "happy to continue this over email" instead of
proposing a call). Keep the same
3-sentence structure and per-persona emphasis -- only the channel named in the
CTA changes. If `contact_preferences.note` is set, you may fold its intent into
the CTA phrasing (e.g. "screens unknown numbers" → prefer email wording) but do
not quote the note verbatim in a public-facing message.

**Message rules:**
- **Length by channel:** the 300-character cap applies only to a LinkedIn
  *connection request note*. A direct message, InMail, email, or in-form question
  has no such limit -- keep it concise but let it breathe (a few short sentences).
  Never sacrifice a warm, natural read just to hit a character count. When the
  channel is a 300-char connection note, say so and trim to fit without going
  robotic.
- NO corporate-speak
- NO "I'm passionate about..."
- NO keyword dumps -- a message is not a CV
- Write like a person: warm opener, contractions, natural flow, NO em dashes (see
  Voice above)
- Something that makes them want to respond
- NEVER share phone number
- The contact type and intent change the EMPHASIS and length, not the honesty

---

## Greeting variant

A single, punchy first-touch message for platforms where the opener has a hard
character budget — BOSS Zhipin's 打招呼, job-board chat boxes, or the first line
of a cold email. Reuses the persona engine above; the difference is brevity, and
that there is **no contact discovery**.

1. **Skip target identification.** There is no WebSearch/contact-finding step —
   the message goes to whoever the platform connects you with (usually the poster
   or the recruiter). Do not fabricate a named recipient.

2. **Classify the recipient's persona** from context (default to **Recruiter** if
   unknown) and set the emphasis exactly as above:
   - **Recruiter** → hard requirements met (role, years, stack, location, availability)
   - **Hiring Manager / Founder** → impact and vision (a result that maps to their goal)

3. **Synthesize the top 3 match points** between the JD and `cv.md` (same JD↔profile
   fit logic the LinkedIn flow uses). These are the raw material — you will surface
   only the strongest one or two that fit the budget.

4. **Compose ONE message within the character budget.**
   - **Budget:** read `outreach.greeting_max_chars` from `config/profile.yml`.
     **Default 150** when the key is absent. The message MUST fit — count and trim.
   - **Lead with a specific value proposition** (the single strongest match point),
     not an introduction. Punchy sentences, not paragraphs.
   - **Language:** match the JD / platform language (e.g. Simplified Chinese for
     BOSS Zhipin). Character count applies to the output language.

5. **No-fluff policy (hard):** remove filler and replace it with a concrete value
   prop. Ban phrases like "I'm looking for a job", "I'm passionate about",
   "I hope to have the opportunity", generic self-description. Every clause must
   earn its characters.

6. **Output:** the greeting, its character count vs the budget, and a one-line note
   of which match point(s) it used. Offer a shorter fallback if it's near the limit.

**Greeting rules:**
- Platform-agnostic — never assume LinkedIn; works for any chat/opener surface.
- Within `outreach.greeting_max_chars` (default 150). Never exceed it.
- Same non-fabrication rule as the rest of career-ops: reformulate real experience
  from `cv.md`, never invent a skill, metric, or claim.
- NO corporate-speak, NO "I'm passionate about...", NEVER share a phone number.
- Persona changes the EMPHASIS, not the structure.

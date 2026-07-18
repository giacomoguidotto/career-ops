import assert from "node:assert/strict";
import { test } from "node:test";
import { parseApproachPlan } from "./src/lib/approach-plan.mjs";

const plan = [
  "## Ranked Approaches",
  "",
  "### 1. Best: Warm peer note",
  "- **Route:** peer outreach",
  "- **To:** Maya Chen | https://example.invalid/maya",
  "- **Channel:** LinkedIn connection note",
  "- **Timing:** now",
  "",
  "### 2. Official form",
  "- **Route:** formal application",
  "- **To:** Northstar careers | https://example.invalid/apply",
  "- **Channel:** ATS",
  "",
  "### 3. Employment gate",
  "- **Route:** qualifying question",
  "- **To:** Recipient not found",
  "- **Channel:** Email",
  "",
  "### 4. Continue recruiter thread",
  "- **Route:** follow-up",
  "- **To:** Elena Rossi | mailto:elena@example.invalid",
  "- **Channel:** Email",
  "- **Follows:** A014",
  "",
  "### Send the Outreach Message",
  "- **To:** Maya Chen | https://example.invalid/maya",
  "- **Channel:** LinkedIn connection note",
  "- **Connection note:** yes, 282/300 chars",
  "- **Instruction:** Paste into Maya's profile.",
  "",
  "Hello Maya.",
  "",
  "### Fill the Application Form",
  "- **To:** Northstar careers | https://example.invalid/apply",
  "- **Channel:** ATS",
  "",
  "| Question | Answer | Notes |",
  "|---|---|---|",
  "| Why this role? | Traceable systems matter to me. | Explicit JD instruction: one sentence. |",
  "| Desired salary | TBD | Missing personal fact blocker |",
  "",
  "### Send the Gating Question",
  "- **To:** Recipient not found",
  "- **Channel:** Email",
  "",
  "Can this role employ someone in the EU?",
  "",
  "### Send the Follow-up Message",
  "- **To:** Elena Rossi | mailto:elena@example.invalid",
  "- **Channel:** Email",
  "- **Follows:** A014",
  "",
  "Hello Elena.",
].join("\n");

test("parses ranked canonical routes and route-specific material", () => {
  const routes = parseApproachPlan(plan);
  assert.deepEqual(routes.map((route) => route.type), ["outreach", "application", "qualifying", "followup"]);
  assert.equal(routes[0].limit, 300);
  assert.equal(routes[0].body, "Hello Maya.");
  assert.equal(routes[2].blockedReason?.includes("verified destination"), true);
  assert.equal(routes[3].follows, "A014");
});

test("keeps missing facts blank and preserves posting answer order", () => {
  const application = parseApproachPlan(plan)[1];
  assert.deepEqual(application.answers.map((answer) => answer.label), ["Why this role?", "Desired salary"]);
  assert.equal(application.answers[0].instruction, "one sentence.");
  assert.equal(application.answers[1].state, "blocked");
  assert.equal(application.answers[1].value, "");
});

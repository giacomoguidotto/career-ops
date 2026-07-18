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
  "| Why this role? | Traceable systems matter to me. | Explicit JD instruction: maximum 80 characters. Regeneration: I care about building traceable systems. |",
  "| Desired salary | [your answer] | Explicit JD instruction: maximum 50 characters. |",
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
  assert.equal(application.answers[0].instruction, "maximum 80 characters.");
  assert.equal(application.answers[0].limit, 80);
  assert.deepEqual(application.answers[0].regenerationCandidates, ["I care about building traceable systems."]);
  assert.equal(application.answers[1].state, "blocked");
  assert.equal(application.answers[1].value, "");
});

test("matches repeated route material by its canonical destination", () => {
  const repeated = `${plan}\n\n### 5. Backup peer note\n- **Route:** peer outreach\n- **To:** Luca Bianchi | https://example.invalid/luca\n- **Channel:** Email\n\n### Send the Backup Outreach Message\n- **To:** Luca Bianchi | https://example.invalid/luca\n- **Channel:** Email\n\nHello Luca.`;
  const backup = parseApproachPlan(repeated).find((route) => route.rank === 5);
  assert.equal(backup.destination, "Luca Bianchi | https://example.invalid/luca");
  assert.equal(backup.channel, "Email");
  assert.equal(backup.body, "Hello Luca.");
});

test("does not consume later route material for an unmatched route", () => {
  const unmatched = [
    "### 1. First outreach",
    "- **Route:** peer outreach",
    "- **To:** Nora Smith | https://example.invalid/nora",
    "- **Channel:** Email",
    "",
    "### 2. Second outreach",
    "- **Route:** peer outreach",
    "- **To:** Luca Bianchi | https://example.invalid/luca",
    "- **Channel:** Email",
    "",
    "### Send the Outreach Message",
    "- **To:** Luca Bianchi | https://example.invalid/luca",
    "- **Channel:** Email",
    "",
    "Hello Luca.",
  ].join("\n");
  const routes = parseApproachPlan(unmatched);
  assert.match(routes[0].blockedReason, /does not contain sendable text/);
  assert.equal(routes[1].destination, "Luca Bianchi | https://example.invalid/luca");
  assert.equal(routes[1].body, "Hello Luca.");
});

test("preserves escaped pipes inside application table cells", () => {
  const escaped = [
    "### 1. Official form",
    "- **Route:** formal application",
    "- **To:** Northstar careers | https://example.invalid/apply",
    "- **Channel:** ATS",
    "",
    "### Fill the Application Form",
    "- **To:** Northstar careers | https://example.invalid/apply",
    "- **Channel:** ATS",
    "",
    "| Question | Answer | Notes |",
    "|---|---|---|",
    "| JavaScript \\| TypeScript? | Both are source-backed. | Regeneration: TypeScript and JavaScript are both source-backed. |",
  ].join("\n");
  const answer = parseApproachPlan(escaped)[0].answers[0];
  assert.equal(answer.label, "JavaScript | TypeScript?");
  assert.equal(answer.value, "Both are source-backed.");
  assert.deepEqual(answer.regenerationCandidates, ["TypeScript and JavaScript are both source-backed."]);
});

test("matches canonical application sections that declare the destination in prose", () => {
  const canonical = [
    "### 1. Official form",
    "- **Route:** formal application",
    "- **To:** Northstar careers | https://example.invalid/apply",
    "- **Channel:** ATS",
    "",
    "### Fill the Application Form",
    "Press `o` to open and fill the form: https://example.invalid/apply",
    "",
    "| Question | Answer | Notes |",
    "|---|---|---|",
    "| Why this role? | Traceable systems matter to me. | Source: fictional CV. |",
  ].join("\n");
  const application = parseApproachPlan(canonical)[0];
  assert.equal(application.destination, "Northstar careers | https://example.invalid/apply");
  assert.deepEqual(application.answers.map((answer) => answer.label), ["Why this role?"]);
  assert.equal(application.blockedReason, null);
});

test("explicit outreach route metadata outranks timing words in its label", () => {
  const explicit = [
    "### 1. Warm outreach before applying",
    "- **Route:** peer outreach",
    "- **To:** Maya Chen | https://example.invalid/maya",
    "- **Channel:** LinkedIn connection note",
    "",
    "### Send the Outreach Message",
    "- **To:** Maya Chen | https://example.invalid/maya",
    "- **Channel:** LinkedIn connection note",
    "",
    "Hello Maya.",
  ].join("\n");
  const route = parseApproachPlan(explicit)[0];
  assert.equal(route.type, "outreach");
  assert.equal(route.body, "Hello Maya.");
  assert.equal(route.blockedReason, null);
});

test("a concrete URL keeps names containing placeholder words verified", () => {
  const verified = [
    "### 1. Official form",
    "- **Route:** formal application",
    "- **To:** Unknown Worlds | https://unknownworlds.example/jobs/123",
    "- **Channel:** ATS",
    "",
    "### Fill the Application Form",
    "Press `o` to open and fill the form: https://unknownworlds.example/jobs/123",
    "",
    "| Question | Answer | Notes |",
    "|---|---|---|",
    "| Name | Candidate-provided name | Source: fictional CV. |",
  ].join("\n");
  assert.equal(parseApproachPlan(verified)[0].blockedReason, null);
});

test("unresolved destination templates stay blocked", () => {
  const unresolved = [
    "### 1. Official form",
    "- **Route:** formal application",
    "- **To:** {ATS/form URL}",
    "- **Channel:** ATS",
    "",
    "### Fill the Application Form",
    "- **To:** {ATS/form URL}",
    "- **Channel:** ATS",
    "",
    "| Question | Answer | Notes |",
    "|---|---|---|",
    "| Name | Candidate-provided name | Source: fictional CV. |",
  ].join("\n");
  assert.match(parseApproachPlan(unresolved)[0].blockedReason, /verified destination is missing/);
});

test("a contact name alone is blocked while a concrete email is actionable", () => {
  const nameOnly = [
    "### 1. Warm peer note",
    "- **Route:** peer outreach",
    "- **To:** Maya Chen",
    "- **Channel:** Email",
    "",
    "### Send the Outreach Message",
    "- **To:** Maya Chen",
    "- **Channel:** Email",
    "",
    "Hello Maya.",
  ].join("\n");
  assert.match(parseApproachPlan(nameOnly)[0].blockedReason, /verified destination is missing/);

  const withEmail = nameOnly.replaceAll("Maya Chen", "Maya Chen | maya@example.com");
  assert.equal(parseApproachPlan(withEmail)[0].blockedReason, null);
});

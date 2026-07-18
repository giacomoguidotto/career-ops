import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import {
  createFictionalOpportunityWorkspace,
  removeFictionalOpportunityWorkspace,
} from "../tests/fixtures/fictional-opportunity-workspace.mjs";

const WEB_ROOT = import.meta.dirname;
const DIST_DIR = process.env.BUILD_DIST ?? ".next";
const ARTIFACT_DIR = join(WEB_ROOT, ".lifecycle-browser-artifacts", "today");
rmSync(ARTIFACT_DIR, { recursive: true, force: true });

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("could not reserve a browser-test port");
  return port;
}

async function waitUntilReady(url, child, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`web server exited ${child.exitCode}\n${output.join("")}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`web server did not become ready\n${output.join("")}`);
}

async function waitForTerminalWorker(request, baseUrl, minimumHistory = 1) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await request.get(`${baseUrl}/api/workers`);
    const workers = (await response.json()).workers ?? [];
    const worker = workers.find((candidate) => (
      candidate.kind === "lifecycle"
      && candidate.status === "terminal"
      && candidate.recoveryHistory.length >= minimumHistory
    ));
    if (worker) return worker;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("durable lifecycle worker did not settle");
}

async function waitForAcknowledgedWorker(request, baseUrl, id) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await request.get(`${baseUrl}/api/workers/${id}`);
    if (response.ok()) {
      const worker = (await response.json()).worker;
      if (worker?.acknowledgedAt) return worker;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("durable lifecycle worker acknowledgement did not persist");
}

function replaceStage(root, opportunity, from, to) {
  const tracker = join(root, "data", "applications.md");
  const lines = readFileSync(tracker, "utf8").split("\n");
  const index = lines.findIndex((line) => new RegExp(`^\\|\\s*${opportunity}\\s*\\|`).test(line));
  assert.notEqual(index, -1, `fixture Opportunity #${opportunity} exists`);
  assert.equal(lines[index].includes(`| ${from} |`), true, `fixture Opportunity #${opportunity} is ${from}`);
  lines[index] = lines[index].replace(`| ${from} |`, `| ${to} |`);
  writeFileSync(tracker, lines.join("\n"));
}

const fixture = createFictionalOpportunityWorkspace({
  materializeCore: true,
  opportunities: [
    { num: 1, date: "2026-07-18", company: "Agent Leader", role: "Applied AI Engineer", stage: "Evaluated", score: "4.8/5" },
    { num: 2, date: "2026-07-18", company: "External Due", role: "ML Engineer", stage: "Approached", score: "4.2/5" },
    { num: 3, date: "2026-07-18", company: "User Ready", role: "AI Engineer", stage: "Approach Ready", score: "4.7/5" },
    { num: 4, date: "2026-07-18", company: "Research Pair", role: "AI Engineer", stage: "Evaluated", score: "4.5/5" },
    { num: 5, date: "2026-07-18", company: "Research Pair", role: "ML Engineer", stage: "Responded", score: "4.4/5" },
    { num: 6, date: "2026-07-18", company: "Coordinated Pair", role: "AI Engineer", stage: "Evaluated", score: "4.1/5" },
    { num: 7, date: "2026-07-18", company: "Coordinated Pair", role: "ML Engineer", stage: "Responded", score: "4.6/5" },
  ],
  clusters: [
    "# Candidacy clusters",
    "",
    "| Cluster ID | Company | Hiring Surface | Confidence | Members | Primary | Outreach anchor | Evidence | Reviewed |",
    "|---|---|---|---|---|---|---|---|---|",
    "| C-007 | Coordinated Pair | Shared hiring team | high | #6, #7 | #7 | #7 | tracker note | 2026-07-17 |",
    "",
  ].join("\n"),
  files: {
    "cv.md": "# Fictional CV\n",
    "modes/_profile.md": "# Fictional profile\n",
    "modes/next.md": "# Fictional next mode\n",
    "portals.yml": "title_filter:\n  positive:\n    - engineer\n",
    "doctor.mjs": "process.stdout.write(JSON.stringify({ onboardingNeeded: false, missing: [], warnings: [], autoCopied: [] }) + '\\n');\n",
  },
});

const binDir = join(fixture.root, "fixture-bin");
mkdirSync(binDir, { recursive: true });
const codex = join(binDir, "codex");
writeFileSync(codex, "#!/bin/sh\nprintf 'VERDICT: 5/5 | fictional lifecycle worker completed\\n'\n");
chmodSync(codex, 0o755);

const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const output = [];
const child = spawn(
  process.execPath,
  [join(WEB_ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    cwd: WEB_ROOT,
    env: { ...process.env, BUILD_DIST: DIST_DIR, CAREER_OPS_ROOT: fixture.root, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.on("data", (chunk) => output.push(String(chunk)));
child.stderr.on("data", (chunk) => output.push(String(chunk)));

let browser;
let phoneContext;
let desktopContext;
let phone;
const observedRequests = [];
try {
  await waitUntilReady(baseUrl, child, output);
  browser = await chromium.launch({ headless: true });

  desktopContext = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "light" });
  await desktopContext.addInitScript(() => localStorage.setItem("career-ops:config", JSON.stringify({ cliId: "codex" })));
  const desktop = await desktopContext.newPage();
  await desktop.goto(baseUrl);
  await desktop.getByRole("heading", { name: "Keep the search moving." }).waitFor();
  assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await desktop.getByRole("button", { name: "Review eligible batch" }).click();
  const desktopDialog = desktop.getByRole("dialog", { name: "Review what may start" });
  await desktopDialog.waitFor();
  assert.equal(await desktop.getByRole("button", { name: "Close batch review" }).evaluate((node) => node === document.activeElement), true);
  await desktop.keyboard.press("Escape");
  await desktopDialog.waitFor({ state: "hidden" });
  await desktop.waitForFunction(() => document.activeElement?.textContent?.includes("Review eligible batch"));
  assert.equal(await desktop.getByRole("button", { name: "Review eligible batch" }).evaluate((node) => node === document.activeElement), true);

  phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", reducedMotion: "reduce" });
  await phoneContext.addInitScript(() => localStorage.setItem("career-ops:config", JSON.stringify({ cliId: "codex" })));
  phone = await phoneContext.newPage();
  phone.on("request", (request) => observedRequests.push({ method: request.method(), url: request.url() }));
  await phone.goto(baseUrl);
  await phone.getByRole("heading", { name: "Keep the search moving." }).waitFor();
  assert.equal(observedRequests.some((request) => request.method !== "GET" && request.method !== "HEAD"), false, "passive Today load starts no work");
  assert.equal(await phone.getByText("Research required (2)").isVisible(), false, "exclusions stay inside reviewed batch");
  assert.equal(await phone.getByRole("link", { name: "Open External Due Opportunity" }).isVisible(), true, "External-owned work navigates");

  const list = await (await phone.request.get(`${baseUrl}/api/opportunities`)).json();
  const leader = list.opportunities.find((item) => item.opportunity === 7);
  await phone.getByRole("button", { name: "Generate one: interview cheatsheet" }).click();
  await phone.getByText(/Starting interview cheatsheet for Coordinated Pair/i).waitFor();
  await phone.waitForTimeout(1_000);
  assert.equal(observedRequests.some((request) => request.method === "POST" && request.url.endsWith("/api/run")), true, "one explicit generation requests canonical work");

  const duplicate = await phone.request.post(`${baseUrl}/api/run`, {
    data: {
      kind: "lifecycle",
      cliId: "codex",
      input: JSON.stringify({ opportunity: 7, expectedStage: leader.stage.id, expectedRevision: leader.revision }),
    },
  });
  assert.equal(duplicate.status(), 409);
  assert.equal((await duplicate.json()).code, "already-running");

  const terminalWorker = await waitForTerminalWorker(phone.request, baseUrl);
  assert.equal(terminalWorker.recoveryHistory.at(-1).outcome, "retryable");
  assert.equal(terminalWorker.recoveryHistory.at(-1).nextAction.kind, "retry");
  await phone.goto(`${baseUrl}/jobs/${terminalWorker.id}`);
  await phone.getByRole("heading", { name: "No complete artifact exists, and a fresh attempt is safe." }).waitFor();
  assert.equal(await phone.getByRole("button", { name: "Retry safely" }).isVisible(), true);
  await phone.getByText("Content-safe diagnostics").click();
  assert.equal(await phone.getByText("career-ops.opportunity-lifecycle v1").isVisible(), true);
  await phone.getByRole("button", { name: "Retry safely" }).click();
  await phone.getByText("Retrying work", { exact: true }).waitFor();
  const retried = await waitForTerminalWorker(phone.request, baseUrl, 2);
  assert.equal(retried.id, terminalWorker.id, "retry preserves one durable worker identity");
  assert.equal(retried.recoveryHistory.length, 2, "retry appends typed recovery history");
  const partialDir = join(fixture.root, "output", "next-packs");
  mkdirSync(partialDir, { recursive: true });
  writeFileSync(join(partialDir, "007-partial.md"), "# Preserved partial checkpoint\n");
  const partialRecoveryResponse = await phone.request.post(`${baseUrl}/api/workers/${terminalWorker.id}`, {
    data: { action: "recover", trigger: "reload" },
  });
  assert.equal(partialRecoveryResponse.ok(), true);
  assert.equal((await partialRecoveryResponse.json()).recovery.outcome, "resumable");
  await phone.reload();
  await phone.getByRole("button", { name: "Resume work" }).click();
  await phone.getByText("Resuming preserved work", { exact: true }).waitFor();
  const resumed = await waitForTerminalWorker(phone.request, baseUrl, 4);
  assert.equal(resumed.id, terminalWorker.id, "resume preserves one durable worker identity");
  assert.equal(resumed.recoveryHistory.at(-1).outcome, "resumable", "partial work remains resumable without regeneration");
  rmSync(join(partialDir, "007-partial.md"));
  replaceStage(fixture.root, 7, leader.stage.label, "Discarded");
  const staleResume = await phone.request.post(`${baseUrl}/api/run`, {
    data: {
      kind: "lifecycle",
      cliId: "codex",
      input: "",
      workerId: terminalWorker.id,
      continuation: "resume",
    },
  });
  assert.equal(staleResume.status(), 409, "retry rechecks current canonical Stage before launching work");
  assert.equal((await staleResume.json()).code, "conflict");
  replaceStage(fixture.root, 7, "Discarded", leader.stage.label);
  await phone.reload();
  await phone.getByRole("heading", { name: "The Opportunity changed after this worker started. Current state was preserved." }).waitFor();
  await phone.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await waitForAcknowledgedWorker(phone.request, baseUrl, terminalWorker.id);
  await phone.reload();
  await phone.getByRole("heading", { name: "The Opportunity changed after this worker started. Current state was preserved." }).waitFor();
  assert.equal(await phone.getByRole("heading", { name: "Recovery history" }).isVisible(), true, "acknowledgement preserves worker history");
  assert.equal(await phone.getByRole("button", { name: "Acknowledge", exact: true }).count(), 0, "acknowledgement persists across reload");
  await phone.goto(baseUrl);
  await phone.getByRole("heading", { name: "Keep the search moving." }).waitFor();

  await phone.getByRole("button", { name: "Review eligible batch" }).click();
  const dialog = phone.getByRole("dialog", { name: "Review what may start" });
  await dialog.waitFor();
  await dialog.getByRole("region", { name: "Included Agent-owned work" }).waitFor();
  await dialog.getByRole("region", { name: "Research required" }).waitFor();
  await dialog.getByRole("region", { name: "Suppressed" }).waitFor();
  await dialog.getByRole("region", { name: "User-owned" }).waitFor();
  await dialog.getByRole("region", { name: "External-owned" }).waitFor();

  replaceStage(fixture.root, 7, "Responded", "Interview Ready");
  const batchResponse = phone.waitForResponse((response) => response.url().endsWith("/api/opportunities/batch") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Start 2 eligible jobs" }).click();
  const batch = await batchResponse;
  assert.equal(batch.status(), 200);
  const batchPayload = await batch.json();
  assert.deepEqual(batchPayload.ready.map((item) => item.opportunity), [1]);
  assert.deepEqual(batchPayload.skipped.map((item) => [item.opportunity, item.code]), [[7, "changed"]]);
  assert.match(batchPayload.groupId, /^group-today-/);
  const grouped = await (await phone.request.get(`${baseUrl}/api/work-groups/${batchPayload.groupId}`)).json();
  assert.equal(grouped.group.children.length, 3, "group owns ready and reviewed child identities");
  assert.equal(grouped.group.summary.conflict, 2, "fresh revision drift is preserved per child");
  const detachedChild = await phone.request.post(`${baseUrl}/api/run`, {
    data: {
      kind: "lifecycle",
      cliId: "codex",
      workerId: batchPayload.ready[0].workerId,
      input: JSON.stringify(batchPayload.ready[0]),
    },
  });
  assert.equal(detachedChild.status(), 409, "a group child cannot be launched outside its owning group");
  assert.equal((await detachedChild.json()).code, "group-child-conflict");
  await phone.getByText(/Starting 1 eligible work item\. Skipped 1 changed or excluded Opportunity\./).waitFor();

  const conflict = await phone.request.post(`${baseUrl}/api/run`, {
    data: {
      kind: "lifecycle",
      cliId: "codex",
      input: JSON.stringify({ opportunity: 1, expectedStage: "evaluated", expectedRevision: "0".repeat(64) }),
    },
  });
  assert.equal(conflict.status(), 409);
  assert.equal((await conflict.json()).code, "opportunity-conflict");

  await phone.reload();
  await phone.getByRole("button", { name: "Review eligible batch" }).click();
  const emptyDialog = phone.getByRole("dialog", { name: "Review what may start" });
  await emptyDialog.waitFor();
  replaceStage(fixture.root, 1, "Evaluated", "Approach Ready");
  await emptyDialog.getByRole("button", { name: "Start 1 eligible job" }).click();
  await phone.getByText("Nothing started. The fresh preflight found no unchanged eligible work.").waitFor();
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);

  console.log("PASS Today supervision browser journeys");
} catch (error) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  if (phone) {
    try { await phone.screenshot({ path: join(ARTIFACT_DIR, "failure.png"), fullPage: true }); } catch { /* page may already be closed */ }
  }
  writeFileSync(join(ARTIFACT_DIR, "server-output.txt"), `${output.join("")}\nREQUESTS\n${JSON.stringify(observedRequests, null, 2)}\n`);
  throw error;
} finally {
  await desktopContext?.close();
  await phoneContext?.close();
  await browser?.close();
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode != null) resolve();
    else child.once("exit", resolve);
    setTimeout(resolve, 5_000).unref();
  });
  removeFictionalOpportunityWorkspace(fixture.root);
}

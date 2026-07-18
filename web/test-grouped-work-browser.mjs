import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import {
  createFictionalOpportunityWorkspace,
  removeFictionalOpportunityWorkspace,
} from "../tests/fixtures/fictional-opportunity-workspace.mjs";
import { readOpportunityLifecycle, requestOpportunityWork } from "./src/lib/core/opportunity-lifecycle.ts";
import { createDurableWorkGroup } from "./src/lib/core/work-group-store.ts";
import { acknowledgeDurableWorker, createDurableWorker, settleDurableWorker } from "./src/lib/core/worker-store.ts";

const WEB_ROOT = import.meta.dirname;
const DIST_DIR = process.env.BUILD_DIST ?? ".next";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("could not reserve browser-test port");
  return port;
}

async function waitUntilReady(url, child, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`web server exited ${child.exitCode}\n${output.join("")}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`web server did not become ready\n${output.join("")}`);
}

async function workOrder(root, opportunity) {
  const summary = (await readOpportunityLifecycle(root, opportunity)).opportunity;
  const requested = await requestOpportunityWork(root, {
    opportunity,
    expectedStage: summary.stage.id,
    expectedRevision: summary.revision,
  });
  assert.equal(requested.code, "work-requested");
  return requested.workOrder;
}

async function waitForWorker(request, baseUrl, id, minimumHistory = 1) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await request.get(`${baseUrl}/api/workers/${id}`);
    if (response.ok()) {
      const worker = (await response.json()).worker;
      if (worker?.status === "terminal" && worker.recoveryHistory.length >= minimumHistory) return worker;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`durable worker ${id} did not settle`);
}

function recovery(order, outcome, options = {}) {
  const nextAction = {
    changed: { kind: "open", label: "Open result", href: `/pipeline/${order.opportunity}#materials` },
    recovered: { kind: "open", label: "Open recovered result", href: `/pipeline/${order.opportunity}#materials` },
    resumable: { kind: "resume", label: "Resume work", href: null },
    retryable: { kind: "retry", label: "Retry safely", href: null },
    paused: { kind: "resume", label: "Resume when available", href: null },
    unchanged: { kind: "open", label: "Open existing result", href: `/pipeline/${order.opportunity}#materials` },
    unavailable: { kind: "repair", label: "Review recovery details", href: `/pipeline/${order.opportunity}` },
  }[outcome];
  const artifact = options.artifact ? { kind: "approach plan", path: `output/next-packs/${String(order.opportunity).padStart(3, "0")}.md`, revision: order.source.revision } : null;
  return {
    outcome,
    message: options.message ?? `${outcome} canonical child`,
    occurredAt: new Date().toISOString(),
    artifact,
    nextAction,
    diagnostic: {
      trigger: options.trigger ?? "completed",
      contract: { id: "career-ops.opportunity-lifecycle", version: 1 },
      stage: order.source.stage,
      revision: order.source.revision,
      exitCode: outcome === "paused" ? null : 0,
      signal: null,
      parserCode: outcome === "paused" ? "rate-limit" : null,
      lifecycleCode: options.lifecycleCode ?? outcome,
      artifacts: artifact ? [{ kind: artifact.kind, state: "available", format: "canonical", path: artifact.path, revision: artifact.revision }] : [],
    },
  };
}

const fixture = createFictionalOpportunityWorkspace({
  materializeCore: true,
  opportunities: Array.from({ length: 10 }, (_, index) => ({
    num: index + 1,
    date: "2026-07-18",
    company: `Grouped Browser ${index + 1}`,
    role: "Engineer",
    stage: "Evaluated",
    score: "4.5/5",
  })),
  missingOptionalFiles: true,
  files: {
    "cv.md": "# Fictional CV\n",
    "config/profile.yml": "followup_cadence: {}\n",
    "modes/_profile.md": "# Fictional profile\n",
    "modes/next.md": "# Fictional next mode\n",
  },
});
const orders = await Promise.all(Array.from({ length: 9 }, (_, index) => workOrder(fixture.root, index + 1)));
const reserved = (await readOpportunityLifecycle(fixture.root, 10)).opportunity;
writeFileSync(join(fixture.root, "output", "next-packs", "004-partial.md"), "# Preserved partial checkpoint\n");
const groupId = "group-browser-mixed-truth";
const dispositions = ["ready", "ready", "ready", "ready", "ready", "ready", "conflict", "suppressed", "ready", "ready"];
createDurableWorkGroup(fixture.root, {
  id: groupId,
  title: "Mixed browser truth",
  page: "/",
  children: [...orders.map((order, index) => ({
    workerId: `job-browser-${index + 1}`,
    opportunity: order.opportunity,
    title: `Grouped Browser ${index + 1}`,
    subtitle: "Engineer",
    expectedStage: order.source.stage,
    expectedRevision: order.source.revision,
    disposition: dispositions[index],
    code: dispositions[index],
    message: dispositions[index] === "suppressed" ? "Canonical candidacy suppressed this child." : dispositions[index] === "conflict" ? "Opportunity changed after review." : "Canonical work was reviewed.",
  })), {
    workerId: "job-browser-10",
    opportunity: 10,
    title: "Grouped Browser 10",
    subtitle: "Engineer",
    expectedStage: reserved.stage.id,
    expectedRevision: reserved.revision,
    disposition: "ready",
    code: "ready",
    message: "Canonical work was reviewed.",
  }],
});

const outcomes = ["changed", "recovered", "retryable", "resumable", "paused", "unchanged"];
for (const [index, outcome] of outcomes.entries()) {
  createDurableWorker(fixture.root, { id: `job-browser-${index + 1}`, title: `Grouped Browser ${index + 1}`, subtitle: "Engineer", batchId: groupId, workOrder: orders[index] });
  settleDurableWorker(fixture.root, `job-browser-${index + 1}`, recovery(orders[index], outcome, { trigger: outcome === "recovered" ? "reload" : "completed" }));
}
acknowledgeDurableWorker(fixture.root, "job-browser-1");
createDurableWorker(fixture.root, { id: "job-browser-9", title: "Grouped Browser 9", subtitle: "Engineer", batchId: groupId, workOrder: orders[8] });
settleDurableWorker(fixture.root, "job-browser-9", recovery(orders[8], "unavailable", { artifact: true, lifecycleCode: "reconciliation-unavailable", message: "Complete artifact awaits canonical reconciliation." }));
acknowledgeDurableWorker(fixture.root, "job-browser-9");

const binDir = join(fixture.root, "fixture-bin");
mkdirSync(binDir, { recursive: true });
const codex = join(binDir, "codex");
writeFileSync(codex, "#!/bin/sh\nprintf 'VERDICT: 5/5 | fictional grouped worker completed\\n'\n");
chmodSync(codex, 0o755);

const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const output = [];
const child = spawn(process.execPath, [join(WEB_ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: WEB_ROOT,
  env: { ...process.env, BUILD_DIST: DIST_DIR, CAREER_OPS_ROOT: fixture.root, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (chunk) => output.push(String(chunk)));
child.stderr.on("data", (chunk) => output.push(String(chunk)));

let browser;
let desktopContext;
let phoneContext;
try {
  await waitUntilReady(baseUrl, child, output);
  browser = await chromium.launch({ headless: true });
  desktopContext = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "light" });
  await desktopContext.addInitScript(() => localStorage.setItem("career-ops:config", JSON.stringify({ cliId: "codex" })));
  const desktop = await desktopContext.newPage();
  await desktop.goto(`${baseUrl}/jobs`);
  await desktop.getByRole("link", { name: /Mixed browser truth/ }).click();
  await desktop.getByRole("heading", { name: "Mixed browser truth" }).waitFor();
  const malformedOwner = await desktop.request.post(`${baseUrl}/api/run`, {
    data: { kind: "lifecycle", cliId: "codex", input: "{}", batchId: 42 },
  });
  assert.equal(malformedOwner.status(), 400, "runtime group ownership input is validated before lifecycle access");
  for (const label of ["changed", "recovered", "failed", "paused", "unchanged", "suppressed", "conflict"]) {
    assert.equal(await desktop.getByText(label, { exact: true }).first().isVisible(), true, `${label} summary renders`);
  }
  const active = desktop.getByRole("region", { name: "Active and attention" });
  const history = desktop.getByRole("region", { name: "History" });
  assert.equal(await active.getByText("#1 · Grouped Browser 1").count(), 0, "processed terminal child leaves active queue");
  assert.equal(await history.getByText("#1 · Grouped Browser 1").count(), 1, "processed terminal child remains in history");
  assert.equal(await desktop.getByRole("button", { name: "Retry safely" }).count(), 1, "failed child has one retry action");
  assert.equal(await desktop.getByRole("button", { name: "Resume work" }).count(), 1, "partial child has one resume action");
  assert.equal(await desktop.getByRole("button", { name: "Resume when available" }).count(), 1, "paused child has one resume action");
  assert.equal(await desktop.getByText("Complete artifact exists, but canonical reconciliation has not succeeded.").isVisible(), true);
  const recoveredCard = active.locator("article").filter({ hasText: "#2 · Grouped Browser 2" });
  await recoveredCard.getByRole("button", { name: "Acknowledge" }).click();
  await assert.doesNotReject(async () => active.getByText("#2 · Grouped Browser 2").waitFor({ state: "detached" }));
  await history.getByText("#2 · Grouped Browser 2").waitFor();
  await desktop.getByRole("button", { name: "Retry safely" }).click();
  assert.equal((await waitForWorker(desktop.request, baseUrl, "job-browser-3", 2)).recoveryHistory.length, 2, "retry appends canonical recovery history");
  await desktop.getByRole("button", { name: "Resume work" }).click();
  assert.equal((await waitForWorker(desktop.request, baseUrl, "job-browser-4", 2)).recoveryHistory.at(-1).outcome, "resumable", "resume preserves partial canonical work");
  await desktop.getByRole("button", { name: "Resume when available" }).click();
  assert.equal((await waitForWorker(desktop.request, baseUrl, "job-browser-5", 2)).recoveryHistory.length, 2, "paused work resumes through the same worker identity");
  await desktop.getByRole("button", { name: "Start reserved work" }).click();
  const started = await waitForWorker(desktop.request, baseUrl, "job-browser-10");
  assert.equal(started.batchId, groupId, "interrupted launch starts only under its durable group owner");
  assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);

  phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", reducedMotion: "reduce" });
  await phoneContext.addInitScript(() => localStorage.setItem("career-ops:config", JSON.stringify({ cliId: "codex" })));
  const phone = await phoneContext.newPage();
  await phone.goto(`${baseUrl}/jobs/groups/${groupId}`);
  await phone.getByRole("heading", { name: "Mixed browser truth" }).waitFor();
  await phone.reload();
  await phone.getByText("#8 · Grouped Browser 8").waitFor();
  assert.equal(await phone.getByText("Canonical candidacy suppressed this child.").isVisible(), true, "suppression survives reload");
  assert.equal(await phone.getByText("Opportunity changed after review.").isVisible(), true, "conflict survives reload");
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);

  const api = await (await phone.request.get(`${baseUrl}/api/work-groups/${groupId}`)).json();
  assert.equal(api.group.children.length, 10);
  assert.equal(api.group.summary.failed, 5, "partial failure does not collapse successful siblings");
  console.log("PASS grouped work browser journeys");
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

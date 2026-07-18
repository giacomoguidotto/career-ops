import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createFictionalOpportunityWorkspace,
  removeFictionalOpportunityWorkspace,
} from "../tests/fixtures/fictional-opportunity-workspace.mjs";
import {
  readOpportunityLifecycle,
  reconcileOpportunityWork,
  requestOpportunityWork,
} from "./src/lib/core/opportunity-lifecycle.ts";
import { recoverLifecycleWork, WORK_RECOVERY_OUTCOMES } from "./src/lib/core/work-recovery.ts";
import {
  acknowledgeDurableWorker,
  createDurableWorker,
  listDurableWorkers,
  readDurableWorker,
  settleDurableWorker,
} from "./src/lib/core/worker-store.ts";

function artifactPath(root, name = "001-recovery.md") {
  return path.join(root, "output", "next-packs", name);
}

function canonicalArtifact(action = "generate_approach_plan") {
  return [
    "# Fictional recovery artifact",
    "",
    "**Stage:** evaluated",
    "**Owner:** agent",
    `**Suggests:** ${action}`,
    "",
  ].join("\n");
}

async function reservedFixture(options = {}) {
  const fixture = createFictionalOpportunityWorkspace({
    materializeCore: true,
    opportunities: [{
      num: 1,
      company: options.company ?? "Recovery Fictional",
      role: options.role ?? "Researcher",
      stage: "Evaluated",
      notes: options.notes ?? "",
    }],
    missingOptionalFiles: true,
  });
  const before = (await readOpportunityLifecycle(fixture.root, 1)).opportunity;
  const requested = await requestOpportunityWork(fixture.root, {
    opportunity: 1,
    expectedStage: before.stage.id,
    expectedRevision: before.revision,
  });
  assert.equal(requested.code, "work-requested");
  return { fixture, before, workOrder: requested.workOrder };
}

test("recovery publishes the complete stable outcome vocabulary", () => {
  assert.deepEqual(WORK_RECOVERY_OUTCOMES, [
    "changed", "recovered", "resumable", "retryable", "paused", "unchanged", "conflict", "unavailable",
  ]);
});

test("clean completion reconciles one complete canonical artifact as changed", async () => {
  const { fixture, workOrder } = await reservedFixture();
  try {
    writeFileSync(artifactPath(fixture.root), canonicalArtifact());
    const recovery = await recoverLifecycleWork(fixture.root, workOrder, { trigger: "completed", exitCode: 0 });
    assert.equal(recovery.outcome, "changed");
    assert.equal(recovery.nextAction.kind, "open");
    assert.equal(recovery.artifact.path, "output/next-packs/001-recovery.md");
    assert.equal((await readOpportunityLifecycle(fixture.root, 1)).opportunity.stage.id, "approach_ready");
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("uncertain process endings recover a complete artifact before offering retry", async () => {
  for (const trigger of ["timeout", "disconnect", "reload", "non-zero-exit", "uncertain-close"]) {
    const { fixture, workOrder } = await reservedFixture();
    try {
      writeFileSync(artifactPath(fixture.root), canonicalArtifact());
      const recovery = await recoverLifecycleWork(fixture.root, workOrder, { trigger, exitCode: trigger === "non-zero-exit" ? 7 : null });
      assert.equal(recovery.outcome, "recovered", trigger);
      assert.equal(recovery.nextAction.kind, "open", trigger);
      assert.notEqual(recovery.nextAction.kind, "retry", trigger);
      assert.equal((await readOpportunityLifecycle(fixture.root, 1)).opportunity.stage.id, "approach_ready", trigger);
    } finally {
      removeFictionalOpportunityWorkspace(fixture.root);
    }
  }
});

test("partial work is resumable while absent work is retryable and they never overlap", async () => {
  const partial = await reservedFixture();
  const absent = await reservedFixture();
  try {
    writeFileSync(artifactPath(partial.fixture.root), "# Partial work\n\nA recorded checkpoint without a canonical header.\n");
    const resumable = await recoverLifecycleWork(partial.fixture.root, partial.workOrder, { trigger: "timeout" });
    const retryable = await recoverLifecycleWork(absent.fixture.root, absent.workOrder, { trigger: "non-zero-exit", exitCode: 2 });
    assert.equal(resumable.outcome, "resumable");
    assert.equal(resumable.nextAction.kind, "resume");
    assert.equal(retryable.outcome, "retryable");
    assert.equal(retryable.nextAction.kind, "retry");
    assert.notEqual(resumable.nextAction.kind, retryable.nextAction.kind);
    assert.equal((await readOpportunityLifecycle(partial.fixture.root, 1)).opportunity.stage.id, "evaluated");
    assert.equal((await readOpportunityLifecycle(absent.fixture.root, 1)).opportunity.stage.id, "evaluated");
  } finally {
    removeFictionalOpportunityWorkspace(partial.fixture.root);
    removeFictionalOpportunityWorkspace(absent.fixture.root);
  }
});

test("a known pause preserves work and exposes only resume", async () => {
  const { fixture, workOrder } = await reservedFixture();
  try {
    const recovery = await recoverLifecycleWork(fixture.root, workOrder, { trigger: "paused", parserCode: "rate-limit" });
    assert.equal(recovery.outcome, "paused");
    assert.equal(recovery.nextAction.kind, "resume");
    assert.equal(recovery.diagnostic.parserCode, "rate-limit");
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("already reconciled work is unchanged after a clean close and recovered after uncertainty", async () => {
  for (const trigger of ["completed", "reload"]) {
    const { fixture, workOrder } = await reservedFixture();
    try {
      writeFileSync(artifactPath(fixture.root), canonicalArtifact());
      const reconciled = await reconcileOpportunityWork(fixture.root, {
        opportunity: 1,
        expectedStage: workOrder.source.stage,
        expectedRevision: workOrder.source.revision,
      });
      assert.equal(reconciled.effect, "changed");
      const recovery = await recoverLifecycleWork(fixture.root, workOrder, { trigger });
      assert.equal(recovery.outcome, trigger === "completed" ? "unchanged" : "recovered");
      assert.equal(recovery.nextAction.kind, "open");
    } finally {
      removeFictionalOpportunityWorkspace(fixture.root);
    }
  }
});

test("newer Stage evidence conflicts and unsupported artifact evidence is unavailable", async () => {
  const conflictFixture = await reservedFixture();
  const staleFixture = await reservedFixture();
  try {
    const tracker = path.join(conflictFixture.fixture.root, "data", "applications.md");
    writeFileSync(tracker, readFileSync(tracker, "utf8").replace("| Evaluated |", "| Discarded |"));
    const conflict = await recoverLifecycleWork(conflictFixture.fixture.root, conflictFixture.workOrder, { trigger: "reload" });
    assert.equal(conflict.outcome, "conflict");
    assert.equal(conflict.nextAction.kind, "review");

    writeFileSync(artifactPath(staleFixture.fixture.root), canonicalArtifact("generate_negotiation_prep"));
    const unavailable = await recoverLifecycleWork(staleFixture.fixture.root, staleFixture.workOrder, { trigger: "timeout" });
    assert.equal(unavailable.outcome, "unavailable");
    assert.equal(unavailable.nextAction.kind, "repair");
  } finally {
    removeFictionalOpportunityWorkspace(conflictFixture.fixture.root);
    removeFictionalOpportunityWorkspace(staleFixture.fixture.root);
  }
});

test("missing lifecycle capability is unavailable and diagnostics stay content-safe", async () => {
  const sentinel = "DO-NOT-LEAK-CV-CONTENT";
  const url = "https://secret.example.invalid/job/123";
  const { fixture, workOrder } = await reservedFixture({ company: sentinel, role: url, notes: `${sentinel} ${url}` });
  try {
    const recovery = await recoverLifecycleWork(fixture.root, workOrder, { trigger: "non-zero-exit", exitCode: 9, signal: "SIGTERM" });
    const serialized = JSON.stringify(recovery.diagnostic);
    assert.equal(serialized.includes(sentinel), false);
    assert.equal(serialized.includes(url), false);
    assert.equal(recovery.diagnostic.exitCode, 9);
    assert.equal(recovery.diagnostic.signal, "SIGTERM");

    const unavailable = await recoverLifecycleWork(path.join(fixture.root, "missing"), workOrder, { trigger: "reload" });
    assert.equal(unavailable.outcome, "unavailable");
    assert.equal(unavailable.nextAction.kind, "repair");
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("durable worker acknowledgement preserves typed history and canonical files", async () => {
  const { fixture, workOrder } = await reservedFixture();
  try {
    const worker = createDurableWorker(fixture.root, {
      id: "job-recovery-1",
      title: "Prepare fictional artifact",
      workOrder,
    });
    assert.equal(worker.status, "active");
    const recovery = await recoverLifecycleWork(fixture.root, workOrder, { trigger: "timeout" });
    settleDurableWorker(fixture.root, worker.id, recovery);
    const statePath = path.join(fixture.root, ".career-ops-web", "workers", `${worker.id}.json`);
    assert.equal(existsSync(statePath), true);
    const before = readFileSync(statePath, "utf8");
    acknowledgeDurableWorker(fixture.root, worker.id);
    const after = readDurableWorker(fixture.root, worker.id);
    assert.equal(after.recoveryHistory.length, 1);
    assert.equal(after.recoveryHistory[0].outcome, "retryable");
    assert.equal(typeof after.acknowledgedAt, "string");
    assert.notEqual(readFileSync(statePath, "utf8"), before);
    assert.equal(listDurableWorkers(fixture.root).some((candidate) => candidate.id === worker.id), true);
    assert.equal((await readOpportunityLifecycle(fixture.root, 1)).opportunity.stage.id, "evaluated");
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  createFictionalOpportunityWorkspace,
  removeFictionalOpportunityWorkspace,
} from "../tests/fixtures/fictional-opportunity-workspace.mjs";
import { readOpportunityLifecycle, requestOpportunityWork } from "./src/lib/core/opportunity-lifecycle.ts";
import {
  createDurableWorkGroup,
  GROUP_CHILD_OUTCOMES,
  ownsGroupChild,
  readProjectedWorkGroup,
} from "./src/lib/core/work-group-store.ts";
import { acknowledgeDurableWorker, createDurableWorker, settleDurableWorker } from "./src/lib/core/worker-store.ts";

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

function recovery(order, outcome, options = {}) {
  const next = {
    changed: { kind: "open", label: "Open result", href: `/pipeline/${order.opportunity}#materials` },
    recovered: { kind: "open", label: "Open recovered result", href: `/pipeline/${order.opportunity}#materials` },
    resumable: { kind: "resume", label: "Resume work", href: null },
    retryable: { kind: "retry", label: "Retry safely", href: null },
    paused: { kind: "resume", label: "Resume when available", href: null },
    unchanged: { kind: "open", label: "Open existing result", href: `/pipeline/${order.opportunity}#materials` },
    conflict: { kind: "review", label: "Review current Opportunity", href: `/pipeline/${order.opportunity}` },
    unavailable: { kind: "repair", label: "Review recovery details", href: `/pipeline/${order.opportunity}` },
  }[outcome];
  const artifact = options.artifact ? { kind: "approach plan", path: `output/next-packs/${String(order.opportunity).padStart(3, "0")}.md`, revision: order.source.revision } : null;
  return {
    outcome,
    message: options.message ?? `${outcome} canonical child`,
    occurredAt: new Date().toISOString(),
    artifact,
    nextAction: next,
    diagnostic: {
      trigger: options.trigger ?? "completed",
      contract: { id: "career-ops.opportunity-lifecycle", version: 1 },
      stage: order.source.stage,
      revision: order.source.revision,
      exitCode: options.exitCode ?? 0,
      signal: null,
      parserCode: null,
      lifecycleCode: options.lifecycleCode ?? outcome,
      artifacts: artifact ? [{ kind: artifact.kind, state: "available", format: "canonical", path: artifact.path, revision: artifact.revision }] : [],
    },
  };
}

test("group projection preserves mixed canonical child truth and processed history", async () => {
  const fixture = createFictionalOpportunityWorkspace({
    materializeCore: true,
    opportunities: Array.from({ length: 8 }, (_, index) => ({
      num: index + 1,
      company: `Grouped Fictional ${index + 1}`,
      role: "Engineer",
      stage: "Evaluated",
    })),
    missingOptionalFiles: true,
  });
  try {
    const orders = await Promise.all(Array.from({ length: 8 }, (_, index) => workOrder(fixture.root, index + 1)));
    const dispositions = ["ready", "ready", "ready", "ready", "ready", "conflict", "suppressed", "ready"];
    const group = createDurableWorkGroup(fixture.root, {
      id: "group-mixed-truth",
      title: "Mixed truth",
      page: "/",
      children: orders.map((order, index) => ({
        workerId: `job-mixed-${index + 1}`,
        opportunity: order.opportunity,
        title: `Grouped Fictional ${index + 1}`,
        subtitle: "Engineer",
        expectedStage: order.source.stage,
        expectedRevision: order.source.revision,
        disposition: dispositions[index],
        code: dispositions[index],
        message: `${dispositions[index]} at fresh preflight`,
      })),
    });

    const terminal = ["changed", "recovered", "retryable", "paused", "unchanged"];
    for (const [index, outcome] of terminal.entries()) {
      createDurableWorker(fixture.root, { id: `job-mixed-${index + 1}`, title: `Child ${index + 1}`, batchId: group.id, workOrder: orders[index] });
      settleDurableWorker(fixture.root, `job-mixed-${index + 1}`, recovery(orders[index], outcome, { trigger: outcome === "recovered" ? "reload" : "completed" }));
    }
    acknowledgeDurableWorker(fixture.root, "job-mixed-1");

    createDurableWorker(fixture.root, { id: "job-mixed-8", title: "Completed but unmerged", batchId: group.id, workOrder: orders[7] });
    settleDurableWorker(fixture.root, "job-mixed-8", recovery(orders[7], "unavailable", {
      artifact: true,
      lifecycleCode: "reconciliation-unavailable",
      message: "Complete artifact awaits canonical reconciliation.",
    }));
    acknowledgeDurableWorker(fixture.root, "job-mixed-8");

    const projected = readProjectedWorkGroup(fixture.root, group.id);
    assert.ok(projected);
    assert.deepEqual(GROUP_CHILD_OUTCOMES, ["changed", "recovered", "failed", "paused", "unchanged", "suppressed", "conflict"]);
    assert.deepEqual(projected.summary, { changed: 1, recovered: 1, failed: 2, paused: 1, unchanged: 1, suppressed: 1, conflict: 1 });
    assert.equal(projected.activeChildren.some((child) => child.workerId === "job-mixed-1"), false, "processed terminal child leaves active queue");
    assert.equal(projected.historyChildren.some((child) => child.workerId === "job-mixed-1"), true, "processed child remains in history");
    assert.equal(projected.activeChildren.some((child) => child.workerId === "job-mixed-8"), true, "unmerged completion stays attention-worthy after acknowledgement");
    assert.equal(projected.activeChildren.find((child) => child.workerId === "job-mixed-8").artifacts.length, 1);
    assert.equal(projected.activeChildren.find((child) => child.workerId === "job-mixed-3").nextAction.kind, "retry");
    assert.equal(projected.activeChildren.find((child) => child.workerId === "job-mixed-4").nextAction.kind, "resume");
    assert.equal(ownsGroupChild(fixture.root, group.id, "job-mixed-2", 2), true);
    assert.equal(ownsGroupChild(fixture.root, group.id, "job-mixed-7", 7), false, "suppressed child cannot be launched");
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

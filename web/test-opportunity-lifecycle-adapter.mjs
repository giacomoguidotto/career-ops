import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createFictionalOpportunityWorkspace,
  removeFictionalOpportunityWorkspace,
} from "../tests/fixtures/fictional-opportunity-workspace.mjs";
import {
  LifecycleAdapterError,
  listOpportunityLifecycle,
  readOpportunityLifecycle,
  recordOpportunityAttemptLifecycle,
  reportOpportunitySuccessorLifecycle,
  requestOpportunityWork,
  setOpportunityPrimaryLifecycle,
  tryListOpportunityLifecycle,
} from "./src/lib/core/opportunity-lifecycle.ts";
import { reportableSuccessors } from "./src/lib/core/reported-event-contract.ts";

const TODAY = new Date().toISOString().slice(0, 10);

function clone(value) {
  return structuredClone(value);
}

function servePayload(root, value) {
  const serialized = `${JSON.stringify(value)}\n`;
  writeFileSync(
    path.join(root, "opportunity-lifecycle.mjs"),
    `process.stdout.write(${JSON.stringify(serialized)});\n`,
  );
}

async function incompatible(root, mutate, code) {
  const valid = await listOpportunityLifecycle(root);
  const malformed = clone(valid);
  mutate(malformed);
  servePayload(root, malformed);
  await assert.rejects(
    listOpportunityLifecycle(root),
    (error) => error instanceof LifecycleAdapterError && error.code === code && error.status === 503,
  );
}

test("adapter accepts the published lifecycle structure", async () => {
  const fixture = createFictionalOpportunityWorkspace({ materializeCore: true, missingOptionalFiles: true });
  try {
    const result = await listOpportunityLifecycle(fixture.root);
    assert.equal(result.contract.version, 1);
    assert.equal(result.opportunities.length, fixture.stages.length);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("adapter transports confirmed Attempts and allowed successor reports through the canonical seam", async () => {
  const fixture = createFictionalOpportunityWorkspace({
    materializeCore: true,
    extraOpportunities: [{ num: 42, company: "Reported Fictional", role: "Engineer", stage: "Approach Ready" }],
  });
  try {
    const detail = await readOpportunityLifecycle(fixture.root, 42);
    const before = detail.opportunity;
    assert.deepEqual(reportableSuccessors(before, detail.contract), ["discarded"]);
    const attempt = await recordOpportunityAttemptLifecycle(
      fixture.root,
      42,
      before.stage.id,
      before.revision,
      {
        occurredAt: TODAY,
        type: "formal_application",
        channel: "ats",
        recipient: "Fictional Hiring Team",
        result: "submitted",
        followUpTo: null,
        notes: "",
      },
    );
    assert.equal(attempt.code, "attempt-recorded");
    assert.equal(attempt.after.stage.id, "approached");
    const successor = await reportOpportunitySuccessorLifecycle(
      fixture.root,
      42,
      attempt.after.stage.id,
      attempt.after.revision,
      "responded",
    );
    assert.equal(successor.code, "successor-recorded");
    assert.equal(successor.after.stage.id, "responded");
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("adapter defaults the pre-coordination v1 candidacy shape from older checkouts", async () => {
  const fixture = createFictionalOpportunityWorkspace({ materializeCore: true, missingOptionalFiles: true });
  try {
    const legacy = clone(await listOpportunityLifecycle(fixture.root));
    for (const opportunity of legacy.opportunities) {
      opportunity.candidacy = {
        state: opportunity.candidacy.state,
        reason: opportunity.candidacy.reason,
        clusterId: opportunity.candidacy.clusterId,
        primary: opportunity.candidacy.primary,
        outreachAnchor: opportunity.candidacy.outreachAnchor,
      };
    }
    servePayload(fixture.root, legacy);

    const result = await listOpportunityLifecycle(fixture.root);
    assert.equal(result.contract.version, 1);
    assert.deepEqual(result.opportunities[0].candidacy, {
      ...legacy.opportunities[0].candidacy,
      shared: false,
      surface: null,
      confidence: null,
      evidence: null,
      reviewed: null,
      recommendedLead: null,
      persistedPrimary: null,
      members: [],
      research: null,
      canSelectPrimary: false,
      canReleasePrimary: false,
      canGenerateOnce: false,
    });
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("adapter rejects future versions and malformed domain values", async () => {
  const cases = [
    [(result) => { result.contract.version = 999; }, "invalid-lifecycle-contract"],
    [(result) => { result.contract.capabilities.passiveRead = "yes"; }, "invalid-lifecycle-contract"],
    [(result) => { result.contract.stages[0].owner = "browser"; }, "invalid-lifecycle-contract"],
    [(result) => { result.opportunities[0].primaryAction.kind = "invented"; }, "invalid-opportunity-summary"],
    [(result) => { result.opportunities[0].candidacy.shared = "yes"; }, "invalid-opportunity-summary"],
    [(result) => { result.opportunities[0].candidacy.members = [{ opportunity: -1 }]; }, "invalid-opportunity-summary"],
    [(result) => { delete result.opportunities[0].candidacy.members; }, "invalid-opportunity-summary"],
  ];
  for (const [mutate, code] of cases) {
    const fixture = createFictionalOpportunityWorkspace({ materializeCore: true, missingOptionalFiles: true });
    try {
      await incompatible(fixture.root, mutate, code);
    } finally {
      removeFictionalOpportunityWorkspace(fixture.root);
    }
  }
});

test("adapter transports guarded candidacy commands through the canonical seam", async () => {
  const clusters = [
    "# Candidacy clusters",
    "",
    "| Cluster ID | Company | Hiring surface | Confidence | Members | Primary | Outreach anchor | Evidence | Reviewed |",
    "|---|---|---|---|---|---|---|---|---|",
    `| shared | Fictional | Shared team | high | #1, #2 | #1 | #1 | [team](https://example.invalid/team) | ${TODAY} |`,
    "",
  ].join("\n");
  const primaryFixture = createFictionalOpportunityWorkspace({
    materializeCore: true,
    opportunities: [
      { num: 1, company: "Fictional", role: "Lead", stage: "Evaluated", notes: "APPLY: lead" },
      { num: 2, company: "Fictional", role: "Alternate", stage: "Evaluated", notes: "APPLY: alternate" },
    ],
    clusters,
  });
  const overrideFixture = createFictionalOpportunityWorkspace({
    materializeCore: true,
    opportunities: [
      { num: 1, company: "Fictional", role: "Lead", stage: "Evaluated", notes: "APPLY: lead" },
      { num: 2, company: "Fictional", role: "Alternate", stage: "Evaluated", notes: "APPLY: alternate" },
    ],
    clusters,
  });
  try {
    const target = (await readOpportunityLifecycle(primaryFixture.root, 2)).opportunity;
    const selected = await setOpportunityPrimaryLifecycle(
      primaryFixture.root, 2, target.stage.id, target.revision, 2,
    );
    assert.equal(selected.code, "primary-selected");
    assert.equal(selected.after.candidacy.persistedPrimary, 2);
    assert.equal(selected.after.stage.id, target.stage.id);

    const alternate = (await readOpportunityLifecycle(overrideFixture.root, 2)).opportunity;
    const generated = await requestOpportunityWork(overrideFixture.root, {
      opportunity: 2,
      expectedStage: alternate.stage.id,
      expectedRevision: alternate.revision,
      candidacyOverride: true,
    });
    assert.equal(generated.code, "work-requested");
    assert.equal(generated.workOrder.authorization.kind, "single-generation-exception");
    assert.equal(generated.before.stage.id, generated.after.stage.id);
  } finally {
    removeFictionalOpportunityWorkspace(primaryFixture.root);
    removeFictionalOpportunityWorkspace(overrideFixture.root);
  }
});

test("adapter validates Attempt links, notes, artifact metadata, and safe Opportunity IDs", async () => {
  const fixture = createFictionalOpportunityWorkspace({
    materializeCore: true,
    opportunities: [{ num: 1, company: "Fictional", role: "Researcher", stage: "Approached" }],
    attempts: [{
      id: "A001",
      opportunity: 1,
      type: "follow_up",
      followUpTo: "A000",
      notes: "Fictional follow-up note",
    }],
  });
  try {
    const focused = await readOpportunityLifecycle(fixture.root, 1);
    assert.equal(focused.attempts[0].followUpTo, "A000");
    assert.equal(focused.attempts[0].notes, "Fictional follow-up note");
    assert.equal(focused.opportunity.artifacts.every((artifact) => "revision" in artifact), true);
    await assert.rejects(
      readOpportunityLifecycle(fixture.root, Number.MAX_SAFE_INTEGER + 1),
      (error) => error instanceof LifecycleAdapterError && error.code === "invalid-opportunity" && error.status === 400,
    );

    await incompatible(fixture.root, (result) => {
      result.opportunities[0].attempts.latest.followUpTo = 7;
    }, "invalid-opportunity-summary");
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("adapter rejects malformed Attempt dates and negative or unsafe counters", async () => {
  const listCases = [
    (result) => { result.opportunities[0].date = "not-a-date"; },
    (result) => { result.opportunities[0].attempts.latest.date = "tomorrow"; },
    (result) => { result.opportunities[0].attempts.count = -1; },
    (result) => { result.opportunities[0].attempts.count = Number.MAX_SAFE_INTEGER + 1; },
    (result) => { result.opportunities[0].attemptAttention.followupCount = -1; },
    (result) => { result.opportunities[0].attemptAttention.followupCount = Number.MAX_SAFE_INTEGER + 1; },
  ];
  for (const mutate of listCases) {
    const fixture = createFictionalOpportunityWorkspace({
      materializeCore: true,
      opportunities: [{ num: 1, company: "Fictional", role: "Researcher", stage: "Approached" }],
      attempts: [{ id: "A001", opportunity: 1 }],
    });
    try {
      await incompatible(fixture.root, mutate, "invalid-opportunity-summary");
    } finally {
      removeFictionalOpportunityWorkspace(fixture.root);
    }
  }

  const focusedFixture = createFictionalOpportunityWorkspace({
    materializeCore: true,
    opportunities: [{ num: 1, company: "Fictional", role: "Researcher", stage: "Approached" }],
    attempts: [{ id: "A001", opportunity: 1 }],
  });
  try {
    const malformed = clone(await readOpportunityLifecycle(focusedFixture.root, 1));
    malformed.attempts[0].date = "2026-02-31";
    servePayload(focusedFixture.root, malformed);
    await assert.rejects(
      readOpportunityLifecycle(focusedFixture.root, 1),
      (error) => error instanceof LifecycleAdapterError && error.code === "invalid-opportunity-detail" && error.status === 503,
    );
  } finally {
    removeFictionalOpportunityWorkspace(focusedFixture.root);
  }

  const identityCases = [
    (result) => { result.opportunity.opportunity = 2; },
    (result) => { result.attempts[0].opportunity = 2; },
  ];
  for (const mutate of identityCases) {
    const fixture = createFictionalOpportunityWorkspace({
      materializeCore: true,
      opportunities: [{ num: 1, company: "Fictional", role: "Researcher", stage: "Approached" }],
      attempts: [{ id: "A001", opportunity: 1 }],
    });
    try {
      const malformed = clone(await readOpportunityLifecycle(fixture.root, 1));
      mutate(malformed);
      servePayload(fixture.root, malformed);
      await assert.rejects(
        readOpportunityLifecycle(fixture.root, 1),
        (error) => error instanceof LifecycleAdapterError && error.code === "invalid-opportunity-detail" && error.status === 503,
      );
    } finally {
      removeFictionalOpportunityWorkspace(fixture.root);
    }
  }
});

test("adapter gracefully falls back only when the passive contract is unavailable", async () => {
  const missing = path.join(process.cwd(), ".definitely-missing-career-ops-root");
  assert.equal(await tryListOpportunityLifecycle(missing), null);

  const fixture = createFictionalOpportunityWorkspace({ materializeCore: true, missingOptionalFiles: true });
  try {
    const valid = await listOpportunityLifecycle(fixture.root);
    valid.contract.version = 999;
    servePayload(fixture.root, valid);
    await assert.rejects(
      tryListOpportunityLifecycle(fixture.root),
      (error) => error instanceof LifecycleAdapterError && error.code === "invalid-lifecycle-contract",
    );

    writeFileSync(path.join(fixture.root, "opportunity-lifecycle.mjs"), "process.stdout.write('not json');\n");
    await assert.rejects(
      tryListOpportunityLifecycle(fixture.root),
      (error) => error instanceof LifecycleAdapterError && error.code === "invalid-lifecycle-output",
    );
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("adapter guards explicit work requests and validates duplicate suppression", async () => {
  const fixture = createFictionalOpportunityWorkspace({
    materializeCore: true,
    opportunities: [{ num: 7, company: "Fictional Runway", role: "Applied AI Engineer", stage: "Evaluated" }],
    files: { "cv.md": "# Fictional CV\n" },
  });
  try {
    const before = await readOpportunityLifecycle(fixture.root, 7);
    const expectation = {
      opportunity: 7,
      expectedStage: before.opportunity.stage.id,
      expectedRevision: before.opportunity.revision,
    };
    const requested = await requestOpportunityWork(fixture.root, expectation);
    assert.equal(requested.code, "work-requested");
    assert.equal(requested.effect, "accepted");
    assert.equal(requested.workOrder.opportunity, 7);
    assert.equal(requested.workOrder.artifact.kind, "approach-plan");
    assert.equal(requested.before.stage.id, "evaluated");
    assert.equal(requested.after.stage.id, "evaluated");

    const repeated = await requestOpportunityWork(fixture.root, expectation);
    assert.equal(repeated.code, "already-running");
    assert.equal(repeated.effect, "unchanged");
    assert.equal(repeated.workOrder.id, requested.workOrder.id);

    const conflict = await requestOpportunityWork(fixture.root, { ...expectation, expectedRevision: "0".repeat(64) });
    assert.equal(conflict.code, "opportunity-conflict");
    assert.equal(conflict.effect, "conflict");
    assert.equal(conflict.workOrder, null);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

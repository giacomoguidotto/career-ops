import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createFictionalOpportunityWorkspace,
  removeFictionalOpportunityWorkspace,
} from "../tests/fixtures/fictional-opportunity-workspace.mjs";
import {
  inspectPdfArtifact,
  opportunityForReport,
  recordPdfArtifact,
  reconcilePdfArtifact,
} from "../pdf-artifact.mjs";
import { readOpportunityLifecycle } from "./src/lib/core/opportunity-lifecycle.ts";
import { recoverPdfWork, recoverWork } from "./src/lib/core/work-recovery.ts";

function pdfFixture() {
  return createFictionalOpportunityWorkspace({
    materializeCore: true,
    opportunities: [{
      num: 1,
      company: "Reviewable PDF Fictional",
      role: "Researcher",
      stage: "Evaluated",
      report: "[001](../reports/001-fictional.md)",
      pdf: "-",
    }],
    reports: { "001-fictional.md": "# Evaluation\n\n## Machine Summary\n\nfinal_decision: apply\n" },
    files: {
      "output/cv-fictional.pdf": "fictional pdf bytes v1",
      "output/cv-fictional.html": "<html>fictional</html>",
    },
    missingOptionalFiles: true,
  });
}

async function record(fixture, { pages, budget = 1, allowOverflow = false } = {}) {
  return recordPdfArtifact({
    root: fixture.root,
    report: "001",
    pdfPath: path.join(fixture.root, "output", "cv-fictional.pdf"),
    htmlPath: path.join(fixture.root, "output", "cv-fictional.html"),
    format: "a4",
    pageCount: pages,
    maxPages: budget,
    allowOverflow,
  });
}

function workOrder(detail) {
  return {
    workflow: "pdf",
    id: "a".repeat(64),
    opportunity: 1,
    action: "generate_pdf",
    source: { stage: detail.opportunity.stage.id, revision: detail.opportunity.revision },
    artifact: { kind: "pdf", directory: "output" },
    consequence: { stage: detail.opportunity.stage.id, label: "PDF ready" },
  };
}

test("an accepted PDF becomes ready once and reconciles idempotently", async () => {
  const fixture = pdfFixture();
  try {
    const before = await readOpportunityLifecycle(fixture.root, 1);
    const rendered = await record(fixture, { pages: 1 });
    assert.equal(rendered.artifact.acceptance.status, "accepted");
    const first = await reconcilePdfArtifact({
      root: fixture.root,
      opportunity: 1,
      expectedRevision: rendered.record.revision,
    });
    assert.equal(first.effect, "changed");
    const trackerAfterFirst = readFileSync(path.join(fixture.root, "data", "applications.md"), "utf8");
    assert.match(trackerAfterFirst, /\[pdf\]\(\.\.\/output\/cv-fictional\.pdf\)/);

    const second = await reconcilePdfArtifact({
      root: fixture.root,
      opportunity: 1,
      expectedRevision: rendered.record.revision,
    });
    assert.equal(second.effect, "unchanged");
    assert.equal(readFileSync(path.join(fixture.root, "data", "applications.md"), "utf8"), trackerAfterFirst);

    const completed = await recoverPdfWork(fixture.root, workOrder(before), { trigger: "completed", exitCode: 0 });
    assert.equal(completed.outcome, "changed");
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("a written overflow stays inspectable, unaccepted, and retryable after trimming", async () => {
  const fixture = pdfFixture();
  try {
    const before = await readOpportunityLifecycle(fixture.root, 1);
    const rendered = await record(fixture, { pages: 2 });
    const detail = await readOpportunityLifecycle(fixture.root, 1);
    const artifact = detail.opportunity.artifacts.find((candidate) => candidate.kind === "pdf");
    assert.equal(rendered.artifact.state, "available");
    assert.equal(artifact.acceptance.status, "needs-review");
    assert.equal(artifact.acceptance.actualPages, 2);
    assert.equal(artifact.acceptance.budget, 1);
    assert.match(artifact.acceptance.trimGuidance, /extra bullets/);
    assert.doesNotMatch(readFileSync(path.join(fixture.root, "data", "applications.md"), "utf8"), /\[pdf\]/);

    const recovered = await recoverPdfWork(fixture.root, workOrder(before), { trigger: "non-zero-exit", exitCode: 1 });
    assert.equal(recovered.outcome, "resumable");
    assert.equal(recovered.nextAction.label, "Regenerate after trimming");
    assert.equal(recovered.pdfReview.actualPages, 2);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("regeneration replaces overflow evidence with one accepted canonical success", async () => {
  const fixture = pdfFixture();
  try {
    await record(fixture, { pages: 2 });
    writeFileSync(path.join(fixture.root, "output", "cv-fictional.pdf"), "fictional pdf bytes v2");
    const regenerated = await record(fixture, { pages: 1 });
    const outcome = await reconcilePdfArtifact({
      root: fixture.root,
      opportunity: 1,
      expectedRevision: regenerated.record.revision,
    });
    assert.equal(outcome.effect, "changed");
    const detail = await readOpportunityLifecycle(fixture.root, 1);
    const artifact = detail.opportunity.artifacts.find((candidate) => candidate.kind === "pdf");
    assert.equal(artifact.acceptance.status, "accepted");
    assert.equal(artifact.acceptance.actualPages, 1);
    assert.equal(artifact.acceptance.acceptedBy, "within-budget");
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("a later overflow invalidates an existing ready tracker link", async () => {
  const fixture = pdfFixture();
  try {
    const accepted = await record(fixture, { pages: 1 });
    await reconcilePdfArtifact({
      root: fixture.root,
      opportunity: 1,
      expectedRevision: accepted.record.revision,
    });
    assert.match(readFileSync(path.join(fixture.root, "data", "applications.md"), "utf8"), /\[pdf\]/);

    writeFileSync(path.join(fixture.root, "output", "cv-fictional.pdf"), "fictional overflow replacement bytes");
    await record(fixture, { pages: 2 });
    assert.doesNotMatch(readFileSync(path.join(fixture.root, "data", "applications.md"), "utf8"), /\[pdf\]/);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("an exact page-count allowance is separate, guarded, and idempotent", async () => {
  const fixture = pdfFixture();
  try {
    const overflow = await record(fixture, { pages: 2 });
    const allowed = await reconcilePdfArtifact({
      root: fixture.root,
      opportunity: 1,
      expectedRevision: overflow.record.revision,
      allowPageCount: 2,
    });
    assert.equal(allowed.effect, "changed");
    assert.equal(allowed.code, "pdf-overflow-allowed");
    assert.equal(allowed.artifact.acceptance.acceptedBy, "explicit-overflow");

    const current = inspectPdfArtifact({ root: fixture.root, row: { num: 1, report: "[001](x)" } });
    const repeated = await reconcilePdfArtifact({
      root: fixture.root,
      opportunity: 1,
      expectedRevision: current.record.revision,
      allowPageCount: 2,
    });
    assert.equal(repeated.effect, "unchanged");
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("an accepted PDF link is relative to a legacy flat tracker", async () => {
  const fixture = pdfFixture();
  try {
    renameSync(
      path.join(fixture.root, "data", "applications.md"),
      path.join(fixture.root, "applications.md"),
    );
    const rendered = await record(fixture, { pages: 1 });
    const outcome = await reconcilePdfArtifact({
      root: fixture.root,
      opportunity: 1,
      expectedRevision: rendered.record.revision,
    });
    assert.equal(outcome.effect, "changed");
    assert.match(
      readFileSync(path.join(fixture.root, "applications.md"), "utf8"),
      /\[pdf\]\(output\/cv-fictional\.pdf\)/,
    );
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("a stale overflow revision cannot accept a newer render", async () => {
  const fixture = pdfFixture();
  try {
    const stale = await record(fixture, { pages: 2 });
    writeFileSync(path.join(fixture.root, "output", "cv-fictional.pdf"), "fictional pdf bytes v3");
    await record(fixture, { pages: 3 });
    const outcome = await reconcilePdfArtifact({
      root: fixture.root,
      opportunity: 1,
      expectedRevision: stale.record.revision,
      allowPageCount: 2,
    });
    assert.equal(outcome.effect, "conflict");
    assert.equal(outcome.code, "pdf-revision-conflict");
    assert.doesNotMatch(readFileSync(path.join(fixture.root, "data", "applications.md"), "utf8"), /\[pdf\]/);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("changed PDF bytes cannot be accepted from an otherwise current record", async () => {
  const fixture = pdfFixture();
  try {
    const rendered = await record(fixture, { pages: 2 });
    writeFileSync(path.join(fixture.root, "output", "cv-fictional.pdf"), "replaced after review");
    const outcome = await reconcilePdfArtifact({
      root: fixture.root,
      opportunity: 1,
      expectedRevision: rendered.record.revision,
      allowPageCount: 2,
    });
    assert.equal(outcome.effect, "unavailable");
    assert.equal(outcome.code, "pdf-artifact-unavailable");
    assert.doesNotMatch(readFileSync(path.join(fixture.root, "data", "applications.md"), "utf8"), /\[pdf\]/);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("a missing tracker leaves the completed render inspectable", async () => {
  const fixture = pdfFixture();
  try {
    renameSync(
      path.join(fixture.root, "data", "applications.md"),
      path.join(fixture.root, "data", "applications.missing"),
    );
    const rendered = await record(fixture, { pages: 1 });
    assert.equal(rendered.artifact.state, "available");
    assert.equal(opportunityForReport({ root: fixture.root, report: "001" }), null);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("an invalid canonical record cannot fall back to legacy tracker readiness", async () => {
  const fixture = pdfFixture();
  try {
    const accepted = await record(fixture, { pages: 1 });
    await reconcilePdfArtifact({
      root: fixture.root,
      opportunity: 1,
      expectedRevision: accepted.record.revision,
    });
    const contradictory = {
      ...accepted.record,
      pageCount: 2,
      maxPages: 1,
      status: "accepted",
      acceptedBy: "within-budget",
    };
    delete contradictory.revision;
    contradictory.revision = createHash("sha256").update(JSON.stringify(contradictory)).digest("hex");
    writeFileSync(
      path.join(fixture.root, ".career-ops-web", "pdf-artifacts", "1.json"),
      `${JSON.stringify(contradictory, null, 2)}\n`,
    );
    const detail = await readOpportunityLifecycle(fixture.root, 1);
    const pdfArtifacts = detail.opportunity.artifacts.filter((artifact) => artifact.kind === "pdf");
    assert.equal(pdfArtifacts.length, 1);
    assert.equal(pdfArtifacts[0].format, "canonical");
    assert.equal(pdfArtifacts[0].state, "unavailable");
    assert.equal(pdfArtifacts[0].acceptance, undefined);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("uncertain process exit recovers accepted PDF evidence without duplicate readiness writes", async () => {
  const fixture = pdfFixture();
  try {
    const before = await readOpportunityLifecycle(fixture.root, 1);
    await record(fixture, { pages: 2, allowOverflow: true });
    const order = workOrder(before);
    const first = await recoverPdfWork(fixture.root, order, { trigger: "uncertain-close" });
    assert.equal(first.outcome, "recovered");
    const trackerAfterFirst = readFileSync(path.join(fixture.root, "data", "applications.md"), "utf8");
    const second = await recoverPdfWork(fixture.root, order, { trigger: "reload" });
    assert.equal(second.outcome, "recovered");
    assert.equal(readFileSync(path.join(fixture.root, "data", "applications.md"), "utf8"), trackerAfterFirst);

    const dispatched = await recoverWork(fixture.root, order, { trigger: "reload" });
    assert.equal(dispatched.outcome, "recovered");
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("render recording serializes with a stale allowance without clobbering the newer PDF", async () => {
  const fixture = pdfFixture();
  try {
    const stale = await record(fixture, { pages: 2 });
    writeFileSync(path.join(fixture.root, "output", "cv-fictional.pdf"), "fictional concurrent pdf bytes");
    const [allowance, newer] = await Promise.all([
      reconcilePdfArtifact({
        root: fixture.root,
        opportunity: 1,
        expectedRevision: stale.record.revision,
        allowPageCount: 2,
      }),
      record(fixture, { pages: 3 }),
    ]);
    assert.equal(allowance.effect, "unavailable");
    assert.equal(newer.artifact.acceptance.status, "needs-review");
    const current = inspectPdfArtifact({ root: fixture.root, row: { num: 1, report: "[001](x)" } });
    assert.equal(current.record.revision, newer.record.revision);
    assert.equal(current.artifact.acceptance.actualPages, 3);
    assert.equal(current.artifact.acceptance.status, "needs-review");
    assert.doesNotMatch(readFileSync(path.join(fixture.root, "data", "applications.md"), "utf8"), /\[pdf\]/);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

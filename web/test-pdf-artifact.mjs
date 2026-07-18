import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createFictionalOpportunityWorkspace,
  removeFictionalOpportunityWorkspace,
} from "../tests/fixtures/fictional-opportunity-workspace.mjs";
import {
  inspectPdfArtifact,
  recordPdfArtifact,
  reconcilePdfArtifact,
} from "../pdf-artifact.mjs";
import { readOpportunityLifecycle } from "./src/lib/core/opportunity-lifecycle.ts";
import { recoverPdfWork } from "./src/lib/core/work-recovery.ts";

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

function record(fixture, { pages, budget = 1, allowOverflow = false } = {}) {
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
    const rendered = record(fixture, { pages: 1 });
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
    const rendered = record(fixture, { pages: 2 });
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
    record(fixture, { pages: 2 });
    writeFileSync(path.join(fixture.root, "output", "cv-fictional.pdf"), "fictional pdf bytes v2");
    const regenerated = record(fixture, { pages: 1 });
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

test("an exact page-count allowance is separate, guarded, and idempotent", async () => {
  const fixture = pdfFixture();
  try {
    const overflow = record(fixture, { pages: 2 });
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

test("a stale overflow revision cannot accept a newer render", async () => {
  const fixture = pdfFixture();
  try {
    const stale = record(fixture, { pages: 2 });
    writeFileSync(path.join(fixture.root, "output", "cv-fictional.pdf"), "fictional pdf bytes v3");
    record(fixture, { pages: 3 });
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

test("uncertain process exit recovers accepted PDF evidence without duplicate readiness writes", async () => {
  const fixture = pdfFixture();
  try {
    const before = await readOpportunityLifecycle(fixture.root, 1);
    record(fixture, { pages: 2, allowOverflow: true });
    const order = workOrder(before);
    const first = await recoverPdfWork(fixture.root, order, { trigger: "uncertain-close" });
    assert.equal(first.outcome, "recovered");
    const trackerAfterFirst = readFileSync(path.join(fixture.root, "data", "applications.md"), "utf8");
    const second = await recoverPdfWork(fixture.root, order, { trigger: "reload" });
    assert.equal(second.outcome, "recovered");
    assert.equal(readFileSync(path.join(fixture.root, "data", "applications.md"), "utf8"), trackerAfterFirst);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

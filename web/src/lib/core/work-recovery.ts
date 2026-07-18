import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  LifecycleAdapterError,
  readOpportunityLifecycle,
  reconcileOpportunityWork,
  type LifecycleWorkOrder,
  type OpportunitySummary,
} from "./opportunity-lifecycle.ts";

export const WORK_RECOVERY_OUTCOMES = [
  "changed",
  "recovered",
  "resumable",
  "retryable",
  "paused",
  "unchanged",
  "conflict",
  "unavailable",
] as const;

export type WorkRecoveryOutcome = (typeof WORK_RECOVERY_OUTCOMES)[number];
export type WorkRecoveryTrigger =
  | "completed"
  | "timeout"
  | "disconnect"
  | "reload"
  | "non-zero-exit"
  | "paused"
  | "uncertain-close";
export type WorkNextActionKind = "open" | "resume" | "retry" | "review" | "repair";

export type WorkRecoveryDiagnostic = {
  trigger: WorkRecoveryTrigger;
  contract: { id: string; version: number } | null;
  stage: string | null;
  revision: string | null;
  exitCode: number | null;
  signal: string | null;
  parserCode: string | null;
  lifecycleCode: string | null;
  artifacts: Array<{
    kind: string;
    state: string;
    format: string;
    path: string | null;
    revision: string | null;
  }>;
};

export type WorkRecovery = {
  outcome: WorkRecoveryOutcome;
  message: string;
  occurredAt: string;
  artifact: { kind: string; path: string; revision: string | null } | null;
  nextAction: { kind: WorkNextActionKind; label: string; href: string | null };
  pdfReview?: {
    actualPages: number;
    budget: number;
    trimGuidance: string;
    reviewRevision: string;
  };
  diagnostic: WorkRecoveryDiagnostic;
};

export type WorkProcessEvidence = {
  trigger: WorkRecoveryTrigger;
  exitCode?: number | null;
  signal?: string | null;
  parserCode?: string | null;
};

type Artifact = OpportunitySummary["artifacts"][number];

function safeArtifacts(artifacts: Artifact[]): WorkRecoveryDiagnostic["artifacts"] {
  return artifacts.map(({ kind, state, format, path, revision }) => ({
    kind,
    state,
    format,
    path,
    revision,
  }));
}

function pdfArtifact(artifacts: Artifact[]): Artifact | null {
  return artifacts.find((artifact) => artifact.kind === "pdf" && artifact.format === "canonical") ?? null;
}

function artifactFor(workOrder: LifecycleWorkOrder, artifacts: Artifact[]): Artifact | null {
  return artifacts.find((artifact) => (
    artifact.action === workOrder.action
    && artifact.expectedAction === workOrder.action
    && artifact.state === "available"
  )) ?? null;
}

function diagnostic(
  evidence: WorkProcessEvidence,
  summary: OpportunitySummary | null,
  contract: { id: string; version: number } | null,
  lifecycleCode: string | null,
): WorkRecoveryDiagnostic {
  const safeSignal = typeof evidence.signal === "string" && /^SIG[A-Z0-9]+$/.test(evidence.signal)
    ? evidence.signal.slice(0, 24)
    : null;
  const safeParserCode = evidence.parserCode === "no-worker-output" || evidence.parserCode === "rate-limit"
    ? evidence.parserCode
    : null;
  return {
    trigger: evidence.trigger,
    contract,
    stage: summary?.stage.id ?? null,
    revision: summary?.revision ?? null,
    exitCode: evidence.exitCode ?? null,
    signal: safeSignal,
    parserCode: safeParserCode,
    lifecycleCode,
    artifacts: safeArtifacts(summary?.artifacts ?? []),
  };
}

function result(
  workOrder: LifecycleWorkOrder,
  evidence: WorkProcessEvidence,
  outcome: WorkRecoveryOutcome,
  message: string,
  summary: OpportunitySummary | null,
  contract: { id: string; version: number } | null,
  lifecycleCode: string | null,
  artifact: Artifact | null,
): WorkRecovery {
  const next = {
    changed: { kind: "open", label: "Open result", href: `/pipeline/${workOrder.opportunity}#materials` },
    recovered: { kind: "open", label: "Open recovered result", href: `/pipeline/${workOrder.opportunity}#materials` },
    resumable: { kind: "resume", label: "Resume work", href: null },
    retryable: { kind: "retry", label: "Retry safely", href: null },
    paused: { kind: "resume", label: "Resume when available", href: null },
    unchanged: { kind: "open", label: "Open existing result", href: `/pipeline/${workOrder.opportunity}#materials` },
    conflict: { kind: "review", label: "Review current Opportunity", href: `/pipeline/${workOrder.opportunity}` },
    unavailable: { kind: "repair", label: "Review recovery details", href: `/pipeline/${workOrder.opportunity}` },
  } satisfies Record<WorkRecoveryOutcome, WorkRecovery["nextAction"]>;
  return {
    outcome,
    message,
    occurredAt: new Date().toISOString(),
    artifact: artifact?.path ? { kind: artifact.kind, path: artifact.path, revision: artifact.revision } : null,
    nextAction: next[outcome],
    diagnostic: diagnostic(evidence, summary, contract, lifecycleCode),
  };
}

/**
 * Classify one uncertain worker from canonical evidence. This adapter never
 * infers Stage or writes lifecycle state itself: the only mutation is the
 * guarded reconciliation command owned by opportunity-lifecycle.mjs.
 */
export async function recoverLifecycleWork(
  root: string,
  workOrder: LifecycleWorkOrder,
  evidence: WorkProcessEvidence,
): Promise<WorkRecovery> {
  let detail;
  try {
    detail = await readOpportunityLifecycle(root, workOrder.opportunity);
  } catch (error) {
    const code = error instanceof LifecycleAdapterError ? error.code : "lifecycle-read-failed";
    return result(
      workOrder,
      evidence,
      "unavailable",
      "Canonical lifecycle evidence is unavailable, so no retry was started.",
      null,
      null,
      code,
      null,
    );
  }

  const summary = detail.opportunity;
  const contract = { id: detail.contract.id, version: detail.contract.version };
  const artifact = artifactFor(workOrder, summary.artifacts);
  const complete = artifact && ["canonical", "legacy"].includes(artifact.format);
  const partial = artifact?.format === "unknown";

  if (summary.stage.id === workOrder.consequence.stage) {
    if (!complete) {
      return result(
        workOrder,
        evidence,
        "unavailable",
        "The Ready Stage exists without a readable canonical artifact.",
        summary,
        contract,
        "ready-artifact-unavailable",
        artifact,
      );
    }
    const outcome = evidence.trigger === "completed" ? "unchanged" : "recovered";
    return result(
      workOrder,
      evidence,
      outcome,
      outcome === "recovered"
        ? "The process was uncertain, but canonical evidence proves the result is ready."
        : "The canonical result was already ready.",
      summary,
      contract,
      "already-reconciled",
      artifact,
    );
  }

  if (summary.stage.id !== workOrder.source.stage) {
    return result(
      workOrder,
      evidence,
      "conflict",
      "The Opportunity changed after this worker started. Current state was preserved.",
      summary,
      contract,
      "opportunity-conflict",
      artifact,
    );
  }

  if (complete) {
    let reconciled;
    try {
      reconciled = await reconcileOpportunityWork(root, {
        opportunity: workOrder.opportunity,
        expectedStage: workOrder.source.stage,
        expectedRevision: workOrder.source.revision,
      });
    } catch (error) {
      const code = error instanceof LifecycleAdapterError ? error.code : "reconciliation-unavailable";
      return result(
        workOrder,
        evidence,
        "unavailable",
        "The artifact is complete, but canonical reconciliation is unavailable.",
        summary,
        contract,
        code,
        artifact,
      );
    }
    if (reconciled.effect === "changed") {
      const outcome = evidence.trigger === "completed" ? "changed" : "recovered";
      return result(
        workOrder,
        evidence,
        outcome,
        outcome === "changed"
          ? "The canonical artifact was completed and reconciled."
          : "Canonical reconciliation recovered the completed artifact.",
        reconciled.after,
        contract,
        reconciled.code,
        artifact,
      );
    }
    if (reconciled.effect === "unchanged") {
      return result(
        workOrder,
        evidence,
        evidence.trigger === "completed" ? "unchanged" : "recovered",
        "The canonical result was already reconciled.",
        reconciled.after,
        contract,
        reconciled.code,
        artifact,
      );
    }
    if (reconciled.effect === "conflict") {
      return result(
        workOrder,
        evidence,
        "conflict",
        "The Opportunity changed before reconciliation. Current state was preserved.",
        reconciled.after,
        contract,
        reconciled.code,
        artifact,
      );
    }
    return result(
      workOrder,
      evidence,
      "unavailable",
      reconciled.retryable
        ? "The complete artifact remains available, but only reconciliation may be retried."
        : "The complete artifact remains available, but reconciliation is blocked.",
      reconciled.after ?? summary,
      contract,
      reconciled.code,
      artifact,
    );
  }

  if (partial) {
    return result(
      workOrder,
      evidence,
      "resumable",
      "Partial canonical work is preserved and can be resumed without regeneration.",
      summary,
      contract,
      "partial-artifact",
      artifact,
    );
  }

  const incompatible = summary.artifacts.find((candidate) => (
    candidate.expectedAction === workOrder.action
    && candidate.state === "available"
    && candidate.action !== workOrder.action
  ));
  if (incompatible || summary.artifacts.some((candidate) => candidate.state === "unavailable")) {
    return result(
      workOrder,
      evidence,
      "unavailable",
      "The expected artifact cannot be interpreted safely.",
      summary,
      contract,
      incompatible ? "stale-artifact-action" : "artifact-unavailable",
      incompatible ?? null,
    );
  }

  if (evidence.trigger === "paused") {
    return result(
      workOrder,
      evidence,
      "paused",
      "Work paused before a complete artifact existed. Its retry budget was not consumed.",
      summary,
      contract,
      "worker-paused",
      null,
    );
  }

  return result(
    workOrder,
    evidence,
    "retryable",
    "No complete artifact exists, and a fresh attempt is safe.",
    summary,
    contract,
    "artifact-missing",
    null,
  );
}

async function reconcilePdf(root: string, opportunity: number, expectedRevision: string): Promise<Record<string, unknown>> {
  const script = path.join(root, "pdf-artifact.mjs");
  if (!fs.existsSync(script)) throw new LifecycleAdapterError("pdf-contract-unavailable", "The PDF acceptance contract is unavailable.", 503);
  let stdout: string;
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [script, "reconcile", `--opportunity=${opportunity}`, `--expected-revision=${expectedRevision}`, `--root=${root}`],
        { cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024, env: { ...process.env, CAREER_OPS_PDF_ARTIFACT_CLI: "1" } },
        (error, output) => error ? reject(Object.assign(error, { output })) : resolve(output),
      );
    });
  } catch (error) {
    const output = typeof (error as { output?: unknown })?.output === "string" ? (error as { output: string }).output : "";
    let parsed: unknown = null;
    try { parsed = JSON.parse(output); } catch { /* fall through */ }
    if (
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && ["conflict", "blocked", "unavailable"].includes(String((parsed as Record<string, unknown>).effect ?? ""))
    ) return parsed as Record<string, unknown>;
    throw error;
  }
  const parsed = JSON.parse(stdout) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid PDF reconciliation output");
  return parsed as Record<string, unknown>;
}

/** Recover one PDF worker from the canonical render record, never from exit alone. */
export async function recoverPdfWork(
  root: string,
  workOrder: LifecycleWorkOrder,
  evidence: WorkProcessEvidence,
): Promise<WorkRecovery> {
  let detail;
  try {
    detail = await readOpportunityLifecycle(root, workOrder.opportunity);
  } catch (error) {
    const code = error instanceof LifecycleAdapterError ? error.code : "lifecycle-read-failed";
    return result(workOrder, evidence, "unavailable", "Canonical PDF evidence is unavailable.", null, null, code, null);
  }
  const summary = detail.opportunity;
  const contract = { id: detail.contract.id, version: detail.contract.version };
  const artifact = pdfArtifact(summary.artifacts);
  if (!artifact || artifact.state !== "available" || !artifact.acceptance) {
    return result(
      workOrder,
      evidence,
      artifact ? "unavailable" : "retryable",
      artifact ? "The written PDF cannot be interpreted safely." : "No canonical PDF render exists, and regeneration is safe.",
      summary,
      contract,
      artifact ? "pdf-artifact-unavailable" : "pdf-artifact-missing",
      artifact,
    );
  }
  if (summary.stage.id !== workOrder.source.stage) {
    return result(workOrder, evidence, "conflict", "The Opportunity changed while the PDF was generated.", summary, contract, "opportunity-conflict", artifact);
  }
  if (artifact.acceptance.status === "needs-review") {
    const recovery = result(
      workOrder,
      evidence,
      "resumable",
      `The ${artifact.acceptance.actualPages}-page PDF exceeds its ${artifact.acceptance.budget}-page budget and needs review.`,
      summary,
      contract,
      "pdf-needs-review",
      artifact,
    );
    recovery.nextAction = { kind: "retry", label: "Regenerate after trimming", href: null };
    recovery.pdfReview = {
      actualPages: artifact.acceptance.actualPages,
      budget: artifact.acceptance.budget,
      trimGuidance: artifact.acceptance.trimGuidance,
      reviewRevision: artifact.acceptance.reviewRevision,
    };
    return recovery;
  }

  try {
    const reconciled = await reconcilePdf(root, workOrder.opportunity, artifact.acceptance.reviewRevision);
    const effect = String(reconciled.effect ?? "unavailable");
    if (effect === "changed" || effect === "unchanged") {
      const outcome = evidence.trigger === "completed"
        ? "changed"
        : "recovered";
      return result(
        workOrder,
        evidence,
        outcome,
        outcome === "recovered" ? "The accepted PDF was recovered and marked ready." : "The accepted PDF was generated and marked ready.",
        summary,
        contract,
        String(reconciled.code ?? "pdf-reconciled"),
        artifact,
      );
    }
    return result(workOrder, evidence, effect === "conflict" ? "conflict" : "unavailable", String(reconciled.message ?? "PDF reconciliation failed."), summary, contract, String(reconciled.code ?? "pdf-reconciliation-failed"), artifact);
  } catch {
    return result(workOrder, evidence, "unavailable", "The accepted PDF remains inspectable, but reconciliation is unavailable.", summary, contract, "pdf-reconciliation-unavailable", artifact);
  }
}

/** Dispatch durable recovery by the canonical workflow recorded on the worker. */
export async function recoverWork(
  root: string,
  workOrder: LifecycleWorkOrder,
  evidence: WorkProcessEvidence,
): Promise<WorkRecovery> {
  return workOrder.workflow === "pdf"
    ? recoverPdfWork(root, workOrder, evidence)
    : recoverLifecycleWork(root, workOrder, evidence);
}

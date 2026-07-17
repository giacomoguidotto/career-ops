import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type LifecycleContract = {
  id: string;
  version: number;
  stageSchemaVersion: number | null;
  capabilities: Record<string, boolean>;
  stages: Array<{
    id: string;
    label: string;
    owner: string;
    suggests: string | null;
    allowedSuccessors: string[];
  }>;
  warnings: Array<Record<string, unknown>>;
  revision: string;
};

export type OpportunitySummary = {
  opportunity: number;
  date: string;
  company: string;
  via: string;
  role: string;
  location: string;
  score: string;
  pdf: string;
  report: string;
  notes: string;
  rawStage: string;
  stage: {
    id: string | null;
    label: string;
    owner: string | null;
    suggests: string | null;
    allowedSuccessors: string[];
  };
  primaryAction: { kind: string; id: string | null; enabled: boolean; reason: string | null };
  attemptAttention: { state: string; nextReview: string | null; followupCount?: number; latestAttemptId?: string | null };
  attempts: {
    count: number;
    latest: { id: string; date: string; type: string; channel: string; recipient: string; result: string } | null;
    channels: string[];
    formalSubmitted: boolean;
  };
  artifacts: Array<{ kind: string; state: string; format: string; path: string | null }>;
  candidacy: { state: string; reason: string | null; clusterId: string | null; primary: number | null; outreachAnchor: number | null };
  warnings: Array<Record<string, unknown>>;
  provenance: Array<Record<string, unknown>>;
  capabilities: Record<string, boolean>;
  contractVersion: number;
  revision: string;
};

export type OpportunityListResult = {
  contract: LifecycleContract;
  opportunities: OpportunitySummary[];
  warnings: Array<Record<string, unknown>>;
  revision: string;
};

export type OpportunityDetailResult = {
  contract: LifecycleContract;
  opportunity: OpportunitySummary;
  attempts: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
  revision: string;
};

export class LifecycleAdapterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateContract(value: unknown): asserts value is LifecycleContract {
  if (
    !object(value)
    || value.id !== "career-ops.opportunity-lifecycle"
    || !Number.isInteger(value.version)
    || !Array.isArray(value.stages)
    || !object(value.capabilities)
    || typeof value.revision !== "string"
  ) {
    throw new LifecycleAdapterError("invalid-lifecycle-contract", "The lifecycle contract is incompatible.", 503);
  }
}

function validateOpportunity(value: unknown): asserts value is OpportunitySummary {
  if (
    !object(value)
    || !Number.isInteger(value.opportunity)
    || !object(value.stage)
    || !object(value.primaryAction)
    || !object(value.attemptAttention)
    || !object(value.attempts)
    || !object(value.candidacy)
    || !object(value.capabilities)
    || !Array.isArray(value.artifacts)
    || !Array.isArray(value.warnings)
    || !Array.isArray(value.provenance)
    || typeof value.revision !== "string"
  ) {
    throw new LifecycleAdapterError("invalid-opportunity-summary", "The Opportunity summary is incompatible.", 503);
  }
}

function lifecycleScript(root: string): string {
  const script = path.join(root, `opportunity-${"lifecycle"}.mjs`);
  if (!fs.existsSync(script)) {
    throw new LifecycleAdapterError("lifecycle-contract-unavailable", "This checkout does not provide passive lifecycle reads.", 503);
  }
  return script;
}

function run(root: string, action: "contract" | "list" | "read", extra: string[] = []): unknown {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) {
    throw new LifecycleAdapterError("checkout-unavailable", "The career-ops checkout is unavailable.", 503);
  }
  try {
    const stdout = execFileSync(
      process.execPath,
      [lifecycleScript(resolvedRoot), action, "--root", resolvedRoot, ...extra],
      {
        cwd: resolvedRoot,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const parsed: unknown = JSON.parse(stdout);
    if (object(parsed) && object(parsed.error)) {
      const code = typeof parsed.error.code === "string" ? parsed.error.code : "lifecycle-read-failed";
      const status = code === "opportunity-not-found" ? 404 : 503;
      throw new LifecycleAdapterError(code, "The passive lifecycle read could not be completed.", status);
    }
    return parsed;
  } catch (error) {
    if (error instanceof LifecycleAdapterError) throw error;
    throw new LifecycleAdapterError("lifecycle-read-failed", "The passive lifecycle read could not be completed.", 503);
  }
}

export function readLifecycleContract(root: string): LifecycleContract {
  const result = run(root, "contract");
  validateContract(result);
  return result;
}

export function listOpportunityLifecycle(root: string): OpportunityListResult {
  const result = run(root, "list");
  if (!object(result) || !Array.isArray(result.opportunities) || !Array.isArray(result.warnings)) {
    throw new LifecycleAdapterError("invalid-lifecycle-list", "The lifecycle list is incompatible.", 503);
  }
  validateContract(result.contract);
  for (const opportunity of result.opportunities) validateOpportunity(opportunity);
  if (typeof result.revision !== "string") {
    throw new LifecycleAdapterError("invalid-lifecycle-list", "The lifecycle list is incompatible.", 503);
  }
  return result as OpportunityListResult;
}

export function readOpportunityLifecycle(root: string, opportunity: number): OpportunityDetailResult {
  if (!Number.isInteger(opportunity) || opportunity <= 0) {
    throw new LifecycleAdapterError("invalid-opportunity", "Opportunity must be a positive tracker number.", 400);
  }
  const result = run(root, "read", ["--opportunity", String(opportunity)]);
  if (!object(result) || !Array.isArray(result.attempts) || !Array.isArray(result.warnings)) {
    throw new LifecycleAdapterError("invalid-opportunity-detail", "The Opportunity detail is incompatible.", 503);
  }
  validateContract(result.contract);
  validateOpportunity(result.opportunity);
  if (typeof result.revision !== "string") {
    throw new LifecycleAdapterError("invalid-opportunity-detail", "The Opportunity detail is incompatible.", 503);
  }
  return result as OpportunityDetailResult;
}


import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CONTRACT_ID = "career-ops.opportunity-lifecycle";
const SUPPORTED_CONTRACT_VERSION = 1;
const LIFECYCLE_OWNERS = ["agent", "user", "external", "none"] as const;
const PRIMARY_ACTION_KINDS = ["generate", "act-outside", "wait", "terminal", "unavailable"] as const;
const ATTEMPT_ATTENTION_STATES = ["none", "unknown", "urgent", "review_due", "waiting", "cold"] as const;
const CANDIDACY_STATES = ["research-required", "suppressed", "primary", "eligible", "member", "not-coordinated"] as const;
const ARTIFACT_KINDS = ["approach-plan", "pdf", "report"] as const;
const ARTIFACT_STATES = ["available", "missing", "unavailable"] as const;
const ARTIFACT_FORMATS = ["canonical", "legacy", "unknown", "declared"] as const;

export type LifecycleOwner = (typeof LIFECYCLE_OWNERS)[number];
export type PrimaryActionKind = (typeof PRIMARY_ACTION_KINDS)[number];
export type AttemptAttentionState = (typeof ATTEMPT_ATTENTION_STATES)[number];
export type CandidacyState = (typeof CANDIDACY_STATES)[number];
export type ArtifactState = (typeof ARTIFACT_STATES)[number];
export type ArtifactFormat = (typeof ARTIFACT_FORMATS)[number];

type LifecycleStage = {
  id: string;
  label: string;
  owner: LifecycleOwner;
  suggests: string | null;
  producedBy: string | null;
  onDemand: string[];
  allowedSuccessors: string[];
  dashboardGroup: string;
  description: string;
};

type OpportunityStage = Omit<LifecycleStage, "id" | "owner" | "dashboardGroup"> & {
  id: string | null;
  owner: LifecycleOwner | null;
  dashboardGroup: string | null;
};

type ApproachAttempt = {
  id: string;
  opportunity: number;
  date: string;
  type: string;
  channel: string;
  recipient: string;
  result: string;
};

export type LifecycleContract = {
  id: typeof CONTRACT_ID;
  version: typeof SUPPORTED_CONTRACT_VERSION;
  stageSchemaVersion: number | null;
  capabilities: {
    passiveRead: boolean;
    focusedRead: boolean;
    generationRequest: boolean;
    attemptRecording: boolean;
    candidacyCoordination: boolean;
  };
  stages: LifecycleStage[];
  warnings: Array<Record<string, unknown>>;
  provenance: Array<Record<string, unknown>>;
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
  stage: OpportunityStage;
  primaryAction: { kind: PrimaryActionKind; id: string | null; enabled: boolean; reason: string | null };
  attemptAttention: {
    state: AttemptAttentionState;
    nextReview: string | null;
    followupCount?: number;
    latestAttemptId?: string | null;
  };
  attempts: {
    count: number;
    latest: ApproachAttempt | null;
    channels: string[];
    formalSubmitted: boolean;
  };
  artifacts: Array<{
    kind: (typeof ARTIFACT_KINDS)[number];
    state: ArtifactState;
    format: ArtifactFormat;
    path: string | null;
  }>;
  candidacy: {
    state: CandidacyState;
    reason: string | null;
    clusterId: string | null;
    primary: number | null;
    outreachAnchor: number | null;
  };
  warnings: Array<Record<string, unknown>>;
  provenance: Array<Record<string, unknown>>;
  capabilities: {
    passiveRead: boolean;
    generate: boolean;
    recordAttempt: boolean;
    reportSuccessor: boolean;
    openArtifacts: boolean;
  };
  contractVersion: typeof SUPPORTED_CONTRACT_VERSION;
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
  attempts: ApproachAttempt[];
  warnings: Array<Record<string, unknown>>;
  revision: string;
};

export class LifecycleAdapterError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || Number.isInteger(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecordArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(isRecord);
}

function hasBooleanKeys(value: unknown, keys: string[]): value is Record<string, boolean> {
  return isRecord(value) && keys.every((key) => typeof value[key] === "boolean");
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isLifecycleStage(value: unknown): value is LifecycleStage {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.label === "string"
    && isOneOf(value.owner, LIFECYCLE_OWNERS)
    && isNullableString(value.suggests)
    && isNullableString(value.producedBy)
    && isStringArray(value.onDemand)
    && isStringArray(value.allowedSuccessors)
    && typeof value.dashboardGroup === "string"
    && typeof value.description === "string";
}

function isOpportunityStage(value: unknown): value is OpportunityStage {
  return isRecord(value)
    && isNullableString(value.id)
    && typeof value.label === "string"
    && (value.owner === null || isOneOf(value.owner, LIFECYCLE_OWNERS))
    && isNullableString(value.suggests)
    && isNullableString(value.producedBy)
    && isStringArray(value.onDemand)
    && isStringArray(value.allowedSuccessors)
    && isNullableString(value.dashboardGroup)
    && typeof value.description === "string";
}

function isApproachAttempt(value: unknown): value is ApproachAttempt {
  return isRecord(value)
    && typeof value.id === "string"
    && Number.isInteger(value.opportunity)
    && typeof value.date === "string"
    && typeof value.type === "string"
    && typeof value.channel === "string"
    && typeof value.recipient === "string"
    && typeof value.result === "string";
}

function isPrimaryAction(value: unknown): value is OpportunitySummary["primaryAction"] {
  return isRecord(value)
    && isOneOf(value.kind, PRIMARY_ACTION_KINDS)
    && isNullableString(value.id)
    && typeof value.enabled === "boolean"
    && isNullableString(value.reason);
}

function isAttemptAttention(value: unknown): value is OpportunitySummary["attemptAttention"] {
  return isRecord(value)
    && isOneOf(value.state, ATTEMPT_ATTENTION_STATES)
    && isNullableString(value.nextReview)
    && (value.followupCount === undefined || Number.isInteger(value.followupCount))
    && (value.latestAttemptId === undefined || isNullableString(value.latestAttemptId));
}

function isAttemptAggregate(value: unknown): value is OpportunitySummary["attempts"] {
  return isRecord(value)
    && Number.isInteger(value.count)
    && (value.latest === null || isApproachAttempt(value.latest))
    && isStringArray(value.channels)
    && typeof value.formalSubmitted === "boolean";
}

function isArtifact(value: unknown): value is OpportunitySummary["artifacts"][number] {
  return isRecord(value)
    && isOneOf(value.kind, ARTIFACT_KINDS)
    && isOneOf(value.state, ARTIFACT_STATES)
    && isOneOf(value.format, ARTIFACT_FORMATS)
    && isNullableString(value.path);
}

function isCandidacy(value: unknown): value is OpportunitySummary["candidacy"] {
  return isRecord(value)
    && isOneOf(value.state, CANDIDACY_STATES)
    && isNullableString(value.reason)
    && isNullableString(value.clusterId)
    && isNullableInteger(value.primary)
    && isNullableInteger(value.outreachAnchor);
}

function validateContract(value: unknown): asserts value is LifecycleContract {
  if (
    !isRecord(value)
    || value.id !== CONTRACT_ID
    || value.version !== SUPPORTED_CONTRACT_VERSION
    || !isNullableInteger(value.stageSchemaVersion)
    || !hasBooleanKeys(value.capabilities, [
      "passiveRead",
      "focusedRead",
      "generationRequest",
      "attemptRecording",
      "candidacyCoordination",
    ])
    || !Array.isArray(value.stages)
    || !value.stages.every(isLifecycleStage)
    || !isRecordArray(value.warnings)
    || !isRecordArray(value.provenance)
    || typeof value.revision !== "string"
  ) {
    throw new LifecycleAdapterError("invalid-lifecycle-contract", "The lifecycle contract is incompatible.", 503);
  }
}

function validateOpportunity(value: unknown): asserts value is OpportunitySummary {
  const stringFields = ["date", "company", "via", "role", "location", "score", "pdf", "report", "notes", "rawStage"];
  if (
    !isRecord(value)
    || !Number.isInteger(value.opportunity)
    || !stringFields.every((field) => typeof value[field] === "string")
    || !isOpportunityStage(value.stage)
    || !isPrimaryAction(value.primaryAction)
    || !isAttemptAttention(value.attemptAttention)
    || !isAttemptAggregate(value.attempts)
    || !Array.isArray(value.artifacts)
    || !value.artifacts.every(isArtifact)
    || !isCandidacy(value.candidacy)
    || !isRecordArray(value.warnings)
    || !isRecordArray(value.provenance)
    || !hasBooleanKeys(value.capabilities, ["passiveRead", "generate", "recordAttempt", "reportSuccessor", "openArtifacts"])
    || value.contractVersion !== SUPPORTED_CONTRACT_VERSION
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
    if (isRecord(parsed) && isRecord(parsed.error)) {
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
  if (!isRecord(result) || !Array.isArray(result.opportunities) || !isRecordArray(result.warnings)) {
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
  if (!isRecord(result) || !Array.isArray(result.attempts) || !result.attempts.every(isApproachAttempt) || !isRecordArray(result.warnings)) {
    throw new LifecycleAdapterError("invalid-opportunity-detail", "The Opportunity detail is incompatible.", 503);
  }
  validateContract(result.contract);
  validateOpportunity(result.opportunity);
  if (typeof result.revision !== "string") {
    throw new LifecycleAdapterError("invalid-opportunity-detail", "The Opportunity detail is incompatible.", 503);
  }
  return result as OpportunityDetailResult;
}

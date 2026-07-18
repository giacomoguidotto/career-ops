import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CONTRACT_ID = "career-ops.opportunity-lifecycle";
const SUPPORTED_CONTRACT_VERSION = 1;
const LIFECYCLE_OWNERS = ["agent", "user", "external", "none"] as const;
const PRIMARY_ACTION_KINDS = ["generate", "act-outside", "wait", "terminal", "unavailable"] as const;
const ATTEMPT_ATTENTION_STATES = ["none", "unknown", "urgent", "review_due", "waiting", "cold"] as const;
const CANDIDACY_STATES = ["research-required", "suppressed", "primary", "eligible", "member", "not-coordinated"] as const;
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
  followUpTo: string | null;
  notes: string;
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
  rawFields?: Record<string, string>;
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
    kind: string;
    action: string | null;
    expectedAction: string | null;
    state: ArtifactState;
    format: ArtifactFormat;
    path: string | null;
    revision: string | null;
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

function isNullablePositiveInteger(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
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

function isIsoOccurrence(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = value.match(/^(\d{4}-\d{2}-\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/);
  if (!date) return false;
  const parsedDate = new Date(`${date[1]}T00:00:00Z`);
  if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== date[1]) return false;
  return !value.includes("T") || !Number.isNaN(Date.parse(value));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isApproachAttempt(value: unknown): value is ApproachAttempt {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.opportunity === "number"
    && Number.isSafeInteger(value.opportunity)
    && value.opportunity > 0
    && isIsoOccurrence(value.date)
    && typeof value.type === "string"
    && typeof value.channel === "string"
    && typeof value.recipient === "string"
    && typeof value.result === "string"
    && isNullableString(value.followUpTo)
    && typeof value.notes === "string";
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
    && (value.followupCount === undefined || isNonNegativeSafeInteger(value.followupCount))
    && (value.latestAttemptId === undefined || isNullableString(value.latestAttemptId));
}

function isAttemptAggregate(value: unknown): value is OpportunitySummary["attempts"] {
  return isRecord(value)
    && isNonNegativeSafeInteger(value.count)
    && (value.latest === null || isApproachAttempt(value.latest))
    && isStringArray(value.channels)
    && typeof value.formalSubmitted === "boolean";
}

function isArtifact(value: unknown): value is OpportunitySummary["artifacts"][number] {
  return isRecord(value)
    && typeof value.kind === "string"
    && /^[a-z][a-z0-9-]*$/.test(value.kind)
    && isNullableString(value.action)
    && isNullableString(value.expectedAction)
    && isOneOf(value.state, ARTIFACT_STATES)
    && isOneOf(value.format, ARTIFACT_FORMATS)
    && isNullableString(value.path)
    && isNullableString(value.revision);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isCandidacy(value: unknown): value is OpportunitySummary["candidacy"] {
  return isRecord(value)
    && isOneOf(value.state, CANDIDACY_STATES)
    && isNullableString(value.reason)
    && isNullableString(value.clusterId)
    && isNullablePositiveInteger(value.primary)
    && isNullablePositiveInteger(value.outreachAnchor);
}

function validateContract(value: unknown): asserts value is LifecycleContract {
  if (
    !isRecord(value)
    || value.id !== CONTRACT_ID
    || value.version !== SUPPORTED_CONTRACT_VERSION
    || !isNullablePositiveInteger(value.stageSchemaVersion)
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
    || typeof value.opportunity !== "number"
    || !Number.isSafeInteger(value.opportunity)
    || value.opportunity <= 0
    || !stringFields.every((field) => typeof value[field] === "string")
    || (value.rawFields !== undefined && !isStringRecord(value.rawFields))
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

async function run(root: string, action: "contract" | "list" | "read", extra: string[] = []): Promise<unknown> {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) {
    throw new LifecycleAdapterError("checkout-unavailable", "The career-ops checkout is unavailable.", 503);
  }
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [lifecycleScript(resolvedRoot), action, "--root", resolvedRoot, ...extra],
        {
          cwd: resolvedRoot,
          encoding: "utf8",
          timeout: 15_000,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, output) => error ? reject(error) : resolve(output),
      );
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new LifecycleAdapterError("invalid-lifecycle-output", "The lifecycle reader returned invalid output.", 503);
    }
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

export async function readLifecycleContract(root: string): Promise<LifecycleContract> {
  const result = await run(root, "contract");
  validateContract(result);
  return result;
}

export async function listOpportunityLifecycle(root: string): Promise<OpportunityListResult> {
  const result = await run(root, "list");
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

export async function tryListOpportunityLifecycle(root: string): Promise<OpportunityListResult | null> {
  try {
    return await listOpportunityLifecycle(root);
  } catch (error) {
    if (
      error instanceof LifecycleAdapterError
      && ["checkout-unavailable", "lifecycle-contract-unavailable", "lifecycle-read-failed"].includes(error.code)
    ) return null;
    throw error;
  }
}

export async function readOpportunityLifecycle(root: string, opportunity: number): Promise<OpportunityDetailResult> {
  if (!Number.isSafeInteger(opportunity) || opportunity <= 0) {
    throw new LifecycleAdapterError("invalid-opportunity", "Opportunity must be a positive tracker number.", 400);
  }
  const result = await run(root, "read", ["--opportunity", String(opportunity)]);
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

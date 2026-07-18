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

export type ApproachAttempt = {
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
    shared: boolean;
    surface: string | null;
    confidence: string | null;
    evidence: string | null;
    reviewed: string | null;
    recommendedLead: number | null;
    persistedPrimary: number | null;
    members: Array<{
      opportunity: number;
      role: string;
      stage: string | null;
      stageLabel: string;
      owner: LifecycleOwner | null;
      selection: string;
      reason: string | null;
    }>;
    research: {
      reason: string;
      applications: number[];
      unclassified: number[];
      multiplyClassified: number[];
      invalidClusters: Array<Record<string, unknown>>;
    } | null;
    canSelectPrimary: boolean;
    canReleasePrimary: boolean;
    canGenerateOnce: boolean;
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

export type LifecycleWorkOrder = {
  id: string;
  opportunity: number;
  action: string;
  source: { stage: string; revision: string };
  artifact: { kind: string; directory: "output/next-packs" };
  consequence: { stage: string; label: string };
  authorization?: {
    kind: "single-generation-exception";
    clusterId: string;
    opportunity: number;
  };
};

export type LifecycleCommandOutcome = {
  code: string;
  effect: "accepted" | "changed" | "unchanged" | "blocked" | "conflict" | "unavailable";
  retryable: boolean;
  message: string;
  before: OpportunitySummary | null;
  after: OpportunitySummary | null;
  artifacts: OpportunitySummary["artifacts"];
  workOrder: LifecycleWorkOrder | null;
  consequences: Record<string, unknown> | null;
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

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isIsoOccurrence(value: unknown): value is string {
  if (isIsoDate(value)) return true;
  if (typeof value !== "string") return false;
  const timestamp = value.match(/^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/);
  return Boolean(timestamp && isIsoDate(timestamp[1]) && !Number.isNaN(Date.parse(value)));
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

function isLifecycleWorkOrder(value: unknown): value is LifecycleWorkOrder {
  return isRecord(value)
    && typeof value.id === "string"
    && /^[a-f0-9]{64}$/.test(value.id)
    && typeof value.opportunity === "number"
    && Number.isSafeInteger(value.opportunity)
    && value.opportunity > 0
    && typeof value.action === "string"
    && /^[a-z][a-z0-9_]*$/.test(value.action)
    && isRecord(value.source)
    && typeof value.source.stage === "string"
    && /^[a-z][a-z0-9_]*$/.test(value.source.stage)
    && typeof value.source.revision === "string"
    && /^[a-f0-9]{64}$/.test(value.source.revision)
    && isRecord(value.artifact)
    && typeof value.artifact.kind === "string"
    && /^[a-z][a-z0-9-]*$/.test(value.artifact.kind)
    && value.artifact.directory === "output/next-packs"
    && isRecord(value.consequence)
    && typeof value.consequence.stage === "string"
    && /^[a-z][a-z0-9_]*$/.test(value.consequence.stage)
    && typeof value.consequence.label === "string"
    && (value.authorization === undefined || (
      isRecord(value.authorization)
      && value.authorization.kind === "single-generation-exception"
      && typeof value.authorization.clusterId === "string"
      && value.authorization.opportunity === value.opportunity
    ));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

const CANDIDACY_EXTENSION_KEYS = [
  "shared",
  "surface",
  "confidence",
  "evidence",
  "reviewed",
  "recommendedLead",
  "persistedPrimary",
  "members",
  "research",
  "canSelectPrimary",
  "canReleasePrimary",
  "canGenerateOnce",
] as const;

function normalizeCandidacy(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const hasExtension = CANDIDACY_EXTENSION_KEYS.some((key) => Object.hasOwn(value, key));
  if (hasExtension) return value;
  return {
    ...value,
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
  };
}

function normalizeOpportunity(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return { ...value, candidacy: normalizeCandidacy(value.candidacy) };
}

function normalizeCommandOutcome(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    before: value.before === null ? null : normalizeOpportunity(value.before),
    after: value.after === null ? null : normalizeOpportunity(value.after),
  };
}

function isCandidacy(value: unknown): value is OpportunitySummary["candidacy"] {
  return isRecord(value)
    && isOneOf(value.state, CANDIDACY_STATES)
    && isNullableString(value.reason)
    && isNullableString(value.clusterId)
    && isNullablePositiveInteger(value.primary)
    && isNullablePositiveInteger(value.outreachAnchor)
    && typeof value.shared === "boolean"
    && isNullableString(value.surface)
    && isNullableString(value.confidence)
    && isNullableString(value.evidence)
    && isNullableString(value.reviewed)
    && isNullablePositiveInteger(value.recommendedLead)
    && isNullablePositiveInteger(value.persistedPrimary)
    && Array.isArray(value.members)
    && value.members.every((member) => isRecord(member)
      && typeof member.opportunity === "number"
      && Number.isSafeInteger(member.opportunity)
      && member.opportunity > 0
      && typeof member.role === "string"
      && isNullableString(member.stage)
      && typeof member.stageLabel === "string"
      && (member.owner === null || isOneOf(member.owner, LIFECYCLE_OWNERS))
      && typeof member.selection === "string"
      && isNullableString(member.reason))
    && (value.research === null || (isRecord(value.research)
      && typeof value.research.reason === "string"
      && Array.isArray(value.research.applications)
      && value.research.applications.every((item) => Number.isSafeInteger(item) && item > 0)
      && Array.isArray(value.research.unclassified)
      && value.research.unclassified.every((item) => Number.isSafeInteger(item) && item > 0)
      && Array.isArray(value.research.multiplyClassified)
      && value.research.multiplyClassified.every((item) => Number.isSafeInteger(item) && item > 0)
      && isRecordArray(value.research.invalidClusters)))
    && typeof value.canSelectPrimary === "boolean"
    && typeof value.canReleasePrimary === "boolean"
    && typeof value.canGenerateOnce === "boolean";
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
  const stringFields = ["company", "via", "role", "location", "score", "pdf", "report", "notes", "rawStage"];
  if (
    !isRecord(value)
    || typeof value.opportunity !== "number"
    || !Number.isSafeInteger(value.opportunity)
    || value.opportunity <= 0
    || !isIsoDate(value.date)
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

async function run(
  root: string,
  action: "contract" | "list" | "read" | "request" | "reconcile" | "primary" | "attempt" | "successor",
  extra: string[] = [],
  input: string | null = null,
): Promise<unknown> {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) {
    throw new LifecycleAdapterError("checkout-unavailable", "The career-ops checkout is unavailable.", 503);
  }
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
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
      if (input !== null) child.stdin?.end(input);
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

function validateCommandOutcome(value: unknown): asserts value is LifecycleCommandOutcome {
  if (
    !isRecord(value)
    || typeof value.code !== "string"
    || !isOneOf(value.effect, ["accepted", "changed", "unchanged", "blocked", "conflict", "unavailable"] as const)
    || typeof value.retryable !== "boolean"
    || typeof value.message !== "string"
    || (value.before !== null && !isRecord(value.before))
    || (value.after !== null && !isRecord(value.after))
    || !Array.isArray(value.artifacts)
    || !value.artifacts.every(isArtifact)
    || (value.workOrder !== null && !isLifecycleWorkOrder(value.workOrder))
    || (value.consequences !== null && !isRecord(value.consequences))
  ) {
    throw new LifecycleAdapterError("invalid-lifecycle-command", "The lifecycle command response is incompatible.", 503);
  }
  if (value.before !== null) validateOpportunity(value.before);
  if (value.after !== null) validateOpportunity(value.after);
}

function commandArguments(opportunity: number, expectedStage: string, expectedRevision: string): string[] {
  if (!Number.isSafeInteger(opportunity) || opportunity <= 0) {
    throw new LifecycleAdapterError("invalid-opportunity", "Opportunity must be a positive tracker number.", 400);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(expectedStage) || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
    throw new LifecycleAdapterError("invalid-lifecycle-expectation", "The lifecycle expectation is invalid.", 400);
  }
  return [
    "--opportunity", String(opportunity),
    "--expected-stage", expectedStage,
    "--expected-revision", expectedRevision,
  ];
}

export async function setOpportunityPrimaryLifecycle(
  root: string,
  opportunity: number,
  expectedStage: string,
  expectedRevision: string,
  primary: number | null,
): Promise<LifecycleCommandOutcome> {
  const result = normalizeCommandOutcome(await run(root, "primary", [
    ...commandArguments(opportunity, expectedStage, expectedRevision),
    "--primary", primary == null ? "none" : String(primary),
  ]));
  validateCommandOutcome(result);
  return result;
}

export type AttemptConfirmation = {
  occurredAt: string;
  type: string;
  channel: string;
  recipient: string;
  result: string;
  followUpTo: string | null;
  notes: string;
};

export async function recordOpportunityAttemptLifecycle(
  root: string,
  opportunity: number,
  expectedStage: string,
  expectedRevision: string,
  attempt: AttemptConfirmation,
): Promise<LifecycleCommandOutcome> {
  const result = normalizeCommandOutcome(await run(root, "attempt", [
    ...commandArguments(opportunity, expectedStage, expectedRevision),
    "--attempt-stdin",
  ], JSON.stringify(attempt)));
  validateCommandOutcome(result);
  return result;
}

export async function reportOpportunitySuccessorLifecycle(
  root: string,
  opportunity: number,
  expectedStage: string,
  expectedRevision: string,
  successor: string,
): Promise<LifecycleCommandOutcome> {
  if (!/^[a-z][a-z0-9_]*$/.test(successor)) {
    throw new LifecycleAdapterError("invalid-successor", "Successor must be a canonical Stage id.", 400);
  }
  const result = normalizeCommandOutcome(await run(root, "successor", [
    ...commandArguments(opportunity, expectedStage, expectedRevision),
    "--successor", successor,
  ]));
  validateCommandOutcome(result);
  return result;
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
  const opportunities = result.opportunities.map(normalizeOpportunity);
  for (const opportunity of opportunities) validateOpportunity(opportunity);
  if (typeof result.revision !== "string") {
    throw new LifecycleAdapterError("invalid-lifecycle-list", "The lifecycle list is incompatible.", 503);
  }
  return { ...result, opportunities } as OpportunityListResult;
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
  const opportunitySummary = normalizeOpportunity(result.opportunity);
  validateOpportunity(opportunitySummary);
  if (
    opportunitySummary.opportunity !== opportunity
    || result.attempts.some((attempt) => attempt.opportunity !== opportunity)
  ) {
    throw new LifecycleAdapterError("invalid-opportunity-detail", "The Opportunity detail is incompatible.", 503);
  }
  if (typeof result.revision !== "string") {
    throw new LifecycleAdapterError("invalid-opportunity-detail", "The Opportunity detail is incompatible.", 503);
  }
  return { ...result, opportunity: opportunitySummary } as OpportunityDetailResult;
}

export async function requestOpportunityWork(
  root: string,
  expectation: {
    opportunity: number;
    expectedStage: string;
    expectedRevision: string;
    candidacyOverride?: true;
  },
): Promise<LifecycleCommandOutcome> {
  if (!Number.isSafeInteger(expectation.opportunity) || expectation.opportunity <= 0) {
    throw new LifecycleAdapterError("invalid-opportunity", "Opportunity must be a positive tracker number.", 400);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(expectation.expectedStage)) {
    throw new LifecycleAdapterError("invalid-expected-stage", "Expected Stage must be a canonical Stage id.", 400);
  }
  if (!/^[a-f0-9]{64}$/.test(expectation.expectedRevision)) {
    throw new LifecycleAdapterError("invalid-expected-revision", "Expected revision must be a lifecycle summary revision.", 400);
  }
  if (expectation.candidacyOverride !== undefined && expectation.candidacyOverride !== true) {
    throw new LifecycleAdapterError("invalid-candidacy-override", "Candidacy override must be the explicit one-generation authorization.", 400);
  }
  const result = normalizeCommandOutcome(await run(root, "request", [
    "--opportunity", String(expectation.opportunity),
    "--expected-stage", expectation.expectedStage,
    "--expected-revision", expectation.expectedRevision,
    ...(expectation.candidacyOverride ? ["--candidacy-override"] : []),
  ]));
  if (
    !isRecord(result)
    || typeof result.code !== "string"
    || !/^[a-z][a-z0-9-]*$/.test(result.code)
    || !isOneOf(result.effect, ["accepted", "changed", "unchanged", "blocked", "conflict", "unavailable"] as const)
    || typeof result.retryable !== "boolean"
    || typeof result.message !== "string"
    || (result.before !== null && !isRecord(result.before))
    || (result.after !== null && !isRecord(result.after))
    || !Array.isArray(result.artifacts)
    || !result.artifacts.every(isArtifact)
    || (result.workOrder !== null && !isLifecycleWorkOrder(result.workOrder))
  ) {
    throw new LifecycleAdapterError("invalid-lifecycle-command", "The lifecycle command result is incompatible.", 503);
  }
  if (result.before !== null) validateOpportunity(result.before);
  if (result.after !== null) validateOpportunity(result.after);
  if (result.workOrder && result.workOrder.opportunity !== expectation.opportunity) {
    throw new LifecycleAdapterError("invalid-lifecycle-command", "The lifecycle command result is incompatible.", 503);
  }
  return result as LifecycleCommandOutcome;
}

export async function reconcileOpportunityWork(
  root: string,
  expectation: {
    opportunity: number;
    expectedStage: string;
    expectedRevision: string;
  },
): Promise<LifecycleCommandOutcome> {
  const result = normalizeCommandOutcome(await run(root, "reconcile", commandArguments(
    expectation.opportunity,
    expectation.expectedStage,
    expectation.expectedRevision,
  )));
  validateCommandOutcome(result);
  return result;
}

#!/usr/bin/env node

/**
 * Passive Opportunity lifecycle contract.
 *
 * This module is the single deep read seam for lifecycle consumers. It derives
 * Stage behavior from templates/states.yml and tracker parsing from the shared
 * canonical readers. Passive functions in this module never write files or
 * start generation.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeNextFollowupDate,
  computeUrgency,
  daysBetween,
  parseAppliedDate,
  parseDate,
  parseNextOverrides,
  resolveCadenceConfig,
  resolveNextOverride,
} from './followup-cadence.mjs';
import { readApproachAttempts } from './approach-attempts.mjs';
import {
  decisionFromReport,
  decisionFromTrackerNotes,
  parseClusterRegistry,
  selectCandidacyCandidates,
} from './candidacy-select.mjs';
import { findPack, packArtifact } from './advance-stage.mjs';
import { loadTrackerHeaderAliases, resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { loadStates, resolveState } from './tracker-utils.mjs';

const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));
export const OPPORTUNITY_LIFECYCLE_CONTRACT_ID = 'career-ops.opportunity-lifecycle';
export const OPPORTUNITY_LIFECYCLE_CONTRACT_VERSION = 1;

function digest(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function checkoutRoot(root) {
  const candidate = resolve(root ?? MODULE_ROOT);
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new Error(`career-ops checkout root not found: ${candidate}`);
  }
  return candidate;
}

function relativePath(root, path) {
  return relative(root, path).split(sep).join('/');
}

function trackerPath(root) {
  const nested = join(root, 'data', 'applications.md');
  if (existsSync(nested)) return nested;
  const flat = join(root, 'applications.md');
  return existsSync(flat) ? flat : null;
}

function readTracker(root) {
  const path = trackerPath(root);
  if (!path) return { path: null, rows: [] };
  const lines = readFileSync(path, 'utf8').split('\n');
  const aliases = loadTrackerHeaderAliases(join(root, 'tracker-aliases.json'));
  const columns = resolveColumns(lines, aliases);
  return {
    path,
    rows: lines.map((line) => parseTrackerRow(line, columns)).filter(Boolean),
  };
}

function readOptional(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function nowDate(raw) {
  const value = raw ?? new Date().toISOString().slice(0, 10);
  const parsed = parseDate(value);
  if (!parsed || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`now must be a real ISO date: ${value}`);
  }
  return { value, parsed };
}

function publicStage(record) {
  return {
    id: record.id,
    label: record.label,
    owner: record.owner,
    suggests: record.suggests,
    producedBy: record.producedBy,
    onDemand: [...record.onDemand],
    allowedSuccessors: [...record.nextStates],
    dashboardGroup: record.group,
    description: record.description,
  };
}

function primaryAction(stage, enabled = true, disabledReason = null) {
  if (!stage) {
    return { kind: 'unavailable', id: null, enabled: false, reason: 'unknown-stage' };
  }
  if (stage.owner === 'agent') {
    return {
      kind: 'generate',
      id: stage.suggests,
      enabled: Boolean(stage.suggests) && enabled,
      reason: enabled ? null : disabledReason,
    };
  }
  if (stage.owner === 'user') {
    return { kind: 'act-outside', id: stage.suggests, enabled: false, reason: 'user-confirmation-required' };
  }
  if (stage.owner === 'external') {
    return { kind: 'wait', id: stage.suggests, enabled: false, reason: 'external-event-required' };
  }
  return { kind: 'terminal', id: null, enabled: false, reason: 'terminal-stage' };
}

function baseCapabilities({ stage, contract, candidacy, mayRecordAttempt, artifactWarnings }) {
  const generationBlocked = candidacy.state === 'suppressed'
    || candidacy.state === 'research-required'
    || artifactWarnings.some((warning) => warning.code === 'unknown-artifact-format');
  return {
    passiveRead: true,
    generate: Boolean(
      contract.capabilities.generationRequest
      && stage
      && stage.owner === 'agent'
      && stage.suggests
      && !generationBlocked,
    ),
    recordAttempt: Boolean(contract.capabilities.attemptRecording && mayRecordAttempt),
    reportSuccessor: Boolean(stage && stage.owner !== 'none' && stage.nextStates.length > 0),
    openArtifacts: true,
  };
}

function resolveDeclaredArtifact({ root, tracker, kind, cell }) {
  const match = String(cell ?? '').match(/\]\(([^)]+)\)/);
  if (!match || /^https?:/i.test(match[1])) return null;
  const absolute = resolve(dirname(tracker), match[1]);
  const path = relativePath(root, absolute);
  if (path === '..' || path.startsWith('../')) {
    return {
      kind,
      state: 'unavailable',
      format: 'unknown',
      path: null,
      warning: { code: 'artifact-path-outside-root', source: relativePath(root, tracker), disables: [] },
    };
  }
  return {
    kind,
    state: existsSync(absolute) ? 'available' : 'missing',
    format: 'declared',
    path,
    warning: existsSync(absolute)
      ? null
      : { code: 'artifact-missing', source: path, disables: [] },
  };
}

function readArtifacts({ root, tracker, row }) {
  const artifacts = [];
  const warnings = [];
  const pack = findPack(row.num, join(root, 'output', 'next-packs'));
  if (pack) {
    const content = readFileSync(pack.abs, 'utf8');
    const artifact = packArtifact(content);
    const canonical = /^\*\*Suggests:\*\*/m.test(content);
    const legacy = /^\*\*Action:\*\*/m.test(content);
    const format = artifact ? (canonical ? 'canonical' : legacy ? 'legacy' : 'unknown') : 'unknown';
    artifacts.push({
      kind: 'approach-plan',
      state: 'available',
      format,
      path: relativePath(root, pack.abs),
      suggests: artifact,
    });
    if (format === 'unknown') {
      warnings.push({
        code: 'unknown-artifact-format',
        source: relativePath(root, pack.abs),
        disables: ['generate'],
      });
    }
  }
  for (const [kind, cell] of [['pdf', row.pdf], ['report', row.report]]) {
    const artifact = resolveDeclaredArtifact({ root, tracker, kind, cell });
    if (!artifact) continue;
    artifacts.push({
      kind: artifact.kind,
      state: artifact.state,
      format: artifact.format,
      path: artifact.path,
    });
    if (artifact.warning) warnings.push(artifact.warning);
  }
  return { artifacts, warnings };
}

function attemptsForRow(attempts, num) {
  return attempts
    .filter((attempt) => attempt.opportunity === num)
    .sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id));
}

function deriveAttemptAttention({ row, stage, attempts, cadence, overrides, now }) {
  if (!stage || !['approached', 'responded', 'interview'].includes(stage.group)) {
    return { state: 'none', nextReview: null };
  }
  const latest = attempts.at(-1) ?? null;
  const appliedDate = latest?.date?.slice(0, 10) || parseAppliedDate(row.notes) || row.date;
  const applicationDate = parseDate(appliedDate);
  if (!applicationDate) return { state: 'unknown', nextReview: null };
  const followups = attempts.filter((attempt) => attempt.type === 'follow_up');
  const latestFollowupDate = followups.map((attempt) => attempt.date.slice(0, 10)).sort().at(-1) ?? null;
  const latestFollowup = latestFollowupDate ? parseDate(latestFollowupDate) : null;
  const daysSinceApplication = daysBetween(applicationDate, now.parsed);
  const daysSinceLastFollowup = latestFollowup ? daysBetween(latestFollowup, now.parsed) : null;
  let urgency = computeUrgency(
    stage.group,
    daysSinceApplication,
    daysSinceLastFollowup,
    followups.length,
    cadence,
  );
  let nextReview = computeNextFollowupDate(
    stage.group,
    appliedDate,
    latestFollowupDate,
    followups.length,
    cadence,
  );
  const override = resolveNextOverride(overrides.get(row.num), latestFollowupDate);
  if (override) {
    nextReview = override;
    urgency = override <= now.value ? 'overdue' : 'waiting';
  }
  return {
    state: urgency === 'overdue' ? 'review_due' : urgency,
    nextReview,
    followupCount: followups.length,
    latestAttemptId: latest?.id ?? null,
  };
}

function reportDecision(row, tracker, root) {
  const noteDecision = decisionFromTrackerNotes(row.notes);
  if (noteDecision !== 'unknown') return noteDecision;
  const artifact = resolveDeclaredArtifact({ root, tracker, kind: 'report', cell: row.report });
  if (!artifact?.path || artifact.state !== 'available') return 'unknown';
  return decisionFromReport(readFileSync(join(root, artifact.path), 'utf8'));
}

function readCandidacy({ root, tracker, rows, states }) {
  const registryPath = join(root, 'data', 'candidacy-clusters.md');
  const registry = readOptional(registryPath);
  const clusters = registry == null ? [] : parseClusterRegistry(registry);
  const decisions = new Map(rows.map((row) => [row.num, reportDecision(row, tracker, root)]));
  const selection = selectCandidacyCandidates({ rows, clusters, states, decisionByNum: decisions });
  return { registryPath: registry == null ? null : registryPath, selection };
}

function candidacyForRow(row, candidacy) {
  const { selection } = candidacy;
  const research = selection.researchRequired.find((item) => item.applications.includes(row.num));
  if (research) {
    return {
      state: 'research-required', reason: research.reason, clusterId: null,
      primary: null, outreachAnchor: null,
    };
  }
  const suppressed = selection.suppressed.find((item) => item.num === row.num);
  const cluster = selection.clusters.find((item) => item.members?.includes(row.num));
  if (suppressed) {
    return {
      state: 'suppressed',
      reason: suppressed.reason,
      clusterId: suppressed.clusterId,
      primary: suppressed.primary,
      outreachAnchor: cluster?.outreachAnchor ?? null,
    };
  }
  const eligible = selection.eligible.find((item) => item.num === row.num);
  if (eligible) {
    return {
      state: eligible.primary === row.num ? 'primary' : 'eligible',
      reason: null,
      clusterId: eligible.clusterId,
      primary: eligible.primary,
      outreachAnchor: cluster?.outreachAnchor ?? null,
    };
  }
  if (cluster) {
    const primary = cluster.effectivePrimary ?? cluster.storedPrimary ?? null;
    return {
      state: primary === row.num ? 'primary' : 'member',
      reason: null,
      clusterId: cluster.id,
      primary,
      outreachAnchor: cluster.outreachAnchor ?? null,
    };
  }
  return { state: 'not-coordinated', reason: null, clusterId: null, primary: null, outreachAnchor: null };
}

function opportunitySummary({ root, tracker, row, states, contract, attempts, cadence, overrides, candidacy, now }) {
  const stageRecord = resolveState(row.status, states);
  const stage = stageRecord ? publicStage(stageRecord) : {
    id: null,
    label: row.status,
    owner: null,
    suggests: null,
    producedBy: null,
    onDemand: [],
    allowedSuccessors: [],
    dashboardGroup: null,
    description: '',
  };
  const warnings = stageRecord ? [] : [{
    code: 'unknown-stage',
    source: relativePath(root, tracker),
    value: row.status,
    disables: ['generate', 'recordAttempt', 'reportSuccessor'],
  }];
  const provenance = [
    {
      kind: 'tracker',
      path: relativePath(root, tracker),
      fields: ['opportunity', 'date', 'company', 'role', 'score', 'stage', 'pdf', 'report', 'notes'],
    },
    {
      kind: 'stage-contract',
      path: relativePath(root, states.path),
      fields: ['stage.id', 'stage.label', 'stage.owner', 'stage.suggests', 'stage.allowedSuccessors'],
    },
  ];
  const rowAttempts = attemptsForRow(attempts, row.num);
  const artifactState = readArtifacts({ root, tracker, row });
  warnings.push(...artifactState.warnings);
  const candidacyState = candidacyForRow(row, candidacy);
  if (candidacy.registryPath) {
    provenance.push({
      kind: 'candidacy-registry',
      path: relativePath(root, candidacy.registryPath),
      fields: ['candidacy'],
    });
  }
  if (rowAttempts.length > 0) {
    provenance.push({
      kind: 'approach-attempts',
      path: 'data/approach-attempts.md',
      fields: ['attemptAttention', 'attempts'],
    });
  }
  if (artifactState.artifacts.length > 0) {
    provenance.push({
      kind: 'artifacts',
      path: 'output/next-packs',
      fields: ['artifacts'],
    });
  }
  const approachedStage = states.records.find(
    (candidate) => candidate.owner === 'external' && candidate.onDemand.includes('review_approach'),
  );
  const mayRecordAttempt = Boolean(
    stageRecord
    && approachedStage
    && (stageRecord.id === approachedStage.id || stageRecord.nextStates.includes(approachedStage.id)),
  );
  const capabilities = baseCapabilities({
    stage: stageRecord,
    contract,
    candidacy: candidacyState,
    mayRecordAttempt,
    artifactWarnings: artifactState.warnings,
  });
  const actionDisabledReason = candidacyState.state === 'suppressed'
    ? 'candidacy-suppressed'
    : candidacyState.state === 'research-required'
      ? 'candidacy-research-required'
      : artifactState.warnings.some((warning) => warning.code === 'unknown-artifact-format')
        ? 'unknown-artifact-format'
        : 'capability-unavailable';
  const summary = {
    opportunity: row.num,
    date: row.date,
    company: row.company,
    via: row.via ?? '',
    role: row.role,
    location: row.location ?? '',
    score: row.score,
    pdf: row.pdf,
    report: row.report,
    notes: row.notes,
    rawStage: row.status,
    stage,
    primaryAction: primaryAction(stageRecord, capabilities.generate, actionDisabledReason),
    attemptAttention: deriveAttemptAttention({
      row,
      stage: stageRecord,
      attempts: rowAttempts,
      cadence,
      overrides,
      now,
    }),
    attempts: {
      count: rowAttempts.length,
      latest: rowAttempts.at(-1) ?? null,
      channels: [...new Set(rowAttempts.map((attempt) => attempt.channel).filter(Boolean))].sort(),
      formalSubmitted: rowAttempts.some((attempt) => attempt.type === 'formal_application'),
    },
    artifacts: artifactState.artifacts,
    candidacy: candidacyState,
    warnings,
    provenance,
    capabilities,
    contractVersion: contract.version,
  };
  return { ...summary, revision: digest(summary) };
}

export function readOpportunityContract(options = {}) {
  const root = checkoutRoot(options.root);
  const states = loadStates({ rootDir: root, force: true });
  const stages = states.records.map(publicStage);
  const contract = {
    id: OPPORTUNITY_LIFECYCLE_CONTRACT_ID,
    version: OPPORTUNITY_LIFECYCLE_CONTRACT_VERSION,
    stageSchemaVersion: states.version,
    capabilities: {
      passiveRead: true,
      focusedRead: true,
      generationRequest: existsSync(join(root, 'advance-stage.mjs')),
      attemptRecording: existsSync(join(root, 'approach-attempts.mjs')),
      candidacyCoordination: existsSync(join(root, 'candidacy-select.mjs')),
    },
    stages,
    warnings: [],
    provenance: [{ kind: 'stage-contract', path: relativePath(root, states.path) }],
  };
  return { ...contract, revision: digest(contract) };
}

export function listOpportunities(options = {}) {
  const root = checkoutRoot(options.root);
  const now = nowDate(options.now);
  const states = loadStates({ rootDir: root, force: true });
  const contract = readOpportunityContract({ root });
  const tracker = readTracker(root);
  const warnings = tracker.path ? [] : [{ code: 'tracker-missing', source: 'data/applications.md' }];
  const attempts = readApproachAttempts(join(root, 'data', 'approach-attempts.md'));
  const cadence = resolveCadenceConfig({ profilePath: join(root, 'config', 'profile.yml') });
  const followups = readOptional(join(root, 'data', 'follow-ups.md')) ?? '';
  const overrides = parseNextOverrides(followups);
  const candidacy = tracker.path
    ? readCandidacy({ root, tracker: tracker.path, rows: tracker.rows, states })
    : { registryPath: null, selection: { eligible: [], suppressed: [], researchRequired: [], clusters: [], warnings: [] } };
  const opportunities = tracker.path
    ? tracker.rows.map((row) => opportunitySummary({
        root,
        tracker: tracker.path,
        row,
        states,
        contract,
        attempts,
        cadence,
        overrides,
        candidacy,
        now,
      }))
    : [];
  const result = { contract, opportunities, warnings: [...warnings, ...(candidacy.selection.warnings ?? [])] };
  return { ...result, revision: digest(result) };
}

export function readOpportunity(options = {}) {
  const opportunity = Number(options.opportunity);
  if (!Number.isInteger(opportunity) || opportunity <= 0) {
    throw new Error('opportunity must be a positive tracker number');
  }
  const root = checkoutRoot(options.root);
  const result = listOpportunities({ root, now: options.now });
  const summary = result.opportunities.find((item) => item.opportunity === opportunity) ?? null;
  if (!summary) return null;
  const attempts = readApproachAttempts(join(root, 'data', 'approach-attempts.md'))
    .filter((attempt) => attempt.opportunity === opportunity)
    .sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id));
  const focused = {
    contract: result.contract,
    opportunity: summary,
    attempts,
    warnings: summary.warnings,
  };
  return { ...focused, revision: digest(focused) };
}

function parseCliArgs(argv) {
  const [action, ...rest] = argv;
  if (!['contract', 'list', 'read'].includes(action)) {
    throw new Error('usage: opportunity-lifecycle.mjs <contract|list|read> [--root PATH] [--opportunity NUM] [--now YYYY-MM-DD]');
  }
  const options = { action, root: MODULE_ROOT, opportunity: null, now: null };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--root') options.root = rest[++index];
    else if (argument === '--opportunity') options.opportunity = rest[++index];
    else if (argument === '--now') options.now = rest[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.root) throw new Error('--root requires a path');
  if (action === 'read' && options.opportunity == null) throw new Error('read requires --opportunity NUM');
  return options;
}

function runCli() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    let result;
    if (options.action === 'contract') result = readOpportunityContract({ root: options.root });
    else if (options.action === 'list') result = listOpportunities({ root: options.root, now: options.now });
    else {
      result = readOpportunity({
        root: options.root,
        opportunity: options.opportunity,
        now: options.now,
      });
      if (!result) {
        result = {
          error: {
            code: 'opportunity-not-found',
            message: `Opportunity #${options.opportunity} was not found.`,
          },
        };
      }
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      error: { code: 'invalid-lifecycle-request', message: error.message },
    })}\n`);
    process.exitCode = 2;
  }
}

if (
  process.argv[1]
  && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
) runCli();

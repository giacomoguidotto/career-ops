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
  parseAppliedDate as parseLegacyApproachDate,
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
import { inspectColumns, loadTrackerHeaderAliases, parseTrackerRow } from './tracker-parse.mjs';
import { loadStates, resolveState } from './tracker-utils.mjs';

const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));
export const OPPORTUNITY_LIFECYCLE_CONTRACT_ID = 'career-ops.opportunity-lifecycle';
export const OPPORTUNITY_LIFECYCLE_CONTRACT_VERSION = 1;

function digest(value) {
  const input = typeof value === 'string' || value instanceof Uint8Array
    ? value
    : JSON.stringify(value);
  return createHash('sha256').update(input).digest('hex');
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

function isContained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

function trackerPath(root) {
  const nested = join(root, 'data', 'applications.md');
  if (existsSync(nested)) return nested;
  const flat = join(root, 'applications.md');
  return existsSync(flat) ? flat : null;
}

function readTracker(root) {
  const path = trackerPath(root);
  if (!path) return { path: null, rows: [], warnings: [] };
  const lines = readFileSync(path, 'utf8').split('\n');
  const aliases = loadTrackerHeaderAliases(join(root, 'tracker-aliases.json'));
  const inspection = inspectColumns(lines, aliases);
  if (inspection.format === 'unknown') {
    const rows = lines.slice((inspection.headerIndex ?? 0) + 2).map((line) => {
      if (!line.startsWith('|')) return null;
      const cells = line.split('|').map((cell) => cell.trim());
      const at = (key) => inspection.columns[key] == null ? '' : (cells[inspection.columns[key]] ?? '');
      const rawNum = at('num') || cells[1] || '';
      if (!/^\d+$/.test(rawNum)) return null;
      const num = Number(rawNum);
      if (!Number.isSafeInteger(num) || num <= 0) return null;
      const rawFields = Object.fromEntries(inspection.headers.map((header, index) => [header, cells[index + 1] ?? '']));
      return {
        num,
        date: at('date'),
        company: at('company'),
        role: at('role'),
        score: at('score'),
        status: at('status'),
        pdf: at('pdf'),
        report: at('report'),
        notes: at('notes'),
        location: at('location'),
        via: at('via'),
        rawFields,
        unknownTrackerFormat: true,
        raw: line,
      };
    }).filter(Boolean);
    return {
      path,
      rows,
      warnings: [{
        code: 'unknown-tracker-format',
        source: relativePath(root, path),
        headers: inspection.headers,
        disables: ['generate', 'recordAttempt', 'reportSuccessor'],
      }],
    };
  }
  return {
    path,
    rows: lines.map((line) => parseTrackerRow(line, inspection.columns)).filter(Boolean),
    warnings: [],
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
  const blockedActions = new Set(artifactWarnings.flatMap((warning) => warning.blocksActions ?? []));
  const generationBlocked = candidacy.state === 'suppressed'
    || candidacy.state === 'research-required'
    || (stage?.suggests && blockedActions.has(stage.suggests));
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

function actionArtifactKind(action) {
  const normalized = String(action ?? '').replace(/^generate_/, '').replace(/_/g, '-');
  return normalized || 'next-pack';
}

function predecessorAction(stage, states) {
  if (!stage) return null;
  if (stage.owner === 'agent') return stage.suggests;
  if (stage.owner !== 'user') return null;
  if (stage.producedBy) return stage.producedBy;
  const predecessors = states.records.filter(
    (candidate) => candidate.owner === 'agent' && candidate.nextStates.includes(stage.id),
  );
  return predecessors.length === 1 ? predecessors[0].suggests : null;
}

function generatedActionForPack(parsedAction, stage, states) {
  if (String(parsedAction ?? '').startsWith('generate_')) return parsedAction;
  const ready = states.records.find(
    (candidate) => candidate.owner === 'user' && candidate.suggests === parsedAction,
  );
  return predecessorAction(ready, states) || predecessorAction(stage, states) || parsedAction;
}

function inspectArtifactFile({ root, absolute, kind, format = 'declared', action = null, expectedAction = null }) {
  const canonicalRoot = realpathSync(root);
  const lexical = resolve(absolute);
  const publicBase = { kind, action, expectedAction, format, path: null, revision: null };
  if (!isContained(resolve(root), lexical)) {
    return {
      artifact: { ...publicBase, state: 'unavailable' },
      content: null,
      warning: { code: 'artifact-path-outside-root', source: relativePath(root, lexical), disables: [], blocksActions: [] },
    };
  }
  const path = relativePath(root, lexical);
  if (!existsSync(lexical)) {
    return {
      artifact: { ...publicBase, state: 'missing', path },
      content: null,
      warning: { code: 'artifact-missing', source: path, disables: [], blocksActions: [] },
    };
  }
  try {
    const canonical = realpathSync(lexical);
    if (!isContained(canonicalRoot, canonical)) {
      return {
        artifact: { ...publicBase, state: 'unavailable' },
        content: null,
        warning: { code: 'artifact-path-outside-root', source: path, disables: [], blocksActions: [] },
      };
    }
    if (!statSync(canonical).isFile()) {
      return {
        artifact: { ...publicBase, state: 'unavailable', path },
        content: null,
        warning: { code: 'artifact-not-file', source: path, disables: [], blocksActions: [] },
      };
    }
    const content = readFileSync(canonical);
    return {
      artifact: { ...publicBase, state: 'available', path, revision: digest(content) },
      content,
      warning: null,
    };
  } catch {
    return {
      artifact: { ...publicBase, state: 'unavailable', path },
      content: null,
      warning: { code: 'artifact-unreadable', source: path, disables: [], blocksActions: [] },
    };
  }
}

function resolveDeclaredArtifact({ root, tracker, kind, cell }) {
  const match = String(cell ?? '').match(/\]\(([^)]+)\)/);
  if (!match || /^https?:/i.test(match[1])) return null;
  return inspectArtifactFile({
    root,
    absolute: resolve(dirname(tracker), match[1]),
    kind,
  });
}

function readArtifacts({ root, tracker, row, stage, states }) {
  const artifacts = [];
  const warnings = [];
  const provenance = [];
  let reportContent = null;
  const expectedAction = predecessorAction(stage, states);
  let pack = null;
  try {
    pack = findPack(row.num, join(root, 'output', 'next-packs'));
  } catch {
    warnings.push({ code: 'artifact-directory-unreadable', source: 'output/next-packs', disables: [], blocksActions: [] });
  }
  if (pack) {
    const inspected = inspectArtifactFile({
      root,
      absolute: pack.abs,
      kind: actionArtifactKind(expectedAction),
      format: 'unknown',
      expectedAction,
    });
    let parsedAction = null;
    let generatedAction = expectedAction;
    if (inspected.content) {
      const content = inspected.content.toString('utf8');
      parsedAction = packArtifact(content);
      generatedAction = generatedActionForPack(parsedAction, stage, states);
      inspected.artifact.kind = actionArtifactKind(generatedAction);
      inspected.artifact.action = generatedAction;
      inspected.artifact.format = parsedAction
        ? /^\*\*Suggests:\*\*/m.test(content) ? 'canonical' : /^\*\*Action:\*\*/m.test(content) ? 'legacy' : 'unknown'
        : 'unknown';
      if (inspected.artifact.format === 'unknown') {
        warnings.push({
          code: 'unknown-artifact-format',
          source: inspected.artifact.path,
          disables: [],
          blocksActions: expectedAction ? [expectedAction] : [],
        });
      }
    }
    artifacts.push(inspected.artifact);
    if (inspected.warning) {
      warnings.push({
        ...inspected.warning,
        blocksActions: expectedAction ? [expectedAction] : [],
      });
    }
    if (inspected.artifact.path && inspected.artifact.state === 'available') {
      provenance.push({ kind: 'artifact', path: inspected.artifact.path, fields: ['artifacts'] });
    }
  } else if (expectedAction) {
    artifacts.push({
      kind: actionArtifactKind(expectedAction),
      action: expectedAction,
      expectedAction,
      state: 'missing',
      format: 'unknown',
      path: null,
      revision: null,
    });
  }
  for (const [kind, cell] of [['pdf', row.pdf], ['report', row.report]]) {
    const inspected = resolveDeclaredArtifact({ root, tracker, kind, cell });
    if (!inspected) continue;
    if (kind === 'report' && inspected.content) {
      reportContent = inspected.content.toString('utf8');
      inspected.artifact.format = /^## Machine Summary\b/m.test(reportContent) && /^\s*final_decision:/im.test(reportContent)
        ? 'canonical'
        : /^## Decision Snapshot\b/m.test(reportContent) && /^\*\*Decision:\*\*/m.test(reportContent)
          ? 'legacy'
          : 'unknown';
      if (inspected.artifact.format === 'unknown') {
        warnings.push({
          code: 'unknown-report-format',
          source: inspected.artifact.path,
          disables: [],
          blocksActions: stage?.owner === 'agent' && stage.suggests ? [stage.suggests] : [],
        });
      }
    }
    artifacts.push(inspected.artifact);
    if (inspected.artifact.path && inspected.artifact.state === 'available') {
      provenance.push({ kind: 'artifact', path: inspected.artifact.path, fields: ['artifacts'] });
    }
    if (inspected.warning) warnings.push(inspected.warning);
  }
  return { artifacts, warnings, provenance, reportContent };
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
  const approachDate = latest?.date?.slice(0, 10) || parseLegacyApproachDate(row.notes) || row.date;
  const parsedApproachDate = parseDate(approachDate);
  if (!parsedApproachDate) return { state: 'unknown', nextReview: null };
  const followups = attempts.filter((attempt) => attempt.type === 'follow_up');
  const latestFollowupDate = followups.map((attempt) => attempt.date.slice(0, 10)).sort().at(-1) ?? null;
  const latestFollowup = latestFollowupDate ? parseDate(latestFollowupDate) : null;
  const daysSinceApproach = daysBetween(parsedApproachDate, now.parsed);
  const daysSinceLastFollowup = latestFollowup ? daysBetween(latestFollowup, now.parsed) : null;
  let urgency = computeUrgency(
    stage.group,
    daysSinceApproach,
    daysSinceLastFollowup,
    followups.length,
    cadence,
  );
  let nextReview = computeNextFollowupDate(
    stage.group,
    approachDate,
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

function reportDecision(row, artifactState) {
  const noteDecision = decisionFromTrackerNotes(row.notes);
  if (noteDecision !== 'unknown') return noteDecision;
  return artifactState?.reportContent ? decisionFromReport(artifactState.reportContent) : 'unknown';
}

function readCandidacy({ root, rows, states, artifactByNum }) {
  const registryPath = join(root, 'data', 'candidacy-clusters.md');
  const registry = readOptional(registryPath);
  const clusters = registry == null ? [] : parseClusterRegistry(registry);
  const decisions = new Map(rows.map((row) => [row.num, reportDecision(row, artifactByNum.get(row.num))]));
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

function opportunitySummary({ root, tracker, row, states, contract, attempts, cadence, overrides, candidacy, now, artifactState }) {
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
  if (row.unknownTrackerFormat) {
    warnings.push({
      code: 'unknown-tracker-format',
      source: relativePath(root, tracker),
      disables: ['generate', 'recordAttempt', 'reportSuccessor'],
    });
  }
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
  warnings.push(...artifactState.warnings);
  provenance.push(...artifactState.provenance);
  const candidacyState = candidacyForRow(row, candidacy);
  provenance.push({
    kind: 'candidacy-authority',
    path: 'candidacy-select.mjs',
    fields: ['candidacy'],
  });
  if (candidacy.registryPath) {
    provenance.push({
      kind: 'candidacy-registry',
      path: relativePath(root, candidacy.registryPath),
      fields: ['candidacy'],
    });
  }
  if (existsSync(join(root, 'data', 'approach-attempts.md'))) {
    provenance.push({
      kind: 'approach-attempts',
      path: 'data/approach-attempts.md',
      fields: ['attemptAttention', 'attempts'],
    });
  }
  provenance.push({
    kind: 'cadence-authority',
    path: 'followup-cadence.mjs',
    fields: ['attemptAttention'],
  });
  if (existsSync(join(root, 'config', 'profile.yml'))) {
    provenance.push({
      kind: 'cadence-profile',
      path: 'config/profile.yml',
      fields: ['attemptAttention'],
    });
  }
  if (existsSync(join(root, 'data', 'follow-ups.md'))) {
    provenance.push({
      kind: 'cadence-overrides',
      path: 'data/follow-ups.md',
      fields: ['attemptAttention'],
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
    mayRecordAttempt: mayRecordAttempt && !row.unknownTrackerFormat,
    artifactWarnings: artifactState.warnings,
  });
  if (row.unknownTrackerFormat) {
    capabilities.generate = false;
    capabilities.recordAttempt = false;
    capabilities.reportSuccessor = false;
  }
  const artifactActionBlocked = artifactState.warnings.some(
    (warning) => (warning.blocksActions ?? []).includes(stageRecord?.suggests),
  );
  const actionDisabledReason = candidacyState.state === 'suppressed'
    ? 'candidacy-suppressed'
    : candidacyState.state === 'research-required'
      ? 'candidacy-research-required'
      : row.unknownTrackerFormat
        ? 'unknown-tracker-format'
        : artifactActionBlocked
          ? 'incompatible-artifact'
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
    ...(row.rawFields ? { rawFields: row.rawFields } : {}),
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
  return buildOpportunitySnapshot(options).result;
}

function buildOpportunitySnapshot(options = {}) {
  const root = checkoutRoot(options.root);
  const now = nowDate(options.now);
  const states = loadStates({ rootDir: root, force: true });
  const contract = readOpportunityContract({ root });
  const tracker = readTracker(root);
  const warnings = tracker.path
    ? [...tracker.warnings]
    : [{ code: 'tracker-missing', source: 'data/applications.md' }];
  const readAttempts = options.readAttempts ?? readApproachAttempts;
  const attempts = readAttempts(join(root, 'data', 'approach-attempts.md'));
  const cadence = resolveCadenceConfig({ profilePath: join(root, 'config', 'profile.yml') });
  const followups = readOptional(join(root, 'data', 'follow-ups.md')) ?? '';
  const overrides = parseNextOverrides(followups);
  const artifactByNum = new Map(tracker.path
    ? tracker.rows.map((row) => [
        row.num,
        readArtifacts({
          root,
          tracker: tracker.path,
          row,
          stage: resolveState(row.status, states),
          states,
        }),
      ])
    : []);
  const candidacy = tracker.path
    ? readCandidacy({ root, rows: tracker.rows, states, artifactByNum })
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
        artifactState: artifactByNum.get(row.num),
      }))
    : [];
  const result = { contract, opportunities, warnings: [...warnings, ...(candidacy.selection.warnings ?? [])] };
  return { result: { ...result, revision: digest(result) }, attempts };
}

export function readOpportunity(options = {}) {
  const rawOpportunity = options.opportunity;
  const opportunity = typeof rawOpportunity === 'string' && !/^\d+$/.test(rawOpportunity)
    ? Number.NaN
    : Number(rawOpportunity);
  if (!Number.isSafeInteger(opportunity) || opportunity <= 0) {
    throw new Error('opportunity must be a positive tracker number');
  }
  const root = checkoutRoot(options.root);
  const snapshot = buildOpportunitySnapshot({ root, now: options.now, readAttempts: options.readAttempts });
  const result = snapshot.result;
  const summary = result.opportunities.find((item) => item.opportunity === opportunity) ?? null;
  if (!summary) return null;
  const attempts = snapshot.attempts
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

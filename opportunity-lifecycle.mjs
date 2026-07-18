#!/usr/bin/env node

/**
 * Canonical Opportunity lifecycle contract and guarded command seam.
 *
 * This module is the single deep read seam for lifecycle consumers. It derives
 * Stage behavior from templates/states.yml and tracker parsing from the shared
 * canonical readers. Passive functions never write files or start generation;
 * explicit commands recheck revisions under the shared tracker lock.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
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
import {
  APPROACH_ATTEMPT_TYPES,
  readApproachAttempts,
  recordApproachAttempt,
} from './approach-attempts.mjs';
import {
  candidacyStageIsReleased,
  decisionFromReport,
  decisionFromTrackerNotes,
  parseClusterRegistry,
  selectCandidacyCandidates,
} from './candidacy-select.mjs';
import {
  applyStatusToLine,
  computeAdvance,
  findPack,
  packArtifact,
  syncPackHeader,
} from './advance-stage.mjs';
import { inspectColumns, loadTrackerHeaderAliases, parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import {
  acquireTrackerLock,
  loadStates,
  pairedReadyStage,
  resolveState,
  trackerLockDirFor,
  writeFileAtomic,
} from './tracker-utils.mjs';

const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));
export const OPPORTUNITY_LIFECYCLE_CONTRACT_ID = 'career-ops.opportunity-lifecycle';
export const OPPORTUNITY_LIFECYCLE_CONTRACT_VERSION = 1;
const WORK_STATE_VERSION = 1;
const DEFAULT_WORK_LEASE_MS = 30 * 60_000;

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

function reportableSuccessorIds(stage, states) {
  if (!stage || !['user', 'external'].includes(stage.owner)) return [];
  return stage.nextStates.filter((id) => {
    const successor = resolveState(id, states);
    return successor && !successor.onDemand.includes('review_approach');
  });
}

function baseCapabilities({ stage, states, contract, candidacy, mayRecordAttempt, artifactWarnings }) {
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
    reportSuccessor: reportableSuccessorIds(stage, states).length > 0,
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
    let actionMismatch = false;
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
      } else if (expectedAction && generatedAction !== expectedAction) {
        actionMismatch = true;
        warnings.push({
          code: 'stale-artifact-action',
          source: inspected.artifact.path,
          expectedAction,
          actualAction: generatedAction,
          disables: [],
          blocksActions: [expectedAction],
        });
      }
    }
    artifacts.push(inspected.artifact);
    if (actionMismatch) {
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

function readCandidacy({ root, rows, states, artifactByNum, now }) {
  const registryPath = join(root, 'data', 'candidacy-clusters.md');
  const registry = readOptional(registryPath);
  const clusters = registry == null ? [] : parseClusterRegistry(registry);
  const decisions = new Map(rows.map((row) => [row.num, reportDecision(row, artifactByNum.get(row.num))]));
  const selection = selectCandidacyCandidates({ rows, clusters, states, decisionByNum: decisions, now: now.value });
  return { registryPath: registry == null ? null : registryPath, clusters, rows, states, selection };
}

function candidacyForRow(row, candidacy) {
  const { selection } = candidacy;
  const research = selection.researchRequired.find((item) => item.applications.includes(row.num));
  const selectionCluster = selection.clusters.find((item) => item.members?.includes(row.num));
  const registryCluster = candidacy.clusters?.find((item) => item.id === selectionCluster?.id) ?? null;
  const memberRows = (selectionCluster?.members ?? research?.applications ?? [])
    .map((num) => candidacy.rows?.find((candidate) => candidate.num === num))
    .filter(Boolean);
  const members = memberRows.map((member) => {
    const stage = resolveState(member.status, candidacy.states);
    const eligible = selection.eligible.find((item) => item.num === member.num);
    const suppressed = selection.suppressed.find((item) => item.num === member.num);
    return {
      opportunity: member.num,
      role: member.role,
      stage: stage?.id ?? null,
      stageLabel: stage?.label ?? member.status,
      owner: stage?.owner ?? null,
      selection: suppressed ? 'suppressed' : eligible ? 'eligible' : 'not-agent-owned',
      reason: suppressed?.reason ?? null,
    };
  });
  const entryAgentStage = candidacy.states.records.find((stage) => stage.owner === 'agent') ?? null;
  const hasReservedMember = members.some((member) => (
    member.stage
    && !candidacyStageIsReleased(member.stage)
    && member.stage !== entryAgentStage?.id
  ));
  const details = {
    shared: Boolean(registryCluster && registryCluster.members.length > 1),
    surface: registryCluster?.surface ?? null,
    confidence: registryCluster?.confidence ?? null,
    evidence: registryCluster?.evidence ?? null,
    reviewed: registryCluster?.reviewed ?? null,
    recommendedLead: selectionCluster?.recommendedLead ?? null,
    persistedPrimary: selectionCluster?.storedPrimary ?? null,
    members,
    research: research ? {
      reason: research.reason,
      applications: research.applications,
      unclassified: research.unclassified,
      multiplyClassified: research.multiplyClassified,
      invalidClusters: research.invalidClusters,
    } : null,
    canSelectPrimary: false,
    canReleasePrimary: false,
    canGenerateOnce: false,
  };
  if (research) {
    return {
      state: 'research-required', reason: research.reason, clusterId: null,
      primary: null, outreachAnchor: null, ...details,
    };
  }
  const suppressed = selection.suppressed.find((item) => item.num === row.num);
  const cluster = selectionCluster;
  if (suppressed) {
    return {
      state: 'suppressed',
      reason: suppressed.reason,
      clusterId: suppressed.clusterId,
      primary: suppressed.primary,
      outreachAnchor: cluster?.outreachAnchor ?? null,
      ...details,
      canSelectPrimary: details.shared && !hasReservedMember,
      canReleasePrimary: details.shared && cluster?.storedPrimary === row.num,
    };
  }
  const eligible = selection.eligible.find((item) => item.num === row.num);
  if (eligible) {
    return {
      state: cluster?.storedPrimary === row.num ? 'primary' : 'eligible',
      reason: null,
      clusterId: eligible.clusterId,
      primary: eligible.primary,
      outreachAnchor: cluster?.outreachAnchor ?? null,
      ...details,
      canSelectPrimary: details.shared && !hasReservedMember && cluster?.storedPrimary !== row.num,
      canReleasePrimary: details.shared && cluster?.storedPrimary === row.num,
    };
  }
  if (cluster) {
    const primary = cluster.effectivePrimary ?? cluster.storedPrimary ?? null;
    const memberStage = resolveState(row.status, candidacy.states);
    const maySelectPrimary = memberStage?.owner === 'agent';
    return {
      state: primary === row.num ? 'primary' : 'member',
      reason: null,
      clusterId: cluster.id,
      primary,
      outreachAnchor: cluster.outreachAnchor ?? null,
      ...details,
      canSelectPrimary: details.shared && !hasReservedMember && maySelectPrimary && cluster.storedPrimary !== row.num,
      canReleasePrimary: details.shared && cluster.storedPrimary === row.num,
    };
  }
  return {
    state: 'not-coordinated', reason: null, clusterId: null, primary: null, outreachAnchor: null,
    ...details,
  };
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
    states,
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
  candidacyState.canGenerateOnce = Boolean(
    candidacyState.shared
    && candidacyState.state === 'suppressed'
    && candidacyState.reason !== 'accepted-primary'
    && stageRecord?.owner === 'agent'
    && stageRecord.suggests
    && contract.capabilities.generationRequest
    && !row.unknownTrackerFormat
    && !artifactState.warnings.some((warning) => (warning.blocksActions ?? []).includes(stageRecord.suggests)),
  );
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

function opportunityContract(root, states) {
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

export function readOpportunityContract(options = {}) {
  const root = checkoutRoot(options.root);
  const loadStageAuthority = options.loadStageAuthority ?? loadStates;
  const states = loadStageAuthority({ rootDir: root, force: true });
  return opportunityContract(root, states);
}

export function listOpportunities(options = {}) {
  return buildOpportunitySnapshot(options).result;
}

function buildOpportunitySnapshot(options = {}) {
  const root = checkoutRoot(options.root);
  const now = nowDate(options.now);
  const loadStageAuthority = options.loadStageAuthority ?? loadStates;
  const states = loadStageAuthority({ rootDir: root, force: true });
  const contract = opportunityContract(root, states);
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
    ? readCandidacy({ root, rows: tracker.rows, states, artifactByNum, now })
    : {
        registryPath: null,
        clusters: [],
        rows: [],
        states,
        selection: { eligible: [], suppressed: [], researchRequired: [], clusters: [], warnings: [] },
      };
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
  const snapshot = buildOpportunitySnapshot({
    root,
    now: options.now,
    readAttempts: options.readAttempts,
    loadStageAuthority: options.loadStageAuthority,
  });
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

const COMMAND_EFFECTS = new Set(['accepted', 'changed', 'unchanged', 'blocked', 'conflict', 'unavailable']);

function commandOutcome({
  code, effect, retryable, message, before = null, after = before, artifacts = [], workOrder = null, consequences = null,
}) {
  if (!COMMAND_EFFECTS.has(effect)) throw new Error(`invalid lifecycle command effect: ${effect}`);
  return { code, effect, retryable, message, before, after, artifacts, workOrder, consequences };
}

function parseCommandExpectation(options) {
  const rawOpportunity = options.opportunity;
  const opportunity = typeof rawOpportunity === 'string' && !/^\d+$/.test(rawOpportunity)
    ? Number.NaN
    : Number(rawOpportunity);
  if (!Number.isSafeInteger(opportunity) || opportunity <= 0) {
    throw new Error('opportunity must be a positive tracker number');
  }
  if (typeof options.expectedStage !== 'string' || !/^[a-z][a-z0-9_]*$/.test(options.expectedStage)) {
    throw new Error('expectedStage must be a canonical Stage id');
  }
  if (typeof options.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedRevision)) {
    throw new Error('expectedRevision must be a lifecycle summary revision');
  }
  return { opportunity, expectedStage: options.expectedStage, expectedRevision: options.expectedRevision };
}

function expectationConflict(summary, expected) {
  return summary.stage.id !== expected.expectedStage || summary.revision !== expected.expectedRevision;
}

function commandArtifacts(summary) {
  return summary?.artifacts?.map(({ kind, action, expectedAction, state, format, path, revision }) => ({
    kind, action, expectedAction, state, format, path, revision,
  })) ?? [];
}

function workOrderFor(summary, states, authorization = null) {
  const stage = resolveState(summary.rawStage, states);
  const ready = stage ? pairedReadyStage(stage, states, stage.suggests) : null;
  if (!stage || stage.owner !== 'agent' || !stage.suggests || !ready) return null;
  const kind = actionArtifactKind(stage.suggests);
  const id = digest({ opportunity: summary.opportunity, stage: stage.id, action: stage.suggests });
  return {
    id,
    opportunity: summary.opportunity,
    action: stage.suggests,
    source: { stage: stage.id, revision: summary.revision },
    artifact: { kind, directory: 'output/next-packs' },
    consequence: { stage: ready.id, label: ready.label },
    ...(authorization ? { authorization } : {}),
  };
}

function workStatePath(root, workOrder) {
  return join(root, '.career-ops-web', 'lifecycle-work', `${workOrder.id}.json`);
}

function hasExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function validWorkOrder(value) {
  const keys = ['id', 'opportunity', 'action', 'source', 'artifact', 'consequence'];
  const validKeys = hasExactKeys(value, keys) || hasExactKeys(value, [...keys, 'authorization']);
  const validAuthorization = value?.authorization === undefined || (
    hasExactKeys(value.authorization, ['kind', 'clusterId', 'opportunity'])
    && value.authorization.kind === 'single-generation-exception'
    && typeof value.authorization.clusterId === 'string'
    && Number.isSafeInteger(value.authorization.opportunity)
    && value.authorization.opportunity === value.opportunity
  );
  return validKeys
    && validAuthorization
    && typeof value.id === 'string'
    && /^[a-f0-9]{64}$/.test(value.id)
    && Number.isSafeInteger(value.opportunity)
    && value.opportunity > 0
    && typeof value.action === 'string'
    && hasExactKeys(value.source, ['stage', 'revision'])
    && typeof value.source.stage === 'string'
    && /^[a-f0-9]{64}$/.test(value.source.revision)
    && hasExactKeys(value.artifact, ['kind', 'directory'])
    && typeof value.artifact.kind === 'string'
    && value.artifact.directory === 'output/next-packs'
    && hasExactKeys(value.consequence, ['stage', 'label'])
    && typeof value.consequence.stage === 'string'
    && typeof value.consequence.label === 'string';
}

function validWorkState(value) {
  return hasExactKeys(value, ['version', 'id', 'status', 'lease', 'workOrder'])
    && value.version === WORK_STATE_VERSION
    && value.status === 'active'
    && typeof value.id === 'string'
    && hasExactKeys(value.lease, ['owner', 'acquiredAt', 'expiresAt'])
    && typeof value.lease.owner === 'string'
    && value.lease.owner.length > 0
    && typeof value.lease.acquiredAt === 'string'
    && Number.isFinite(Date.parse(value.lease.acquiredAt))
    && typeof value.lease.expiresAt === 'string'
    && Number.isFinite(Date.parse(value.lease.expiresAt))
    && Date.parse(value.lease.expiresAt) > Date.parse(value.lease.acquiredAt)
    && validWorkOrder(value.workOrder)
    && value.workOrder.id === value.id;
}

function readWorkState(path, canonicalWorkOrder = null, nowMs = Date.now()) {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!validWorkState(value)) return { invalid: true };
    if (canonicalWorkOrder) {
      const { authorization: _storedAuthorization, ...storedCanonical } = value.workOrder;
      const { authorization: _requestedAuthorization, ...requestedCanonical } = canonicalWorkOrder;
      if (digest(storedCanonical) !== digest(requestedCanonical)) return { invalid: true };
    }
    if (Date.parse(value.lease.expiresAt) <= nowMs) return { stale: true };
    return value;
  } catch {
    return { invalid: true };
  }
}

function sameWorkOrderForReconciliation(stored, current) {
  if (!validWorkOrder(stored) || !validWorkOrder(current)) return false;
  const normalize = (workOrder) => {
    const { authorization: _authorization, ...canonical } = workOrder;
    return { ...canonical, source: { ...canonical.source, revision: null } };
  };
  return digest(normalize(stored)) === digest(normalize(current));
}

function writeWorkState(root, workOrder, nowMs, leaseMs) {
  const path = workStatePath(root, workOrder);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify({
    version: WORK_STATE_VERSION,
    id: workOrder.id,
    status: 'active',
    lease: {
      owner: `pid:${process.pid}`,
      acquiredAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + leaseMs).toISOString(),
    },
    workOrder,
  }, null, 2)}\n`);
}

function workClock(options) {
  const nowMs = options.nowMs ?? Date.now();
  const leaseMs = options.workLeaseMs ?? DEFAULT_WORK_LEASE_MS;
  if (!Number.isFinite(nowMs) || nowMs < 0) throw new Error('nowMs must be a non-negative timestamp');
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('workLeaseMs must be positive');
  return { nowMs, leaseMs };
}

async function withLifecycleLock(root, options, command) {
  const tracker = trackerPath(root);
  if (!tracker) {
    return commandOutcome({
      code: 'tracker-unavailable', effect: 'unavailable', retryable: false,
      message: 'The Opportunity tracker is unavailable.',
    });
  }
  let lock;
  try {
    lock = await acquireTrackerLock(trackerLockDirFor(tracker), {
      timeoutMs: options.lockTimeoutMs ?? (Number(process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS) || 60_000),
      retryMs: options.lockRetryMs ?? (Number(process.env.CAREER_OPS_TRACKER_LOCK_RETRY_MS) || 75),
      staleMs: options.lockStaleMs ?? (Number(process.env.CAREER_OPS_TRACKER_LOCK_STALE_MS) || 10 * 60_000),
      tracker,
    });
  } catch (error) {
    if (error?.code === 'LOCK_TIMEOUT') {
      return commandOutcome({
        code: 'tracker-busy', effect: 'unavailable', retryable: true,
        message: 'The Opportunity tracker is busy. Retry after the active write finishes.',
      });
    }
    return commandOutcome({
      code: 'tracker-lock-failed', effect: 'unavailable', retryable: false,
      message: 'The Opportunity tracker lock could not be acquired.',
    });
  }
  try {
    return await command(tracker);
  } finally {
    lock.release();
  }
}

function conflictOutcome(summary) {
  return commandOutcome({
    code: 'opportunity-conflict', effect: 'conflict', retryable: false,
    message: 'The Opportunity changed. Review the fresh summary before retrying.',
    before: summary, after: summary, artifacts: commandArtifacts(summary),
  });
}

function parseAttemptConfirmation(options) {
  const attempt = options.attempt;
  if (!attempt || typeof attempt !== 'object' || Array.isArray(attempt)) {
    throw new Error('attempt must be a typed Approach Attempt');
  }
  const allowed = new Set(['occurredAt', 'type', 'channel', 'recipient', 'result', 'followUpTo', 'notes']);
  if (Object.keys(attempt).some((key) => !allowed.has(key))) {
    throw new Error('attempt contains unsupported fields');
  }
  for (const field of ['occurredAt', 'type', 'channel', 'recipient', 'result']) {
    if (typeof attempt[field] !== 'string' || !attempt[field].trim()) {
      throw new Error(`attempt.${field} is required`);
    }
  }
  if (!APPROACH_ATTEMPT_TYPES.has(attempt.type)) {
    throw new Error(`unsupported approach type: ${attempt.type}`);
  }
  const followUpTo = attempt.followUpTo == null || attempt.followUpTo === '' ? null : attempt.followUpTo;
  if (followUpTo !== null && (typeof followUpTo !== 'string' || !/^A\d+$/.test(followUpTo))) {
    throw new Error('attempt.followUpTo must be a canonical Attempt id or null');
  }
  if (attempt.type === 'follow_up' && !followUpTo) {
    throw new Error('attempt.followUpTo is required for a follow-up Attempt');
  }
  if (attempt.type !== 'follow_up' && followUpTo) {
    throw new Error('attempt.followUpTo is valid only for a follow-up Attempt');
  }
  if (attempt.notes !== undefined && typeof attempt.notes !== 'string') {
    throw new Error('attempt.notes must be a string');
  }
  return {
    occurredAt: attempt.occurredAt,
    type: attempt.type,
    channel: attempt.channel,
    recipient: attempt.recipient,
    result: attempt.result,
    followUpTo,
    notes: attempt.notes ?? '',
  };
}

function sameConfirmedAttempt(left, right) {
  const normalized = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return left.date === right.occurredAt
    && normalized(left.type) === normalized(right.type)
    && normalized(left.channel) === normalized(right.channel)
    && normalized(left.recipient) === normalized(right.recipient)
    && normalized(left.result) === normalized(right.result)
    && normalized(left.followUpTo) === normalized(right.followUpTo);
}

/**
 * Append one explicitly confirmed Approach Attempt, then repair the canonical
 * Stage when this is the first Attempt. The Attempt writer stays authoritative
 * for validation, id allocation, append-only persistence, and retry repair.
 */
export async function recordOpportunityAttempt(options = {}) {
  const expected = parseCommandExpectation(options);
  const attempt = parseAttemptConfirmation(options);
  const root = checkoutRoot(options.root);
  return withLifecycleLock(root, options, async (tracker) => {
    const focused = readOpportunity({ root, opportunity: expected.opportunity, now: options.now });
    if (!focused) {
      return commandOutcome({
        code: 'opportunity-not-found', effect: 'unavailable', retryable: false,
        message: 'The Opportunity was not found.',
      });
    }
    const before = focused.opportunity;
    if (expectationConflict(before, expected)) return conflictOutcome(before);
    if (!before.capabilities.recordAttempt) {
      return commandOutcome({
        code: 'attempt-recording-blocked', effect: 'blocked', retryable: false,
        message: 'An Approach Attempt cannot be recorded from the current Stage.',
        before, artifacts: commandArtifacts(before),
      });
    }

    const writerOptions = {
      appsFile: tracker,
      attemptsFile: join(root, 'data', 'approach-attempts.md'),
      rootDir: root,
      lockHeld: true,
      opportunity: expected.opportunity,
      date: attempt.occurredAt,
      type: attempt.type,
      channel: attempt.channel,
      recipient: attempt.recipient,
      result: attempt.result,
      followUpTo: attempt.followUpTo,
      notes: attempt.notes,
    };
    try {
      await recordApproachAttempt({ ...writerOptions, dryRun: true });
    } catch {
      return commandOutcome({
        code: 'attempt-confirmation-invalid', effect: 'blocked', retryable: false,
        message: 'The typed Attempt is incomplete or incompatible with current canonical history.',
        before, artifacts: commandArtifacts(before),
      });
    }

    let recorded;
    try {
      recorded = await recordApproachAttempt({
        ...writerOptions,
        onMutationStep: options.onMutationStep,
      });
    } catch (error) {
      const failedDetail = readOpportunity({ root, opportunity: expected.opportunity, now: options.now });
      const afterFailure = failedDetail?.opportunity ?? before;
      const appended = Boolean(
        failedDetail?.attempts.some((candidate) => sameConfirmedAttempt(candidate, attempt)),
      );
      return commandOutcome({
        code: appended ? 'attempt-stage-repair-required' : 'attempt-write-failed',
        effect: 'unavailable',
        retryable: true,
        message: appended
          ? 'The Attempt was appended, but Stage repair did not finish. Retry from the fresh Opportunity summary.'
          : 'The confirmed Attempt could not be recorded. Retry after reviewing the current Opportunity.',
        before,
        after: afterFailure,
        artifacts: commandArtifacts(afterFailure),
        consequences: appended ? { kind: 'approach-attempt', appended: true, stageRepairRequired: true } : null,
      });
    }
    const after = readOpportunity({ root, opportunity: expected.opportunity, now: options.now })?.opportunity ?? before;
    return commandOutcome({
      code: recorded.reason === 'duplicate' ? 'attempt-unchanged' : 'attempt-recorded',
      effect: recorded.changed ? 'changed' : 'unchanged',
      retryable: false,
      message: recorded.reason === 'repaired-stage'
        ? 'The existing confirmed Attempt repaired the Opportunity Stage.'
        : recorded.reason === 'duplicate'
          ? 'This confirmed Attempt is already in append-only history.'
          : 'The confirmed Attempt was added to append-only history.',
      before,
      after,
      artifacts: commandArtifacts(after),
      consequences: {
        kind: 'approach-attempt',
        attempt: recorded.attempt,
        stageRepaired: recorded.oldStage !== recorded.newStage,
      },
    });
  });
}

/** Record a non-Attempt real-world event only through a fresh allowed successor. */
export async function reportOpportunitySuccessor(options = {}) {
  const expected = parseCommandExpectation(options);
  if (typeof options.successor !== 'string' || !/^[a-z][a-z0-9_]*$/.test(options.successor)) {
    throw new Error('successor must be a canonical Stage id');
  }
  const root = checkoutRoot(options.root);
  return withLifecycleLock(root, options, async (tracker) => {
    const focused = readOpportunity({ root, opportunity: expected.opportunity, now: options.now });
    if (!focused) {
      return commandOutcome({
        code: 'opportunity-not-found', effect: 'unavailable', retryable: false,
        message: 'The Opportunity was not found.',
      });
    }
    const before = focused.opportunity;
    if (expectationConflict(before, expected)) return conflictOutcome(before);
    const states = loadStates({ rootDir: root, force: true });
    const current = resolveState(before.rawStage, states);
    const successor = resolveState(options.successor, states);
    if (!before.capabilities.reportSuccessor || !successor || !reportableSuccessorIds(current, states).includes(successor.id)) {
      return commandOutcome({
        code: 'successor-report-blocked', effect: 'blocked', retryable: false,
        message: 'That reported event is not an allowed successor of the current Stage.',
        before, artifacts: commandArtifacts(before),
      });
    }
    if (successor.id === current.id) {
      return commandOutcome({
        code: 'successor-unchanged', effect: 'unchanged', retryable: false,
        message: 'The reported event keeps the Opportunity at its current Stage.',
        before, artifacts: commandArtifacts(before),
        consequences: { kind: 'world-stage-event', successor: successor.id },
      });
    }
    const replacement = prepareTrackerStageReplacement(tracker, before.opportunity, successor.label);
    if (!replacement.ok) {
      return commandOutcome({
        code: replacement.reason, effect: 'unavailable', retryable: false,
        message: 'The Opportunity tracker row could not be updated safely.',
        before, artifacts: commandArtifacts(before),
      });
    }
    try {
      writeFileAtomic(tracker, replacement.content);
    } catch {
      return commandOutcome({
        code: 'successor-write-failed', effect: 'unavailable', retryable: true,
        message: 'The reported event was not recorded.',
        before, artifacts: commandArtifacts(before),
      });
    }
    const after = readOpportunity({ root, opportunity: expected.opportunity, now: options.now })?.opportunity ?? before;
    return commandOutcome({
      code: 'successor-recorded', effect: 'changed', retryable: false,
      message: `The confirmed event advanced the Opportunity to ${successor.label}.`,
      before, after, artifacts: commandArtifacts(after),
      consequences: { kind: 'world-stage-event', successor: successor.id },
    });
  });
}

/**
 * Reserve one explicit Agent-owned generation request without changing Stage.
 * The shared tracker lock makes the revision recheck and active-work claim one
 * critical section, so simultaneous requests cannot fork duplicate workers.
 */
export async function requestOpportunityWork(options = {}) {
  const expected = parseCommandExpectation(options);
  const root = checkoutRoot(options.root);
  const clock = workClock(options);
  return withLifecycleLock(root, options, async () => {
    const focused = readOpportunity({ root, opportunity: expected.opportunity, now: options.now });
    if (!focused) {
      return commandOutcome({
        code: 'opportunity-not-found', effect: 'unavailable', retryable: false,
        message: 'The Opportunity was not found.',
      });
    }
    const before = focused.opportunity;
    if (expectationConflict(before, expected)) return conflictOutcome(before);
    const candidacyOverride = options.candidacyOverride === true;
    const overrideAllowed = candidacyOverride && before.candidacy.canGenerateOnce;
    if (
      before.stage.owner !== 'agent'
      || (candidacyOverride ? !overrideAllowed : !before.capabilities.generate)
    ) {
      return commandOutcome({
        code: 'generation-blocked', effect: 'blocked', retryable: false,
        message: 'Generation is not available for the current Opportunity state.',
        before, artifacts: commandArtifacts(before),
      });
    }

    const states = loadStates({ rootDir: root, force: true });
    const workOrder = workOrderFor(before, states, overrideAllowed ? {
      kind: 'single-generation-exception',
      clusterId: before.candidacy.clusterId,
      opportunity: before.opportunity,
    } : null);
    if (!workOrder) {
      return commandOutcome({
        code: 'generation-unavailable', effect: 'unavailable', retryable: false,
        message: 'A canonical work order could not be derived.',
        before, artifacts: commandArtifacts(before),
      });
    }
    const workState = readWorkState(workStatePath(root, workOrder), workOrder, clock.nowMs);
    if (workState?.invalid) {
      return commandOutcome({
        code: 'work-state-invalid', effect: 'unavailable', retryable: false,
        message: 'The active work record is incompatible.',
        before, artifacts: commandArtifacts(before), workOrder,
      });
    }
    if (workState && !workState.stale) {
      return commandOutcome({
        code: 'already-running', effect: 'unchanged', retryable: false,
        message: 'Already running.',
        before, artifacts: commandArtifacts(before), workOrder: workState.workOrder,
      });
    }
    writeWorkState(root, workOrder, clock.nowMs, clock.leaseMs);
    return commandOutcome({
      code: 'work-requested', effect: 'accepted', retryable: false,
      message: overrideAllowed
        ? 'One generation request was accepted without changing the standing candidacy coordination.'
        : 'Work request accepted.',
      before, artifacts: commandArtifacts(before), workOrder,
      consequences: overrideAllowed ? {
        kind: 'single-generation-exception',
        clusterId: before.candidacy.clusterId,
        outreachAnchor: before.candidacy.outreachAnchor,
        stagesUnchanged: true,
      } : null,
    });
  });
}

function replaceClusterPrimary(content, clusterId, primary) {
  const lines = String(content).split('\n');
  let headers = null;
  let changed = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('|')) continue;
    const trailingPipe = lines[index].trimEnd().endsWith('|');
    const parts = lines[index].split('|').slice(1);
    if (parts.at(-1)?.trim() === '') parts.pop();
    const cells = parts.map((cell) => cell.trim());
    const lower = cells.map((cell) => cell.toLowerCase());
    if (lower.includes('cluster id') && lower.includes('primary')) {
      headers = Object.fromEntries(lower.map((name, cellIndex) => [name, cellIndex]));
      continue;
    }
    if (!headers || cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    if (cells[headers['cluster id']] !== clusterId) continue;
    cells[headers.primary] = primary == null ? '' : `#${primary}`;
    lines[index] = `| ${cells.join(' | ')}${trailingPipe ? ' |' : ''}`;
    changed += 1;
  }
  if (changed !== 1) return { ok: false, reason: changed ? 'duplicate-candidacy-cluster' : 'candidacy-cluster-not-found' };
  return { ok: true, content: lines.join('\n') };
}

/**
 * Persist or release one cluster Primary after a fresh evidence and revision
 * check. Only the candidacy registry changes; every Opportunity Stage and the
 * Outreach anchor must remain byte-for-byte authoritative.
 */
export async function setOpportunityPrimary(options = {}) {
  if (!Object.prototype.hasOwnProperty.call(options, 'primary') || options.primary === undefined) {
    throw new Error('primary is required');
  }
  const expected = parseCommandExpectation(options);
  const primary = options.primary == null ? null : Number(options.primary);
  if (primary != null && (!Number.isSafeInteger(primary) || primary <= 0)) {
    throw new Error('primary must be a positive tracker number or null');
  }
  if (primary != null && primary !== expected.opportunity) {
    throw new Error('primary must match the target Opportunity');
  }
  const root = checkoutRoot(options.root);
  return withLifecycleLock(root, options, async () => {
    const focused = readOpportunity({ root, opportunity: expected.opportunity, now: options.now });
    if (!focused) {
      return commandOutcome({
        code: 'opportunity-not-found', effect: 'unavailable', retryable: false,
        message: 'The Opportunity was not found.',
      });
    }
    const before = focused.opportunity;
    if (expectationConflict(before, expected)) return conflictOutcome(before);
    if (
      before.candidacy.state === 'research-required'
      || !before.candidacy.shared
      || !before.candidacy.clusterId
    ) {
      return commandOutcome({
        code: 'candidacy-evidence-required', effect: 'blocked', retryable: false,
        message: 'Fresh canonical Hiring-surface evidence is required before candidacy coordination can change.',
        before, artifacts: commandArtifacts(before),
      });
    }
    if (primary == null && before.candidacy.persistedPrimary !== before.opportunity) {
      return commandOutcome({
        code: 'primary-release-blocked', effect: 'blocked', retryable: false,
        message: 'Only the persisted Primary Opportunity can release this Hiring surface.',
        before, artifacts: commandArtifacts(before),
      });
    }
    if (primary != null && !before.candidacy.canSelectPrimary) {
      return commandOutcome({
        code: 'primary-selection-blocked', effect: 'blocked', retryable: false,
        message: 'This Opportunity cannot become Primary in the current canonical state.',
        before, artifacts: commandArtifacts(before),
      });
    }

    const workNowMs = options.nowMs ?? Date.now();
    if (!Number.isFinite(workNowMs) || workNowMs < 0) {
      throw new Error('nowMs must be a non-negative timestamp');
    }
    const states = loadStates({ rootDir: root, force: true });
    let activeWork = null;
    for (const member of before.candidacy.members) {
      const summary = readOpportunity({ root, opportunity: member.opportunity, now: options.now })?.opportunity;
      const workOrder = summary ? workOrderFor(summary, states) : null;
      if (!workOrder) continue;
      const workState = readWorkState(workStatePath(root, workOrder), null, workNowMs);
      if (workState && !workState.invalid && !workState.stale) {
        activeWork = workState;
        break;
      }
    }
    if (activeWork) {
      return commandOutcome({
        code: 'candidacy-work-active', effect: 'blocked', retryable: false,
        message: 'Primary coordination cannot change while lifecycle work is active for this Hiring surface.',
        before, artifacts: commandArtifacts(before), workOrder: activeWork.workOrder,
      });
    }

    const registryPath = join(root, 'data', 'candidacy-clusters.md');
    const registryContent = readOptional(registryPath);
    if (registryContent == null) {
      return commandOutcome({
        code: 'candidacy-registry-unavailable', effect: 'unavailable', retryable: false,
        message: 'The candidacy registry is unavailable.',
        before, artifacts: commandArtifacts(before),
      });
    }
    const replacement = replaceClusterPrimary(registryContent, before.candidacy.clusterId, primary);
    if (!replacement.ok) {
      return commandOutcome({
        code: replacement.reason, effect: 'unavailable', retryable: false,
        message: 'The candidacy registry could not be updated safely.',
        before, artifacts: commandArtifacts(before),
      });
    }
    if (replacement.content === registryContent) {
      return commandOutcome({
        code: 'primary-unchanged', effect: 'unchanged', retryable: false,
        message: 'The persisted Primary Opportunity is already current.',
        before, artifacts: commandArtifacts(before),
      });
    }

    let after;
    let wroteRegistry = false;
    try {
      writeFileAtomic(registryPath, replacement.content);
      wroteRegistry = true;
      after = readOpportunity({ root, opportunity: expected.opportunity, now: options.now })?.opportunity;
      const beforeStages = before.candidacy.members.map((member) => [member.opportunity, member.stage]);
      const afterStages = after?.candidacy.members.map((member) => [member.opportunity, member.stage]);
      if (
        !after
        || after.candidacy.outreachAnchor !== before.candidacy.outreachAnchor
        || digest(afterStages) !== digest(beforeStages)
      ) throw new Error('candidacy invariant failed');
    } catch {
      let restored = true;
      if (wroteRegistry) {
        try { writeFileAtomic(registryPath, registryContent); } catch { restored = false; }
      }
      return commandOutcome({
        code: restored ? 'candidacy-write-failed' : 'candidacy-recovery-required',
        effect: 'unavailable', retryable: restored,
        message: restored
          ? 'Candidacy coordination was not changed. Prior canonical state was restored.'
          : 'Candidacy coordination could not be completed or restored. Manual recovery is required.',
        before, artifacts: commandArtifacts(before),
      });
    }
    return commandOutcome({
      code: primary == null ? 'primary-released' : 'primary-selected',
      effect: 'changed', retryable: false,
      message: primary == null
        ? 'The Hiring surface was released without changing Stage or the Outreach anchor.'
        : 'The Primary Opportunity changed without changing Stage or the Outreach anchor.',
      before, after, artifacts: commandArtifacts(after),
      consequences: {
        kind: primary == null ? 'primary-release' : 'primary-selection',
        clusterId: before.candidacy.clusterId,
        outreachAnchor: before.candidacy.outreachAnchor,
        stagesUnchanged: true,
        members: after.candidacy.members,
      },
    });
  });
}

function expectedGeneratedArtifact(summary, action) {
  return summary.artifacts.find((artifact) => (
    artifact.action === action
    && artifact.expectedAction === action
    && artifact.state === 'available'
    && ['canonical', 'legacy'].includes(artifact.format)
  )) ?? null;
}

function prepareTrackerStageReplacement(tracker, opportunity, toLabel) {
  const content = readFileSync(tracker, 'utf8');
  const lines = content.split('\n');
  const columns = resolveColumns(lines);
  const matches = [];
  lines.forEach((line, index) => {
    const row = parseTrackerRow(line, columns);
    if (row?.num === opportunity) matches.push(index);
  });
  if (matches.length !== 1) return { ok: false, reason: matches.length ? 'duplicate-opportunity' : 'opportunity-not-found' };
  lines[matches[0]] = applyStatusToLine(lines[matches[0]], columns, toLabel);
  return { ok: true, content: lines.join('\n') };
}

function rollbackReconciliation({ tracker, trackerContent, artifactPath, artifactContent, workStatePath: statePath, workStateContent }) {
  const failures = [];
  const restore = (label, action) => {
    try { action(); } catch { failures.push(label); }
  };
  restore('work-state', () => {
    if (workStateContent == null) rmSync(statePath, { force: true });
    else writeFileAtomic(statePath, workStateContent);
  });
  restore('tracker', () => writeFileAtomic(tracker, trackerContent));
  restore('artifact', () => writeFileAtomic(artifactPath, artifactContent));
  return failures;
}

/**
 * Reconcile a completed canonical artifact to its paired Ready Stage. The
 * artifact reader, revision check, and mutation all run under the shared lock.
 */
export async function reconcileOpportunityWork(options = {}) {
  const expected = parseCommandExpectation(options);
  const root = checkoutRoot(options.root);
  return withLifecycleLock(root, options, async (tracker) => {
    const focused = readOpportunity({ root, opportunity: expected.opportunity, now: options.now });
    if (!focused) {
      return commandOutcome({
        code: 'opportunity-not-found', effect: 'unavailable', retryable: false,
        message: 'The Opportunity was not found.',
      });
    }
    const before = focused.opportunity;
    const states = loadStates({ rootDir: root, force: true });
    const stage = resolveState(before.rawStage, states);
    const workOrder = workOrderFor(before, states);
    const activeWork = workOrder
      ? readWorkState(workStatePath(root, workOrder))
      : null;
    const activeExpectationMatches = Boolean(
      activeWork
      && !activeWork.invalid
      && !activeWork.stale
      && sameWorkOrderForReconciliation(activeWork.workOrder, workOrder)
      && activeWork.workOrder.source.stage === expected.expectedStage
      && activeWork.workOrder.source.revision === expected.expectedRevision
    );
    if (
      before.stage.id !== expected.expectedStage
      || (before.revision !== expected.expectedRevision && !activeExpectationMatches)
    ) return conflictOutcome(before);

    const action = predecessorAction(stage, states);
    const artifact = expectedGeneratedArtifact(before, action);
    if (!stage || !action || !artifact) {
      return commandOutcome({
        code: 'artifact-incomplete', effect: 'blocked', retryable: true,
        message: 'The expected canonical artifact is not complete.',
        before, artifacts: commandArtifacts(before),
      });
    }

    if (stage.owner === 'user') {
      return commandOutcome({
        code: 'already-reconciled', effect: 'unchanged', retryable: false,
        message: 'The canonical artifact is already reconciled.',
        before, artifacts: commandArtifacts(before),
      });
    }
    const authorization = activeExpectationMatches
      ? activeWork.workOrder.authorization
      : null;
    const oneGenerationAuthorized = Boolean(
      authorization
      && authorization.kind === 'single-generation-exception'
      && authorization.opportunity === before.opportunity
      && authorization.clusterId === before.candidacy.clusterId
      && before.candidacy.canGenerateOnce,
    );
    if (stage.owner !== 'agent' || (!before.capabilities.generate && !oneGenerationAuthorized)) {
      return commandOutcome({
        code: 'reconciliation-blocked', effect: 'blocked', retryable: false,
        message: 'Reconciliation is not available for the current Opportunity state.',
        before, artifacts: commandArtifacts(before),
      });
    }

    const advance = computeAdvance(before.rawStage, states, action);
    if (!advance.ok || !advance.readyRecord) {
      return commandOutcome({
        code: 'ready-stage-unavailable', effect: 'unavailable', retryable: false,
        message: 'The canonical Ready Stage could not be derived.',
        before, artifacts: commandArtifacts(before),
      });
    }

    if (!workOrder) {
      return commandOutcome({
        code: 'generation-unavailable', effect: 'unavailable', retryable: false,
        message: 'A canonical work order could not be derived.',
        before, artifacts: commandArtifacts(before),
      });
    }
    const replacement = prepareTrackerStageReplacement(tracker, before.opportunity, advance.toLabel);
    if (!replacement.ok) {
      return commandOutcome({
        code: replacement.reason, effect: 'unavailable', retryable: false,
        message: 'The Opportunity tracker row could not be updated safely.',
        before, artifacts: commandArtifacts(before),
      });
    }
    const artifactPath = resolve(root, artifact.path);
    const artifactContent = readFileSync(artifactPath, 'utf8');
    const trackerContent = readFileSync(tracker, 'utf8');
    const statePath = workStatePath(root, workOrder);
    const workStateContent = existsSync(statePath) ? readFileSync(statePath, 'utf8') : null;
    const synced = syncPackHeader(artifactContent, advance.readyRecord);
    let after;
    try {
      if (synced.changed) writeFileAtomic(artifactPath, synced.content);
      options.onTransitionStep?.('artifact-written');
      writeFileAtomic(tracker, replacement.content);
      options.onTransitionStep?.('tracker-written');
      rmSync(statePath, { force: true });
      options.onTransitionStep?.('work-state-retired');
      after = readOpportunity({ root, opportunity: expected.opportunity, now: options.now }).opportunity;
    } catch {
      const rollbackFailures = rollbackReconciliation({
        tracker,
        trackerContent,
        artifactPath,
        artifactContent,
        workStatePath: statePath,
        workStateContent,
      });
      return commandOutcome({
        code: rollbackFailures.length ? 'reconciliation-recovery-required' : 'reconciliation-write-failed',
        effect: 'unavailable',
        retryable: rollbackFailures.length === 0,
        message: rollbackFailures.length
          ? 'Reconciliation could not be completed or fully restored. Manual recovery is required.'
          : 'Reconciliation was not completed. Prior canonical state was restored.',
        before,
        after: before,
        artifacts: commandArtifacts(before),
      });
    }
    return commandOutcome({
      code: 'work-reconciled', effect: 'changed', retryable: false,
      message: 'The canonical artifact was reconciled to its Ready Stage.',
      before, after, artifacts: commandArtifacts(after),
    });
  });
}

function parseCliArgs(argv) {
  const [action, ...rest] = argv;
  if (!['contract', 'list', 'read', 'request', 'reconcile', 'primary', 'attempt', 'successor'].includes(action)) {
    throw new Error('usage: opportunity-lifecycle.mjs <contract|list|read|request|reconcile|primary|attempt|successor> [options]');
  }
  const options = {
    action, root: MODULE_ROOT, opportunity: null, expectedStage: null, expectedRevision: null,
    primary: undefined, candidacyOverride: false, attempt: undefined, successor: undefined, now: null,
  };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--root') options.root = rest[++index];
    else if (argument === '--opportunity') options.opportunity = rest[++index];
    else if (argument === '--expected-stage') options.expectedStage = rest[++index];
    else if (argument === '--expected-revision') options.expectedRevision = rest[++index];
    else if (argument === '--primary') {
      if (index + 1 >= rest.length || rest[index + 1].startsWith('--')) {
        throw new Error('--primary requires NUM or none');
      }
      const value = rest[++index];
      options.primary = value === 'none' ? null : value;
    } else if (argument === '--candidacy-override') options.candidacyOverride = true;
    else if (argument === '--attempt-stdin') options.attempt = 'stdin';
    else if (argument === '--successor') options.successor = rest[++index];
    else if (argument === '--now') options.now = rest[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.root) throw new Error('--root requires a path');
  if (['read', 'request', 'reconcile', 'primary', 'attempt', 'successor'].includes(action) && options.opportunity == null) {
    throw new Error(`${action} requires --opportunity NUM`);
  }
  if (['request', 'reconcile', 'primary', 'attempt', 'successor'].includes(action) && (!options.expectedStage || !options.expectedRevision)) {
    throw new Error(`${action} requires --expected-stage ID and --expected-revision SHA256`);
  }
  if (action === 'primary' && options.primary === undefined) {
    throw new Error('primary requires --primary NUM|none');
  }
  if (action === 'attempt' && options.attempt !== 'stdin') throw new Error('attempt requires --attempt-stdin');
  if (action === 'successor' && !options.successor) throw new Error('successor requires --successor ID');
  return options;
}

async function runCli() {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    let result;
    if (options.action === 'contract') result = readOpportunityContract({ root: options.root });
    else if (options.action === 'list') result = listOpportunities({ root: options.root, now: options.now });
    else if (options.action === 'read') {
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
    } else if (options.action === 'request') result = await requestOpportunityWork(options);
    else if (options.action === 'primary') result = await setOpportunityPrimary(options);
    else if (options.action === 'attempt') {
      try { options.attempt = JSON.parse(readFileSync(0, 'utf8')); }
      catch { throw new Error('attempt stdin must contain valid JSON'); }
      result = await recordOpportunityAttempt(options);
    }
    else if (options.action === 'successor') result = await reportOpportunitySuccessor(options);
    else result = await reconcileOpportunityWork(options);
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

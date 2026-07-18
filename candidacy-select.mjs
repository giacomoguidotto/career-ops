#!/usr/bin/env node
/**
 * candidacy-select.mjs — Deterministic preflight for Agent-owned advancement.
 *
 * Lifecycle state remains per Application in templates/states.yml. This tool
 * applies the separate, user-layer candidacy coordination registry before an
 * agent or unattended automation ranks work. It never writes tracker state or
 * edits the registry.
 *
 * Usage:
 *   node candidacy-select.mjs --json
 *   node candidacy-select.mjs --summary
 *   node candidacy-select.mjs --tracker path/to/applications.md --clusters path/to/candidacy-clusters.md --json
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { loadStates, resolveState } from './tracker-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const RELEASED_STAGE_IDS = new Set(['rejected', 'discarded', 'skip']);
export const CANDIDACY_SUPPRESSION_REASONS = Object.freeze({
  RESEARCH_REQUIRED: 'research-required',
  ACCEPTED_PRIMARY: 'accepted-primary',
  RESERVED_PRIMARY: 'reserved-primary',
  CLUSTER_CHOICE: 'cluster-choice',
});
const KNOWN_SUPPRESSION_REASONS = new Set(Object.values(CANDIDACY_SUPPRESSION_REASONS));

export function candidacyAdvanceBlockReason(reason) {
  return KNOWN_SUPPRESSION_REASONS.has(reason)
    ? `candidacy-${reason}`
    : 'candidacy-invalid-suppression';
}

function companyKey(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function trackerNumbers(value) {
  return [...String(value ?? '').matchAll(/#(\d+)/g)].map((match) => Number(match[1]));
}

function firstTrackerNumber(value) {
  return trackerNumbers(value)[0] ?? null;
}

/** Parse the user-layer candidacy registry into stable machine records. */
export function parseClusterRegistry(content) {
  const lines = String(content ?? '').split('\n');
  let headers = null;
  const clusters = [];

  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').slice(1);
    if (parts.at(-1)?.trim() === '') parts.pop();
    const cells = parts.map((cell) => cell.trim());
    const lower = cells.map((cell) => cell.toLowerCase());
    if (lower.includes('cluster id') && lower.includes('members')) {
      headers = Object.fromEntries(lower.map((name, index) => [name, index]));
      continue;
    }
    if (!headers || cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    const at = (name) => cells[headers[name]] ?? '';
    const id = at('cluster id');
    if (!id) continue;
    clusters.push({
      id,
      company: at('company'),
      surface: at('hiring surface'),
      confidence: at('confidence'),
      members: trackerNumbers(at('members')),
      primary: firstTrackerNumber(at('primary')),
      outreachAnchor: firstTrackerNumber(at('outreach anchor')),
      evidence: at('evidence'),
      reviewed: at('reviewed'),
    });
  }
  return clusters;
}

export function normalizeDecision(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[ _-]+/g, ' ');
  if (/^apply\b/.test(normalized)) return 'apply';
  if (/^consider\b/.test(normalized)) return 'consider';
  if (/^research first\b/.test(normalized)) return 'research_first';
  if (/^(?:skip|do not apply|discard)\b/.test(normalized)) return 'skip';
  return 'unknown';
}

/** The latest explicit re-evaluation marker supersedes older tracker prose. */
export function decisionFromTrackerNotes(notes) {
  const raw = String(notes ?? '');
  const marker = raw.toLowerCase().lastIndexOf('[re-evaluated');
  const current = marker >= 0 ? raw.slice(marker) : raw;
  const match = current.match(/\b(APPLY|CONSIDER|RESEARCH FIRST|SKIP|DO NOT APPLY|DISCARD)\s*:/i);
  return match ? normalizeDecision(match[1]) : 'unknown';
}

export function decisionFromReport(content) {
  const raw = String(content ?? '');
  const machineSummary = raw.match(/^\s*final_decision:\s*["']?([^"'\n]+?)["']?\s*$/im);
  if (machineSummary) return normalizeDecision(machineSummary[1]);
  const decisionSnapshot = raw.match(/^\s*\*\*Decision:\*\*\s*([^\n]+?)\s*$/im);
  return decisionSnapshot ? normalizeDecision(decisionSnapshot[1]) : 'unknown';
}

function decisionPriority(decision) {
  return { apply: 4, consider: 3, research_first: 2, unknown: 1, skip: 0 }[normalizeDecision(decision)] ?? 1;
}

function scoreValue(score) {
  const match = String(score ?? '').replace(/\*\*/g, '').match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NEGATIVE_INFINITY;
}

function stageIndex(state, states) {
  return state ? states.records.findIndex((record) => record.id === state.id) : -1;
}

function compareCandidates(a, b) {
  return (
    b.stageRank - a.stageRank ||
    b.decisionRank - a.decisionRank ||
    b.scoreValue - a.scoreValue ||
    b.num - a.num
  );
}

function publicCandidate(item, extra = {}) {
  return {
    num: item.num,
    company: item.company,
    role: item.role,
    score: item.score,
    status: item.status,
    stage: item.state?.id ?? null,
    owner: item.state?.owner ?? null,
    suggests: item.state?.suggests ?? null,
    decision: item.decision,
    ...extra,
  };
}

function activeForCoordination(item) {
  return item.state && (!RELEASED_STAGE_IDS.has(item.state.id));
}

function validReviewedDate(value) {
  const raw = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const parsed = new Date(`${raw}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === raw;
}

function hasAuditableEvidence(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  return /(https?:\/\/|reports?\/|\bcontact\b|\btracker\b)/i.test(raw);
}

/**
 * Apply researched Hiring-surface coordination before global ranking.
 *
 * The returned `eligible` array is the exclusive Agent-owned input to `next`
 * auto selection. A company in `researchRequired` contributes no implicit
 * candidate until its active rows are classified and the selector is rerun.
 */
export function selectCandidacyCandidates({ rows, clusters = [], states = loadStates(), decisionByNum = new Map() }) {
  const warnings = [];
  const stateRankById = new Map(states.records.map((record, index) => [record.id, index]));
  const entryAgentRank = Math.min(
    ...states.records
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => record.owner === 'agent')
      .map(({ index }) => index),
  );

  const annotated = rows.map((row) => {
    const state = resolveState(row.status, states);
    const decision = normalizeDecision(decisionByNum.get(row.num));
    if (!state) warnings.push({ type: 'unknown-stage', num: row.num, status: row.status });
    return {
      ...row,
      state,
      stageRank: state ? (stateRankById.get(state.id) ?? stageIndex(state, states)) : -1,
      decision,
      decisionRank: decisionPriority(decision),
      scoreValue: scoreValue(row.score),
      companyKey: companyKey(row.company),
    };
  });
  const rowsByNum = new Map(annotated.map((row) => [row.num, row]));
  const companies = new Map();
  for (const row of annotated) {
    if (!companies.has(row.companyKey)) companies.set(row.companyKey, []);
    companies.get(row.companyKey).push(row);
  }

  const clusterMembership = new Map();
  for (const item of clusters) {
    for (const num of item.members) {
      if (!clusterMembership.has(num)) clusterMembership.set(num, []);
      clusterMembership.get(num).push(item);
    }
  }

  const clusterIdCounts = new Map();
  for (const item of clusters) {
    clusterIdCounts.set(item.id, (clusterIdCounts.get(item.id) ?? 0) + 1);
  }
  const invalidClustersByCompany = new Map();
  for (const item of clusters) {
    const key = companyKey(item.company);
    const issues = [];
    if (!String(item.evidence ?? '').trim()) issues.push('missing-evidence');
    else if (!hasAuditableEvidence(item.evidence)) issues.push('unsupported-evidence-reference');
    if (!/^(?:high|medium|low)$/i.test(String(item.confidence ?? '').trim())) issues.push('invalid-confidence');
    if (!validReviewedDate(item.reviewed)) issues.push('invalid-reviewed-date');
    if (item.members.length === 0) issues.push('missing-members');
    if (new Set(item.members).size !== item.members.length) issues.push('duplicate-members');
    if ((clusterIdCounts.get(item.id) ?? 0) > 1) issues.push('duplicate-cluster-id');
    if (item.primary != null && !item.members.includes(item.primary)) issues.push('primary-not-a-member');
    if (item.outreachAnchor != null && !item.members.includes(item.outreachAnchor)) issues.push('outreach-anchor-not-a-member');
    for (const num of item.members) {
      const row = rowsByNum.get(num);
      if (!row) {
        issues.push(`missing-tracker-row:#${num}`);
        warnings.push({ type: 'missing-tracker-row', clusterId: item.id, num });
      } else if (row.companyKey !== key) {
        issues.push(`company-mismatch:#${num}`);
        warnings.push({ type: 'company-mismatch', clusterId: item.id, num });
      }
    }
    if (issues.length > 0) {
      if (!invalidClustersByCompany.has(key)) invalidClustersByCompany.set(key, []);
      invalidClustersByCompany.get(key).push({ clusterId: item.id, issues: [...new Set(issues)] });
    }
  }

  const researchRequired = [];
  const researchCompanyKeys = new Set();
  for (const [key, companyRows] of companies) {
    const activeRows = companyRows.filter(activeForCoordination);
    const agentRows = activeRows.filter((row) => row.state?.owner === 'agent');
    const hasDuplicateMembership = agentRows.some((row) => (clusterMembership.get(row.num)?.length ?? 0) > 1);
    const invalidClusters = invalidClustersByCompany.get(key) ?? [];
    const needsCoordination =
      agentRows.length > 1 ||
      (agentRows.length > 0 && activeRows.length > 1) ||
      hasDuplicateMembership ||
      (agentRows.length > 0 && invalidClusters.length > 0);
    if (!needsCoordination) continue;

    const matchingClusters = clusters.filter((item) => companyKey(item.company) === key);
    const coveredCounts = new Map();
    for (const item of matchingClusters) {
      for (const num of item.members) coveredCounts.set(num, (coveredCounts.get(num) ?? 0) + 1);
    }
    const unclassified = activeRows.filter((row) => !coveredCounts.has(row.num)).map((row) => row.num).sort((a, b) => a - b);
    const multiplyClassified = activeRows.filter((row) => (coveredCounts.get(row.num) ?? 0) > 1).map((row) => row.num).sort((a, b) => a - b);
    if (
      matchingClusters.length === 0 ||
      unclassified.length > 0 ||
      multiplyClassified.length > 0 ||
      invalidClusters.length > 0
    ) {
      researchCompanyKeys.add(key);
      researchRequired.push({
        company: companyRows[0]?.company ?? key,
        applications: activeRows.map((row) => row.num).sort((a, b) => a - b),
        unclassified,
        multiplyClassified,
        invalidClusters,
        reason: invalidClusters.length > 0
          ? 'invalid-classification'
          : matchingClusters.length === 0
            ? 'missing-classification'
            : 'membership-drift',
      });
    }
  }

  const eligible = [];
  const suppressed = [];
  const clusterResults = [];
  const handledAgentNums = new Set();

  for (const key of researchCompanyKeys) {
    for (const item of companies.get(key) ?? []) {
      if (item.state?.owner !== 'agent') continue;
      handledAgentNums.add(item.num);
      suppressed.push(publicCandidate(item, {
        reason: CANDIDACY_SUPPRESSION_REASONS.RESEARCH_REQUIRED,
        clusterId: null,
        primary: null,
      }));
    }
  }

  for (const item of clusters) {
    const key = companyKey(item.company);
    const memberRows = item.members
      .map((num) => rowsByNum.get(num))
      .filter((row) => row && row.companyKey === key);
    const agentRows = memberRows.filter((row) => row.state?.owner === 'agent');
    for (const row of agentRows) handledAgentNums.add(row.num);

    if (researchCompanyKeys.has(key)) {
      clusterResults.push({
        id: item.id,
        company: item.company,
        members: item.members,
        storedPrimary: item.primary,
        effectivePrimary: null,
        outreachAnchor: item.outreachAnchor,
        reserved: false,
        blockedByResearch: true,
      });
      continue;
    }

    const acceptedRows = memberRows.filter((row) => row.state?.id === 'accepted').sort(compareCandidates);
    const storedPrimary = item.primary == null
      ? null
      : memberRows.find((row) => row.num === item.primary) ?? null;
    const activeStoredPrimary = storedPrimary && activeForCoordination(storedPrimary) ? storedPrimary : null;
    const progressedRows = memberRows
      .filter((row) => activeForCoordination(row) && row.stageRank > entryAgentRank)
      .sort(compareCandidates);

    let effectivePrimary = null;
    let reserved = false;
    let suppressionReason = CANDIDACY_SUPPRESSION_REASONS.CLUSTER_CHOICE;

    if (acceptedRows.length > 0) {
      effectivePrimary = acceptedRows[0];
      reserved = true;
      suppressionReason = CANDIDACY_SUPPRESSION_REASONS.ACCEPTED_PRIMARY;
    } else if (activeStoredPrimary) {
      effectivePrimary = activeStoredPrimary;
      reserved = true;
      suppressionReason = CANDIDACY_SUPPRESSION_REASONS.RESERVED_PRIMARY;
    } else if (progressedRows.length > 0) {
      effectivePrimary = progressedRows[0];
      reserved = true;
      suppressionReason = CANDIDACY_SUPPRESSION_REASONS.RESERVED_PRIMARY;
    } else if (agentRows.length > 0) {
      effectivePrimary = [...agentRows].sort(compareCandidates)[0];
    }

    for (const row of agentRows) {
      if (
        effectivePrimary?.num === row.num &&
        suppressionReason !== CANDIDACY_SUPPRESSION_REASONS.ACCEPTED_PRIMARY
      ) {
        eligible.push(publicCandidate(row, {
          clusterId: item.id,
          primary: effectivePrimary.num,
          reserved,
          outreachAnchor: item.outreachAnchor,
        }));
      } else {
        suppressed.push(publicCandidate(row, {
          reason: suppressionReason,
          clusterId: item.id,
          primary: effectivePrimary?.num ?? null,
          outreachAnchor: item.outreachAnchor,
        }));
      }
    }

    clusterResults.push({
      id: item.id,
      company: item.company,
      members: item.members,
      storedPrimary: item.primary,
      effectivePrimary: effectivePrimary?.num ?? null,
      outreachAnchor: item.outreachAnchor,
      reserved,
      blockedByResearch: false,
    });
  }

  for (const row of annotated) {
    if (row.state?.owner !== 'agent' || handledAgentNums.has(row.num)) continue;
    const memberships = clusterMembership.get(row.num) ?? [];
    if (memberships.length > 0) continue;
    eligible.push(publicCandidate(row, { clusterId: null, primary: null, reserved: false, outreachAnchor: null }));
  }

  eligible.sort((a, b) => {
    const left = annotated.find((row) => row.num === a.num);
    const right = annotated.find((row) => row.num === b.num);
    return compareCandidates(left, right);
  });
  suppressed.sort((a, b) => a.num - b.num);
  researchRequired.sort((a, b) => a.company.localeCompare(b.company));

  return {
    eligible,
    suppressed,
    researchRequired,
    clusters: clusterResults,
    warnings,
    blocked: researchRequired.length > 0,
  };
}

function resolveReportPath(reportCell, trackerPath) {
  const match = String(reportCell ?? '').match(/\]\(([^)]+)\)/);
  if (!match || /^https?:/i.test(match[1])) return null;
  return resolve(dirname(trackerPath), match[1]);
}

function loadDecisionMap(rows, trackerPath) {
  const result = new Map();
  for (const row of rows) {
    const noteDecision = decisionFromTrackerNotes(row.notes);
    if (noteDecision !== 'unknown') {
      result.set(row.num, noteDecision);
      continue;
    }
    const reportPath = resolveReportPath(row.report, trackerPath);
    const reportDecision = reportPath && existsSync(reportPath)
      ? decisionFromReport(readFileSync(reportPath, 'utf-8'))
      : 'unknown';
    result.set(row.num, reportDecision);
  }
  return result;
}

/** Load tracker + registry files and return the complete deterministic preflight. */
export function loadCandidacySelection({
  trackerPath,
  clustersPath = join(ROOT, 'data', 'candidacy-clusters.md'),
  states = loadStates(),
}) {
  const resolvedTracker = resolve(trackerPath);
  const resolvedClusters = resolve(clustersPath);
  if (!existsSync(resolvedTracker)) throw new Error(`Tracker not found: ${resolvedTracker}`);
  const trackerLines = readFileSync(resolvedTracker, 'utf-8').split('\n');
  const colmap = resolveColumns(trackerLines);
  const rows = trackerLines.map((line) => parseTrackerRow(line, colmap)).filter(Boolean);
  const registryExists = existsSync(resolvedClusters);
  const clusters = registryExists
    ? parseClusterRegistry(readFileSync(resolvedClusters, 'utf-8'))
    : [];
  return {
    tracker: resolvedTracker,
    registry: registryExists ? resolvedClusters : null,
    ...selectCandidacyCandidates({
      rows,
      clusters,
      states,
      decisionByNum: loadDecisionMap(rows, resolvedTracker),
    }),
  };
}

function parseArgs(argv) {
  const args = { json: false, summary: false, tracker: null, clusters: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--summary') args.summary = true;
    else if (arg === '--tracker') args.tracker = argv[++index];
    else if (arg === '--clusters') args.clusters = argv[++index];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  console.log('Usage: node candidacy-select.mjs [--json|--summary] [--tracker PATH] [--clusters PATH]');
}

function runCli() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    usage();
    process.exit(1);
  }
  if (args.help) {
    usage();
    return;
  }

  const trackerPath = resolve(args.tracker ?? join(ROOT, 'data', 'applications.md'));
  const clustersPath = resolve(args.clusters ?? join(ROOT, 'data', 'candidacy-clusters.md'));
  if (!existsSync(trackerPath)) {
    console.error(`Tracker not found: ${trackerPath}`);
    process.exit(2);
  }
  const output = loadCandidacySelection({ trackerPath, clustersPath, states: loadStates() });
  const result = output;

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  console.log(`Eligible Agent-owned Applications: ${result.eligible.length}`);
  for (const item of result.eligible) {
    console.log(`  #${item.num} ${item.company} — ${item.role} (${item.status}, ${item.decision}, ${item.score})`);
  }
  console.log(`Suppressed by candidacy coordination: ${result.suppressed.length}`);
  for (const item of result.suppressed) {
    console.log(`  #${item.num} ${item.company} — ${item.reason}${item.primary ? `; Primary #${item.primary}` : ''}`);
  }
  if (result.researchRequired.length > 0) {
    console.log(`Hiring-surface research required: ${result.researchRequired.length}`);
    for (const item of result.researchRequired) {
      console.log(`  ${item.company}: #${item.applications.join(', #')} (${item.reason})`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();

import { createHash } from 'crypto';
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import {
  aggregateGaps,
  extractSkills,
  parseReportGaps,
  SCHEMA_VERSION,
} from '../upskill.mjs';
import { inspectColumns, parseTrackerRow } from '../tracker-parse.mjs';

export const REQUISITE_REQUEST_SCHEMA = 'career.requisite.snapshot.request/v1';
export const REQUISITE_SNAPSHOT_SCHEMA = 'career.requisite.snapshot/v1';
export const REQUISITE_METHOD_REVISION = `career.requisite.method/v${SCHEMA_VERSION}`;

const EMPTY_OBSERVED_AT = '1970-01-01T00:00:00.000Z';

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

function digest(value, length = 32) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function trackerPath(root) {
  const nativePath = join(root, 'data/applications.md');
  if (existsSync(nativePath)) return nativePath;
  const legacyPath = join(root, 'applications.md');
  return existsSync(legacyPath) ? legacyPath : null;
}

function safeReportPath(root, tracker, reportCell) {
  const match = String(reportCell ?? '').match(/\]\(([^)]+)\)/);
  if (!match) return null;

  const candidates = isAbsolute(match[1])
    ? [match[1]]
    : [resolve(dirname(tracker), match[1]), resolve(root, match[1])];
  const canonicalRoot = `${realpathSync(root)}${sep}`;
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const canonical = realpathSync(candidate);
    if (canonical.startsWith(canonicalRoot) && statSync(canonical).isFile()) return canonical;
  }
  return null;
}

function observedAt(paths) {
  if (paths.length === 0) return EMPTY_OBSERVED_AT;
  const latest = Math.max(...paths.map((path) => statSync(path).mtimeMs));
  return new Date(latest).toISOString();
}

function failedSnapshot(reasons) {
  return {
    schema: REQUISITE_SNAPSHOT_SCHEMA,
    status: 'failed',
    reasons,
    revision_token: null,
    observed_at: null,
    method_revision: REQUISITE_METHOD_REVISION,
    coverage: null,
    requisites: [],
  };
}

function validateRequest(request) {
  const reasons = [];
  if (!isObject(request) || request.schema !== REQUISITE_REQUEST_SCHEMA) {
    reasons.push('unsupported-request-schema');
  }
  if (isObject(request) && Object.keys(request).some((key) => key !== 'schema')) {
    reasons.push('request-contains-unsupported-fields');
  }
  return reasons;
}

export function checkRequisiteSnapshot({ root = process.cwd() } = {}) {
  const tracker = trackerPath(root);
  if (!tracker) return [];

  try {
    const lines = readFileSync(tracker, 'utf8').split(/\r?\n/);
    return inspectColumns(lines).format === 'unknown'
      ? ['malformed:applications-tracker']
      : [];
  } catch {
    return ['unreadable:applications-tracker'];
  }
}

export function snapshotRequisites(request, { root = process.cwd() } = {}) {
  const requestErrors = validateRequest(request);
  if (requestErrors.length > 0) return failedSnapshot(requestErrors);

  const readiness = checkRequisiteSnapshot({ root });
  if (readiness.length > 0) return failedSnapshot(readiness);

  const tracker = trackerPath(root);
  if (!tracker) {
    const coverage = {
      status: 'empty',
      reports_linked: 0,
      reports_read: 0,
      reports_scored: 0,
      low_fit_reports: 0,
      reports_with_machine_summary: 0,
    };
    const revisionBody = JSON.stringify({
      schema: REQUISITE_SNAPSHOT_SCHEMA,
      method_revision: REQUISITE_METHOD_REVISION,
      coverage,
      requisites: [],
    });
    return {
      schema: REQUISITE_SNAPSHOT_SCHEMA,
      status: 'completed',
      reasons: [],
      revision_token: `career.requisite.revision/v1/${digest(revisionBody)}`,
      observed_at: EMPTY_OBSERVED_AT,
      method_revision: REQUISITE_METHOD_REVISION,
      coverage,
      requisites: [],
    };
  }

  const lines = readFileSync(tracker, 'utf8').split(/\r?\n/);
  const inspection = inspectColumns(lines);
  const rows = lines.map((line) => parseTrackerRow(line, inspection.columns)).filter(Boolean);
  const parsedReports = [];
  const sourceByReport = new Map();
  const observedPaths = [tracker];
  let reportsLinked = 0;
  let reportsWithMachineSummary = 0;

  for (const row of rows) {
    if (!String(row.report ?? '').match(/\]\(([^)]+)\)/)) continue;
    reportsLinked += 1;
    const reportPath = safeReportPath(root, tracker, row.report);
    if (!reportPath) continue;

    const content = readFileSync(reportPath, 'utf8');
    const parsed = parseReportGaps(content);
    if (parsed.hasMachineSummary) reportsWithMachineSummary += 1;
    const trackerScore = Number.parseFloat(row.score);
    parsedReports.push({
      num: row.num,
      score: Number.isFinite(trackerScore) ? trackerScore : parsed.score,
      gapText: parsed.gapText,
    });
    observedPaths.push(reportPath);
    const localReference = relative(root, reportPath).replaceAll(sep, '/');
    sourceByReport.set(row.num, `career.evidence/v1/${digest(localReference, 24)}`);
  }

  const knownPaths = [join(root, 'cv.md'), join(root, 'config/profile.yml')]
    .filter((path) => existsSync(path));
  observedPaths.push(...knownPaths);
  const knownSkills = extractSkills(
    knownPaths.map((path) => readFileSync(path, 'utf8')).join('\n'),
  );
  const { gaps, totalLowFit } = aggregateGaps(parsedReports, knownSkills);
  const reportsScored = parsedReports.filter(({ score }) => Number.isFinite(score)).length;
  const reportsRead = parsedReports.length;
  const coverageStatus = reportsScored === 0
    ? 'empty'
    : reportsRead < reportsLinked || reportsScored < reportsRead
      ? 'partial'
      : 'complete';
  const coverage = {
    status: coverageStatus,
    reports_linked: reportsLinked,
    reports_read: reportsRead,
    reports_scored: reportsScored,
    low_fit_reports: totalLowFit,
    reports_with_machine_summary: reportsWithMachineSummary,
  };

  const requisites = gaps.map((gap) => ({
    requisite_key: `career.requisite/v1/${digest(gap.skill.toLocaleLowerCase('en-US'), 24)}`,
    label: gap.skill,
    opportunity_count: gap.reports,
    low_fit_opportunity_count: gap.lowFitReports,
    prevalence: reportsScored > 0 ? round(gap.reports / reportsScored) : 0,
    weighted_score: gap.weightedScore,
    career_tier: gap.tier,
    source_references: gap.sources
      .map((source) => sourceByReport.get(source))
      .filter(Boolean)
      .sort(),
  })).sort((left, right) => (
    right.weighted_score - left.weighted_score
    || right.opportunity_count - left.opportunity_count
    || left.requisite_key.localeCompare(right.requisite_key)
  ));

  const revisionBody = JSON.stringify({
    schema: REQUISITE_SNAPSHOT_SCHEMA,
    method_revision: REQUISITE_METHOD_REVISION,
    coverage,
    requisites,
  });
  return {
    schema: REQUISITE_SNAPSHOT_SCHEMA,
    status: coverageStatus === 'partial' ? 'incomplete' : 'completed',
    reasons: coverageStatus === 'partial' ? ['partial-evidence-coverage'] : [],
    revision_token: `career.requisite.revision/v1/${digest(revisionBody)}`,
    observed_at: observedAt(observedPaths),
    method_revision: REQUISITE_METHOD_REVISION,
    coverage,
    requisites,
  };
}

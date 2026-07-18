import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
  lstatSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PASSIVE_CORE_FILES = [
  'DATA_CONTRACT.md',
  'opportunity-lifecycle.mjs',
  'tracker-utils.mjs',
  'tracker-parse.mjs',
  'tracker-aliases.json',
  'followup-cadence.mjs',
  'approach-attempts.mjs',
  'candidacy-select.mjs',
  'advance-stage.mjs',
];

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function write(path, content) {
  ensureDirectory(dirname(path));
  writeFileSync(path, content);
}

function confinedTarget(base, candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new Error('fictional fixture path must be a non-empty relative path');
  }
  const target = resolve(base, candidate);
  const lexical = relative(resolve(base), target);
  if (isAbsolute(candidate) || lexical === '..' || lexical.startsWith(`..${sep}`)) {
    throw new Error(`fictional fixture path escapes its root: ${candidate}`);
  }

  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const canonicalBase = realpathSync(base);
  const canonicalExisting = realpathSync(existing);
  const physical = relative(canonicalBase, canonicalExisting);
  if (physical === '..' || physical.startsWith(`..${sep}`)) {
    throw new Error(`fictional fixture path crosses a symlink outside its root: ${candidate}`);
  }
  return target;
}

function loadStageDocument(sourceRoot) {
  return yaml.load(readFileSync(join(sourceRoot, 'templates', 'states.yml'), 'utf8'));
}

function trackerHeader(legacyTracker, headers = null) {
  if (headers) {
    return [
      '# Opportunities Tracker',
      '',
      `| ${headers.join(' | ')} |`,
      `| ${headers.map(() => '---').join(' | ')} |`,
    ];
  }
  if (legacyTracker) {
    return [
      '# Applications Tracker',
      '',
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|---|---|---|---|---|---|---|---|',
    ];
  }
  return [
    '# Opportunities Tracker',
    '',
    '| Opportunity | Date | Company | Role | Score | Stage | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
}

function trackerRow(opportunity, fields = null) {
  const values = {
    num: opportunity.num,
    date: opportunity.date ?? '2026-01-15',
    company: opportunity.company,
    role: opportunity.role,
    score: opportunity.score ?? '4.2/5',
    status: opportunity.stage,
    pdf: opportunity.pdf ?? '-',
    report: opportunity.report ?? '-',
    notes: opportunity.notes ?? '',
  };
  const order = fields ?? ['num', 'date', 'company', 'role', 'score', 'status', 'pdf', 'report', 'notes'];
  return `| ${order.map((field) => values[field]).join(' | ')} |`;
}

function defaultOpportunities(stages) {
  return stages.map((stage, index) => ({
    num: index + 1,
    company: `Fictional Company ${index + 1}`,
    role: `${stage.label} Specialist`,
    stage: stage.label,
  }));
}

function aliasOpportunities(stages, firstNumber) {
  const opportunities = [];
  let num = firstNumber;
  for (const stage of stages) {
    for (const alias of stage.aliases ?? []) {
      opportunities.push({
        num,
        company: `Alias Company ${num}`,
        role: `${stage.label} Alias Specialist`,
        stage: String(alias),
      });
      num += 1;
    }
  }
  return opportunities;
}

function attemptDocument(attempts) {
  const header = [
    '# Approach Attempts',
    '',
    '> Append-only fictional facts.',
    '',
    '| id | opportunity | occurredAt | type | channel | recipient | result | followUpTo | notes |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  const rows = attempts.map((attempt, index) => `| ${[
    attempt.id ?? `A${String(index + 1).padStart(3, '0')}`,
    attempt.opportunity,
    attempt.date ?? '2026-01-15',
    attempt.type ?? 'formal_application',
    attempt.channel ?? 'fictional_portal',
    attempt.recipient ?? 'Fictional Hiring Team',
    attempt.result ?? 'sent',
    attempt.followUpTo ?? '',
    attempt.notes ?? '',
  ].join(' | ')} |`);
  return `${[...header, ...rows].join('\n')}\n`;
}

/**
 * Build a complete fictional checkout root for lifecycle and browser tests.
 * Canonical Stage rows are derived live from templates/states.yml so the
 * harness cannot become a second Stage map.
 */
export function createFictionalOpportunityWorkspace(options = {}) {
  const sourceRoot = options.sourceRoot ?? REPO_ROOT;
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'career-ops-lifecycle-'));
  const stageDocument = loadStageDocument(sourceRoot);
  const stages = stageDocument.states ?? [];

  ensureDirectory(join(root, 'templates'));
  ensureDirectory(join(root, 'config'));
  ensureDirectory(join(root, 'data'));
  ensureDirectory(join(root, 'output', 'next-packs'));
  ensureDirectory(join(root, 'reports'));
  copyFileSync(join(sourceRoot, 'templates', 'states.yml'), join(root, 'templates', 'states.yml'));
  copyFileSync(join(sourceRoot, 'tracker-aliases.json'), join(root, 'tracker-aliases.json'));
  if (options.materializeCore) {
    for (const file of PASSIVE_CORE_FILES) copyFileSync(join(sourceRoot, file), join(root, file));
    symlinkSync(join(sourceRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  }
  if (options.trackerAliases) {
    const aliases = JSON.parse(readFileSync(join(root, 'tracker-aliases.json'), 'utf8'));
    write(join(root, 'tracker-aliases.json'), `${JSON.stringify({ ...aliases, ...options.trackerAliases }, null, 2)}\n`);
  }

  let opportunities = options.opportunities
    ? [...options.opportunities]
    : defaultOpportunities(stages);
  if (options.opportunityPatches) {
    opportunities = opportunities.map((opportunity) => ({
      ...opportunity,
      ...(options.opportunityPatches[opportunity.num] ?? {}),
    }));
  }
  opportunities.push(...(options.extraOpportunities ?? []));
  if (options.includeAliases) {
    opportunities.push(...aliasOpportunities(stages, opportunities.length + 1));
  }
  if (options.includeUnknownStage) {
    opportunities.push({
      num: opportunities.length + 1,
      company: 'Unknown Stage Labs',
      role: 'Compatibility Researcher',
      stage: 'FUTURE_STAGE',
    });
  }

  const tracker = trackerHeader(Boolean(options.legacyTracker), options.trackerHeaders);
  tracker.push(...opportunities.map((opportunity) => trackerRow(opportunity, options.trackerFields)));
  write(join(root, 'data', 'applications.md'), `${tracker.join('\n')}\n`);

  if (!options.missingOptionalFiles) {
    write(join(root, 'data', 'approach-attempts.md'), attemptDocument(options.attempts ?? []));
    write(join(root, 'data', 'follow-ups.md'), options.followups ?? '# Follow-ups\n');
    write(join(root, 'data', 'candidacy-clusters.md'), options.clusters ?? '# Candidacy clusters\n');
    write(join(root, 'config', 'profile.yml'), options.profile ?? 'followup_cadence: {}\n');
  }

  for (const [name, content] of Object.entries(options.approachPlans ?? {})) {
    write(confinedTarget(join(root, 'output', 'next-packs'), name), content);
  }
  for (const [name, content] of Object.entries(options.reports ?? {})) {
    write(confinedTarget(join(root, 'reports'), name), content);
  }
  for (const [path, content] of Object.entries(options.files ?? {})) {
    write(confinedTarget(root, path), content);
  }

  return { root, sourceRoot, stages, opportunities };
}

export function removeFictionalOpportunityWorkspace(root) {
  rmSync(root, { recursive: true, force: true });
}

function walkFiles(root, current = root) {
  const files = [];
  for (const name of readdirSync(current)) {
    const path = join(current, name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) files.push(...walkFiles(root, path));
    else files.push(path);
  }
  return files;
}

/** Return a content fingerprint without exposing fixture contents in output. */
export function snapshotFictionalWorkspace(root) {
  return Object.fromEntries(walkFiles(root)
    .map((path) => [relative(root, path), createHash('sha256').update(readFileSync(path)).digest('hex')])
    .sort(([left], [right]) => left.localeCompare(right)));
}

export function fingerprintFictionalWorkspace(root) {
  return createHash('sha256').update(JSON.stringify(snapshotFictionalWorkspace(root))).digest('hex');
}

function fingerprintPath(root, path, entries) {
  let stats;
  try { stats = lstatSync(path); } catch { return; }
  const key = relative(root, path);
  if (stats.isSymbolicLink()) {
    entries.set(`link:${key}`, readlinkSync(path));
    return;
  }
  if (stats.isDirectory()) {
    entries.set(`directory:${key}`, '');
    for (const name of readdirSync(path)) fingerprintPath(root, join(path, name), entries);
    return;
  }
  entries.set(`file:${key}`, createHash('sha256').update(readFileSync(path)).digest('hex'));
}

function userLayerDeclarations(root) {
  const contract = readFileSync(join(root, 'DATA_CONTRACT.md'), 'utf8');
  const section = contract.match(/## User Layer[^\n]*\n([\s\S]*?)(?=\n## System Layer)/)?.[1];
  if (!section) throw new Error('DATA_CONTRACT.md does not declare a User Layer');
  return [...section.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((match) => match[1]);
}

/** Hash existing repository User Layer bytes without returning their contents. */
export function fingerprintUserLayer(root) {
  const entries = new Map();
  for (const declaration of userLayerDeclarations(root)) {
    const wildcard = declaration.search(/[\{*]/);
    const prefix = wildcard === -1 ? declaration : declaration.slice(0, wildcard).replace(/\/$/, '');
    fingerprintPath(root, join(root, prefix), entries);
  }
  return createHash('sha256')
    .update(JSON.stringify([...entries].sort(([left], [right]) => left.localeCompare(right))))
    .digest('hex');
}

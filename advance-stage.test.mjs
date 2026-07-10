/**
 * advance-stage.test.mjs — Systematic test suite for advance-stage.mjs
 *
 * Covers:
 * - computeAdvance routing (agent → paired _ready; non-agent skipped with reasons)
 * - syncPackHeader (advances Stage/Owner/Suggests, preserves content, idempotent)
 * - advanceApplications end-to-end on temp fixtures (tracker rewrite + pack sync,
 *   backup, dry-run, --force, --reconcile, header-aware Location column, idempotency)
 *
 * Run: node advance-stage.test.mjs
 */

import {
  computeAdvance,
  syncPackHeader,
  advanceApplications,
  applyStatusToLine,
  findPack,
  validateCoordinationOverrideRequest,
} from './advance-stage.mjs';
import { loadStates, resolveState } from './tracker-utils.mjs';
import { resolveColumns } from './tracker-parse.mjs';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let passed = 0;
let failed = 0;
const failures = [];

function ok(label, cond) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL: ${label}`);
  }
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.log(`  FAIL: ${label}`);
    console.log(`    expected: ${e}`);
    console.log(`    actual:   ${a}`);
  }
}

const states = loadStates();

// ============================================================================
// 0. interactive coordination override boundary
// ============================================================================
console.log('\n--- 0. coordination override boundary ---');

eq('reconcile can never override coordination', validateCoordinationOverrideRequest({
  requested: true, reconcile: true, nums: [], json: false, stdinIsTTY: true, stdoutIsTTY: true,
}).reason, 'override-not-allowed-with-reconcile');
eq('override requires exactly one explicit target', validateCoordinationOverrideRequest({
  requested: true, reconcile: false, nums: [1, 2], json: false, stdinIsTTY: true, stdoutIsTTY: true,
}).reason, 'override-requires-one-target');
eq('machine-readable invocation cannot claim interactive override', validateCoordinationOverrideRequest({
  requested: true, reconcile: false, nums: [1], json: true, stdinIsTTY: true, stdoutIsTTY: true,
}).reason, 'override-requires-human-output');
eq('non-TTY invocation cannot override coordination', validateCoordinationOverrideRequest({
  requested: true, reconcile: false, nums: [1], json: false, stdinIsTTY: false, stdoutIsTTY: false,
}).reason, 'override-requires-tty');
eq('one explicit target on a TTY reaches confirmation', validateCoordinationOverrideRequest({
  requested: true, reconcile: false, nums: [93], json: false, stdinIsTTY: true, stdoutIsTTY: true,
}), { ok: true, needsConfirmation: true, num: 93 });
eq('no override needs no confirmation', validateCoordinationOverrideRequest({
  requested: false, reconcile: true, nums: [], json: true, stdinIsTTY: false, stdoutIsTTY: false,
}), { ok: true, needsConfirmation: false });

// ============================================================================
// 1. computeAdvance — routing derived from states.yml
// ============================================================================
console.log('\n--- 1. computeAdvance routing ---');

eq('Evaluated → Application Ready', computeAdvance('Evaluated', states).toLabel, 'Application Ready');
eq('Responded → Interview Ready', computeAdvance('Responded', states).toLabel, 'Interview Ready');
eq('Offer → Offer Ready', computeAdvance('Offer', states).toLabel, 'Offer Ready');
ok('Evaluated advance ok', computeAdvance('Evaluated', states).ok === true);
ok('tolerates bold + trailing date', computeAdvance('**Evaluated** (2026-01-01)', states).toLabel === 'Application Ready');
ok('alias resolves (id form)', computeAdvance('evaluated', states).toLabel === 'Application Ready');

eq('Application Ready is already-advanced', computeAdvance('Application Ready', states).reason, 'already-advanced');
eq('Applied (company) does not advance', computeAdvance('Applied', states).ok, false);
eq('Accepted is terminal', computeAdvance('Accepted', states).reason, 'terminal');
eq('Rejected is terminal', computeAdvance('Rejected', states).reason, 'terminal');
eq('unknown status flagged', computeAdvance('Totally Bogus', states).reason, 'unknown-status');
ok('paired stage is user-owned', resolveState(computeAdvance('Evaluated', states).toLabel, states).owner === 'user');

// ============================================================================
// 2. syncPackHeader — advance + preserve + idempotent
// ============================================================================
console.log('\n--- 2. syncPackHeader ---');

const ready = computeAdvance('Evaluated', states).readyRecord;
const rawPack =
  '## Next: Deepgram (#93)\n\n' +
  '**Stage:** evaluated  \n' +
  '**Owner:** agent  \n' +
  '**Suggests:** generate_application_pack  \n' +
  '**Score:** 3.85/5\n\n' +
  'Body text mentioning evaluated and agent should be untouched.\n';

const s1 = syncPackHeader(rawPack, ready);
ok('stage advanced', /\*\*Stage:\*\* application_ready/.test(s1.content));
ok('owner advanced', /\*\*Owner:\*\* user/.test(s1.content));
ok('suggests advanced', /\*\*Suggests:\*\* send_application/.test(s1.content));
ok('reports changed', s1.changed === true);
ok('hard-break spaces preserved', s1.content.includes('send_application  \n'));
ok('body text untouched', s1.content.includes('Body text mentioning evaluated and agent should be untouched.'));
ok('score line untouched', s1.content.includes('**Score:** 3.85/5'));
ok('idempotent (no change on re-run)', syncPackHeader(s1.content, ready).changed === false);

const interviewReady = computeAdvance('Responded', states).readyRecord;
const respondedPack = '**Stage:** responded  \n**Owner:** agent  \n**Suggests:** generate_interview_cheatsheet  \n';
const s2 = syncPackHeader(respondedPack, interviewReady);
ok('responded pack → interview_ready/attend', /\*\*Stage:\*\* interview_ready/.test(s2.content) && /\*\*Suggests:\*\* attend_interview_and_report/.test(s2.content));

// ============================================================================
// 3. applyStatusToLine — header-aware cell rewrite
// ============================================================================
console.log('\n--- 3. applyStatusToLine ---');

const legacyLine = '| 93 | 2026-06-24 | Deepgram | Backend Engineer | 3.85/5 | Evaluated | ✅ | [112](../reports/112.md) | keep me |';
const legacyMap = resolveColumns([legacyLine]);
const rewritten = applyStatusToLine(legacyLine, legacyMap, 'Application Ready');
ok('status replaced', / Application Ready /.test(rewritten));
ok('no longer Evaluated', !/ Evaluated /.test(rewritten));
ok('score preserved', rewritten.includes('3.85/5'));
ok('notes preserved', rewritten.includes('keep me'));

// header-aware: an inserted Location column must not shift the target
const locHeader = '| # | Date | Company | Role | Location | Score | Status | PDF | Report | Notes |';
const locSep = '|---|------|---------|------|----------|-------|--------|-----|--------|-------|';
const locRow = '| 7 | 2026-01-01 | Foo | Bar | Remote | 4.0/5 | Evaluated | ✅ | [007](../reports/007.md) | n |';
const locMap = resolveColumns([locHeader, locSep, locRow]);
const locRewritten = applyStatusToLine(locRow, locMap, 'Application Ready');
ok('Location-column layout: status replaced', / Application Ready /.test(locRewritten));
ok('Location-column layout: location preserved', locRewritten.includes('Remote') && locRewritten.includes('4.0/5'));

// ============================================================================
// 4. advanceApplications — end-to-end on temp fixtures
// ============================================================================
console.log('\n--- 4. advanceApplications (temp FS) ---');

function scaffold() {
  const dir = mkdtempSync(join(tmpdir(), 'advance-stage-'));
  const dataDir = join(dir, 'data');
  const packsDir = join(dir, 'output', 'next-packs');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(packsDir, { recursive: true });
  const appsFile = join(dataDir, 'applications.md');
  writeFileSync(
    appsFile,
    [
      '# Applications Tracker',
      '',
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|------|---------|------|-------|--------|-----|--------|-------|',
      '| 84 | 2026-06-24 | Vercel | Software Engineer, AI SDK | 3.80/5 | Evaluated | ✅ | [099](../reports/099.md) | note84 |',
      '| 93 | 2026-06-24 | Deepgram | Backend Engineer | 3.85/5 | Evaluated | ✅ | [112](../reports/112.md) | note93 |',
      '| 50 | 2026-06-20 | Foo | Platform Engineer | 3.10/5 | Applied | ❌ | [050](../reports/050.md) | note50 |',
      '| 60 | 2026-06-20 | Bar | Data Engineer | 3.20/5 | Evaluated | ❌ | [060](../reports/060.md) | note60 |',
      '',
    ].join('\n'),
    'utf-8',
  );
  const packHeader = (id) =>
    `## Next (#${id})\n\n**Stage:** evaluated  \n**Owner:** agent  \n**Suggests:** generate_application_pack  \n\nbody\n`;
  writeFileSync(join(packsDir, '084-vercel.md'), packHeader(84), 'utf-8');
  writeFileSync(join(packsDir, '093-deepgram.md'), packHeader(93), 'utf-8');
  // #60 has NO pack on disk; #50 is Applied (company-owned).
  return { dir, appsFile, packsDir };
}

// 4a. Explicit advance of rows that have packs
{
  const { dir, appsFile, packsDir } = scaffold();
  const { results, wrote } = advanceApplications({ appsFile, packsDir, nums: [84, 93], states });
  ok('4a: wrote', wrote === true);
  ok('4a: #84 advanced', results.find((r) => r.num === 84)?.to === 'Application Ready');
  ok('4a: #93 advanced', results.find((r) => r.num === 93)?.to === 'Application Ready');
  const tracker = readFileSync(appsFile, 'utf-8');
  ok('4a: tracker shows Application Ready for #84', /\| 84 \|.*\| Application Ready \|/.test(tracker));
  ok('4a: tracker shows Application Ready for #93', /\| 93 \|.*\| Application Ready \|/.test(tracker));
  ok('4a: backup written', existsSync(appsFile + '.bak'));
  ok('4a: backup preserves original Evaluated', /\| 84 \|.*\| Evaluated \|/.test(readFileSync(appsFile + '.bak', 'utf-8')));
  const pack84 = readFileSync(join(packsDir, '084-vercel.md'), 'utf-8');
  ok('4a: pack #84 header synced', /\*\*Suggests:\*\* send_application/.test(pack84) && /\*\*Stage:\*\* application_ready/.test(pack84));
  rmSync(dir, { recursive: true, force: true });
}

// 4b. Row without a pack is skipped unless --force
{
  const { dir, appsFile, packsDir } = scaffold();
  const res1 = advanceApplications({ appsFile, packsDir, nums: [60], states });
  ok('4b: #60 skipped (no pack)', res1.results.find((r) => r.num === 60)?.reason === 'no-pack');
  ok('4b: nothing written', res1.wrote === false);
  const res2 = advanceApplications({ appsFile, packsDir, nums: [60], force: true, states });
  ok('4b: #60 advances with --force', res2.results.find((r) => r.num === 60)?.to === 'Application Ready');
  ok('4b: forced advance wrote', res2.wrote === true);
  rmSync(dir, { recursive: true, force: true });
}

// 4c. Non-agent + missing rows are skipped with reasons
{
  const { dir, appsFile, packsDir } = scaffold();
  const { results } = advanceApplications({ appsFile, packsDir, nums: [50, 999], force: true, states });
  ok('4c: #50 (Applied) not advanced', results.find((r) => r.num === 50)?.ok === false);
  ok('4c: #999 not-in-tracker', results.find((r) => r.num === 999)?.reason === 'not-in-tracker');
  rmSync(dir, { recursive: true, force: true });
}

// 4d. dry-run writes nothing
{
  const { dir, appsFile, packsDir } = scaffold();
  const before = readFileSync(appsFile, 'utf-8');
  const { wrote } = advanceApplications({ appsFile, packsDir, nums: [84, 93], dryRun: true, states });
  ok('4d: dry-run reports not written', wrote === false);
  ok('4d: tracker unchanged', readFileSync(appsFile, 'utf-8') === before);
  ok('4d: no backup created', !existsSync(appsFile + '.bak'));
  ok('4d: pack unchanged', /\*\*Suggests:\*\* generate_application_pack/.test(readFileSync(join(packsDir, '084-vercel.md'), 'utf-8')));
  rmSync(dir, { recursive: true, force: true });
}

// 4e. --reconcile advances only agent rows with packs
{
  const { dir, appsFile, packsDir } = scaffold();
  const { results } = advanceApplications({ appsFile, packsDir, reconcile: true, states });
  const advanced = results.filter((r) => r.ok).map((r) => r.num).sort((a, b) => a - b);
  eq('4e: reconcile advances exactly #84 and #93', advanced, [84, 93]);
  rmSync(dir, { recursive: true, force: true });
}

// 4f. idempotency — a second pass is a no-op (rows already advanced)
{
  const { dir, appsFile, packsDir } = scaffold();
  advanceApplications({ appsFile, packsDir, nums: [84, 93], states });
  const second = advanceApplications({ appsFile, packsDir, nums: [84, 93], states });
  ok('4f: second pass writes nothing', second.wrote === false);
  ok('4f: #84 reported already-advanced', second.results.find((r) => r.num === 84)?.reason === 'already-advanced');
  rmSync(dir, { recursive: true, force: true });
}

// 4g. findPack matches zero-padded and bare prefixes
{
  const { dir, packsDir } = scaffold();
  ok('4g: findPack matches 84 via 084- prefix', findPack(84, packsDir)?.rel.endsWith('084-vercel.md'));
  ok('4g: findPack returns null for missing', findPack(777, packsDir) === null);
  rmSync(dir, { recursive: true, force: true });
}

// 4h. a qualifying pack routes evaluated → Qualifying Ready (not Application Ready)
{
  const { dir, appsFile, packsDir } = scaffold();
  // #84's pack is a qualifying question, not an application pack.
  writeFileSync(
    join(packsDir, '084-vercel.md'),
    '## Next (#84)\n\n**Stage:** evaluated  \n**Owner:** agent  \n**Suggests:** draft_qualifying_questions  \n\nbody\n',
    'utf-8',
  );
  const { results } = advanceApplications({ appsFile, packsDir, nums: [84, 93], states });
  eq('4h: #84 (qualifying pack) → Qualifying Ready', results.find((r) => r.num === 84)?.to, 'Qualifying Ready');
  eq('4h: #93 (app pack) → Application Ready', results.find((r) => r.num === 93)?.to, 'Application Ready');
  const tracker = readFileSync(appsFile, 'utf-8');
  ok('4h: tracker shows Qualifying Ready for #84', /\| 84 \|.*\| Qualifying Ready \|/.test(tracker));
  const pack84 = readFileSync(join(packsDir, '084-vercel.md'), 'utf-8');
  ok('4h: pack #84 synced to send_qualifying_questions', /\*\*Suggests:\*\* send_qualifying_questions/.test(pack84) && /\*\*Stage:\*\* qualifying_ready/.test(pack84));
  rmSync(dir, { recursive: true, force: true });
}

// 4i. candidacy coordination is a deterministic last line of defence: a pack
// generated for a suppressed sibling cannot advance the tracker accidentally.
{
  const { dir, appsFile, packsDir } = scaffold();
  const coordination = {
    eligible: [{ num: 84 }],
    suppressed: [{ num: 93, reason: 'reserved-primary', clusterId: 'shared-engineering', primary: 84 }],
  };
  const { results } = advanceApplications({
    appsFile,
    packsDir,
    nums: [84, 93],
    states,
    coordination,
  });
  eq('4i: eligible Primary advances', results.find((r) => r.num === 84)?.to, 'Application Ready');
  eq('4i: suppressed sibling is refused', results.find((r) => r.num === 93)?.reason, 'candidacy-reserved-primary');
  eq('4i: refusal carries Primary', results.find((r) => r.num === 93)?.primary, 84);
  rmSync(dir, { recursive: true, force: true });
}

// 4j. an explicit interactive override is the only escape hatch for a known
// suppressed sibling; it does not weaken the default automation path.
{
  const { dir, appsFile, packsDir } = scaffold();
  const coordination = {
    eligible: [{ num: 84 }],
    suppressed: [{ num: 93, reason: 'cluster-choice', clusterId: 'shared-engineering', primary: 84 }],
  };
  const { results } = advanceApplications({
    appsFile,
    packsDir,
    nums: [93],
    states,
    coordination,
    coordinationOverride: true,
  });
  eq('4j: explicit coordination override advances sibling', results.find((r) => r.num === 93)?.to, 'Application Ready');
  rmSync(dir, { recursive: true, force: true });
}

// 4k. an unknown suppression reason still blocks safely and cannot leak an
// arbitrary public reason string through the canonical advancer contract.
{
  const { dir, appsFile, packsDir } = scaffold();
  const coordination = {
    eligible: [],
    suppressed: [{ num: 84, reason: 'typo-from-caller', clusterId: 'shared-engineering', primary: 93 }],
  };
  const { results } = advanceApplications({ appsFile, packsDir, nums: [84], states, coordination });
  eq('4k: unknown reason fails closed with canonical label', results[0].reason, 'candidacy-invalid-suppression');
  rmSync(dir, { recursive: true, force: true });
}

// ============================================================================
// Summary
// ============================================================================
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

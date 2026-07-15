import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pass, fail } from '../helpers.mjs';
import { migrateApproaches } from '../../migrate-approaches.mjs';
import { readApproachAttempts } from '../../approach-attempts.mjs';

function ok(label, condition) {
  if (condition) pass(label);
  else fail(label);
}

const root = mkdtempSync(join(tmpdir(), 'career-ops-migrate-'));
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const appsFile = join(dataDir, 'applications.md');
const attemptsFile = join(dataDir, 'approach-attempts.md');
const followupsFile = join(dataDir, 'follow-ups.md');
const packsDir = join(root, 'output', 'next-packs');
mkdirSync(packsDir, { recursive: true });
const historicalPack = join(packsDir, '313-two.md');
const historicalBytes = Buffer.from('# Historical #313 pack\n\nAlready executed.\n');
writeFileSync(historicalPack, historicalBytes);

const legacy = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '| 1 | 2026-07-01 | One | Engineer | 4.0/5 | Application Ready | ✅ | [1](../reports/1.md) | pack ready |',
  '| 313 | 2026-07-02 | Two | Engineer | 4.1/5 | Applied | ✅ | [313](../reports/313.md) | Applied 2026-07-09; initial LinkedIn outreach sent 2026-07-10 to Ada Founder. |',
  '| 3 | 2026-07-03 | Three | Engineer | 4.2/5 | Qualifying Ready | ✅ | [3](../reports/3.md) | question drafted |',
  '| 4 | 2026-07-04 | Four | Engineer | 4.3/5 | Qualifying Sent | ✅ | [4](../reports/4.md) | Qualifying question sent 2026-07-08 via email to Bob Recruiter. |',
  '| 5 | 2026-07-05 | Five | Engineer | 4.4/5 | Outreach Ready | ✅ | [5](../reports/5.md) | Applied 2026-07-07; outreach drafted, not sent. |',
  '| 6 | 2026-07-06 | Six | Engineer | 4.5/5 | Responded | ✅ | [6](../reports/6.md) | interview invite |',
  '| 7 | 2026-07-07 | Seven | Engineer | 4.6/5 | Applied | ✅ | [7](../reports/7.md) | submission confirmed without a date |',
  '| 8 | 2026-07-08 | Eight | Engineer | 4.0/5 | Outreach Ready | ✅ | [8](../reports/8.md) | outreach drafted, not sent |',
  '',
].join('\n');
writeFileSync(appsFile, legacy);
writeFileSync(followupsFile, [
  '# Follow-ups',
  '',
  '| num | appNum | date | company | role | channel | contact | notes |',
  '|---|---|---|---|---|---|---|---|',
  '| 1 | 313 | 2026-07-12 | Two | Engineer | Email | Ada Founder | Sent a useful update |',
  '',
].join('\n'));

try {
  const preview = await migrateApproaches({ appsFile, attemptsFile, followupsFile, apply: false });
  ok('migration defaults to a non-writing preview', preview.dryRun === true && readFileSync(appsFile, 'utf-8') === legacy);
  ok('preview reports ambiguous legacy evidence instead of guessing', preview.ambiguities.some((item) => item.opportunity === 7 && item.field === 'date'));
  ok('preview does not create attempt storage', !existsSync(attemptsFile));

  const applied = await migrateApproaches({ appsFile, attemptsFile, followupsFile, apply: true });
  const tracker = readFileSync(appsFile, 'utf-8');
  ok('Application Ready becomes Approach Ready', /\| 1 \|.*\| Approach Ready \|/.test(tracker));
  ok('Applied with confirmed evidence becomes Approached', /\| 313 \|.*\| Approached \|/.test(tracker));
  ok('Qualifying Ready becomes Approach Ready', /\| 3 \|.*\| Approach Ready \|/.test(tracker));
  ok('Qualifying Sent becomes Approached', /\| 4 \|.*\| Approached \|/.test(tracker));
  ok('Outreach Ready becomes Approached', /\| 5 \|.*\| Approached \|/.test(tracker));
  ok('ambiguous Applied falls back to Approach Ready', /\| 7 \|.*\| Approach Ready \|/.test(tracker));
  ok('unsent Outreach Ready remains Approach Ready', /\| 8 \|.*\| Approach Ready \|/.test(tracker));
  ok('downstream lifecycle remains unchanged', /\| 6 \|.*\| Responded \|/.test(tracker));
  ok('migration writes a tracker backup before applying', applied.backups.some((path) => path.startsWith(appsFile) && existsSync(path)));

  const attempts = readApproachAttempts(attemptsFile);
  ok('#313 formal submission becomes an attempt', attempts.some((a) => a.opportunity === 313 && a.type === 'formal_application' && a.date === '2026-07-09'));
  ok('#313 confirmed LinkedIn action becomes a separate attempt', attempts.some((a) => a.opportunity === 313 && a.type === 'founder_outreach' && a.channel === 'linkedin'));
  ok('confirmed qualifying question becomes an attempt', attempts.some((a) => a.opportunity === 4 && a.type === 'qualifying_question'));
  ok('pending outreach never becomes a sent attempt', !attempts.some((a) => a.opportunity === 5 && a.type.endsWith('_outreach')));
  ok('confirmed follow-up history becomes a linked attempt', attempts.some((a) => a.opportunity === 313 && a.type === 'follow_up' && a.date === '2026-07-12' && a.followUpTo));
  ok('ambiguous Applied row receives no invented attempt', !attempts.some((a) => a.opportunity === 7));
  ok('#313 historical pack remains byte-for-byte unchanged', readFileSync(historicalPack).equals(historicalBytes));

  const rerun = await migrateApproaches({ appsFile, attemptsFile, followupsFile, apply: true });
  ok('migration is idempotent', rerun.changed === false && readApproachAttempts(attemptsFile).length === attempts.length);
} finally {
  rmSync(root, { recursive: true, force: true });
}

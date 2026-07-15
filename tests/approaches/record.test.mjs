import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pass, fail } from '../helpers.mjs';
import { recordApproachAttempt, readApproachAttempts } from '../../approach-attempts.mjs';

function ok(label, condition) {
  if (condition) pass(label);
  else fail(label);
}

const root = mkdtempSync(join(tmpdir(), 'career-ops-approach-'));
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const appsFile = join(dataDir, 'applications.md');
const attemptsFile = join(dataDir, 'approach-attempts.md');

writeFileSync(appsFile, [
  '# Opportunities Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '| 42 | 2026-07-10 | Acme | Product Engineer | 4.5/5 | Approach Ready | ✅ | [42](../reports/42.md) | ready |',
  '',
].join('\n'));

try {
  const first = await recordApproachAttempt({
    appsFile,
    attemptsFile,
    opportunity: 42,
    date: '2026-07-14T10:30:00+02:00',
    type: 'founder_outreach',
    channel: 'email',
    recipient: 'Ada Founder',
    result: 'sent',
    notes: 'Shared the product teardown video.',
  });

  ok('first confirmed attempt is recorded', first.changed === true && first.attempt.id === 'A001');
  ok('a confirmed event timestamp preserves its reported precision', first.attempt.date === '2026-07-14T10:30:00+02:00');
  ok('first confirmed attempt moves the opportunity to Approached', /\| 42 \|.*\| Approached \|/.test(readFileSync(appsFile, 'utf-8')));

  const second = await recordApproachAttempt({
    appsFile,
    attemptsFile,
    opportunity: 42,
    date: '2026-07-15',
    type: 'formal_application',
    channel: 'ats',
    recipient: 'Acme hiring team',
    result: 'submitted',
  });

  ok('a second route appends another attempt', second.changed === true && second.attempt.id === 'A002');
  ok('a second route keeps the Stage Approached', /\| 42 \|.*\| Approached \|/.test(readFileSync(appsFile, 'utf-8')));

  const duplicate = await recordApproachAttempt({
    appsFile,
    attemptsFile,
    opportunity: 42,
    date: '2026-07-15',
    type: 'formal_application',
    channel: 'ats',
    recipient: 'Acme hiring team',
    result: 'submitted',
  });

  ok('retrying the same report is idempotent', duplicate.changed === false && duplicate.reason === 'duplicate');
  const attempts = readApproachAttempts(attemptsFile);
  ok('only confirmed distinct actions exist in append-only history', attempts.length === 2);
  ok('formal submission remains a typed attempt', attempts[1].type === 'formal_application');

  let missingPriorRejected = false;
  try {
    await recordApproachAttempt({
      appsFile,
      attemptsFile,
      opportunity: 42,
      date: '2026-07-20',
      type: 'follow_up',
      channel: 'email',
      recipient: 'Ada Founder',
      result: 'sent',
    });
  } catch (error) {
    missingPriorRejected = /followUpTo/.test(error.message);
  }
  ok('a follow-up must reference a prior Attempt', missingPriorRejected);

  let foreignPriorRejected = false;
  try {
    await recordApproachAttempt({
      appsFile,
      attemptsFile,
      opportunity: 42,
      date: '2026-07-20',
      type: 'follow_up',
      channel: 'email',
      recipient: 'Ada Founder',
      result: 'sent',
      followUpTo: 'A999',
    });
  } catch (error) {
    foreignPriorRejected = /prior Attempt/.test(error.message);
  }
  ok('a follow-up reference must resolve on the same Opportunity', foreignPriorRejected);
} finally {
  rmSync(root, { recursive: true, force: true });
}

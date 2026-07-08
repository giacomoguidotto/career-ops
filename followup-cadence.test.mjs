/**
 * followup-cadence.test.mjs — tests for computeNextFollowupDate cadence selection.
 *
 * Focuses on the `responded` branch, where the first follow-up after a recruiter
 * reply must be scheduled with `responded_initial`, not `responded_subsequent`.
 *
 * Run: node followup-cadence.test.mjs
 */

import {
  computeNextFollowupDate,
  addDays,
  parseDate,
  DEFAULT_CADENCE,
  parseQualifyingSentDate,
  computeQualifyingUrgency,
} from './followup-cadence.mjs';

let passed = 0;
let failed = 0;
const failures = [];

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

const APP = '2026-06-30';

// The first follow-up after a recruiter response is due at appDate + responded_initial.
// responded_initial (and its profile override responded_initial_days) is otherwise only
// read by computeUrgency, so before the fix it had no effect on the scheduled date.
eq(
  'responded, no prior follow-up uses responded_initial',
  computeNextFollowupDate('responded', APP, null, 0),
  addDays(parseDate(APP), DEFAULT_CADENCE.responded_initial),
);

// Subsequent follow-ups still use responded_subsequent, counted from the last follow-up.
eq(
  'responded, with prior follow-up uses responded_subsequent',
  computeNextFollowupDate('responded', APP, '2026-07-02', 1),
  addDays(parseDate('2026-07-02'), DEFAULT_CADENCE.responded_subsequent),
);

// The initial next-date must not land after the overdue threshold, otherwise a row can be
// flagged "overdue" (daysSinceApp >= responded_subsequent) while its own next-follow-up
// date is still in the future, which is impossible for a date meant to trigger "overdue".
eq(
  'initial next follow-up is not later than the overdue threshold',
  computeNextFollowupDate('responded', APP, null, 0) <=
    addDays(parseDate(APP), DEFAULT_CADENCE.responded_subsequent),
  true,
);

// Regression: the applied branch is unchanged.
eq(
  'applied, no follow-ups uses applied_first',
  computeNextFollowupDate('applied', APP, null, 0),
  addDays(parseDate(APP), DEFAULT_CADENCE.applied_first),
);

// --- Qualifying (pre-application gate) staleness nudge ---

// The [qualifying-sent YYYY-MM-DD] marker in notes anchors the staleness clock.
eq(
  'parseQualifyingSentDate reads the marker',
  parseQualifyingSentDate('visa gate; [qualifying-sent 2026-06-28]'),
  '2026-06-28',
);
eq('parseQualifyingSentDate is case-insensitive', parseQualifyingSentDate('[QUALIFYING-SENT 2026-01-02]'), '2026-01-02');
eq('parseQualifyingSentDate null when absent', parseQualifyingSentDate('no marker here'), null);
eq('parseQualifyingSentDate null on empty', parseQualifyingSentDate(''), null);

// Before the stale threshold it is a normal wait; on/after it, decide apply-or-discard.
eq('qualifying fresh (3d) waits', computeQualifyingUrgency(3), 'waiting');
eq('qualifying at threshold (7d) is overdue', computeQualifyingUrgency(DEFAULT_CADENCE.qualifying_stale), 'overdue');
eq('qualifying stale (10d) is overdue', computeQualifyingUrgency(10), 'overdue');
eq('qualifying respects a custom cadence', computeQualifyingUrgency(5, { qualifying_stale: 4 }), 'overdue');
eq('qualifying_stale default is 7', DEFAULT_CADENCE.qualifying_stale, 7);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('Failures:', failures.join(', '));
  process.exit(1);
}

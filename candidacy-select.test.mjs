#!/usr/bin/env node

import { loadStates } from './tracker-utils.mjs';
import {
  decisionFromTrackerNotes,
  parseClusterRegistry,
  selectCandidacyCandidates,
} from './candidacy-select.mjs';

let passed = 0;
let failed = 0;

function eq(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`FAIL: ${label}`);
  console.error(`  expected: ${JSON.stringify(expected)}`);
  console.error(`  actual:   ${JSON.stringify(actual)}`);
}

const states = loadStates();
const row = (num, company, status, score, role = `Role ${num}`) => ({
  num,
  company,
  role,
  status,
  score: `${score}/5`,
  notes: '',
  report: '',
});
const cluster = (id, company, members, primary = null) => ({
  id,
  company,
  surface: id,
  confidence: 'High',
  members,
  primary,
  outreachAnchor: null,
  evidence: '[fixture](https://example.com/source)',
  reviewed: '2026-07-10',
});
const decisions = (entries) => new Map(entries);
const nums = (items) => items.map((item) => item.num).sort((a, b) => a - b);

// A progressed Primary reserves the surface and suppresses its agent-owned siblings.
{
  const result = selectCandidacyCandidates({
    rows: [
      row(311, 'BLP Digital', 'Evaluated', 4.1),
      row(312, 'BLP Digital', 'Evaluated', 4.05),
      row(313, 'BLP Digital', 'Applied', 4.15),
    ],
    clusters: [cluster('blp-engineering', 'BLP Digital', [311, 312, 313], 313)],
    states,
    decisionByNum: decisions([[311, 'apply'], [312, 'apply'], [313, 'apply']]),
  });
  eq('reserved cluster selects no sibling', nums(result.eligible), []);
  eq('reserved cluster suppresses both evaluated siblings', nums(result.suppressed), [311, 312]);
  eq('reserved cluster reports its effective Primary', result.clusters[0].effectivePrimary, 313);
}

// Same company is not the boundary: independently researched surfaces advance independently.
// Inside an unreserved surface, decision outranks score (Apply beats Consider).
{
  const result = selectCandidacyCandidates({
    rows: [
      row(1, 'LargeCo', 'Evaluated', 4.9),
      row(2, 'LargeCo', 'Evaluated', 4.1),
      row(3, 'LargeCo', 'Evaluated', 3.9),
    ],
    clusters: [
      cluster('largeco-platform', 'LargeCo', [1, 2]),
      cluster('largeco-solutions', 'LargeCo', [3]),
    ],
    states,
    decisionByNum: decisions([[1, 'consider'], [2, 'apply'], [3, 'apply']]),
  });
  eq('one winner per independent surface', nums(result.eligible), [2, 3]);
  eq('lower-decision sibling suppressed despite higher score', nums(result.suppressed), [1]);
}

// Missing classification blocks implicit selection for that company instead of guessing.
{
  const result = selectCandidacyCandidates({
    rows: [row(10, 'UnknownCo', 'Evaluated', 4.3), row(11, 'UnknownCo', 'Evaluated', 4.2)],
    clusters: [],
    states,
  });
  eq('unclassified related rows are not eligible', nums(result.eligible), []);
  eq('unclassified related rows require research', result.researchRequired.map((item) => item.company), ['UnknownCo']);
  eq('both unclassified rows are blocked', nums(result.suppressed), [10, 11]);
}

// An Accepted member permanently suppresses sibling applications even without a stored Primary.
{
  const result = selectCandidacyCandidates({
    rows: [row(20, 'WonCo', 'Accepted', 4.5), row(21, 'WonCo', 'Evaluated', 4.4)],
    clusters: [cluster('wonco-engineering', 'WonCo', [20, 21])],
    states,
  });
  eq('accepted cluster has no eligible sibling', nums(result.eligible), []);
  eq('accepted member becomes effective Primary', result.clusters[0].effectivePrimary, 20);
  eq('accepted sibling suppression is explicit', result.suppressed[0].reason, 'accepted-primary');
}

// A released Primary does not reserve the surface; the best remaining sibling becomes eligible.
{
  const result = selectCandidacyCandidates({
    rows: [
      row(30, 'RetryCo', 'Rejected', 4.8),
      row(31, 'RetryCo', 'Evaluated', 4.1),
      row(32, 'RetryCo', 'Evaluated', 4.3),
    ],
    clusters: [cluster('retryco-engineering', 'RetryCo', [30, 31, 32], 30)],
    states,
    decisionByNum: decisions([[31, 'apply'], [32, 'apply']]),
  });
  eq('released Primary lets best sibling advance', nums(result.eligible), [32]);
  eq('other remaining sibling is suppressed', nums(result.suppressed), [31]);
}

// Later agent-owned stages are more actionable than an evaluated sibling.
{
  const result = selectCandidacyCandidates({
    rows: [row(40, 'ProgressCo', 'Responded', 3.8), row(41, 'ProgressCo', 'Evaluated', 4.9)],
    clusters: [cluster('progressco-engineering', 'ProgressCo', [40, 41])],
    states,
  });
  eq('progressed agent-owned member remains eligible', nums(result.eligible), [40]);
  eq('evaluated sibling cannot outrank progressed candidacy', nums(result.suppressed), [41]);
}

// A newly added active member makes a cached company classification incomplete.
{
  const result = selectCandidacyCandidates({
    rows: [row(50, 'GrowingCo', 'Evaluated', 4.2), row(51, 'GrowingCo', 'Evaluated', 4.1)],
    clusters: [cluster('growingco-existing', 'GrowingCo', [50])],
    states,
  });
  eq('classification membership drift requires research', result.researchRequired[0].unclassified, [51]);
  eq('membership drift blocks both implicit candidates', nums(result.suppressed), [50, 51]);
}

// Registry and current-note parsers are deterministic inputs to the selector.
{
  const registry = [
    '# Candidacy Clusters',
    '',
    '| Cluster ID | Company | Hiring surface | Confidence | Members | Primary | Outreach anchor | Evidence | Reviewed |',
    '|---|---|---|---|---|---|---|---|---|',
    '| acme-platform | Acme | Platform | Medium | #7, #8 | #8 | #8 | [source](https://example.com) | 2026-07-10 |',
  ].join('\n');
  const parsed = parseClusterRegistry(registry);
  eq('registry parser reads tracker-number fields', parsed.map((item) => ({ members: item.members, primary: item.primary, outreach: item.outreachAnchor })), [{ members: [7, 8], primary: 8, outreach: 8 }]);
  eq('latest re-evaluation decision wins in tracker notes', decisionFromTrackerNotes('Research first: old; [re-evaluated 2026-07-09] APPLY: current'), 'apply');
}

// Registry corruption cannot make one Application eligible through two surfaces.
{
  const result = selectCandidacyCandidates({
    rows: [row(60, 'DuplicateCo', 'Evaluated', 4.2)],
    clusters: [
      cluster('duplicateco-a', 'DuplicateCo', [60]),
      cluster('duplicateco-b', 'DuplicateCo', [60]),
    ],
    states,
  });
  eq('multiply classified row requires research', result.researchRequired[0].multiplyClassified, [60]);
  eq('multiply classified row is never eligible twice', nums(result.eligible), []);
}

// A foreign-company row invalidates the cached classification and forces research.
{
  const result = selectCandidacyCandidates({
    rows: [row(70, 'Acme', 'Evaluated', 4.2), row(71, 'OtherCo', 'Applied', 4.9)],
    clusters: [cluster('acme-platform', 'Acme', [70, 71], 71)],
    states,
  });
  eq('foreign membership blocks implicit selection', nums(result.eligible), []);
  eq('foreign membership requires research', result.researchRequired[0].invalidClusters[0].issues, ['company-mismatch:#71']);
  eq('foreign member produces an auditable warning', result.warnings.some((item) => item.type === 'company-mismatch' && item.num === 71), true);
}

// Blank evidence, unsupported confidence, and missing review date cannot become
// an authoritative suppression record merely because membership is complete.
{
  const invalid = cluster('unsupportedco-engineering', 'UnsupportedCo', [80, 81]);
  invalid.evidence = '';
  invalid.confidence = 'Certain';
  invalid.reviewed = '';
  const result = selectCandidacyCandidates({
    rows: [row(80, 'UnsupportedCo', 'Evaluated', 4.2), row(81, 'UnsupportedCo', 'Evaluated', 4.1)],
    clusters: [invalid],
    states,
  });
  eq('unsupported registry metadata blocks implicit selection', nums(result.eligible), []);
  eq('unsupported registry metadata names every issue', result.researchRequired[0].invalidClusters[0].issues, [
    'missing-evidence',
    'invalid-confidence',
    'invalid-reviewed-date',
  ]);
}

if (failed > 0) {
  console.error(`\n${passed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`\n${passed} candidacy-selection tests passed`);

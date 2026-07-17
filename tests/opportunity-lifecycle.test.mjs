import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  createFictionalOpportunityWorkspace,
  fingerprintFictionalWorkspace,
  fingerprintUserLayer,
  removeFictionalOpportunityWorkspace,
} from './fixtures/fictional-opportunity-workspace.mjs';
import {
  listOpportunities,
  readOpportunityContract,
  readOpportunity,
} from '../opportunity-lifecycle.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

test('contract and list expose every canonical Stage and Owner without writes', () => {
  const fixture = createFictionalOpportunityWorkspace({ missingOptionalFiles: true });
  try {
    const before = fingerprintFictionalWorkspace(fixture.root);
    const contract = readOpportunityContract({ root: fixture.root });
    const result = listOpportunities({ root: fixture.root });
    const after = fingerprintFictionalWorkspace(fixture.root);

    assert.equal(contract.id, 'career-ops.opportunity-lifecycle');
    assert.equal(contract.version, 1);
    assert.equal(contract.stageSchemaVersion, 3);
    assert.deepEqual(
      contract.stages.map((stage) => stage.id),
      fixture.stages.map((stage) => stage.id),
    );
    assert.deepEqual(
      new Set(contract.stages.map((stage) => stage.owner)),
      new Set(['agent', 'user', 'external', 'none']),
    );
    assert.equal(result.contract.version, contract.version);
    assert.equal(result.opportunities.length, fixture.stages.length);
    assert.deepEqual(
      result.opportunities.map((opportunity) => opportunity.stage.id),
      fixture.stages.map((stage) => stage.id),
    );
    assert.equal(result.opportunities.every((opportunity) => opportunity.capabilities.passiveRead), true);
    assert.equal(before, after);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test('passive reads leave the repository User Layer byte-identical', () => {
  const fixture = createFictionalOpportunityWorkspace({ materializeCore: true });
  try {
    const before = fingerprintUserLayer(REPO_ROOT);
    readOpportunityContract({ root: fixture.root });
    listOpportunities({ root: fixture.root, now: '2026-01-20' });
    readOpportunity({ root: fixture.root, opportunity: 1, now: '2026-01-20' });
    assert.equal(fingerprintUserLayer(REPO_ROOT), before);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test('doctor read-only mode reports onboarding without auto-copying user files', () => {
  const fixture = createFictionalOpportunityWorkspace({
    files: {
      'modes/_profile.template.md': '# Fictional profile template\n',
      'modes/_custom.template.md': '# Fictional custom template\n',
    },
  });
  try {
    const before = fingerprintFictionalWorkspace(fixture.root);
    const result = JSON.parse(execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'doctor.mjs'), '--json', '--read-only', '--target', fixture.root],
      { encoding: 'utf8' },
    ));
    assert.deepEqual(result.autoCopied, []);
    assert.equal(result.missing.includes('modes/_profile.md'), true);
    assert.equal(existsSync(join(fixture.root, 'modes', '_profile.md')), false);
    assert.equal(existsSync(join(fixture.root, 'modes', '_custom.md')), false);
    assert.equal(fingerprintFictionalWorkspace(fixture.root), before);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test('passive summaries compose Attempt, cadence, artifact, and candidacy authorities', () => {
  const fixture = createFictionalOpportunityWorkspace({
    materializeCore: true,
    opportunities: [
      {
        num: 1,
        company: 'Fictional Systems',
        role: 'Applied Researcher',
        stage: 'applied',
        report: '[report](../reports/001-fictional.md)',
        pdf: '[pdf](../output/001-fictional.pdf)',
      },
      {
        num: 2,
        company: 'Fictional Systems',
        role: 'Platform Researcher',
        stage: 'Evaluated',
      },
    ],
    attempts: [
      {
        id: 'A001',
        opportunity: 1,
        date: '2026-01-15',
        type: 'formal_application',
        channel: 'fictional_portal',
        recipient: 'Fictional Hiring Team',
        result: 'sent',
      },
    ],
    profile: [
      'followup_cadence:',
      '  applied_first_days: 2',
      '  applied_subsequent_days: 3',
      '  applied_max_followups: 2',
      '',
    ].join('\n'),
    clusters: [
      '# Candidacy clusters',
      '',
      '| Cluster ID | Company | Hiring Surface | Confidence | Members | Primary | Outreach anchor | Evidence | Reviewed |',
      '|---|---|---|---|---|---|---|---|---|',
      '| C-001 | Fictional Systems | Shared research team | high | #1, #2 | #1 | #1 | tracker note | 2026-01-16 |',
      '',
    ].join('\n'),
    approachPlans: {
      '001-fictional.md': [
        '# Fictional Approach Plan',
        '',
        '**Stage:** approach_ready',
        '**Owner:** user',
        '**Action:** execute_approach',
        '',
      ].join('\n'),
    },
    reports: {
      '001-fictional.md': '# Evaluation\n\n## Decision Snapshot\n\n**Decision:** Apply\n',
    },
    files: {
      'output/001-fictional.pdf': 'fictional pdf bytes',
    },
  });

  try {
    const before = fingerprintFictionalWorkspace(fixture.root);
    const result = listOpportunities({ root: fixture.root, now: '2026-01-20' });
    const applied = result.opportunities.find((item) => item.opportunity === 1);
    const sibling = result.opportunities.find((item) => item.opportunity === 2);
    const focused = readOpportunity({ root: fixture.root, opportunity: 1, now: '2026-01-20' });

    assert.equal(applied.stage.id, 'approached');
    assert.equal(applied.rawStage, 'applied');
    assert.deepEqual(applied.warnings, []);
    assert.deepEqual(applied.attemptAttention, {
      state: 'review_due',
      nextReview: '2026-01-17',
      followupCount: 0,
      latestAttemptId: 'A001',
    });
    assert.deepEqual(
      applied.artifacts.map((artifact) => [artifact.kind, artifact.state, artifact.format]),
      [
        ['approach-plan', 'available', 'legacy'],
        ['pdf', 'available', 'declared'],
        ['report', 'available', 'legacy'],
      ],
    );
    assert.equal(applied.candidacy.state, 'primary');
    assert.equal(applied.candidacy.clusterId, 'C-001');
    assert.equal(applied.capabilities.recordAttempt, true);
    assert.equal(sibling.candidacy.state, 'suppressed');
    assert.equal(sibling.candidacy.primary, 1);
    assert.equal(sibling.capabilities.generate, false);
    assert.equal(sibling.primaryAction.enabled, false);
    assert.equal(focused.opportunity.revision, applied.revision);
    assert.equal(focused.attempts.length, 1);
    assert.equal(focused.attempts[0].id, 'A001');
    assert.equal(focused.contract.version, 1);
    assert.deepEqual(
      new Set(applied.provenance.map((source) => source.path)),
      new Set([
        'data/applications.md',
        'templates/states.yml',
        'output/next-packs/001-fictional.md',
        'output/001-fictional.pdf',
        'reports/001-fictional.md',
        'candidacy-select.mjs',
        'data/candidacy-clusters.md',
        'data/approach-attempts.md',
        'followup-cadence.mjs',
        'config/profile.yml',
        'data/follow-ups.md',
      ]),
    );
    assert.equal(fingerprintFictionalWorkspace(fixture.root), before);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test('aliases normalize quietly while unknown values remain readable and narrowly disabled', () => {
  const fixture = createFictionalOpportunityWorkspace({
    includeAliases: true,
    includeUnknownStage: true,
    missingOptionalFiles: true,
  });
  try {
    const result = listOpportunities({ root: fixture.root, now: '2026-01-20' });
    const aliasRows = result.opportunities.slice(fixture.stages.length, -1);
    const unknown = result.opportunities.at(-1);

    assert.equal(aliasRows.length > 0, true);
    assert.equal(aliasRows.every((item) => item.stage.id && item.warnings.length === 0), true);
    assert.equal(unknown.rawStage, 'FUTURE_STAGE');
    assert.equal(unknown.stage.id, null);
    assert.equal(unknown.capabilities.passiveRead, true);
    assert.equal(unknown.capabilities.openArtifacts, true);
    assert.equal(unknown.capabilities.generate, false);
    assert.equal(unknown.capabilities.recordAttempt, false);
    assert.equal(unknown.capabilities.reportSuccessor, false);
    assert.deepEqual(unknown.warnings.map((warning) => warning.code), ['unknown-stage']);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test('legacy tracker headers and column order normalize without warnings', () => {
  const fixture = createFictionalOpportunityWorkspace({
    legacyTracker: true,
    includeAliases: true,
    missingOptionalFiles: true,
  });
  try {
    const result = listOpportunities({ root: fixture.root, now: '2026-01-20' });
    assert.equal(result.opportunities.length, fixture.opportunities.length);
    assert.equal(result.opportunities.every((item) => item.stage.id !== null), true);
    assert.equal(result.opportunities.every((item) => item.warnings.length === 0), true);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test('an alternate checkout uses its own declared tracker aliases and isolates unknown artifact formats', () => {
  const fixture = createFictionalOpportunityWorkspace({
    materializeCore: true,
    opportunities: [
      {
        num: 41,
        company: 'Alternate Root Company',
        role: 'Lifecycle Reader',
        stage: 'Evaluated',
      },
    ],
    trackerHeaders: ['Identifier', 'Organization', 'Position', 'Phase', 'Fit', 'When', 'Evidence', 'Document', 'Context'],
    trackerFields: ['num', 'company', 'role', 'status', 'score', 'date', 'report', 'pdf', 'notes'],
    trackerAliases: {
      identifier: 'num',
      when: 'date',
      organization: 'company',
      position: 'role',
      fit: 'score',
      phase: 'status',
      document: 'pdf',
      evidence: 'report',
      context: 'notes',
    },
    approachPlans: {
      '041-unknown.md': '# Unrecognized but viewable plan\n',
    },
  });
  try {
    const result = listOpportunities({ root: fixture.root, now: '2026-01-20' });
    assert.equal(result.opportunities.length, 1);
    const opportunity = result.opportunities[0];
    assert.equal(opportunity.opportunity, 41);
    assert.equal(opportunity.stage.id, 'evaluated');
    assert.equal(opportunity.artifacts[0].format, 'unknown');
    assert.equal(opportunity.capabilities.passiveRead, true);
    assert.equal(opportunity.capabilities.openArtifacts, true);
    assert.equal(opportunity.capabilities.generate, false);
    assert.equal(opportunity.capabilities.recordAttempt, false);
    assert.deepEqual(opportunity.warnings.map((warning) => warning.code), ['unknown-artifact-format']);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test('structured CLI transports contract, list, and focused reads without mutations', () => {
  const fixture = createFictionalOpportunityWorkspace({ materializeCore: true, missingOptionalFiles: true });
  try {
    const before = fingerprintFictionalWorkspace(fixture.root);
    const command = (action, extra = []) => JSON.parse(execFileSync(
      process.execPath,
      [
        `${fixture.root}/opportunity-lifecycle.mjs`,
        action,
        '--root', fixture.root,
        '--now', '2026-01-20',
        ...extra,
      ],
      { encoding: 'utf8' },
    ));

    const contract = command('contract');
    const list = command('list');
    const focused = command('read', ['--opportunity', '1']);

    assert.equal(contract.id, 'career-ops.opportunity-lifecycle');
    assert.equal(list.opportunities.length, fixture.stages.length);
    assert.equal(focused.opportunity.opportunity, 1);
    assert.equal(focused.contract.version, contract.version);
    assert.equal(fingerprintFictionalWorkspace(fixture.root), before);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test('passive core and web adapter contain no filesystem mutation or copied domain rules', () => {
  const core = readFileSync(new URL('../opportunity-lifecycle.mjs', import.meta.url), 'utf8');
  const adapter = readFileSync(new URL('../web/src/lib/core/opportunity-lifecycle.ts', import.meta.url), 'utf8');
  const mutationApis = ['writeFile', 'appendFile', 'renameSync', 'unlinkSync', 'rmSync', 'mkdirSync'];
  const copiedAuthorities = [
    'templates/states.yml',
    'followup-cadence.mjs',
    'candidacy-select.mjs',
    'approach-attempts.mjs',
    'scan.mjs',
  ];

  assert.deepEqual(mutationApis.filter((name) => core.includes(name)), []);
  assert.deepEqual(mutationApis.filter((name) => adapter.includes(name)), []);
  assert.deepEqual(copiedAuthorities.filter((name) => adapter.includes(name)), []);
  assert.equal(adapter.includes('execFileSync'), false);
});

test('focused reads use one coherent Attempt snapshot', () => {
  const fixture = createFictionalOpportunityWorkspace({
    opportunities: [{ num: 1, company: 'Fictional Co', role: 'Researcher', stage: 'Approached' }],
  });
  let reads = 0;
  const attempt = {
    id: 'A001', opportunity: 1, date: '2026-01-15', type: 'formal_application',
    channel: 'fictional_portal', recipient: 'Fictional Team', result: 'sent', followUpTo: null, notes: '',
  };
  try {
    const focused = readOpportunity({
      root: fixture.root,
      opportunity: 1,
      now: '2026-01-20',
      readAttempts: () => {
        reads += 1;
        return reads === 1 ? [attempt] : [];
      },
    });
    assert.equal(reads, 1);
    assert.equal(focused.opportunity.attempts.count, 1);
    assert.equal(focused.opportunity.attempts.latest.id, 'A001');
    assert.deepEqual(focused.attempts.map((item) => item.id), ['A001']);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test('artifact reads confine symlinks, tolerate directories, and revise when bytes change', () => {
  const outside = mkdtempSync(join(tmpdir(), 'career-ops-artifact-outside-'));
  const fixture = createFictionalOpportunityWorkspace({
    opportunities: [
      {
        num: 1,
        company: 'Fictional Co',
        role: 'Researcher',
        stage: 'Evaluated',
        report: '[report](../reports/escape.md)',
      },
      {
        num: 2,
        company: 'Directory Co',
        role: 'Researcher',
        stage: 'Evaluated',
        report: '[report](../reports)',
      },
      {
        num: 3,
        company: 'Revision Co',
        role: 'Researcher',
        stage: 'Evaluated',
        report: '[report](../reports/revision.md)',
      },
    ],
    reports: {
      'revision.md': '# Evaluation\n\n## Decision Snapshot\n\n**Decision:** Apply\n',
    },
  });
  try {
    writeFileSync(join(outside, 'secret.md'), 'outside bytes');
    symlinkSync(join(outside, 'secret.md'), join(fixture.root, 'reports', 'escape.md'));
    const first = listOpportunities({ root: fixture.root, now: '2026-01-20' });
    const escaped = first.opportunities.find((item) => item.opportunity === 1);
    const directory = first.opportunities.find((item) => item.opportunity === 2);
    const revision = first.opportunities.find((item) => item.opportunity === 3);
    assert.equal(escaped.artifacts.find((item) => item.kind === 'report').state, 'unavailable');
    assert.equal(escaped.warnings.some((warning) => warning.code === 'artifact-path-outside-root'), true);
    assert.equal(directory.artifacts.find((item) => item.kind === 'report').state, 'unavailable');
    assert.equal(directory.warnings.some((warning) => warning.code === 'artifact-not-file'), true);
    const artifactRevision = revision.artifacts.find((item) => item.kind === 'report').revision;

    writeFileSync(join(fixture.root, 'reports', 'revision.md'), '# Evaluation\n\n## Decision Snapshot\n\n**Decision:** Skip\n');
    const second = listOpportunities({ root: fixture.root, now: '2026-01-20' });
    const changed = second.opportunities.find((item) => item.opportunity === 3);
    assert.notEqual(changed.artifacts.find((item) => item.kind === 'report').revision, artifactRevision);
    assert.notEqual(second.revision, first.revision);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
    rmSync(outside, { recursive: true, force: true });
  }
});

test('unknown report and tracker formats stay visible while only unsafe actions are disabled', () => {
  const reportFixture = createFictionalOpportunityWorkspace({
    opportunities: [{
      num: 1,
      company: 'Fictional Co',
      role: 'Researcher',
      stage: 'Evaluated',
      report: '[report](../reports/future.md)',
    }],
    reports: { 'future.md': '# Future report format\n\nDecision lives elsewhere.\n' },
  });
  const trackerFixture = createFictionalOpportunityWorkspace({
    opportunities: [{ num: 7, company: 'Raw Fields Co', role: 'Researcher', stage: 'Evaluated' }],
    trackerHeaders: ['Record', 'When', 'Employer', 'Position', 'Fit', 'Phase', 'Document', 'Evidence', 'Context'],
    trackerFields: ['num', 'date', 'company', 'role', 'score', 'status', 'pdf', 'report', 'notes'],
  });
  try {
    const report = listOpportunities({ root: reportFixture.root }).opportunities[0];
    assert.equal(report.artifacts.find((item) => item.kind === 'report').format, 'unknown');
    assert.equal(report.warnings.some((warning) => warning.code === 'unknown-report-format'), true);
    assert.equal(report.capabilities.generate, false);

    const tracker = listOpportunities({ root: trackerFixture.root });
    assert.equal(tracker.warnings.some((warning) => warning.code === 'unknown-tracker-format'), true);
    assert.equal(tracker.opportunities[0].company, '');
    assert.equal(tracker.opportunities[0].rawFields.Employer, 'Raw Fields Co');
    assert.equal(tracker.opportunities[0].capabilities.generate, false);
    assert.equal(tracker.opportunities[0].capabilities.recordAttempt, false);
    assert.equal(tracker.opportunities[0].capabilities.reportSuccessor, false);
  } finally {
    removeFictionalOpportunityWorkspace(reportFixture.root);
    removeFictionalOpportunityWorkspace(trackerFixture.root);
  }
});

test('expected generated artifact kinds derive from every agent-owned Stage', () => {
  const fixture = createFictionalOpportunityWorkspace({ missingOptionalFiles: true });
  try {
    const result = listOpportunities({ root: fixture.root });
    for (const opportunity of result.opportunities.filter((item) => item.stage.owner === 'agent')) {
      assert.deepEqual(opportunity.artifacts[0], {
        kind: opportunity.stage.suggests.replace(/^generate_/, '').replace(/_/g, '-'),
        action: opportunity.stage.suggests,
        expectedAction: opportunity.stage.suggests,
        state: 'missing',
        format: 'unknown',
        path: null,
        revision: null,
      });
    }
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test('state schema version rejects non-positive and coercible invalid values', () => {
  const fixture = createFictionalOpportunityWorkspace({ missingOptionalFiles: true });
  try {
    const statesPath = join(fixture.root, 'templates', 'states.yml');
    const original = readFileSync(statesPath, 'utf8');
    for (const invalid of ['null', 'false', "''", '0', '-1']) {
      writeFileSync(statesPath, original.replace(/^version: 3$/m, `version: ${invalid}`));
      assert.equal(readOpportunityContract({ root: fixture.root }).stageSchemaVersion, null);
    }
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test('focused reads reject non-decimal and unsafe Opportunity identifiers', () => {
  const fixture = createFictionalOpportunityWorkspace({ missingOptionalFiles: true });
  try {
    for (const invalid of ['1e0', '1.0', String(Number.MAX_SAFE_INTEGER + 1)]) {
      assert.throws(
        () => readOpportunity({ root: fixture.root, opportunity: invalid }),
        /positive tracker number/,
      );
    }
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test('fictional workspace configurable paths cannot escape or cross symlink roots', () => {
  const parent = mkdtempSync(join(tmpdir(), 'career-ops-fixture-confinement-'));
  const root = join(parent, 'fixture');
  try {
    assert.throws(
      () => createFictionalOpportunityWorkspace({ root, files: { '../escaped.md': 'no' } }),
      /escapes its root/,
    );
    assert.equal(existsSync(join(parent, 'escaped.md')), false);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    assert.throws(
      () => createFictionalOpportunityWorkspace({ root, materializeCore: true, files: { 'node_modules/escaped.md': 'no' } }),
      /crosses a symlink/,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

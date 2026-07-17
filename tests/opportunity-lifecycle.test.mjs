import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createFictionalOpportunityWorkspace,
  fingerprintFictionalWorkspace,
  removeFictionalOpportunityWorkspace,
} from './fixtures/fictional-opportunity-workspace.mjs';
import {
  listOpportunities,
  readOpportunityContract,
  readOpportunity,
} from '../opportunity-lifecycle.mjs';

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
      '001-fictional.md': '# Evaluation\n\n## Summary\nFictional evidence.\n',
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
        ['report', 'available', 'declared'],
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
  assert.equal(adapter.includes('execFileSync'), true);
});

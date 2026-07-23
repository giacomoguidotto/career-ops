import { execFileSync, spawnSync } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fail, pass, ROOT } from './helpers.mjs';
import { isForkManagedCheckout } from '../update-system.mjs';
import { validateCareerSystemSource } from '../validate-career-system-source.mjs';
import { stableOpportunityIdentity } from '../scan.mjs';

console.log('\nCareer System gateway and standalone setup');

const forkReleaseWorkflow = readFileSync(
  join(ROOT, '.github/workflows/release-fork.yml'),
  'utf8',
);
const forkVersionScript = join(ROOT, 'scripts/bump-fork-version.sh');
const forkVersionSyntax = spawnSync('bash', ['-n', forkVersionScript], {
  encoding: 'utf8',
});
if (
  forkReleaseWorkflow.includes('branches: [fork/main]')
  && forkReleaseWorkflow.includes('scripts/bump-fork-version.sh')
  && forkReleaseWorkflow.includes('gh release create')
  && forkReleaseWorkflow.includes('--verify-tag')
  && forkReleaseWorkflow.includes('gh release view')
  && forkVersionSyntax.status === 0
) {
  pass('fork/main has an independent stable release path');
} else {
  fail(`fork release path is invalid: ${forkVersionSyntax.stderr}`);
}

try {
  const releaseRoot = mkdtempSync(join(tmpdir(), 'career-system-release-'));
  const releaseScript = join(releaseRoot, 'bump-fork-version.sh');
  mkdirSync(join(releaseRoot, 'scaffolder'), { recursive: true });
  cpSync(forkVersionScript, releaseScript);
  writeFileSync(join(releaseRoot, 'VERSION'), '1.23.0 # x-release-please-version\n');
  writeFileSync(join(releaseRoot, 'package.json'), '{"version":"1.23.0"}\n');
  writeFileSync(join(releaseRoot, 'scaffolder/package.json'), '{"version":"1.23.0"}\n');
  writeFileSync(join(releaseRoot, '.release-please-manifest.json'), '{".":"1.23.0"}\n');
  writeFileSync(join(releaseRoot, 'README.md'), 'release fixture\n');

  const git = (args, options = {}) => execFileSync(
    'git',
    args,
    { cwd: releaseRoot, encoding: 'utf8', ...options },
  ).trim();
  git(['init', '--initial-branch=main']);
  git(['config', 'user.name', 'release-fixture']);
  git(['config', 'user.email', 'release-fixture@example.invalid']);
  git(['add', '.']);
  git(['commit', '-m', 'chore: align native version files']);
  git(['tag', '-a', 'career-ops-v0.1.0', '-m', 'immutable audit tag']);
  writeFileSync(join(releaseRoot, 'README.md'), 'release fixture\nnext push\n');
  git(['commit', '-am', 'feat: publish correct native release']);

  const tree = git(['rev-parse', 'HEAD^{tree}']);
  const unreachable = git(['commit-tree', tree], { input: 'unreachable tag fixture\n' });
  git(['tag', '-a', 'career-ops-v9.0.0', unreachable, '-m', 'unreachable tag']);

  const dryRun = execFileSync(
    'bash',
    [releaseScript, '--dry-run'],
    { cwd: releaseRoot, encoding: 'utf8' },
  );
  const outputPath = join(releaseRoot, 'github-output');
  execFileSync(
    'bash',
    [releaseScript],
    {
      cwd: releaseRoot,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    },
  );
  const retry = execFileSync(
    'bash',
    [releaseScript],
    {
      cwd: releaseRoot,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outputPath },
    },
  );

  if (
    dryRun.includes('career-ops-v0.1.0 -> career-ops-v1.23.0')
    && !dryRun.includes('career-ops-v9.0.0')
    && git(['rev-list', '-n1', 'career-ops-v1.23.0']) === git(['rev-parse', 'HEAD'])
    && retry.includes('Release tag already points at HEAD: career-ops-v1.23.0')
    && readFileSync(outputPath, 'utf8').trim().split('\n').every(
      (line) => line === 'tag=career-ops-v1.23.0',
    )
  ) {
    pass('fork release follows aligned source versions, reachable tags, and retry safety');
  } else {
    fail(`fork release lineage or retry safety failed: ${JSON.stringify({ dryRun, retry })}`);
  }
} catch (error) {
  fail(`fork release lineage fixture failed: ${error.message}`);
}

function gateway(capability, input) {
  return JSON.parse(execFileSync(
    process.execPath,
    [join(ROOT, 'main.mjs'), capability, '--input', '-'],
    { encoding: 'utf8', input: JSON.stringify(input) },
  ));
}

function fixtureGateway(root, capability, input) {
  return JSON.parse(execFileSync(
    process.execPath,
    [join(root, 'main.mjs'), capability, '--input', '-'],
    { cwd: root, encoding: 'utf8', input: JSON.stringify(input) },
  ));
}

function profileRequest(revision = 'revision-1') {
  return {
    expected_revision: revision,
    snapshot: {
      schema: 'career.profile.snapshot/v1',
      revision,
      sections: {
        identity: {
          name: { state: 'value', value: 'Ada Example', visibility: 'private' },
          phone: { state: 'absent', visibility: 'private' },
        },
        application_defaults: {},
        opportunity_preferences: {
          target_roles: { state: 'value', value: ['Staff Engineer'], visibility: 'private' },
        },
        positioning_and_proof: {},
        communication_strategy: {},
      },
    },
  };
}

function makeSetupFixture() {
  const root = mkdtempSync(join(tmpdir(), 'career-system-setup-'));
  mkdirSync(join(root, 'lib'), { recursive: true });
  mkdirSync(join(root, '.agents/skills/career-ops'), { recursive: true });
  mkdirSync(join(root, 'modes'), { recursive: true });
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'templates'), { recursive: true });
  cpSync(join(ROOT, 'main.mjs'), join(root, 'main.mjs'));
  cpSync(join(ROOT, 'lib/career-opportunity-discovery.mjs'), join(root, 'lib/career-opportunity-discovery.mjs'));
  cpSync(join(ROOT, 'lib/career-opportunity-pursuit.mjs'), join(root, 'lib/career-opportunity-pursuit.mjs'));
  cpSync(join(ROOT, 'lib/career-requisite-snapshot.mjs'), join(root, 'lib/career-requisite-snapshot.mjs'));
  cpSync(join(ROOT, 'lib/career-system-gateway.mjs'), join(root, 'lib/career-system-gateway.mjs'));
  cpSync(join(ROOT, 'lib/career-profile-reconciliation.mjs'), join(root, 'lib/career-profile-reconciliation.mjs'));
  for (const file of [
    'DATA_CONTRACT.md',
    'opportunity-lifecycle.mjs',
    'pdf-artifact.mjs',
    'tracker-utils.mjs',
    'tracker-parse.mjs',
    'tracker-aliases.json',
    'candidacy-select.mjs',
    'followup-cadence.mjs',
    'approach-attempts.mjs',
    'approach-evidence.mjs',
    'advance-stage.mjs',
  ]) cpSync(join(ROOT, file), join(root, file));
  cpSync(join(ROOT, 'templates/states.yml'), join(root, 'templates/states.yml'));
  cpSync(join(ROOT, 'upskill.mjs'), join(root, 'upskill.mjs'));
  symlinkSync(
    join(ROOT, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  writeFileSync(join(root, '.agents/skills/career-ops/SKILL.md'), '# Career Ops\n');
  writeFileSync(join(root, 'modes/_profile.template.md'), '# Profile template\n');
  writeFileSync(join(root, 'modes/_custom.template.md'), '# Custom template\n');
  return root;
}

try {
  const described = gateway('career-system.capabilities/v1', {});
  const names = described.result.capabilities.map(({ name }) => name);
  if (
    described.interface === 'career-system-gateway/v1'
    && described.status === 'ready'
    && names.includes('career-system.capabilities/v1')
    && names.includes('career-system.check/v1')
    && names.includes('career.profile.check/v1')
    && names.includes('career.profile.reconcile/v1')
    && names.includes('career.opportunity.discover/v1')
    && names.includes('career.opportunity.select-related/v1')
    && names.includes('career.opportunity.advance/v1')
    && names.includes('career.opportunity.review-waiting/v1')
    && names.includes('career.requisite.snapshot/v1')
    && names.every((name) => /\/v[1-9]\d*$/.test(name))
  ) pass('gateway advertises only versioned capabilities');
  else fail(`unexpected capability description: ${JSON.stringify(described)}`);

  const scoped = gateway('career-system.check/v1', {
    capabilities: ['career-system.capabilities/v1', 'career-system.future/v1'],
  });
  const byName = Object.fromEntries(scoped.result.capabilities.map((item) => [item.capability, item]));
  if (
    scoped.status === 'blocked'
    && byName['career-system.capabilities/v1']?.status === 'ready'
    && byName['career-system.future/v1']?.reasons.includes('unsupported-capability')
  ) pass('readiness is scoped per requested capability');
  else fail(`unexpected scoped readiness: ${JSON.stringify(scoped)}`);

  const unversioned = spawnSync(
    process.execPath,
    [join(ROOT, 'main.mjs'), 'career-system.capabilities', '--input', '-'],
    { encoding: 'utf8', input: '{}' },
  );
  if (unversioned.status === 2 && /must use/.test(unversioned.stderr)) {
    pass('gateway rejects unversioned capability invocation');
  } else {
    fail(`unversioned invocation was not rejected: ${unversioned.status} ${unversioned.stderr}`);
  }

  const identityA = stableOpportunityIdentity({ company: 'Example GmbH', title: 'Staff Engineer (Berlin)' });
  const identityB = stableOpportunityIdentity({ company: ' example gmbh ', title: 'Staff Engineer' });
  if (identityA === identityB && /^career\.opportunity\/v1\/[a-f0-9]{24}$/.test(identityA)) {
    pass('native scanner assigns stable company-role opportunity identities');
  } else {
    fail(`opportunity identity drifted across equivalent inputs: ${identityA} ${identityB}`);
  }

  const discoveryBlockedRoot = makeSetupFixture();
  const discoveryBlocked = fixtureGateway(discoveryBlockedRoot, 'career-system.check/v1', {
    capabilities: ['career.opportunity.discover/v1'],
  });
  if (
    discoveryBlocked.status === 'blocked'
    && discoveryBlocked.result.capabilities[0]?.reasons.includes('missing:scan.mjs')
    && discoveryBlocked.result.capabilities[0]?.reasons.includes('missing:portals.yml')
    && discoveryBlocked.result.capabilities[0]?.reasons.includes('missing:providers')
  ) pass('discovery readiness reports fresh capability-scoped blockers');
  else fail(`discovery readiness missed native blockers: ${JSON.stringify(discoveryBlocked)}`);

  const discoveryRoot = makeSetupFixture();
  mkdirSync(join(discoveryRoot, 'providers'), { recursive: true });
  writeFileSync(join(discoveryRoot, 'providers/fixture.mjs'), 'export default { id: "fixture", fetch: async () => [] };\n');
  writeFileSync(join(discoveryRoot, 'portals.yml'), 'tracked_companies: []\njob_boards: []\n');
  writeFileSync(join(discoveryRoot, 'scan.mjs'), `#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'fs';
mkdirSync('data', { recursive: true });
if (!existsSync('data/pipeline.md')) writeFileSync('data/pipeline.md', 'fixture opportunity\\n');
if (!existsSync('data/scan-history.tsv')) writeFileSync('data/scan-history.tsv', 'fixture history\\n');
if (!existsSync('data/scan-runs.tsv')) writeFileSync('data/scan-runs.tsv', 'fixture run\\n');
process.stdout.write(JSON.stringify({
  contract: { id: 'career-ops.scanner.company-first', version: 1 },
  unreachableTargets: 0,
  networkErrors: 1,
  otherErrors: 0,
  unhandledSources: 0,
  malformedSources: 0,
  offers: [{
    identity: '${identityA}',
    company: 'Example GmbH',
    title: 'Staff Engineer',
    url: 'https://jobs.example.test/staff',
    location: 'Berlin',
    postedAt: '2026-07-22',
    source: 'fixture-api'
  }]
}) + '\\n');
`);

  const discoveryReady = fixtureGateway(discoveryRoot, 'career-system.check/v1', {
    capabilities: ['career.opportunity.discover/v1'],
  });
  const discoveryRequest = {
    schema: 'career.opportunity.discover.request/v1',
    target: { count: 2 },
  };
  const partialDiscovery = fixtureGateway(discoveryRoot, 'career.opportunity.discover/v1', discoveryRequest);
  const pipelinePath = join(discoveryRoot, 'data/pipeline.md');
  const pipelineMtime = statSync(pipelinePath).mtimeMs;
  const repeatedDiscovery = fixtureGateway(discoveryRoot, 'career.opportunity.discover/v1', discoveryRequest);
  if (
    discoveryReady.status === 'ready'
    && partialDiscovery.status === 'incomplete'
    && partialDiscovery.result.schema === 'career.opportunity.discover.result/v1'
    && partialDiscovery.result.discovered === 1
    && partialDiscovery.result.opportunities[0]?.identity === identityA
    && partialDiscovery.result.failures.some(({ code, count }) => code === 'network-errors' && count === 1)
    && partialDiscovery.result.artifacts.some(({ path }) => path === 'data/pipeline.md')
    && repeatedDiscovery.result.opportunities[0]?.identity === identityA
    && statSync(pipelinePath).mtimeMs === pipelineMtime
  ) pass('discovery preserves partial native work and repeated invocations keep stable identities');
  else fail(`discovery did not preserve partial or repeated work: ${JSON.stringify({ discoveryReady, partialDiscovery, repeatedDiscovery })}`);

  const malformedDiscovery = fixtureGateway(discoveryRoot, 'career.opportunity.discover/v1', {
    schema: 'career.opportunity.discover.request/v1',
    target: { count: 0 },
  });
  if (
    malformedDiscovery.status === 'failed'
    && malformedDiscovery.result.reasons.includes('target-count-must-be-a-positive-integer')
    && statSync(pipelinePath).mtimeMs === pipelineMtime
  ) pass('discovery rejects malformed requests before native writes');
  else fail(`discovery accepted malformed input: ${JSON.stringify(malformedDiscovery)}`);

  const emptyRequisiteRoot = makeSetupFixture();
  const emptyRequisiteRequest = { schema: 'career.requisite.snapshot.request/v1' };
  const emptyRequisite = fixtureGateway(
    emptyRequisiteRoot,
    'career.requisite.snapshot/v1',
    emptyRequisiteRequest,
  );
  const repeatedEmptyRequisite = fixtureGateway(
    emptyRequisiteRoot,
    'career.requisite.snapshot/v1',
    emptyRequisiteRequest,
  );
  if (
    emptyRequisite.status === 'ready'
    && emptyRequisite.result.schema === 'career.requisite.snapshot/v1'
    && emptyRequisite.result.coverage.status === 'empty'
    && emptyRequisite.result.requisites.length === 0
    && JSON.stringify(emptyRequisite) === JSON.stringify(repeatedEmptyRequisite)
  ) pass('requisite snapshots are stable when evaluated evidence is empty');
  else fail(`empty requisite snapshot was unstable or malformed: ${JSON.stringify(emptyRequisite)}`);

  const requisiteRoot = makeSetupFixture();
  mkdirSync(join(requisiteRoot, 'data'), { recursive: true });
  mkdirSync(join(requisiteRoot, 'reports'), { recursive: true });
  writeFileSync(join(requisiteRoot, 'data/applications.md'), [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    '| 1 | 2026-07-20 | Example | Platform Engineer | 2.0/5 | Evaluated | - | [Report](../reports/001-example.md) | |',
    '| 2 | 2026-07-21 | Other | Data Engineer | 3.0/5 | Evaluated | - | [Report](../reports/002-other.md) | |',
    '| 3 | 2026-07-22 | Missing | ML Engineer | 3.5/5 | Evaluated | - | [Report](../reports/003-missing.md) | |',
    '',
  ].join('\n'));
  writeFileSync(join(requisiteRoot, 'reports/001-example.md'), [
    '## Machine Summary',
    '```yaml',
    'score: 2.0',
    'hard_stops:',
    '  - Kubernetes',
    'soft_gaps:',
    '  - Terraform',
    '```',
    '',
  ].join('\n'));
  writeFileSync(join(requisiteRoot, 'reports/002-other.md'), [
    '| Gap | Severity | Evidence |',
    '|---|---|---|',
    '| Kubernetes | High | Required |',
    '| Python | Medium | Preferred |',
    '',
  ].join('\n'));
  const operationalBefore = readFileSync(join(requisiteRoot, 'data/applications.md'), 'utf8');
  const firstRequisite = fixtureGateway(
    requisiteRoot,
    'career.requisite.snapshot/v1',
    emptyRequisiteRequest,
  );
  const secondRequisite = fixtureGateway(
    requisiteRoot,
    'career.requisite.snapshot/v1',
    emptyRequisiteRequest,
  );
  const kubernetes = firstRequisite.result.requisites.find(({ label }) => label === 'Kubernetes');
  const serializedRequisites = JSON.stringify(firstRequisite.result.requisites);
  if (
    firstRequisite.status === 'incomplete'
    && firstRequisite.result.coverage.status === 'partial'
    && firstRequisite.result.coverage.reports_linked === 3
    && firstRequisite.result.coverage.reports_read === 2
    && firstRequisite.result.coverage.reports_scored === 2
    && kubernetes?.opportunity_count === 2
    && kubernetes?.low_fit_opportunity_count === 2
    && kubernetes?.prevalence === 1
    && kubernetes?.weighted_score === 5
    && kubernetes?.career_tier === 'High'
    && kubernetes?.source_references.every((reference) => /^career\.evidence\/v1\/[a-f0-9]{24}$/.test(reference))
    && JSON.stringify(secondRequisite.result.requisites) === serializedRequisites
    && secondRequisite.result.revision_token === firstRequisite.result.revision_token
    && readFileSync(join(requisiteRoot, 'data/applications.md'), 'utf8') === operationalBefore
  ) pass('requisite snapshot derives deterministic Career urgency with partial coverage and no operational writes');
  else fail(`requisite snapshot did not preserve its contract: ${JSON.stringify(firstRequisite)}`);

  writeFileSync(join(requisiteRoot, 'reports/002-other.md'), [
    '| Gap | Severity | Evidence |',
    '|---|---|---|',
    '| Kubernetes | High | Required |',
    '| Python | Medium | Preferred |',
    '| Terraform | Medium | Preferred |',
    '',
  ].join('\n'));
  const revisedRequisite = fixtureGateway(
    requisiteRoot,
    'career.requisite.snapshot/v1',
    emptyRequisiteRequest,
  );
  const prohibitedFields = /capability|knowledge|upskill|agentic/i;
  if (
    revisedRequisite.result.revision_token !== firstRequisite.result.revision_token
    && revisedRequisite.result.requisites.every((record) => (
      Object.keys(record).every((key) => !prohibitedFields.test(key))
    ))
  ) pass('native evidence revisions change opaque tokens without cross-system policy fields');
  else fail(`requisite revision or ownership boundary failed: ${JSON.stringify(revisedRequisite)}`);

  const malformedRequisite = fixtureGateway(
    requisiteRoot,
    'career.requisite.snapshot/v1',
    { schema: 'career.requisite.snapshot.request/v1', ranking_policy: 'external' },
  );
  if (
    malformedRequisite.status === 'failed'
    && malformedRequisite.result.reasons.includes('request-contains-unsupported-fields')
    && readFileSync(join(requisiteRoot, 'data/applications.md'), 'utf8') === operationalBefore
  ) pass('requisite snapshots reject malformed policy-bearing input without mutation');
  else fail(`requisite snapshot accepted malformed input: ${JSON.stringify(malformedRequisite)}`);

  const pursuitRoot = makeSetupFixture();
  mkdirSync(join(pursuitRoot, 'data'), { recursive: true });
  mkdirSync(join(pursuitRoot, 'reports'), { recursive: true });
  mkdirSync(join(pursuitRoot, 'output/next-packs'), { recursive: true });
  const pursuitTracker = [
    '# Opportunities Tracker',
    '',
    '| Opportunity | Date | Company | Role | Score | Stage | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    '| 1 | 2026-07-20 | Example | Platform Engineer | 4.5/5 | Evaluated | - | [Report](../reports/001-example.md) | |',
    '| 2 | 2026-06-01 | Waiting Co | Staff Engineer | 4.2/5 | Approached | - | - | |',
    '| 3 | 2026-07-21 | Ready Co | Principal Engineer | 4.0/5 | Approach Ready | - | - | |',
    '',
  ].join('\n');
  writeFileSync(join(pursuitRoot, 'data/applications.md'), pursuitTracker);
  writeFileSync(join(pursuitRoot, 'reports/001-example.md'), [
    '## Machine Summary',
    '```yaml',
    'final_decision: APPLY',
    '```',
    '',
  ].join('\n'));
  writeFileSync(join(pursuitRoot, 'data/approach-attempts.md'), [
    '# Approach Attempts',
    '',
    '| id | opportunity | occurredAt | type | channel | recipient | result | followUpTo | notes |',
    '|---|---|---|---|---|---|---|---|---|',
    '| A001 | 2 | 2026-06-01 | formal_application | portal | Hiring Team | sent | | |',
    '',
  ].join('\n'));
  writeFileSync(join(pursuitRoot, 'data/follow-ups.md'), '# Follow-ups\n');
  writeFileSync(join(pursuitRoot, 'data/candidacy-clusters.md'), '# Candidacy clusters\n');
  writeFileSync(join(pursuitRoot, 'config/profile.yml'), 'followup_cadence: {}\n');

  const pursuitFilesBefore = {
    tracker: readFileSync(join(pursuitRoot, 'data/applications.md'), 'utf8'),
    attempts: readFileSync(join(pursuitRoot, 'data/approach-attempts.md'), 'utf8'),
    clusters: readFileSync(join(pursuitRoot, 'data/candidacy-clusters.md'), 'utf8'),
  };
  const pursuitReadiness = fixtureGateway(pursuitRoot, 'career-system.check/v1', {
    capabilities: [
      'career.opportunity.select-related/v1',
      'career.opportunity.advance/v1',
      'career.opportunity.review-waiting/v1',
    ],
  });
  const setupPursuitReadiness = JSON.parse(execFileSync(
    process.execPath,
    [
      join(ROOT, 'skills/public/setup-career-system/scripts/setup-career-system.mjs'),
      'check',
      '--root',
      pursuitRoot,
      '--capability',
      'career.opportunity.select-related/v1',
      '--capability',
      'career.opportunity.advance/v1',
      '--capability',
      'career.opportunity.review-waiting/v1',
    ],
    { encoding: 'utf8' },
  ));
  const selected = fixtureGateway(pursuitRoot, 'career.opportunity.select-related/v1', {
    schema: 'career.opportunity.select-related.request/v1',
    personalization: { mode: 'generic-defaults' },
    as_of: '2026-07-23',
  });
  const waiting = fixtureGateway(pursuitRoot, 'career.opportunity.review-waiting/v1', {
    schema: 'career.opportunity.review-waiting.request/v1',
    personalization: { mode: 'generic-defaults' },
    as_of: '2026-07-23',
  });
  const validationPreserved = (
    readFileSync(join(pursuitRoot, 'data/applications.md'), 'utf8') === pursuitFilesBefore.tracker
    && readFileSync(join(pursuitRoot, 'data/approach-attempts.md'), 'utf8') === pursuitFilesBefore.attempts
    && readFileSync(join(pursuitRoot, 'data/candidacy-clusters.md'), 'utf8') === pursuitFilesBefore.clusters
    && !existsSync(join(pursuitRoot, '.career-ops-web'))
  );
  if (
    pursuitReadiness.status === 'ready'
    && pursuitReadiness.result.capabilities.every(({ status }) => status === 'ready')
    && setupPursuitReadiness.gateway.status === 'ready'
    && setupPursuitReadiness.changed.length === 0
    && selected.status === 'ready'
    && selected.result.status === 'completed'
    && selected.result.personalization === 'generic-defaults'
    && selected.result.selected.join(',') === 'career.opportunity/v1/1'
    && selected.result.throughput.source === 'career-default'
    && waiting.status === 'ready'
    && waiting.result.status === 'completed'
    && waiting.result.personalization === 'generic-defaults'
    && waiting.result.recommendations[0]?.reference === 'career.opportunity/v1/2'
    && waiting.result.recommendations[0]?.factual_stage_unchanged === true
    && waiting.result.evidence_sufficiency.sufficient === false
    && validationPreserved
  ) pass('pursuit readiness, selection, and wait review are Career-native, generic-safe, and read-only');
  else fail(`pursuit read contracts failed or mutated state: ${JSON.stringify({
    pursuitReadiness,
    setupPursuitReadiness,
    selected,
    waiting,
    validationPreserved,
  })}`);

  const selectedWork = selected.result.opportunities[0];
  const workRequest = {
    schema: 'career.opportunity.advance.request/v1',
    operation: 'request',
    opportunity_ref: selectedWork.reference,
    expected_stage: selectedWork.stage,
    expected_revision: selectedWork.revision,
  };
  const requestedWork = fixtureGateway(pursuitRoot, 'career.opportunity.advance/v1', workRequest);
  writeFileSync(join(pursuitRoot, 'output/next-packs/001-example.md'), [
    '## Next: Example (#1)',
    '',
    '**Stage:** evaluated  ',
    '**Owner:** agent  ',
    '**Suggests:** generate_approach_plan  ',
    '',
    '## Communication Plan',
    '',
    'Draft only. No application or message was sent.',
    '',
  ].join('\n'));
  const reconciledWork = fixtureGateway(pursuitRoot, 'career.opportunity.advance/v1', {
    ...workRequest,
    operation: 'reconcile',
  });
  const stageAfterReconcile = readFileSync(join(pursuitRoot, 'data/applications.md'), 'utf8');
  const prohibitedAdvance = fixtureGateway(pursuitRoot, 'career.opportunity.advance/v1', {
    ...workRequest,
    operation: 'record-external-event',
    message_sent: true,
  });
  if (
    requestedWork.status === 'ready'
    && requestedWork.result.status === 'completed'
    && requestedWork.result.personalization === 'generic-defaults'
    && requestedWork.result.outcome.code === 'work-requested'
    && readFileSync(join(pursuitRoot, 'data/approach-attempts.md'), 'utf8') === pursuitFilesBefore.attempts
    && reconciledWork.status === 'ready'
    && reconciledWork.result.status === 'completed'
    && reconciledWork.result.outcome.code === 'work-reconciled'
    && reconciledWork.result.required_approvals[0]?.code === 'real-world-action'
    && stageAfterReconcile.includes('| 4.5/5 | Approach Ready |')
    && prohibitedAdvance.status === 'failed'
    && prohibitedAdvance.result.reasons.includes('request-contains-unsupported-fields')
    && !prohibitedAdvance.result.outcome
    && readFileSync(join(pursuitRoot, 'data/approach-attempts.md'), 'utf8') === pursuitFilesBefore.attempts
  ) pass('Agent-owned planning advances only the draft projection and rejects asserted external events');
  else fail(`pursuit advancement crossed its evidence boundary: ${JSON.stringify({
    requestedWork,
    reconciledWork,
    prohibitedAdvance,
  })}`);

  const setupScript = join(ROOT, 'skills/public/setup-career-system/scripts/setup-career-system.mjs');
  const checkRoot = makeSetupFixture();
  const check = JSON.parse(execFileSync(
    process.execPath,
    [setupScript, 'check', '--root', checkRoot],
    { encoding: 'utf8' },
  ));
  if (
    check.mode === 'check'
    && check.status === 'blocked'
    && check.import_ready.status === 'ready'
    && check.operational_ready.status === 'blocked'
    && check.changed.length === 0
    && !existsSync(join(checkRoot, 'modes/_profile.md'))
    && !existsSync(join(checkRoot, 'modes/_custom.md'))
  ) pass('setup check is read-only and reports missing user inputs');
  else fail(`setup check mutated or misreported: ${JSON.stringify(check)}`);

  const reconcileRoot = makeSetupFixture();
  const first = JSON.parse(execFileSync(
    process.execPath,
    [setupScript, 'reconcile', '--root', reconcileRoot],
    { encoding: 'utf8' },
  ));
  const second = JSON.parse(execFileSync(
    process.execPath,
    [setupScript, 'reconcile', '--root', reconcileRoot],
    { encoding: 'utf8' },
  ));
  if (
    first.changed.join(',') === 'modes/_profile.md,modes/_custom.md'
    && readFileSync(join(reconcileRoot, 'modes/_profile.md'), 'utf8') === '# Profile template\n'
    && first.import_ready.status === 'ready'
    && first.operational_ready.status === 'blocked'
    && second.changed.length === 0
  ) pass('setup reconcile applies safe deltas and is idempotent');
  else fail(`setup reconcile was not idempotent: ${JSON.stringify({ first, second })}`);

  const profileRoot = makeSetupFixture();
  const operationalFiles = {
    'data/applications.md': 'applications\n',
    'reports/001-example.md': 'report\n',
    'data/status-log.tsv': 'attempt\toutcome\n',
    'data/follow-ups.md': 'follow-up\n',
    'data/offers/example.md': 'offer\n',
    'data/scan-history.tsv': 'observation\n',
    'output/application-pack.pdf': 'generated artifact\n',
  };
  for (const [path, content] of Object.entries(operationalFiles)) {
    mkdirSync(join(profileRoot, path, '..'), { recursive: true });
    writeFileSync(join(profileRoot, path), content);
  }

  const request = profileRequest();
  const proposed = fixtureGateway(profileRoot, 'career.profile.check/v1', request);
  const driftedRequest = structuredClone(request);
  driftedRequest.expected_revision = 'revision-2';
  const revisionBlocked = fixtureGateway(profileRoot, 'career.profile.reconcile/v1', driftedRequest);
  if (
    proposed.result.status === 'drifted'
    && proposed.result.changed.length === 0
    && proposed.result.actions.some(({ action }) => action === 'change')
    && !existsSync(join(profileRoot, 'config/career-profile.json'))
    && revisionBlocked.status === 'blocked'
    && revisionBlocked.result.reasons.includes('source-revision-drift')
  ) pass('profile check is read-only and source revision drift blocks reconciliation');
  else fail(`profile check or revision guard failed: ${JSON.stringify({ proposed, revisionBlocked })}`);

  const reconciled = fixtureGateway(profileRoot, 'career.profile.reconcile/v1', request);
  const projectionPath = join(profileRoot, 'config/career-profile.json');
  const firstProjection = readFileSync(projectionPath, 'utf8');
  const firstMtime = statSync(projectionPath).mtimeMs;
  const identical = fixtureGateway(profileRoot, 'career.profile.reconcile/v1', request);
  const secondProjection = readFileSync(projectionPath, 'utf8');
  const operationalPreserved = Object.entries(operationalFiles)
    .every(([path, content]) => readFileSync(join(profileRoot, path), 'utf8') === content);
  if (
    reconciled.result.status === 'converged'
    && reconciled.result.changed.join(',') === 'config/career-profile.json'
    && identical.result.status === 'converged'
    && identical.result.changed.length === 0
    && firstProjection === secondProjection
    && statSync(projectionPath).mtimeMs === firstMtime
    && operationalPreserved
  ) pass('profile reconcile is delta-only, idempotent, and preserves all operational state');
  else fail(`profile reconciliation violated preservation or idempotence: ${JSON.stringify({ reconciled, identical })}`);

  const partial = profileRequest('revision-2');
  partial.snapshot.sections.identity.name = { state: 'unresolved', visibility: 'private' };
  partial.snapshot.sections.opportunity_preferences.target_roles.value = ['Principal Engineer'];
  const partialResult = fixtureGateway(profileRoot, 'career.profile.reconcile/v1', partial);
  const partialProjection = JSON.parse(readFileSync(projectionPath, 'utf8'));
  if (
    partialResult.status === 'blocked'
    && partialResult.result.changed.join(',') === 'config/career-profile.json'
    && partialResult.result.actions.some(({ field, action }) => field === 'identity.name' && action === 'blocked')
    && partialProjection.sections.identity.name.value === 'Ada Example'
    && partialProjection.sections.opportunity_preferences.target_roles.value[0] === 'Principal Engineer'
  ) pass('unresolved fields preserve native values while independent safe deltas reconcile');
  else fail(`profile reconcile did not isolate an unresolved field: ${JSON.stringify(partialResult)}`);

  const malformed = profileRequest();
  delete malformed.snapshot.sections.communication_strategy;
  const malformedResult = fixtureGateway(profileRoot, 'career.profile.check/v1', malformed);
  if (
    malformedResult.status === 'failed'
    && malformedResult.result.reasons.includes('snapshot-must-contain-exactly-the-five-managed-sections')
  ) pass('profile gateway rejects incomplete authoritative snapshots');
  else fail(`profile gateway accepted a malformed snapshot: ${JSON.stringify(malformedResult)}`);

  const sourceErrors = validateCareerSystemSource(ROOT);
  if (sourceErrors.length === 0) pass('source validator accepts the canonical public export');
  else fail(`source validator rejected canonical source: ${sourceErrors.join('; ')}`);

  if (isForkManagedCheckout(ROOT)) {
    const updaterSource = readFileSync(join(ROOT, 'update-system.mjs'), 'utf8');
    const guardIndex = updaterSource.indexOf('if (isForkManagedCheckout())');
    const fetchIndex = updaterSource.indexOf("git('fetch', CANONICAL_REPO, 'main')");
    if (guardIndex >= 0 && fetchIndex > guardIndex) {
      pass('upstream auto-update blocks before mutation when the fork gateway is present');
    } else {
      fail('fork updater guard does not run before upstream fetch');
    }
  } else {
    fail('fork-owned Career gateway surface is not detectable');
  }

  const boundaryRoot = mkdtempSync(join(tmpdir(), 'career-system-boundary-'));
  mkdirSync(join(boundaryRoot, 'skills/public/setup-career-system'), { recursive: true });
  mkdirSync(join(boundaryRoot, 'lib'), { recursive: true });
  writeFileSync(join(boundaryRoot, 'skills/public/setup-career-system/SKILL.md'), '---\nname: setup-career-system\n---\n');
  writeFileSync(join(boundaryRoot, 'lib/native.mjs'), 'export const owner = "Agentic OS";\n');
  const boundaryErrors = validateCareerSystemSource(boundaryRoot);
  if (boundaryErrors.some((error) => /cross-system control plane/.test(error))) {
    pass('source validator rejects cross-system concepts in Career-native code');
  } else {
    fail(`source validator accepted forbidden coupling: ${JSON.stringify(boundaryErrors)}`);
  }

  writeFileSync(join(boundaryRoot, 'cv.md'), 'Knowledge System is personal context.\n');
  mkdirSync(join(boundaryRoot, 'modes'), { recursive: true });
  writeFileSync(join(boundaryRoot, 'modes/_profile.md'), 'Mastery System is personal targeting context.\n');
  const userLayerErrors = validateCareerSystemSource(boundaryRoot);
  if (
    !userLayerErrors.some((error) => error.startsWith('cv.md:') || error.startsWith('modes/_profile.md:'))
  ) pass('source validator excludes Career user-layer content from policy checks');
  else fail(`source validator inspected user-owned content: ${JSON.stringify(userLayerErrors)}`);

  mkdirSync(join(boundaryRoot, 'dashboard'), { recursive: true });
  mkdirSync(join(boundaryRoot, 'templates'), { recursive: true });
  writeFileSync(join(boundaryRoot, 'dashboard/main.go'), 'package main // Knowledge System\n');
  writeFileSync(join(boundaryRoot, 'templates/native.html'), '<p>Mastery System</p>\n');
  const formatErrors = validateCareerSystemSource(boundaryRoot);
  if (
    formatErrors.some((error) => error.startsWith('dashboard/main.go:'))
    && formatErrors.some((error) => error.startsWith('templates/native.html:'))
  ) pass('source validator covers dashboard and template source formats');
  else fail(`source validator skipped native source formats: ${JSON.stringify(formatErrors)}`);

  mkdirSync(join(boundaryRoot, 'skills/public/extra-export'));
  const allowlistErrors = validateCareerSystemSource(boundaryRoot);
  if (allowlistErrors.some((error) => /public Career exports must be exactly/.test(error))) {
    pass('source validator rejects non-allowlisted public Career exports');
  } else {
    fail(`source validator accepted an extra public export: ${JSON.stringify(allowlistErrors)}`);
  }
} catch (error) {
  fail(`Career System contract tests crashed: ${error.stack ?? error.message}`);
}

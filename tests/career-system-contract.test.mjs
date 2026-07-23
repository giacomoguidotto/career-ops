import { execFileSync, spawnSync } from 'child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fail, pass, ROOT } from './helpers.mjs';
import { isForkManagedCheckout } from '../update-system.mjs';
import { validateCareerSystemSource } from '../validate-career-system-source.mjs';
import { stableOpportunityIdentity } from '../scan.mjs';

console.log('\nCareer System gateway and standalone setup');

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
  cpSync(join(ROOT, 'main.mjs'), join(root, 'main.mjs'));
  cpSync(join(ROOT, 'lib/career-opportunity-discovery.mjs'), join(root, 'lib/career-opportunity-discovery.mjs'));
  cpSync(join(ROOT, 'lib/career-system-gateway.mjs'), join(root, 'lib/career-system-gateway.mjs'));
  cpSync(join(ROOT, 'lib/career-profile-reconciliation.mjs'), join(root, 'lib/career-profile-reconciliation.mjs'));
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

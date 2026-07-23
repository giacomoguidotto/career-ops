import { execFile } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';

export const OPPORTUNITY_DISCOVERY_REQUEST_SCHEMA = 'career.opportunity.discover.request/v1';
export const OPPORTUNITY_DISCOVERY_RESULT_SCHEMA = 'career.opportunity.discover.result/v1';

const execFileAsync = promisify(execFile);
const OPPORTUNITY_ID_PATTERN = /^career\.opportunity\/v1\/[a-f0-9]{24}$/;

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

function validateRequest(request) {
  const reasons = [];
  if (request.schema !== OPPORTUNITY_DISCOVERY_REQUEST_SCHEMA) {
    reasons.push('unsupported-request-schema');
  }
  if (!isObject(request.target)) {
    reasons.push('target-must-be-an-object');
    return reasons;
  }
  if (!Number.isInteger(request.target.count) || request.target.count < 1) {
    reasons.push('target-count-must-be-a-positive-integer');
  }
  if (
    Object.hasOwn(request.target, 'company')
    && (typeof request.target.company !== 'string' || request.target.company.trim() === '')
  ) {
    reasons.push('target-company-must-be-a-non-empty-string');
  }
  return reasons;
}

function hasProvider(root) {
  const providerRoot = join(root, 'providers');
  if (!existsSync(providerRoot)) return false;
  return readdirSync(providerRoot, { withFileTypes: true })
    .some((entry) => entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.startsWith('_'));
}

export function checkOpportunityDiscovery({ root = process.cwd() } = {}) {
  const reasons = [];
  if (!existsSync(join(root, 'scan.mjs'))) reasons.push('missing:scan.mjs');
  if (!existsSync(join(root, 'portals.yml'))) reasons.push('missing:portals.yml');
  if (!hasProvider(root)) reasons.push('missing:providers');
  return reasons;
}

async function runNativeDiscovery(root, request) {
  const args = [
    join(root, 'scan.mjs'),
    '--json',
    `--max-new=${request.target.count}`,
  ];
  if (request.target.company) args.push('--company', request.target.company);

  const env = {
    ...process.env,
    CAREER_OPS_PORTALS: join(root, 'portals.yml'),
  };
  const profilePath = join(root, 'config/profile.yml');
  if (existsSync(profilePath)) env.CAREER_OPS_PROFILE = profilePath;

  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function normalizeOpportunity(offer) {
  if (!isObject(offer) || !OPPORTUNITY_ID_PATTERN.test(offer.identity)) return null;
  if (
    typeof offer.company !== 'string'
    || typeof offer.title !== 'string'
    || typeof offer.url !== 'string'
  ) return null;
  return {
    identity: offer.identity,
    company: offer.company,
    title: offer.title,
    url: offer.url,
    location: typeof offer.location === 'string' ? offer.location : null,
    posted_at: typeof offer.postedAt === 'string' ? offer.postedAt : null,
    source: typeof offer.source === 'string' ? offer.source : null,
  };
}

function artifactReferences(root) {
  return [
    ['pipeline', 'data/pipeline.md'],
    ['scan_history', 'data/scan-history.tsv'],
    ['scan_runs', 'data/scan-runs.tsv'],
  ].flatMap(([kind, path]) => (
    existsSync(join(root, path)) ? [{ kind, path }] : []
  ));
}

function failureCounts(scan) {
  return [
    ['unreachable-targets', scan.unreachableTargets],
    ['network-errors', scan.networkErrors],
    ['provider-errors', scan.otherErrors],
    ['unhandled-sources', scan.unhandledSources],
    ['malformed-sources', scan.malformedSources],
  ].flatMap(([code, count]) => (
    Number.isInteger(count) && count > 0 ? [{ code, count }] : []
  ));
}

export async function discoverOpportunities(
  request,
  { root = process.cwd(), runner = runNativeDiscovery } = {},
) {
  const validation = validateRequest(request);
  if (validation.length > 0) {
    return {
      schema: OPPORTUNITY_DISCOVERY_RESULT_SCHEMA,
      status: 'failed',
      reasons: validation,
      requested: isObject(request.target) ? request.target.count ?? null : null,
      discovered: 0,
      opportunities: [],
      failures: [],
      artifacts: artifactReferences(root),
    };
  }

  const readiness = checkOpportunityDiscovery({ root });
  if (readiness.length > 0) {
    return {
      schema: OPPORTUNITY_DISCOVERY_RESULT_SCHEMA,
      status: 'blocked',
      reasons: readiness,
      requested: request.target.count,
      discovered: 0,
      opportunities: [],
      failures: [],
      artifacts: artifactReferences(root),
    };
  }

  let scan;
  try {
    scan = await runner(root, request);
  } catch {
    return {
      schema: OPPORTUNITY_DISCOVERY_RESULT_SCHEMA,
      status: 'failed',
      reasons: ['native-discovery-runner-failed'],
      requested: request.target.count,
      discovered: 0,
      opportunities: [],
      failures: [],
      artifacts: artifactReferences(root),
    };
  }

  if (
    !isObject(scan)
    || scan.contract?.id !== 'career-ops.scanner.company-first'
    || scan.contract?.version !== 1
    || !Array.isArray(scan.offers)
  ) {
    return {
      schema: OPPORTUNITY_DISCOVERY_RESULT_SCHEMA,
      status: 'failed',
      reasons: ['native-discovery-result-is-malformed'],
      requested: request.target.count,
      discovered: 0,
      opportunities: [],
      failures: [],
      artifacts: artifactReferences(root),
    };
  }

  const opportunities = scan.offers.map(normalizeOpportunity);
  if (opportunities.some((opportunity) => opportunity === null)) {
    return {
      schema: OPPORTUNITY_DISCOVERY_RESULT_SCHEMA,
      status: 'failed',
      reasons: ['native-opportunity-is-malformed'],
      requested: request.target.count,
      discovered: 0,
      opportunities: [],
      failures: failureCounts(scan),
      artifacts: artifactReferences(root),
    };
  }

  return {
    schema: OPPORTUNITY_DISCOVERY_RESULT_SCHEMA,
    status: opportunities.length >= request.target.count ? 'completed' : 'incomplete',
    reasons: [],
    requested: request.target.count,
    discovered: opportunities.length,
    opportunities,
    failures: failureCounts(scan),
    artifacts: artifactReferences(root),
  };
}

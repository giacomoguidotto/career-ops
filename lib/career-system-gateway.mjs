import { checkCareerProfile, reconcileCareerProfile } from './career-profile-reconciliation.mjs';
import {
  checkOpportunityDiscovery,
  discoverOpportunities,
} from './career-opportunity-discovery.mjs';
import {
  checkRequisiteSnapshot,
  snapshotRequisites,
} from './career-requisite-snapshot.mjs';

export const GATEWAY_INTERFACE = 'career-system-gateway/v1';

const CAPABILITY_PATTERN = /^(?:career-system|career)\.[a-z][a-z0-9.-]*\/v[1-9]\d*$/;

function capabilityDescriptor(name, description, handler, check = () => []) {
  return Object.freeze({ name, description, handler, check });
}

const registry = new Map();

function register(descriptor) {
  registry.set(descriptor.name, descriptor);
}

register(capabilityDescriptor(
  'career-system.capabilities/v1',
  'Describe the versioned capabilities exposed by this gateway.',
  () => ({
    interface: GATEWAY_INTERFACE,
    capabilities: [...registry.values()].map(({ name, description }) => ({ name, description })),
  }),
));

register(capabilityDescriptor(
  'career.profile.check/v1',
  'Validate a revision-checked Career profile snapshot and report native field deltas without writing.',
  (input) => checkCareerProfile(input),
));

register(capabilityDescriptor(
  'career.profile.reconcile/v1',
  'Apply safe native Career profile deltas and verify the resulting projection.',
  (input) => reconcileCareerProfile(input),
));

register(capabilityDescriptor(
  'career.opportunity.discover/v1',
  'Discover Career-native opportunities through configured providers and preserve partial results.',
  (input) => discoverOpportunities(input),
  () => checkOpportunityDiscovery(),
));

register(capabilityDescriptor(
  'career.requisite.snapshot/v1',
  'Return a stable read-only snapshot of Career-owned requisites derived from evaluated opportunities.',
  (input) => snapshotRequisites(input),
  () => checkRequisiteSnapshot(),
));

register(capabilityDescriptor(
  'career-system.check/v1',
  'Return fresh readiness for only the requested gateway capabilities.',
  ({ capabilities } = {}) => {
    const requested = capabilities ?? [...registry.keys()];
    if (!Array.isArray(requested) || requested.length === 0 || requested.some((name) => typeof name !== 'string')) {
      throw new GatewayInputError('capabilities must be a non-empty array of capability names');
    }

    const results = requested.map((name) => {
      if (!isVersionedCapability(name)) {
        return { capability: name, status: 'blocked', reasons: ['capability-name-is-not-versioned'] };
      }

      const descriptor = registry.get(name);
      if (!descriptor) {
        return { capability: name, status: 'blocked', reasons: ['unsupported-capability'] };
      }

      const reasons = descriptor.check();
      return {
        capability: name,
        status: reasons.length === 0 ? 'ready' : 'blocked',
        reasons,
      };
    });

    return {
      status: results.every(({ status }) => status === 'ready') ? 'ready' : 'blocked',
      capabilities: results,
    };
  },
));

export class GatewayInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GatewayInputError';
  }
}

export function isVersionedCapability(name) {
  return typeof name === 'string' && CAPABILITY_PATTERN.test(name);
}

export function listCapabilities() {
  return [...registry.keys()];
}

export async function invokeCapability(name, input = {}) {
  if (!isVersionedCapability(name)) {
    throw new GatewayInputError('capability must use the career-system.<name>/v<major> or career.<aggregate>.<action>/v<major> form');
  }
  if (input === null || Array.isArray(input) || typeof input !== 'object') {
    throw new GatewayInputError('input must be a JSON object');
  }

  const descriptor = registry.get(name);
  if (!descriptor) {
    throw new GatewayInputError(`unsupported capability: ${name}`);
  }

  const result = await descriptor.handler(input);
  const status = ['blocked', 'failed', 'incomplete'].includes(result?.status) ? result.status : 'ready';
  return {
    interface: GATEWAY_INTERFACE,
    capability: name,
    status,
    result,
  };
}

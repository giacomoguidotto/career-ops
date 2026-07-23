import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';

export const PROFILE_SNAPSHOT_SCHEMA = 'career.profile.snapshot/v1';
export const PROFILE_PROJECTION_PATH = 'config/career-profile.json';

const REQUIRED_SECTIONS = Object.freeze([
  'identity',
  'application_defaults',
  'opportunity_preferences',
  'positioning_and_proof',
  'communication_strategy',
]);
const FIELD_STATES = new Set(['value', 'absent', 'unresolved']);

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function equal(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function validateRequest({ snapshot, expected_revision: expectedRevision } = {}) {
  const reasons = [];
  if (!isObject(snapshot)) return ['snapshot-must-be-an-object'];
  if (snapshot.schema !== PROFILE_SNAPSHOT_SCHEMA) reasons.push('unsupported-snapshot-schema');
  if (typeof snapshot.revision !== 'string' || snapshot.revision.trim() === '') {
    reasons.push('snapshot-revision-is-required');
  }
  if (typeof expectedRevision !== 'string' || expectedRevision.trim() === '') {
    reasons.push('expected-revision-is-required');
  }
  if (!isObject(snapshot.sections)) {
    reasons.push('snapshot-sections-must-be-an-object');
    return reasons;
  }

  const suppliedSections = Object.keys(snapshot.sections).sort();
  const expectedSections = [...REQUIRED_SECTIONS].sort();
  if (!equal(suppliedSections, expectedSections)) reasons.push('snapshot-must-contain-exactly-the-five-managed-sections');

  for (const section of suppliedSections) {
    const fields = snapshot.sections[section];
    if (!isObject(fields)) {
      reasons.push(`${section}:section-must-be-an-object`);
      continue;
    }
    for (const [field, descriptor] of Object.entries(fields)) {
      if (!field || !isObject(descriptor)) {
        reasons.push(`${section}.${field || '<empty>'}:field-must-be-an-object`);
        continue;
      }
      if (!FIELD_STATES.has(descriptor.state)) reasons.push(`${section}.${field}:invalid-state`);
      if (typeof descriptor.visibility !== 'string' || descriptor.visibility.trim() === '') {
        reasons.push(`${section}.${field}:visibility-is-required`);
      }
      if (descriptor.state === 'value' && !Object.hasOwn(descriptor, 'value')) {
        reasons.push(`${section}.${field}:value-is-required`);
      }
      if (descriptor.state !== 'value' && Object.hasOwn(descriptor, 'value')) {
        reasons.push(`${section}.${field}:value-is-not-allowed-for-${descriptor.state}`);
      }
    }
  }
  return reasons;
}

function readProjection(root) {
  const path = join(root, PROFILE_PROJECTION_PATH);
  if (!existsSync(path)) return { path, projection: { schema: PROFILE_SNAPSHOT_SCHEMA, sections: {} } };
  try {
    const projection = JSON.parse(readFileSync(path, 'utf8'));
    if (!isObject(projection) || projection.schema !== PROFILE_SNAPSHOT_SCHEMA || !isObject(projection.sections)) {
      return { path, error: 'native-profile-projection-is-malformed' };
    }
    return { path, projection };
  } catch {
    return { path, error: 'native-profile-projection-is-malformed' };
  }
}

function projectedField(descriptor) {
  const { state, ...projection } = descriptor;
  return canonicalize(projection);
}

function buildPlan(snapshot, current) {
  const actions = [];
  const next = structuredClone(current);
  next.schema = PROFILE_SNAPSHOT_SCHEMA;
  next.sections ??= {};

  for (const section of REQUIRED_SECTIONS) {
    const desiredFields = snapshot.sections[section];
    const currentFields = isObject(current.sections[section]) ? current.sections[section] : {};
    const nextFields = { ...currentFields };

    for (const field of Object.keys(desiredFields).sort()) {
      const descriptor = desiredFields[field];
      const path = `${section}.${field}`;
      if (descriptor.state === 'unresolved') {
        actions.push({ field: path, action: 'blocked', reason: 'field-is-unresolved' });
        continue;
      }
      if (descriptor.state === 'absent') {
        if (Object.hasOwn(currentFields, field)) {
          delete nextFields[field];
          actions.push({ field: path, action: 'clear' });
        } else {
          actions.push({ field: path, action: 'preserve' });
        }
        continue;
      }

      const desired = projectedField(descriptor);
      if (Object.hasOwn(currentFields, field) && equal(currentFields[field], desired)) {
        actions.push({ field: path, action: 'preserve' });
      } else {
        nextFields[field] = desired;
        actions.push({ field: path, action: 'change' });
      }
    }

    if (Object.keys(nextFields).length === 0) delete next.sections[section];
    else next.sections[section] = canonicalize(nextFields);
  }

  return { actions, next: canonicalize(next) };
}

function inspect(root, request) {
  const validation = validateRequest(request);
  if (validation.length > 0) return { status: 'failed', reasons: validation, actions: [] };
  if (request.snapshot.revision !== request.expected_revision) {
    return { status: 'blocked', reasons: ['source-revision-drift'], actions: [] };
  }

  const native = readProjection(root);
  if (native.error) return { status: 'failed', reasons: [native.error], actions: [] };
  const plan = buildPlan(request.snapshot, native.projection);
  const blocked = plan.actions.some(({ action }) => action === 'blocked');
  const drifted = plan.actions.some(({ action }) => action === 'change' || action === 'clear');
  return {
    status: blocked ? 'blocked' : drifted ? 'drifted' : 'converged',
    reasons: blocked ? ['required-profile-fields-unresolved'] : [],
    actions: plan.actions,
    native,
    next: plan.next,
  };
}

function publicResult(result, changed = []) {
  return {
    status: result.status,
    reasons: result.reasons,
    actions: result.actions,
    changed,
  };
}

function writeProjection(path, projection) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(projection, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function checkCareerProfile(request, { root = process.cwd() } = {}) {
  return publicResult(inspect(root, request));
}

export function reconcileCareerProfile(request, { root = process.cwd() } = {}) {
  const before = inspect(root, request);
  if (before.status === 'failed' || before.reasons.includes('source-revision-drift')) {
    return publicResult(before);
  }

  const changes = before.actions.filter(({ action }) => action === 'change' || action === 'clear');
  if (changes.length === 0) return publicResult(before);

  writeProjection(before.native.path, before.next);
  const after = inspect(root, request);
  if (after.actions.some(({ action }) => action === 'change' || action === 'clear')) {
    return { status: 'failed', reasons: ['post-check-remains-drifted'], actions: after.actions, changed: [PROFILE_PROJECTION_PATH] };
  }
  return publicResult(after, [PROFILE_PROJECTION_PATH]);
}

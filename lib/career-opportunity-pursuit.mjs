import { existsSync } from 'fs';
import { join } from 'path';
import { analyzeApproachEvidence } from '../approach-evidence.mjs';
import {
  listOpportunities,
  reconcileOpportunityWork,
  requestOpportunityWork,
} from '../opportunity-lifecycle.mjs';

export const SELECT_RELATED_REQUEST_SCHEMA = 'career.opportunity.select-related.request/v1';
export const SELECT_RELATED_RESULT_SCHEMA = 'career.opportunity.select-related.result/v1';
export const ADVANCE_REQUEST_SCHEMA = 'career.opportunity.advance.request/v1';
export const ADVANCE_RESULT_SCHEMA = 'career.opportunity.advance.result/v1';
export const REVIEW_WAITING_REQUEST_SCHEMA = 'career.opportunity.review-waiting.request/v1';
export const REVIEW_WAITING_RESULT_SCHEMA = 'career.opportunity.review-waiting.result/v1';

const DEFAULT_THROUGHPUT = 3;
const OPPORTUNITY_REFERENCE = /^career\.opportunity\/v1\/([1-9]\d*)$/;
const COMMON_FILES = [
  'opportunity-lifecycle.mjs',
  'templates/states.yml',
  'tracker-parse.mjs',
  'tracker-utils.mjs',
  'tracker-aliases.json',
  'candidacy-select.mjs',
  'followup-cadence.mjs',
  'approach-attempts.mjs',
  'approach-evidence.mjs',
  'advance-stage.mjs',
  'pdf-artifact.mjs',
];

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === 'object';
}

function exactKeys(value, allowed) {
  return isObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function trackerPath(root) {
  const native = join(root, 'data/applications.md');
  if (existsSync(native)) return native;
  const legacy = join(root, 'applications.md');
  return existsSync(legacy) ? legacy : null;
}

function opportunityReference(opportunity) {
  return `career.opportunity/v1/${opportunity}`;
}

function parseOpportunityReference(reference) {
  if (typeof reference !== 'string') return null;
  const match = reference.match(OPPORTUNITY_REFERENCE);
  return match ? Number(match[1]) : null;
}

function failed(schema, reasons, extra = {}) {
  return {
    schema,
    status: 'failed',
    reasons,
    ...extra,
  };
}

function personalization(request) {
  if (request.personalization === undefined) return 'generic-defaults';
  if (
    !exactKeys(request.personalization, ['mode'])
    || !['profile', 'generic-defaults'].includes(request.personalization.mode)
  ) return null;
  return request.personalization.mode;
}

function validateReferences(references) {
  if (references === undefined) return { references: null, numbers: null, reasons: [] };
  if (!Array.isArray(references) || references.length === 0) {
    return { references: null, numbers: null, reasons: ['opportunity-refs-must-be-a-non-empty-array'] };
  }
  const numbers = references.map(parseOpportunityReference);
  const reasons = [];
  if (numbers.some((number) => number === null)) reasons.push('opportunity-ref-is-invalid');
  if (new Set(references).size !== references.length) reasons.push('opportunity-refs-must-be-unique');
  return { references, numbers, reasons };
}

function resolveThroughput(value) {
  if (value === undefined) {
    return { count: DEFAULT_THROUGHPUT, source: 'career-default', reasons: [] };
  }
  if (!exactKeys(value, ['count']) || !Number.isSafeInteger(value.count) || value.count < 1) {
    return { count: null, source: null, reasons: ['throughput-count-must-be-a-positive-integer'] };
  }
  return { count: value.count, source: 'requested', reasons: [] };
}

function summarizeOpportunity(opportunity) {
  return {
    reference: opportunityReference(opportunity.opportunity),
    revision: opportunity.revision,
    stage: opportunity.stage.id,
    owner: opportunity.stage.owner,
    action: opportunity.stage.suggests,
    company: opportunity.company,
    role: opportunity.role,
    score: opportunity.score,
  };
}

function summarizeSuppressed(opportunity) {
  return {
    reference: opportunityReference(opportunity.opportunity),
    code: opportunity.candidacy.reason ?? 'related-opportunity-suppressed',
    primary_reference: opportunity.candidacy.primary
      ? opportunityReference(opportunity.candidacy.primary)
      : null,
  };
}

function researchBlock(item) {
  return {
    company: item.company,
    code: item.reason,
    references: item.applications.map(opportunityReference),
  };
}

function selectionSnapshot(request, root) {
  const snapshot = listOpportunities({ root, now: request.as_of });
  const byNumber = new Map(snapshot.opportunities.map((item) => [item.opportunity, item]));
  return { snapshot, byNumber };
}

export function checkOpportunityPursuit({ root = process.cwd() } = {}) {
  const reasons = COMMON_FILES
    .filter((path) => !existsSync(join(root, path)))
    .map((path) => `missing:${path}`);
  if (!trackerPath(root)) reasons.push('missing:applications-tracker');
  return reasons;
}

export function selectRelatedOpportunities(
  request,
  { root = process.cwd(), snapshotReader = selectionSnapshot } = {},
) {
  if (!exactKeys(request, ['schema', 'opportunity_refs', 'throughput', 'personalization', 'as_of'])) {
    return failed(SELECT_RELATED_RESULT_SCHEMA, ['request-contains-unsupported-fields'], {
      personalization: 'generic-defaults',
      selected: [],
      opportunities: [],
      suppressed: [],
      research_blocked: [],
      ineligible: [],
      throughput: null,
    });
  }
  const references = validateReferences(request.opportunity_refs);
  const throughput = resolveThroughput(request.throughput);
  const planningMode = personalization(request);
  const reasons = [
    ...(request.schema === SELECT_RELATED_REQUEST_SCHEMA ? [] : ['unsupported-request-schema']),
    ...references.reasons,
    ...throughput.reasons,
    ...(planningMode ? [] : ['personalization-mode-is-invalid']),
    ...(request.as_of === undefined || !Number.isNaN(Date.parse(request.as_of))
      ? []
      : ['as-of-must-be-an-iso-date']),
  ];
  if (reasons.length > 0) {
    return failed(SELECT_RELATED_RESULT_SCHEMA, reasons, {
      personalization: planningMode ?? 'generic-defaults',
      selected: [],
      opportunities: [],
      suppressed: [],
      research_blocked: [],
      ineligible: [],
      throughput: throughput.count ? {
        requested: throughput.count,
        source: throughput.source,
        selected: 0,
        shortfall: throughput.count,
      } : null,
    });
  }

  const readiness = checkOpportunityPursuit({ root });
  if (readiness.length > 0) {
    return {
      schema: SELECT_RELATED_RESULT_SCHEMA,
      status: 'blocked',
      reasons: readiness,
      personalization: planningMode,
      selected: [],
      opportunities: [],
      suppressed: [],
      research_blocked: [],
      ineligible: [],
      throughput: {
        requested: throughput.count,
        source: throughput.source,
        selected: 0,
        shortfall: throughput.count,
      },
    };
  }

  let snapshot;
  let byNumber;
  try {
    ({ snapshot, byNumber } = snapshotReader(request, root));
  } catch {
    return failed(SELECT_RELATED_RESULT_SCHEMA, ['native-selection-failed'], {
      personalization: planningMode,
      selected: [],
      opportunities: [],
      suppressed: [],
      research_blocked: [],
      ineligible: [],
      throughput: {
        requested: throughput.count,
        source: throughput.source,
        selected: 0,
        shortfall: throughput.count,
      },
    });
  }

  const scopedNumbers = references.numbers ?? snapshot.opportunities.map(({ opportunity }) => opportunity);
  const scoped = scopedNumbers.map((number) => byNumber.get(number)).filter(Boolean);
  const missing = scopedNumbers.filter((number) => !byNumber.has(number));
  const eligible = scoped
    .filter((item) => item.stage.owner === 'agent' && item.capabilities.generate)
    .sort((left, right) => (
      left.stage.id === right.stage.id
        ? Number.parseFloat(right.score) - Number.parseFloat(left.score) || left.opportunity - right.opportunity
        : ['evaluated', 'responded', 'offer'].indexOf(left.stage.id)
          - ['evaluated', 'responded', 'offer'].indexOf(right.stage.id)
    ))
    .slice(0, throughput.count);
  const selectedNumbers = new Set(eligible.map(({ opportunity }) => opportunity));
  const suppressed = scoped
    .filter((item) => item.stage.owner === 'agent' && item.candidacy.state === 'suppressed')
    .map(summarizeSuppressed);
  const researchBlocked = snapshot.opportunities
    .flatMap((item) => item.candidacy.research ? [item.candidacy.research] : [])
    .filter((item, index, all) => (
      all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(item)) === index
      && item.applications.some((number) => scopedNumbers.includes(number))
    ))
    .map((item) => researchBlock({
      company: snapshot.opportunities.find(({ opportunity }) => item.applications.includes(opportunity))?.company ?? '',
      ...item,
    }));
  const ineligible = [
    ...missing.map((number) => ({
      reference: opportunityReference(number),
      code: 'opportunity-not-found',
    })),
    ...scoped
      .filter((item) => !selectedNumbers.has(item.opportunity)
        && !suppressed.some(({ reference }) => reference === opportunityReference(item.opportunity))
        && !researchBlocked.some(({ references: blocked }) => blocked.includes(opportunityReference(item.opportunity))))
      .map((item) => ({
        reference: opportunityReference(item.opportunity),
        code: item.stage.owner === 'agent' ? 'throughput-cap-reached' : 'opportunity-is-not-agent-owned',
      })),
  ];

  return {
    schema: SELECT_RELATED_RESULT_SCHEMA,
    status: 'completed',
    reasons: [],
    personalization: planningMode,
    selection_revision: snapshot.revision,
    selected: eligible.map(({ opportunity }) => opportunityReference(opportunity)),
    opportunities: eligible.map(summarizeOpportunity),
    suppressed,
    research_blocked: researchBlocked,
    ineligible,
    throughput: {
      requested: throughput.count,
      source: throughput.source,
      selected: eligible.length,
      shortfall: Math.max(0, throughput.count - eligible.length),
    },
  };
}

function validateAdvanceRequest(request) {
  const reasons = [];
  if (!exactKeys(request, [
    'schema',
    'operation',
    'opportunity_ref',
    'expected_stage',
    'expected_revision',
    'personalization',
  ])) reasons.push('request-contains-unsupported-fields');
  if (request.schema !== ADVANCE_REQUEST_SCHEMA) reasons.push('unsupported-request-schema');
  if (!['request', 'reconcile'].includes(request.operation)) reasons.push('operation-must-be-request-or-reconcile');
  const opportunity = parseOpportunityReference(request.opportunity_ref);
  if (opportunity === null) reasons.push('opportunity-ref-is-invalid');
  if (typeof request.expected_stage !== 'string' || !/^[a-z][a-z0-9_]*$/.test(request.expected_stage)) {
    reasons.push('expected-stage-is-invalid');
  }
  if (typeof request.expected_revision !== 'string' || !/^[a-f0-9]{64}$/.test(request.expected_revision)) {
    reasons.push('expected-revision-is-invalid');
  }
  const planningMode = personalization(request);
  if (!planningMode) reasons.push('personalization-mode-is-invalid');
  return { reasons, opportunity, planningMode: planningMode ?? 'generic-defaults' };
}

function advanceStatus(effect) {
  if (['accepted', 'changed', 'unchanged'].includes(effect)) return 'completed';
  if (['blocked', 'conflict', 'unavailable'].includes(effect)) return 'blocked';
  return 'failed';
}

export async function advanceOpportunity(
  request,
  {
    root = process.cwd(),
    requestWork = requestOpportunityWork,
    reconcileWork = reconcileOpportunityWork,
  } = {},
) {
  const validation = validateAdvanceRequest(request);
  if (validation.reasons.length > 0) {
    return failed(ADVANCE_RESULT_SCHEMA, validation.reasons, {
      personalization: validation.planningMode,
      opportunity_ref: typeof request.opportunity_ref === 'string' ? request.opportunity_ref : null,
      operation: typeof request.operation === 'string' ? request.operation : null,
      outcome: null,
      required_approvals: [],
    });
  }
  const readiness = checkOpportunityPursuit({ root });
  if (readiness.length > 0) {
    return {
      schema: ADVANCE_RESULT_SCHEMA,
      status: 'blocked',
      reasons: readiness,
      personalization: validation.planningMode,
      opportunity_ref: request.opportunity_ref,
      operation: request.operation,
      outcome: null,
      required_approvals: [],
    };
  }

  let outcome;
  try {
    const options = {
      root,
      opportunity: validation.opportunity,
      expectedStage: request.expected_stage,
      expectedRevision: request.expected_revision,
    };
    outcome = request.operation === 'request'
      ? await requestWork(options)
      : await reconcileWork(options);
  } catch {
    return failed(ADVANCE_RESULT_SCHEMA, ['native-advancement-failed'], {
      personalization: validation.planningMode,
      opportunity_ref: request.opportunity_ref,
      operation: request.operation,
      outcome: null,
      required_approvals: [],
    });
  }

  const resultStatus = advanceStatus(outcome.effect);
  return {
    schema: ADVANCE_RESULT_SCHEMA,
    status: resultStatus,
    reasons: resultStatus === 'completed' ? [] : [outcome.code],
    personalization: validation.planningMode,
    opportunity_ref: request.opportunity_ref,
    operation: request.operation,
    outcome,
    required_approvals: outcome.after?.stage?.owner === 'user'
      ? [{
          code: 'real-world-action',
          message: 'The user must perform and report the real-world action before any factual Stage advance.',
          reference: request.opportunity_ref,
        }]
      : [],
  };
}

function waitingRecommendation(opportunity) {
  const attention = opportunity.attemptAttention;
  const codes = {
    waiting: 'continue-waiting',
    review_due: 'review-due',
    cold: 'cold-review',
    unknown: 'attempt-evidence-incomplete',
  };
  return {
    reference: opportunityReference(opportunity.opportunity),
    code: codes[attention.state] ?? 'no-wait-review',
    attention: attention.state,
    next_review: attention.nextReview,
    latest_attempt_ref: attention.latestAttemptId,
    plan_refs: opportunity.artifacts
      .filter(({ kind, state }) => kind === 'approach-plan' && state === 'available')
      .map(({ path }) => path),
    factual_stage_unchanged: true,
  };
}

export function reviewWaitingOpportunities(
  request,
  { root = process.cwd(), snapshotReader = selectionSnapshot } = {},
) {
  if (!exactKeys(request, ['schema', 'opportunity_refs', 'personalization', 'as_of'])) {
    return failed(REVIEW_WAITING_RESULT_SCHEMA, ['request-contains-unsupported-fields'], {
      personalization: 'generic-defaults',
      recommendations: [],
      evidence_sufficiency: null,
      required_approvals: [],
    });
  }
  const references = validateReferences(request.opportunity_refs);
  const planningMode = personalization(request);
  const reasons = [
    ...(request.schema === REVIEW_WAITING_REQUEST_SCHEMA ? [] : ['unsupported-request-schema']),
    ...references.reasons,
    ...(planningMode ? [] : ['personalization-mode-is-invalid']),
    ...(request.as_of === undefined || !Number.isNaN(Date.parse(request.as_of))
      ? []
      : ['as-of-must-be-an-iso-date']),
  ];
  if (reasons.length > 0) {
    return failed(REVIEW_WAITING_RESULT_SCHEMA, reasons, {
      personalization: planningMode ?? 'generic-defaults',
      recommendations: [],
      evidence_sufficiency: null,
      required_approvals: [],
    });
  }
  const readiness = checkOpportunityPursuit({ root });
  if (readiness.length > 0) {
    return {
      schema: REVIEW_WAITING_RESULT_SCHEMA,
      status: 'blocked',
      reasons: readiness,
      personalization: planningMode,
      recommendations: [],
      evidence_sufficiency: null,
      required_approvals: [],
    };
  }

  let snapshot;
  try {
    ({ snapshot } = snapshotReader(request, root));
  } catch {
    return failed(REVIEW_WAITING_RESULT_SCHEMA, ['native-wait-review-failed'], {
      personalization: planningMode,
      recommendations: [],
      evidence_sufficiency: null,
      required_approvals: [],
    });
  }
  const scoped = new Set(references.numbers ?? snapshot.opportunities.map(({ opportunity }) => opportunity));
  const waiting = snapshot.opportunities.filter((item) => (
    scoped.has(item.opportunity)
    && item.stage.owner === 'external'
    && item.stage.onDemand.includes('review_approach')
  ));
  let evidence;
  try {
    evidence = analyzeApproachEvidence({
      appsFile: trackerPath(root),
      attemptsFile: join(root, 'data/approach-attempts.md'),
    });
  } catch {
    evidence = {
      sufficient: false,
      conclusion: 'Personal channel evidence is unavailable; use generic priors only as a planning aid.',
    };
  }

  return {
    schema: REVIEW_WAITING_RESULT_SCHEMA,
    status: 'completed',
    reasons: [],
    personalization: planningMode,
    recommendations: waiting.map(waitingRecommendation),
    evidence_sufficiency: {
      sufficient: evidence.sufficient,
      conclusion: evidence.conclusion,
    },
    required_approvals: waiting
      .filter(({ attemptAttention }) => ['review_due', 'cold'].includes(attemptAttention.state))
      .map(({ opportunity }) => ({
        code: 'confirm-next-approach',
        message: 'Any recommended application, outreach, message, or follow-up remains a draft until the user acts and reports it.',
        reference: opportunityReference(opportunity),
      })),
  };
}

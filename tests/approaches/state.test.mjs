import { loadStates, resolveState } from '../../tracker-utils.mjs';
import { computeAdvance } from '../../advance-stage.mjs';
import { pass, fail } from '../helpers.mjs';

function ok(label, condition) {
  if (condition) pass(label);
  else fail(label);
}

function eq(label, actual, expected) {
  ok(`${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`, actual === expected);
}

const states = loadStates();

eq(
  'evaluated opportunity advances to Approach Ready after its plan is generated',
  computeAdvance('Evaluated', states, 'generate_approach_plan').toLabel,
  'Approach Ready',
);

const ready = resolveState('Approach Ready', states);
ok('Approach Ready is user-owned', ready?.owner === 'user');
ok('Approach Ready asks the user to execute an approach', ready?.suggests === 'execute_approach');

const approached = resolveState('Approached', states);
ok('Approached is externally owned', approached?.owner === 'external');
ok('Approached offers wait review on demand', approached?.onDemand?.includes('review_approach'));

ok(
  'legacy Applied resolves to Approached during compatibility migration',
  resolveState('Applied', states)?.id === 'approached',
);

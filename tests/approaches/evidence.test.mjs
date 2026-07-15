import { pass, fail } from '../helpers.mjs';
import { assessChannelEvidence } from '../../approach-evidence.mjs';

function ok(label, condition) {
  if (condition) pass(label);
  else fail(label);
}

function observations(channel, count, progressed, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    opportunity: offset + index + 1,
    channel,
    resolved: true,
    progressed: index < progressed,
  }));
}

const belowFloor = assessChannelEvidence([
  ...observations('email', 7, 2),
  ...observations('linkedin', 8, 2, 100),
]);
ok('seven resolved observations are insufficient', belowFloor.sufficient === false);
ok('the audit names the channel below the sample floor', belowFloor.channels.email.resolved === 7);

const noProgress = assessChannelEvidence([
  ...observations('email', 8, 1),
  ...observations('linkedin', 8, 2, 100),
]);
ok('fewer than two meaningful progressions are insufficient', noProgress.sufficient === false);

const atFloor = assessChannelEvidence([
  ...observations('email', 8, 2),
  ...observations('linkedin', 8, 2, 100),
]);
ok('the floor permits a conclusion when samples are comparable', atFloor.sufficient === true);

const confounded = assessChannelEvidence([
  ...observations('email', 8, 2),
  ...observations('linkedin', 8, 2, 100),
  { opportunity: 1, channel: 'linkedin', resolved: true, progressed: true },
]);
ok('multiple compared channels on one opportunity fail the confounder check', confounded.sufficient === false && confounded.confounded === true);

const unresolved = assessChannelEvidence([
  ...observations('email', 8, 2),
  ...observations('linkedin', 8, 2, 100),
  { opportunity: 999, channel: 'email', resolved: false, progressed: false },
]);
ok('unresolved attempts do not inflate the resolved sample', unresolved.channels.email.resolved === 8);

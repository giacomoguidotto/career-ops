import { existsSync, readFileSync } from 'fs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import {
  acquireTrackerLock,
  cell,
  loadStates,
  rebuildRow,
  resolveState,
  trackerLockDirFor,
  writeFileAtomic,
} from './tracker-utils.mjs';

export const APPROACH_ATTEMPT_TYPES = new Set([
  'formal_application',
  'founder_outreach',
  'recruiter_outreach',
  'hiring_manager_outreach',
  'peer_outreach',
  'referral_request',
  'qualifying_question',
  'personalized_media',
  'in_person',
  'follow_up',
  'other',
]);

export const APPROACH_ATTEMPTS_HEADER = [
  '# Approach Attempts',
  '',
  '> Append-only facts. Add a row only after the user confirms the real-world action.',
  '',
  '| id | opportunity | occurredAt | type | channel | recipient | result | followUpTo | notes |',
  '|---|---|---|---|---|---|---|---|---|',
].join('\n');

function normalized(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function validOccurredAt(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }
  const timestamp = String(value).match(/^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/);
  return Boolean(timestamp && validOccurredAt(timestamp[1]) && !Number.isNaN(Date.parse(value)));
}

function splitRow(line) {
  return line.split('|').slice(1, -1).map((part) => part.trim());
}

export function readApproachAttempts(path) {
  if (!existsSync(path)) return [];
  return parseApproachAttempts(readFileSync(path, 'utf-8'));
}

export function parseApproachAttempts(content) {
  const attempts = [];
  for (const line of String(content ?? '').split('\n')) {
    if (!/^\|\s*A\d+\s*\|/.test(line)) continue;
    const [id, opportunity, date, type, channel, recipient, result, followUpTo, notes] = splitRow(line);
    attempts.push({
      id,
      opportunity: Number(opportunity),
      date,
      type,
      channel,
      recipient,
      result,
      followUpTo: followUpTo || null,
      notes,
    });
  }
  return attempts;
}

function sameAttempt(left, right) {
  return left.opportunity === right.opportunity
    && left.date === right.date
    && normalized(left.type) === normalized(right.type)
    && normalized(left.channel) === normalized(right.channel)
    && normalized(left.recipient) === normalized(right.recipient)
    && normalized(left.result) === normalized(right.result)
    && normalized(left.followUpTo) === normalized(right.followUpTo);
}

function nextAttemptId(attempts) {
  const max = attempts.reduce((current, attempt) => {
    const number = Number(String(attempt.id).replace(/^A/i, ''));
    return Number.isFinite(number) ? Math.max(current, number) : current;
  }, 0);
  return `A${String(max + 1).padStart(3, '0')}`;
}

function attemptLine(attempt) {
  return `| ${[
    attempt.id,
    attempt.opportunity,
    attempt.date,
    attempt.type,
    attempt.channel,
    attempt.recipient,
    attempt.result,
    attempt.followUpTo ?? '',
    attempt.notes ?? '',
  ].map(cell).join(' | ')} |`;
}

export function serializeApproachAttempts(attempts) {
  const rows = attempts.map(attemptLine);
  return `${APPROACH_ATTEMPTS_HEADER}${rows.length ? `\n${rows.join('\n')}` : ''}\n`;
}

function trackerTarget(content, opportunity) {
  const lines = content.split('\n');
  const columns = resolveColumns(lines);
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const row = parseTrackerRow(lines[lineIdx], columns);
    if (row?.num === opportunity) return { lines, columns, lineIdx, row };
  }
  return null;
}

function withStage(target, label) {
  const parts = target.lines[target.lineIdx].split('|').map((part) => part.trim());
  parts[target.columns.status] = label;
  target.lines[target.lineIdx] = rebuildRow(parts);
  return target.lines.join('\n');
}

export async function recordApproachAttempt(options) {
  const {
    appsFile,
    attemptsFile,
    opportunity: rawOpportunity,
    date,
    type,
    channel,
    recipient,
    result,
    followUpTo = null,
    notes = '',
    dryRun = false,
    lockHeld = false,
    rootDir = null,
    onMutationStep = null,
  } = options;
  const opportunity = Number(rawOpportunity);
  if (!Number.isInteger(opportunity) || opportunity <= 0) throw new Error('opportunity must be a positive tracker number');
  if (!validOccurredAt(date)) throw new Error('occurredAt must be a real ISO 8601 date or timestamp');
  if (!APPROACH_ATTEMPT_TYPES.has(type)) throw new Error(`unsupported approach type: ${type}`);
  if (!normalized(channel)) throw new Error('channel is required');
  if (!normalized(recipient)) throw new Error('recipient is required');
  if (!normalized(result)) throw new Error('result is required');

  let lock = null;
  if (!dryRun && !lockHeld) {
    lock = await acquireTrackerLock(trackerLockDirFor(appsFile), {
      timeoutMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS) || 60_000,
      tracker: appsFile,
    });
  }

  try {
    const trackerContent = readFileSync(appsFile, 'utf-8');
    const target = trackerTarget(trackerContent, opportunity);
    if (!target) throw new Error(`no Opportunity #${opportunity}`);
    const states = rootDir ? loadStates({ rootDir, force: true }) : loadStates();
    const stage = resolveState(target.row.status, states);
    const approachedStage = states.records.find((record) => record.owner === 'external' && record.onDemand.includes('review_approach'));
    if (!approachedStage) throw new Error('states.yml has no external review_approach stage');
    const mayCreateAttempt = stage && (stage.id === approachedStage.id || stage.nextStates.includes(approachedStage.id));
    if (!mayCreateAttempt) {
      throw new Error(`Opportunity #${opportunity} is at ${target.row.status}; that stage cannot transition to ${approachedStage.label}`);
    }

    const attempts = readApproachAttempts(attemptsFile);
    if (type === 'follow_up') {
      if (!followUpTo) throw new Error('followUpTo is required for a follow-up Attempt');
      const prior = attempts.find((attempt) => attempt.id === followUpTo && attempt.opportunity === opportunity);
      if (!prior) throw new Error(`prior Attempt ${followUpTo} does not exist on Opportunity #${opportunity}`);
    } else if (followUpTo) {
      throw new Error('followUpTo is valid only for a follow-up Attempt');
    }
    const candidate = {
      id: nextAttemptId(attempts),
      opportunity,
      date,
      type,
      channel: normalized(cell(channel)),
      recipient: cell(recipient),
      result: normalized(cell(result)),
      followUpTo: followUpTo ? cell(followUpTo) : null,
      notes: cell(notes),
    };
    const duplicate = attempts.find((attempt) => sameAttempt(attempt, candidate));
    const stageNeedsRepair = stage.id !== approachedStage.id;

    if (dryRun) {
      return {
        changed: !duplicate || stageNeedsRepair,
        dryRun: true,
        reason: duplicate ? 'duplicate' : 'would-record',
        attempt: duplicate ?? candidate,
        oldStage: stage.label,
        newStage: approachedStage.label,
      };
    }

    if (!duplicate) {
      const existing = existsSync(attemptsFile) ? readFileSync(attemptsFile, 'utf-8').trimEnd() : APPROACH_ATTEMPTS_HEADER;
      writeFileAtomic(attemptsFile, `${existing}\n${attemptLine(candidate)}\n`);
      onMutationStep?.('attempt-written');
    }
    if (stageNeedsRepair) {
      writeFileAtomic(appsFile, withStage(target, approachedStage.label));
      onMutationStep?.('stage-written');
    }

    return {
      changed: !duplicate || stageNeedsRepair,
      reason: duplicate ? (stageNeedsRepair ? 'repaired-stage' : 'duplicate') : 'recorded',
      attempt: duplicate ?? candidate,
      oldStage: stage.label,
      newStage: approachedStage.label,
    };
  } finally {
    lock?.release();
  }
}

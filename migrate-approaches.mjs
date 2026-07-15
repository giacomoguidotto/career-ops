#!/usr/bin/env node

import { copyFileSync, existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { readApproachAttempts, serializeApproachAttempts } from './approach-attempts.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import {
  acquireTrackerLock,
  rebuildRow,
  resolveTrackerPath,
  trackerLockDirFor,
  writeFileAtomic,
} from './tracker-utils.mjs';

const LEGACY_STAGE_MAP = new Map([
  ['application ready', 'Approach Ready'],
  ['qualifying ready', 'Approach Ready'],
  ['outreach ready', 'Approach Ready'],
]);

function normalized(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function attemptKey(attempt) {
  return [
    attempt.opportunity,
    attempt.date,
    normalized(attempt.type),
    normalized(attempt.channel),
    normalized(attempt.recipient),
    normalized(attempt.result),
    normalized(attempt.followUpTo),
  ].join('|');
}

function typeForOutreach(recipient) {
  const value = normalized(recipient);
  if (value.includes('founder')) return 'founder_outreach';
  if (value.includes('recruit')) return 'recruiter_outreach';
  if (value.includes('hiring manager')) return 'hiring_manager_outreach';
  return 'other';
}

function isRealDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function parseFollowups(path, ambiguities) {
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const parts = line.split('|').slice(1, -1).map((part) => part.trim());
    if (parts.length < 8) continue;
    const opportunity = Number(parts[1]);
    if (!Number.isInteger(opportunity)) continue;
    if (!isRealDate(parts[2])) {
      ambiguities.push({ opportunity, field: 'date', detail: 'Legacy follow-up has no valid confirmed date; no attempt was invented.' });
      continue;
    }
    rows.push({
      opportunity,
      date: parts[2],
      type: 'follow_up',
      channel: normalized(parts[5] || 'unknown'),
      recipient: parts[6] || 'unknown',
      result: 'sent',
      followUpTo: null,
      notes: parts[7] || 'Migrated from legacy follow-up history.',
    });
  }
  return rows;
}

function extractLegacyAttempts(row, ambiguities) {
  const attempts = [];
  const status = normalized(row.status);
  const notes = row.notes || '';
  const addAmbiguity = (field, detail) => ambiguities.push({ opportunity: row.num, field, detail });

  const applied = notes.match(/\bApplied\s+(\d{4}-\d{2}-\d{2})\b/i);
  if (applied && isRealDate(applied[1])) {
      attempts.push({
        opportunity: row.num,
        date: applied[1],
        type: 'formal_application',
        channel: 'unknown',
        recipient: 'unknown',
        result: 'submitted',
        followUpTo: null,
        notes: 'Migrated from an explicit legacy Applied date.',
      });
      addAmbiguity('channel', 'Formal application channel was not recorded; stored as unknown.');
      addAmbiguity('recipient', 'Formal application recipient was not recorded; stored as unknown.');
  } else if (status === 'applied') {
    addAmbiguity('date', 'Legacy Applied state has no explicit submission date; kept at Approach Ready and no attempt was invented.');
  }

  const qualifying = notes.match(/qualifying\s+question\s+sent\s+(\d{4}-\d{2}-\d{2})\s+via\s+([^.;]+?)\s+to\s+([^.;]+)/i)
    || notes.match(/\[qualifying-sent\s+(\d{4}-\d{2}-\d{2})\]/i);
  if (qualifying && isRealDate(qualifying[1])) {
      const fullySpecified = qualifying.length >= 4;
      attempts.push({
        opportunity: row.num,
        date: qualifying[1],
        type: 'qualifying_question',
        channel: normalized(fullySpecified ? qualifying[2] : 'unknown'),
        recipient: fullySpecified ? qualifying[3] : 'unknown',
        result: 'sent',
        followUpTo: null,
        notes: 'Migrated from confirmed legacy qualifying history.',
      });
      if (!fullySpecified) {
        addAmbiguity('channel', 'Qualifying channel was not recorded; stored as unknown.');
        addAmbiguity('recipient', 'Qualifying recipient was not recorded; stored as unknown.');
      }
  } else if (status === 'qualifying sent') {
    addAmbiguity('date', 'Legacy Qualifying Sent state has no explicit sent date; kept at Approach Ready and no attempt was invented.');
  }

  const outreachPattern = /initial\s+(LinkedIn|Email|InMail|Slack|Other)\s+outreach\s+sent\s+(\d{4}-\d{2}-\d{2})\s+to\s+([^.;]+)/ig;
  for (const match of notes.matchAll(outreachPattern)) {
    attempts.push({
      opportunity: row.num,
      date: match[2],
      type: typeForOutreach(match[3]),
      channel: normalized(match[1]),
      recipient: match[3],
      result: 'sent',
      followUpTo: null,
      notes: 'Migrated from confirmed legacy outreach history.',
    });
  }

  return attempts;
}

function assignIds(existing, candidates, ambiguities) {
  const known = new Set(existing.map(attemptKey));
  let next = existing.reduce((max, attempt) => {
    const value = Number(String(attempt.id).replace(/^A/i, ''));
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 0) + 1;
  const added = [];
  const ordered = [...candidates].sort((left, right) => {
    const byOpportunity = left.opportunity - right.opportunity;
    if (byOpportunity !== 0) return byOpportunity;
    const byDate = left.date.localeCompare(right.date);
    if (byDate !== 0) return byDate;
    return Number(left.type === 'follow_up') - Number(right.type === 'follow_up');
  });
  for (const rawCandidate of ordered) {
    let candidate = rawCandidate;
    if (candidate.type === 'follow_up') {
      const alreadyMigrated = [...existing, ...added].some((attempt) =>
        attempt.opportunity === candidate.opportunity
        && attempt.date === candidate.date
        && attempt.type === candidate.type
        && normalized(attempt.channel) === normalized(candidate.channel)
        && normalized(attempt.recipient) === normalized(candidate.recipient)
        && normalized(attempt.result) === normalized(candidate.result));
      if (alreadyMigrated) continue;
    }
    if (candidate.type === 'follow_up' && !candidate.followUpTo) {
      const prior = [...existing, ...added]
        .filter((attempt) => attempt.opportunity === candidate.opportunity && attempt.date <= candidate.date)
        .sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id))
        .at(-1);
      if (!prior) {
        ambiguities.push({
          opportunity: candidate.opportunity,
          field: 'followUpTo',
          detail: 'Legacy follow-up has no confirmed prior Attempt to reference; no attempt was invented.',
        });
        continue;
      }
      candidate = { ...candidate, followUpTo: prior.id };
    }
    if (known.has(attemptKey(candidate))) continue;
    const attempt = { ...candidate, id: `A${String(next++).padStart(3, '0')}` };
    known.add(attemptKey(attempt));
    added.push(attempt);
  }
  return added;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export async function migrateApproaches(options) {
  const { appsFile, attemptsFile, followupsFile, apply = false } = options;
  const original = readFileSync(appsFile, 'utf-8');
  const lines = original.split('\n');
  const columns = resolveColumns(lines);
  const ambiguities = [];
  const candidates = [];
  const mappings = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const row = parseTrackerRow(lines[lineIdx], columns);
    if (!row) continue;
    const legacyStatus = normalized(row.status);
    const extracted = extractLegacyAttempts(row, ambiguities);
    candidates.push(...extracted);
    let destination = LEGACY_STAGE_MAP.get(legacyStatus);
    if (legacyStatus === 'applied' || legacyStatus === 'qualifying sent') {
      destination = extracted.length > 0 ? 'Approached' : 'Approach Ready';
    } else if (legacyStatus === 'outreach ready' && extracted.length > 0) {
      destination = 'Approached';
    }
    if (!destination) continue;
    mappings.push({ opportunity: row.num, from: row.status, to: destination });
    const parts = lines[lineIdx].split('|').map((part) => part.trim());
    parts[columns.status] = destination;
    lines[lineIdx] = rebuildRow(parts);
  }
  candidates.push(...parseFollowups(followupsFile, ambiguities));

  const existing = readApproachAttempts(attemptsFile);
  const added = assignIds(existing, candidates, ambiguities);
  const trackerAfter = lines.join('\n');
  const trackerChanged = trackerAfter !== original;
  const changed = trackerChanged || added.length > 0;
  const backups = [];

  if (apply && changed) {
    const lock = await acquireTrackerLock(trackerLockDirFor(appsFile), {
      timeoutMs: Number(process.env.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS) || 60_000,
      tracker: appsFile,
    });
    try {
      const suffix = `.pre-approach-${timestamp()}.bak`;
      if (trackerChanged) {
        const backup = `${appsFile}${suffix}`;
        copyFileSync(appsFile, backup);
        backups.push(backup);
        writeFileAtomic(appsFile, trackerAfter);
      }
      if (added.length > 0) {
        if (existsSync(attemptsFile)) {
          const backup = `${attemptsFile}${suffix}`;
          copyFileSync(attemptsFile, backup);
          backups.push(backup);
        }
        writeFileAtomic(attemptsFile, serializeApproachAttempts([...existing, ...added]));
      }
    } finally {
      lock.release();
    }
  }

  return {
    changed,
    dryRun: !apply,
    mappings,
    attemptsAdded: added,
    ambiguities,
    backups,
  };
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node migrate-approaches.mjs [--root PATH] [--apply] [--json]');
    process.exit(0);
  }
  const rootIndex = args.indexOf('--root');
  if (rootIndex >= 0 && (!args[rootIndex + 1] || args[rootIndex + 1].startsWith('--'))) {
    console.error('Error: --root requires a path');
    process.exit(1);
  }
  const root = rootIndex >= 0 ? args[rootIndex + 1] : dirname(fileURLToPath(import.meta.url));
  const apply = args.includes('--apply');
  const json = args.includes('--json');
  const appsFile = resolveTrackerPath(root);
  if (!appsFile || !existsSync(appsFile)) {
    console.error(`Error: Opportunity tracker not found under ${root}`);
    process.exit(1);
  }
  const result = await migrateApproaches({
    appsFile,
    attemptsFile: join(root, 'data', 'approach-attempts.md'),
    followupsFile: join(root, 'data', 'follow-ups.md'),
    apply,
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${apply ? 'Applied' : 'Preview'}: ${result.mappings.length} stage mappings, ${result.attemptsAdded.length} attempts, ${result.ambiguities.length} ambiguities.`);
    if (!apply) console.log('Re-run with --apply after reviewing the JSON preview.');
  }
}

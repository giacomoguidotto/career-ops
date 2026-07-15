#!/usr/bin/env node

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { recordApproachAttempt, APPROACH_ATTEMPT_TYPES } from './approach-attempts.mjs';
import { resolveTrackerPath } from './tracker-utils.mjs';

const USAGE = `Usage: node record-approach.mjs <opportunity#> <type> --channel <channel> --recipient <recipient> [options]

Record one user-confirmed real-world Approach Attempt.

Types: ${[...APPROACH_ATTEMPT_TYPES].join(', ')}

Options:
  --occurred-at ISO       Confirmed event date or timestamp (required)
  --date YYYY-MM-DD       Compatibility alias for --occurred-at
  --result VALUE          Confirmed result (required)
  --notes TEXT            Concise factual note
  --follow-up-to A###     Prior attempt this follows
  --dry-run               Validate and preview without writing
  --json                  Emit machine-readable output
  --help                  Show this help`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const positional = [];
const flags = { channel: '', recipient: '', date: '', result: '', notes: '', followUpTo: null, dryRun: false, json: false };
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--dry-run') flags.dryRun = true;
  else if (arg === '--json') flags.json = true;
  else if (['--channel', '--recipient', '--occurred-at', '--date', '--result', '--notes', '--follow-up-to'].includes(arg)) {
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    const key = arg === '--follow-up-to' ? 'followUpTo' : (arg === '--occurred-at' ? 'date' : arg.slice(2));
    flags[key] = value;
  } else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
  else positional.push(arg);
}

if (positional.length !== 2 || !flags.channel || !flags.recipient || !flags.date || !flags.result) {
  console.error(USAGE);
  process.exit(1);
}

const root = dirname(fileURLToPath(import.meta.url));
try {
  const response = await recordApproachAttempt({
    appsFile: resolveTrackerPath(root),
    attemptsFile: join(root, 'data', 'approach-attempts.md'),
    opportunity: positional[0],
    type: positional[1],
    channel: flags.channel,
    recipient: flags.recipient,
    date: flags.date,
    result: flags.result,
    notes: flags.notes,
    followUpTo: flags.followUpTo,
    dryRun: flags.dryRun,
  });
  if (flags.json) console.log(JSON.stringify(response, null, 2));
  else console.log(`#${positional[0]}: ${response.reason}; Stage ${response.newStage}; attempt ${response.attempt.id}.`);
} catch (error) {
  if (flags.json) console.log(JSON.stringify({ error: error.message }));
  console.error(`Error: ${error.message}`);
  process.exit(1);
}

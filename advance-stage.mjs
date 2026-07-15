#!/usr/bin/env node
/**
 * advance-stage.mjs — Advance an agent-owned application to its `_ready` stage.
 *
 * The canonical state machine (`templates/states.yml`) marks `evaluated`,
 * `responded`, and `offer` as `owner: agent`: the automation drafts an artifact
 * (application pack, interview cheatsheet, negotiation prep) and then advances the
 * row to the paired `owner: user` `_ready` stage, whose next step is the user's
 * real-world action (`Send application`, `Interview`, `Negotiate offer`). That
 * advance is a safe "a draft exists" write — it never records a real-world action.
 *
 * Previously the advance was left to the agent's discretion in `modes/next.md`,
 * so a generated pack could leave its row stuck at `Evaluated` and the dashboard
 * kept showing "Generate application pack" instead of "Send application". This
 * script makes the advance deterministic so the `next` mode (and any automation
 * that drafts packs) can run one command instead of hand-editing the tracker.
 *
 * It also syncs the generated pack's `**Stage:** / **Owner:** / **Suggests:**`
 * header to the destination stage, so the dashboard keeps the drafted pack
 * openable (`n: open …`) at the `_ready` stage — the pack is matched by its
 * `**Suggests:**` action.
 *
 * Usage:
 *   node advance-stage.mjs <num...>     Advance the given tracker rows
 *   node advance-stage.mjs --reconcile  Advance every agent row that has a drafted pack
 *   node advance-stage.mjs 93 --force   Advance even without a drafted pack on disk
 *   node advance-stage.mjs 93 --dry-run Show what would change, write nothing
 *   node advance-stage.mjs 93 --coordination-override  Human-confirm one suppressed target on a TTY
 *   node advance-stage.mjs --json       Machine-readable summary
 *   node advance-stage.mjs --self-test  Run built-in assertions (CI)
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createInterface } from 'readline/promises';
import { loadStates, resolveState, pairedReadyStage, rebuildRow } from './tracker-utils.mjs';
import { resolveColumns, parseTrackerRow } from './tracker-parse.mjs';
import { candidacyAdvanceBlockReason, loadCandidacySelection } from './candidacy-select.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));

// Support both layouts: data/applications.md (boilerplate) and applications.md.
function locateTracker() {
  const nested = join(CAREER_OPS, 'data/applications.md');
  if (existsSync(nested)) return nested;
  const flat = join(CAREER_OPS, 'applications.md');
  if (existsSync(flat)) return flat;
  return null;
}

function packsDir() {
  return join(CAREER_OPS, 'output', 'next-packs');
}

/**
 * Find the drafted next-pack for a tracker number, matching the `{num}-…` prefix
 * (zero-padded or not, since `parseInt` collapses `093` and `93`).
 *
 * @param {number} num
 * @param {string} [dir] - Packs directory (defaults to output/next-packs).
 * @returns {{ rel: string, abs: string } | null}
 */
export function findPack(num, dir = packsDir()) {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const prefix = name.split('-')[0];
    if (parseInt(prefix, 10) === num) {
      return { rel: join('output', 'next-packs', name), abs: join(dir, name) };
    }
  }
  return null;
}

/**
 * Extract the drafted artifact from a next-pack's `**Suggests:**` (or legacy
 * `**Action:**`) header. This is the action the agent just performed, and it is
 * what disambiguates which `_ready` stage an evaluated row advances to when the
 * source stage can draft more than one artifact (application pack vs qualifying
 * question). Returns null when the pack carries no such header.
 *
 * @param {string} packContent - Full pack file content.
 * @returns {string|null}
 */
export function packArtifact(packContent) {
  const m = String(packContent).match(/^\*\*(?:Suggests|Action):\*\*[ \t]*([A-Za-z_]+)[ \t]*$/m);
  return m ? m[1] : null;
}

/**
 * Decide the advance for a raw status cell, deriving routing purely from
 * states.yml. Only `agent`-owned stages advance (to their paired `_ready`
 * stage); everything else is reported with a reason so callers never guess.
 * When the agent stage can draft more than one artifact, `artifact` (the drafted
 * action, e.g. read from the pack header) selects the correct `_ready` stage.
 *
 * @param {string} statusRaw - Raw status cell text.
 * @param {ReturnType<typeof loadStates>} [states]
 * @param {string|null} [artifact] - The draft action just performed, when known.
 * @returns {{ ok: boolean, reason?: string, fromLabel?: string, toLabel?: string, readyRecord?: import('./tracker-utils.mjs').StateRecord }}
 */
export function computeAdvance(statusRaw, states = loadStates(), artifact = null) {
  const cur = resolveState(statusRaw, states);
  if (!cur) return { ok: false, reason: 'unknown-status' };
  if (cur.owner !== 'agent') {
    const reason =
      cur.owner === 'user' || cur.owner === 'external' ? 'already-advanced' : 'terminal';
    return { ok: false, reason, fromLabel: cur.label };
  }
  const ready = pairedReadyStage(cur, states, artifact);
  if (!ready) return { ok: false, reason: 'no-pairing', fromLabel: cur.label };
  return { ok: true, fromLabel: cur.label, toLabel: ready.label, readyRecord: ready };
}

/**
 * Rewrite a single markdown table row's Status cell to a new label, header-aware
 * so an inserted Location column can't shift the target.
 *
 * @param {string} line - The tracker row line.
 * @param {Object<string,number>} colmap - From resolveColumns().
 * @param {string} toLabel - New status label.
 * @returns {string} The rebuilt row.
 */
export function applyStatusToLine(line, colmap, toLabel) {
  const parts = line.split('|').map((s) => s.trim());
  parts[colmap.status] = toLabel;
  return rebuildRow(parts);
}

/**
 * Sync a next-pack's header to the destination stage so the dashboard keeps the
 * drafted artifact matched to the row (packs are matched by `**Suggests:**`).
 * Only the `**Stage:** / **Owner:** / **Suggests:**` value tokens are touched;
 * everything else (including trailing markdown hard-break spaces) is preserved.
 * Idempotent: re-running on an already-synced pack reports no change.
 *
 * @param {string} content - Full pack file content.
 * @param {import('./tracker-utils.mjs').StateRecord} readyRecord - Destination stage.
 * @returns {{ content: string, changed: boolean }}
 */
export function syncPackHeader(content, readyRecord) {
  let changed = false;
  let out = content;
  const repl = (field, value) => {
    if (value == null) return;
    const re = new RegExp(`^(\\*\\*${field}:\\*\\*[ \\t]*)([A-Za-z_]+)([ \\t]*)$`, 'm');
    out = out.replace(re, (m, p1, old, p3) => {
      if (old === value) return m;
      changed = true;
      return p1 + value + p3;
    });
  };
  repl('Stage', readyRecord.id);
  repl('Owner', readyRecord.owner);
  repl('Suggests', readyRecord.suggests);
  return { content: out, changed };
}

/**
 * Advance one or more applications in place (tracker + pack headers).
 *
 * @param {object} opts
 * @param {string} opts.appsFile - Path to applications.md.
 * @param {string} opts.packsDir - Path to output/next-packs.
 * @param {number[]} [opts.nums] - Explicit tracker numbers to advance.
 * @param {boolean} [opts.reconcile] - Advance every agent row that has a drafted pack.
 * @param {boolean} [opts.force] - Advance even without a drafted pack on disk.
 * @param {boolean} [opts.dryRun] - Compute changes but write nothing.
 * @param {ReturnType<typeof loadStates>} [opts.states]
 * @param {ReturnType<typeof loadCandidacySelection>|null} [opts.coordination]
 * @param {boolean} [opts.coordinationOverride] - Explicit interactive override for a suppressed sibling.
 * @returns {{ results: object[], trackerChanged: boolean, wrote: boolean }}
 */
export function advanceApplications(opts) {
  const {
    appsFile,
    packsDir: dir,
    nums = [],
    reconcile = false,
    force = false,
    dryRun = false,
    states = loadStates(),
    coordination = null,
    coordinationOverride = false,
  } = opts;

  const content = readFileSync(appsFile, 'utf-8');
  const lines = content.split('\n');
  const colmap = resolveColumns(lines);

  const rowsByNum = new Map();
  lines.forEach((line, index) => {
    const row = parseTrackerRow(line, colmap);
    if (row) rowsByNum.set(row.num, { row, index });
  });

  let targets = nums;
  if (reconcile) {
    targets = [];
    for (const [num, { row }] of rowsByNum) {
      if (computeAdvance(row.status, states).ok && findPack(num, dir)) targets.push(num);
    }
    targets.sort((a, b) => a - b);
  }

  const results = [];
  const packWrites = [];
  let trackerChanged = false;
  const coordinationBlocks = new Map(
    (coordination?.suppressed ?? []).map((item) => [item.num, item]),
  );

  for (const num of targets) {
    const entry = rowsByNum.get(num);
    if (!entry) {
      results.push({ num, ok: false, reason: 'not-in-tracker' });
      continue;
    }
    // Read the drafted pack first: its `**Suggests:**` header names the artifact
    // just produced, which routes multi-artifact agent stages (evaluated →
    // the drafted artifact) to the right `_ready` stage.
    const pack = findPack(num, dir);
    let packContent = null;
    let artifact = null;
    if (pack) {
      packContent = readFileSync(pack.abs, 'utf-8');
      artifact = packArtifact(packContent);
    }
    const adv = computeAdvance(entry.row.status, states, artifact);
    if (!adv.ok) {
      results.push({ num, ok: false, reason: adv.reason, from: adv.fromLabel });
      continue;
    }
    const coordinationBlock = coordinationBlocks.get(num);
    if (coordinationBlock && !coordinationOverride) {
      results.push({
        num,
        ok: false,
        reason: candidacyAdvanceBlockReason(coordinationBlock.reason),
        from: adv.fromLabel,
        clusterId: coordinationBlock.clusterId ?? null,
        primary: coordinationBlock.primary ?? null,
      });
      continue;
    }
    if (!pack && !force) {
      results.push({ num, ok: false, reason: 'no-pack', from: adv.fromLabel });
      continue;
    }

    lines[entry.index] = applyStatusToLine(lines[entry.index], colmap, adv.toLabel);
    trackerChanged = true;

    let packSynced = false;
    if (pack) {
      const synced = syncPackHeader(packContent, adv.readyRecord);
      if (synced.changed) {
        packWrites.push({ abs: pack.abs, content: synced.content });
        packSynced = true;
      }
    }

    results.push({
      num,
      ok: true,
      from: adv.fromLabel,
      to: adv.toLabel,
      pack: pack ? pack.rel : null,
      packSynced,
    });
  }

  let wrote = false;
  if (!dryRun && trackerChanged) {
    copyFileSync(appsFile, appsFile + '.bak');
    writeFileSync(appsFile, lines.join('\n'));
    for (const p of packWrites) writeFileSync(p.abs, p.content);
    wrote = true;
  }

  return { results, trackerChanged, wrote };
}

// ── Built-in self-test (CI: `node advance-stage.mjs --self-test`) ────────────

function selfTest() {
  const states = loadStates();
  let passed = 0;
  const failures = [];
  const ok = (label, cond) => (cond ? passed++ : failures.push(label));

  // Routing derived from states.yml, not hardcoded.
  ok('Evaluated is agent-owned', resolveState('Evaluated', states)?.owner === 'agent');
  ok('Evaluated → Approach Ready', computeAdvance('Evaluated', states).toLabel === 'Approach Ready');
  ok('Responded → Interview Ready', computeAdvance('Responded', states).toLabel === 'Interview Ready');
  ok('Offer → Offer Ready', computeAdvance('Offer', states).toLabel === 'Offer Ready');
  ok('bold/date noise tolerated', computeAdvance('**Evaluated** 2026-01-01', states).toLabel === 'Approach Ready');

  // Every pre-response route converges on one generated Approach Plan.
  ok('Evaluated default → Approach Ready', computeAdvance('Evaluated', states, null).toLabel === 'Approach Ready');
  ok('Evaluated + plan artifact → Approach Ready', computeAdvance('Evaluated', states, 'generate_approach_plan').toLabel === 'Approach Ready');
  ok('legacy qualifying artifact → Approach Ready', computeAdvance('Evaluated', states, 'draft_qualifying_questions').toLabel === 'Approach Ready');
  ok('packArtifact reads Suggests header', packArtifact('**Suggests:** draft_qualifying_questions  \n') === 'draft_qualifying_questions');
  ok('packArtifact null when absent', packArtifact('no header here') === null);

  // Non-agent stages never advance.
  ok('Approach Ready is already advanced', computeAdvance('Approach Ready', states).reason === 'already-advanced');
  ok('Approached does not advance', computeAdvance('Approached', states).ok === false);
  ok('Accepted is terminal', computeAdvance('Accepted', states).reason === 'terminal');
  ok('unknown status flagged', computeAdvance('Nonsense', states).reason === 'unknown-status');

  // Pack header sync + idempotency.
  const ready = computeAdvance('Evaluated', states).readyRecord;
  const raw = '**Stage:** evaluated  \n**Owner:** agent  \n**Suggests:** generate_approach_plan  \n';
  const first = syncPackHeader(raw, ready);
  ok('pack header advances stage', /\*\*Stage:\*\* approach_ready/.test(first.content));
  ok('pack header advances owner', /\*\*Owner:\*\* user/.test(first.content));
  ok('pack header advances suggests', /\*\*Suggests:\*\* execute_approach/.test(first.content));
  ok('pack header hard-break preserved', first.content.includes('execute_approach  \n'));
  ok('pack header sync reports change', first.changed === true);
  ok('pack header sync is idempotent', syncPackHeader(first.content, ready).changed === false);

  // A legacy route-specific pack still syncs to the unified plan stage.
  const qReady = computeAdvance('Evaluated', states, 'draft_qualifying_questions').readyRecord;
  const qRaw = '**Stage:** evaluated  \n**Owner:** agent  \n**Suggests:** draft_qualifying_questions  \n';
  const qSynced = syncPackHeader(qRaw, qReady);
  ok('qualifying pack → approach_ready', /\*\*Stage:\*\* approach_ready/.test(qSynced.content));
  ok('qualifying pack → execute_approach', /\*\*Suggests:\*\* execute_approach/.test(qSynced.content));

  // Header-aware status rewrite.
  const line = '| 93 | 2026-06-24 | Deepgram | Backend Engineer | 3.85/5 | Evaluated | ✅ | [112](../reports/112.md) | note |';
  const colmap = resolveColumns([line]);
  const rewritten = applyStatusToLine(line, colmap, 'Approach Ready');
  ok('status cell rewritten', / Approach Ready /.test(rewritten));
  ok('other cells preserved', rewritten.includes('Deepgram') && rewritten.includes('3.85/5') && rewritten.includes('note'));

  if (failures.length) {
    console.error(`FAIL: advance-stage self-test (${failures.length} failed)`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`OK: advance-stage self-test (${passed} checks)`);
  process.exit(0);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/**
 * A coordination override is a human-reviewed escape hatch, never an automation
 * switch. It is valid only for one explicit tracker number on an interactive TTY.
 */
export function validateCoordinationOverrideRequest({
  requested,
  reconcile,
  nums,
  json,
  stdinIsTTY,
  stdoutIsTTY,
}) {
  if (!requested) return { ok: true, needsConfirmation: false };
  if (reconcile) return { ok: false, reason: 'override-not-allowed-with-reconcile' };
  if (nums.length !== 1) return { ok: false, reason: 'override-requires-one-target' };
  if (json) return { ok: false, reason: 'override-requires-human-output' };
  if (!stdinIsTTY || !stdoutIsTTY) return { ok: false, reason: 'override-requires-tty' };
  return { ok: true, needsConfirmation: true, num: nums[0] };
}

async function confirmCoordinationOverride(num) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `Override candidacy coordination for #${num}? Type ${num} to confirm: `,
    );
    return answer.trim() === String(num);
  } finally {
    rl.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();

  const dryRun = argv.includes('--dry-run');
  const json = argv.includes('--json');
  const force = argv.includes('--force');
  const coordinationOverride = argv.includes('--coordination-override');
  const reconcile = argv.includes('--reconcile');
  const nums = argv
    .filter((a) => !a.startsWith('--'))
    .map((a) => parseInt(a, 10))
    .filter((n) => !isNaN(n));

  const overrideRequest = validateCoordinationOverrideRequest({
    requested: coordinationOverride,
    reconcile,
    nums,
    json,
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
  });
  if (!overrideRequest.ok) {
    console.error(`Coordination override refused: ${overrideRequest.reason}`);
    process.exit(1);
  }
  if (overrideRequest.needsConfirmation) {
    const confirmed = await confirmCoordinationOverride(overrideRequest.num);
    if (!confirmed) {
      console.error('Coordination override cancelled.');
      process.exit(1);
    }
  }

  if (!reconcile && nums.length === 0) {
    console.error('Usage: node advance-stage.mjs <num...> | --reconcile [--force] [--coordination-override] [--dry-run] [--json]');
    process.exit(json ? 0 : 1);
  }

  const appsFile = locateTracker();
  if (!appsFile) {
    if (json) console.log(JSON.stringify({ error: 'no-tracker', results: [] }));
    else console.log('No applications.md found. Nothing to advance.');
    process.exit(0);
  }

  const coordination = loadCandidacySelection({
    trackerPath: appsFile,
    clustersPath: join(CAREER_OPS, 'data', 'candidacy-clusters.md'),
  });

  const { results, wrote } = advanceApplications({
    appsFile,
    packsDir: packsDir(),
    nums,
    reconcile,
    force,
    dryRun,
    coordination,
    coordinationOverride,
  });

  if (json) {
    console.log(JSON.stringify({
      dryRun,
      wrote,
      coordinationOverride,
      coordination: {
        eligible: coordination.eligible.map((item) => item.num),
        suppressed: coordination.suppressed.map((item) => item.num),
        researchRequired: coordination.researchRequired,
      },
      results,
    }, null, 2));
    return;
  }

  const advanced = results.filter((r) => r.ok);
  for (const r of results) {
    if (r.ok) {
      console.log(`#${r.num}: ${r.from} → ${r.to}${r.packSynced ? '  (pack header synced)' : ''}`);
    } else {
      console.log(`#${r.num}: skipped (${r.reason}${r.from ? `, at ${r.from}` : ''})`);
    }
  }
  console.log(`\n📊 ${advanced.length} advanced`);
  if (dryRun) console.log('(dry-run — no changes written)');
  else if (wrote) console.log(`✅ Written to ${appsFile} (backup: ${appsFile}.bak)`);
  else console.log('✅ No changes needed');
}

// Only run the CLI when executed directly, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

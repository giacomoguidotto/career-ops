/**
 * tracker-utils.mjs — shared helpers for rewriting `data/applications.md` rows.
 *
 * The tracker is a markdown table that several scripts mutate in place
 * (`dedup-tracker.mjs`, `normalize-statuses.mjs`, `merge-tracker.mjs`,
 * `set-status.mjs`). Keeping the row-rewrite, path-resolution, locking, and
 * atomic-write logic here means a fix lands once instead of drifting between
 * copies — and every writer excludes every other writer through the same lock.
 *
 * This module is also the single Node-side reader of the canonical state machine
 * (`templates/states.yml`). Every tracker script that needs to validate or
 * normalize a status resolves it through `loadStates()`/`canonicalStatus()` here,
 * so the lifecycle vocabulary is defined once (in states.yml) and never
 * re-encoded as a hardcoded list in each script.
 */

import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, statSync, existsSync, realpathSync } from 'fs';
import { join, dirname, basename, resolve, relative, isAbsolute, sep } from 'path';
import { fileURLToPath } from 'url';
import { createHash, randomUUID } from 'crypto';
import { tmpdir } from 'os';
import yaml from 'js-yaml';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the canonical states file regardless of repo layout.
 *
 * The boilerplate ships it at `templates/states.yml`; a flattened/original
 * layout keeps it at the repo root as `states.yml`. Resolving relative to this
 * module's own directory (not the process cwd) means every caller finds the same
 * file no matter where it was launched from.
 *
 * @returns {string|null} Absolute path to states.yml, or null when absent.
 */
function locateStatesFile() {
  const templated = join(CAREER_OPS, 'templates/states.yml');
  if (existsSync(templated)) return templated;
  const flat = join(CAREER_OPS, 'states.yml');
  if (existsSync(flat)) return flat;
  return null;
}

let _statesCache = null;

/**
 * @typedef {object} StateRecord
 * @property {string} id - Canonical stage id (e.g. `evaluated`).
 * @property {string} label - Human label (e.g. `Evaluated`).
 * @property {string} owner - `agent` | `user` | `company` | `none`.
 * @property {string|null} suggests - The stage's proactive next action, or null.
 * @property {string[]} nextStates - Allowed successor stage ids.
 * @property {string} group - dashboard_group.
 */

/**
 * Load and index the canonical lifecycle state machine from states.yml.
 *
 * Builds a case-insensitive lookup from every label, id, and alias to that
 * state's canonical label, plus the ordered list of labels and a
 * label/id/alias → dashboard_group map. It also exposes the full stage records
 * (owner/suggests/next_states) so writers that advance stages can derive routing
 * from the same table the dashboard reads. The result is cached; pass
 * `{ force: true }` to re-read (used by tests that swap fixtures).
 *
 * @param {object} [options]
 * @param {boolean} [options.force] - Re-read the file, bypassing the cache.
 * @returns {{ byKey: Map<string,string>, labels: string[], groupByKey: Map<string,string>, records: StateRecord[], byId: Map<string,StateRecord>, recordByKey: Map<string,StateRecord> }}
 */
export function loadStates(options = {}) {
  if (_statesCache && !options.force) return _statesCache;
  const path = locateStatesFile();
  if (!path) {
    throw new Error('states.yml not found (looked for templates/states.yml and states.yml).');
  }
  const doc = yaml.load(readFileSync(path, 'utf-8'));
  const byKey = new Map(); // lowercased label/id/alias → canonical label
  const groupByKey = new Map(); // same keys → dashboard_group
  const recordByKey = new Map(); // same keys → StateRecord
  const byId = new Map(); // lowercased id → StateRecord
  const records = [];
  const labels = [];
  for (const s of doc?.states || []) {
    if (!s?.label) continue;
    labels.push(s.label);
    const group = s.dashboard_group || '';
    /** @type {StateRecord} */
    const record = {
      id: s.id || '',
      label: s.label,
      owner: s.owner || 'none',
      suggests: s.suggests || null,
      nextStates: (s.next_states || []).map((v) => String(v)),
      group,
    };
    records.push(record);
    if (record.id) byId.set(record.id.toLowerCase(), record);
    const register = (k) => {
      const key = String(k).toLowerCase();
      byKey.set(key, s.label);
      groupByKey.set(key, group);
      recordByKey.set(key, record);
    };
    register(s.label);
    if (s.id) register(s.id);
    for (const alias of s.aliases || []) register(alias);
  }
  _statesCache = { byKey, labels, groupByKey, records, byId, recordByKey };
  return _statesCache;
}

/**
 * Resolve a raw status cell to its full canonical stage record.
 *
 * Same normalization as {@link canonicalStatus} (strips markdown bold and any
 * trailing ISO date), but returns the whole {@link StateRecord} so callers can
 * inspect `owner`/`suggests`/`nextStates`. Returns null for unknown statuses.
 *
 * @param {string} raw - Raw status text from a tracker row.
 * @param {ReturnType<typeof loadStates>} [states] - Preloaded states.
 * @returns {StateRecord|null}
 */
export function resolveState(raw, states = loadStates()) {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/\*\*/g, '')
    .replace(/\(?\d{4}-\d{2}-\d{2}\)?/g, '')
    .trim()
    .toLowerCase();
  return states.recordByKey.get(cleaned) || null;
}

/**
 * Given an `agent`-owned stage, return the `_ready` stage it advances to.
 *
 * The state machine pairs each agent stage (the automation drafts an artifact)
 * with exactly one `user`-owned successor (the drafted artifact is re-presented
 * and the user performs the real-world action): `evaluated → application_ready`,
 * `responded → interview_ready`, `offer → offer_ready`. The pairing is derived
 * structurally — the unique `owner: user` entry in the stage's `next_states` —
 * so it stays correct if the table changes, and never hardcodes the mapping.
 *
 * Returns null when the stage is not agent-owned, or when the pairing is not a
 * single unambiguous user successor (so callers fail loudly instead of guessing).
 *
 * @param {StateRecord|null} record - The current stage record.
 * @param {ReturnType<typeof loadStates>} [states] - Preloaded states.
 * @returns {StateRecord|null} The paired `_ready` stage record, or null.
 */
export function pairedReadyStage(record, states = loadStates()) {
  if (!record || record.owner !== 'agent') return null;
  const userSuccessors = record.nextStates
    .map((id) => states.byId.get(String(id).toLowerCase()))
    .filter((r) => r && r.owner === 'user');
  return userSuccessors.length === 1 ? userSuccessors[0] : null;
}

/**
 * Resolve a raw status cell to its canonical states.yml label.
 *
 * Strips Markdown bold and any trailing ISO date noise, lowercases, then looks
 * the value up against every known label, id, and alias. Returns null for
 * unknown statuses so each caller can decide how to treat unrecognized input
 * (flag it, default it, or reject it).
 *
 * @param {string} raw - Raw status text from a tracker row or TSV addition.
 * @param {{ byKey: Map<string,string> }} [states] - Preloaded states (defaults to loadStates()).
 * @returns {string|null} Canonical label, or null when unrecognized.
 */
export function canonicalStatus(raw, states = loadStates()) {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/\*\*/g, '')
    .replace(/\(?\d{4}-\d{2}-\d{2}\)?/g, '')
    .trim()
    .toLowerCase();
  return states.byKey.get(cleaned) || null;
}

/**
 * Resolve a raw status cell to its coarse dashboard_group per states.yml.
 *
 * The `_ready` and subloop stages roll up onto their world-stage group
 * (e.g. `Interview Ready` → `interview`, `Outreach Ready` → `applied`), which is
 * the bucket readers use for funnels, follow-up cadence, and dedup ranking.
 * Returns null for unrecognized statuses.
 *
 * @param {string} raw - Raw status text from a tracker row or TSV addition.
 * @param {{ groupByKey: Map<string,string> }} [states] - Preloaded states (defaults to loadStates()).
 * @returns {string|null} dashboard_group, or null when unrecognized.
 */
export function dashboardGroup(raw, states = loadStates()) {
  if (!raw) return null;
  const cleaned = String(raw)
    .replace(/\*\*/g, '')
    .replace(/\(?\d{4}-\d{2}-\d{2}\)?/g, '')
    .trim()
    .toLowerCase();
  return states.groupByKey.get(cleaned) || null;
}

/**
 * Rebuild a markdown table row from the cells produced by `line.split('|')`.
 *
 * `split('|')` yields a leading empty element (before the opening `|`) and,
 * when the row ends with a trailing `|`, a trailing empty element too. A naive
 * `slice(1, -1)` assumes that trailing empty always exists — but a row written
 * without a trailing pipe (`| 5 | … | note`, still a valid row) keeps its real
 * last cell (the notes) at the end, so `slice(1, -1)` silently drops it. Here we
 * drop the leading empty and only drop a trailing element when it is genuinely
 * empty, preserving every real cell regardless of trailing-pipe style (and
 * tolerating extra columns like a custom Location).
 *
 * @param {string[]} parts - Trimmed cells from `line.split('|').map(s => s.trim())`.
 * @returns {string} The rebuilt `| a | b | … |` row.
 */
export function rebuildRow(parts) {
  const cells = parts.slice(1);
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return '| ' + cells.join(' | ') + ' |';
}

/**
 * Normalize company names for same-company lookups across tracker scripts.
 *
 * Company names can contain spaces, punctuation, or branding variants in the
 * tracker and incoming rows. Removing non-alphanumeric characters gives every
 * consumer (merge-tracker dedup, set-status row resolution) the same stable
 * company key, so a row one script would match is never missed by another.
 *
 * @param {string} name - Company name from the tracker or an input row.
 * @returns {string} Lowercase alphanumeric company key.
 */
export function normalizeCompany(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Neutralize characters that would corrupt the applications.md table.
 *
 * Tracker rows are read with a raw `line.split('|')`, so a literal pipe or a
 * newline in a free-text value (company/role/location/notes) would shift every
 * later column. Replace rather than backslash-escape: `\|` would still split
 * on the inner pipe. Additive — normal cells are unchanged; only values that
 * would already break the table get sanitized.
 *
 * @param {*} v - Free-text value headed for a table cell.
 * @returns {string} Table-safe value.
 */
export function cell(v) {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/\s*\|\s*/g, ' / ').trim();
}

/**
 * Resolve the tracker file path for the current workspace.
 *
 * Supports both layouts: `data/applications.md` (boilerplate) and
 * `applications.md` (original root layout). The `CAREER_OPS_TRACKER` env var
 * overrides the path (used by tests and non-standard layouts). The result is
 * canonicalized so every script that locks or hashes the tracker path agrees
 * on one spelling.
 *
 * @param {string} rootDir - The career-ops repository root.
 * @returns {string} Absolute canonical tracker path.
 */
export function resolveTrackerPath(rootDir) {
  const raw = process.env.CAREER_OPS_TRACKER
    ? process.env.CAREER_OPS_TRACKER
    : existsSync(join(rootDir, 'data/applications.md'))
      ? join(rootDir, 'data/applications.md')
      : join(rootDir, 'applications.md');
  return canonicalizeTrackerPath(raw);
}

/**
 * Convert the tracker path into one stable absolute spelling before hashing it.
 *
 * Equivalent tracker paths can be written in multiple ways, such as a relative
 * path from the current shell, an absolute path, or a path that travels through
 * a symlink. The lock key must be based on one canonical spelling so all
 * processes that target the same tracker also target the same lock directory.
 *
 * @param {string} path - Raw tracker path from config, env, or the default.
 * @returns {string} Absolute canonical path when the file exists, else resolved path.
 */
export function canonicalizeTrackerPath(path) {
  const absolutePath = resolve(path);
  try {
    return realpathSync(absolutePath);
  } catch {
    return absolutePath;
  }
}

/**
 * Check whether one absolute path stays inside another directory.
 *
 * This protects recursive lock cleanup from accepting paths that escape the
 * system temp directory through `..` segments or unrelated absolute roots.
 *
 * @param {string} childPath - Candidate path to validate.
 * @param {string} parentDir - Required parent directory boundary.
 * @returns {boolean} True when childPath is inside parentDir or equal to it.
 */
function pathIsInside(childPath, parentDir) {
  const relativePath = relative(parentDir, childPath);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

/**
 * Compute the tracker lock directory for a tracker file.
 *
 * The lock name is derived from a hash of the canonical tracker path, so every
 * writer (`merge-tracker.mjs`, `set-status.mjs`) that targets the same tracker
 * contends on the same lock. `CAREER_OPS_TRACKER_LOCK` exists for tests and
 * unusual local layouts, but lock directories are removed recursively, so
 * env-provided paths must be absolute, live under the OS temp directory, and
 * use the career-ops lock-name prefix. Invalid values are ignored and the
 * deterministic temp-dir default is used instead.
 *
 * @param {string} appsFile - Canonical tracker path (see canonicalizeTrackerPath).
 * @returns {string} Safe lock directory path.
 */
export function trackerLockDirFor(appsFile) {
  const lockKey = createHash('sha256').update(appsFile).digest('hex').slice(0, 16);
  const tmpRoot = realpathSync(tmpdir());
  const fallback = join(tmpRoot, `career-ops-merge-tracker-${lockKey}.lock`);
  const envValue = process.env.CAREER_OPS_TRACKER_LOCK;
  if (!envValue || !isAbsolute(envValue)) return fallback;

  const candidate = resolve(envValue);
  const parentDir = dirname(candidate);
  const canonicalParent = existsSync(parentDir) ? realpathSync(parentDir) : resolve(parentDir);
  if (!pathIsInside(canonicalParent, tmpRoot)) return fallback;
  if (!basename(candidate).startsWith('career-ops-merge-tracker-')) return fallback;
  return candidate;
}

/**
 * Pause the async lock flow for a fixed number of milliseconds.
 *
 * Used in the lock retry loop, where waiting briefly avoids a tight CPU spin
 * while another process owns the tracker lock.
 *
 * @param {number} ms - Milliseconds to wait before resolving.
 * @returns {Promise<void>} Resolves after the requested delay.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Determine whether a process id still belongs to a live process.
 *
 * The tracker lock stores the owner PID in `owner.json`. When another process
 * finds an existing lock, this check lets it distinguish a valid live owner from
 * a crashed process that left a stale lock directory behind. `EPERM` counts as
 * alive because the process exists even if the current user cannot signal it.
 *
 * @param {number} pid - Process id recorded by the lock owner.
 * @returns {boolean} True when the process appears to still exist.
 */
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * Read lock ownership metadata from a tracker lock directory.
 *
 * The metadata contains the owner PID, a unique release token, the acquisition
 * timestamp, and the tracker path. Invalid or missing metadata is treated as
 * unreadable so the stale-lock recovery path can fall back to directory age.
 *
 * @param {string} lockDir - Directory that represents the active lock.
 * @returns {object|null} Parsed owner metadata, or null when unavailable.
 */
function readLockOwner(lockDir) {
  try {
    return JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Decide whether an existing lock can be safely recovered.
 *
 * Recovery is conservative: if the lock has an owner PID and that process is
 * still alive, the lock is never considered stale merely because it is old. If
 * the owner process is gone, or if the metadata cannot be read and the lock
 * directory itself is older than the stale threshold, the waiting process may
 * remove the lock and retry acquisition.
 *
 * @param {string} lockDir - Directory that represents the active lock.
 * @param {number} staleMs - Age threshold for metadata-free lock recovery.
 * @returns {boolean} True when the caller may remove and recreate the lock.
 */
function lockCanRecover(lockDir, staleMs) {
  const owner = readLockOwner(lockDir);
  if (owner?.pid) return !processIsAlive(owner.pid);

  try {
    return Date.now() - statSync(lockDir).mtimeMs > staleMs;
  } catch {
    return true;
  }
}

/**
 * Acquire an exclusive filesystem lock for one tracker mutation.
 *
 * The critical section must cover the full read/modify/write/move sequence, not
 * just the final write. Otherwise two processes can read the same old tracker
 * snapshot, compute independent updates, and let the later writer erase rows
 * written by the earlier one. The lock is implemented with atomic directory
 * creation, owner metadata, retry/backoff, stale-owner recovery, and a release
 * token so one process cannot delete another process's newer lock.
 *
 * @param {string} lockDir - Directory path used as the lock sentinel.
 * @param {object} [options] - Lock timing options.
 * @param {number} [options.timeoutMs=60000] - Maximum time to wait for the lock.
 * @param {number} [options.retryMs=75] - Delay between acquisition attempts.
 * @param {number} [options.staleMs=600000] - Metadata-free stale-lock threshold.
 * @param {string} [options.tracker] - Tracker path recorded in owner metadata.
 * @returns {Promise<{attempts:number,waitMs:number,staleRecovered:boolean,release:Function}>}
 * Lock handle with metadata and an idempotent release method.
 */
export async function acquireTrackerLock(lockDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retryMs = options.retryMs ?? 75;
  const staleMs = options.staleMs ?? 10 * 60_000;
  const recoverGuardDir = `${lockDir}.recover`;
  const token = randomUUID();
  const startedAt = Date.now();
  let attempts = 0;
  let staleRecovered = false;

  while (Date.now() - startedAt < timeoutMs) {
    attempts++;
    try {
      mkdirSync(lockDir);
      try {
        writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
          pid: process.pid,
          token,
          started_at: new Date().toISOString(),
          tracker: options.tracker ?? '',
        }, null, 2));
      } catch (ownerErr) {
        // We created the dir but could not record ownership. An empty,
        // owner-less lock dir would block every future locker until the
        // staleMs age-out — remove what we just created before rethrowing.
        // Scoped to the owner write only: the mkdir EEXIST contention path
        // is still handled by the outer catch.
        rmSync(lockDir, { recursive: true, force: true });
        throw ownerErr;
      }

      let released = false;
      return {
        attempts,
        waitMs: Date.now() - startedAt,
        staleRecovered,
        release() {
          if (released) return;
          released = true;
          const owner = readLockOwner(lockDir);
          if (owner?.token === token) {
            rmSync(lockDir, { recursive: true, force: true });
          }
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;

      let hasRecoverGuard = false;
      try {
        mkdirSync(recoverGuardDir);
        hasRecoverGuard = true;
      } catch (guardErr) {
        if (guardErr?.code !== 'EEXIST') throw guardErr;
        // A process killed between creating the guard and its cleanup leaves
        // the guard behind forever, permanently disabling stale-lock recovery
        // for every future writer. The guard normally lives for milliseconds,
        // so an old one is judged stale by the same age rule as a
        // metadata-free lock and removed; the next loop iteration can then
        // take the guard and run recovery.
        if (lockCanRecover(recoverGuardDir, staleMs)) {
          rmSync(recoverGuardDir, { recursive: true, force: true });
        }
      }

      if (hasRecoverGuard) {
        try {
          if (lockCanRecover(lockDir, staleMs)) {
            rmSync(lockDir, { recursive: true, force: true });
            staleRecovered = true;
            continue;
          }
        } finally {
          rmSync(recoverGuardDir, { recursive: true, force: true });
        }
      }

      await sleep(retryMs);
    }
  }

  // Tag the timeout so callers can tell "lock is busy, retry later" apart
  // from filesystem/configuration failures rethrown out of the loop above.
  const timeoutErr = new Error(`Timed out waiting for tracker lock at ${lockDir}`);
  timeoutErr.code = 'LOCK_TIMEOUT';
  throw timeoutErr;
}

/**
 * Replace a tracker file atomically using a same-directory temporary file.
 *
 * Writing into the same directory keeps the final `renameSync` atomic on normal
 * filesystems and avoids exposing a partially written `applications.md` to other
 * readers. If the write or rename fails, the temporary file is cleaned up before
 * the original error is rethrown.
 *
 * @param {string} path - Final file path to replace.
 * @param {string} content - Complete file content to write.
 * @returns {void}
 */
export function writeFileAtomic(path, content) {
  const tmpPath = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, content);
    renameSync(tmpPath, path);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

/**
 * Load the canonical tracker states from `templates/states.yml`.
 *
 * states.yml is the single source of truth for the 8 canonical states and
 * their aliases. Parsing it here (instead of hardcoding the list) means a new
 * state or alias lands in one file and every consumer follows.
 *
 * @param {string} statesPath - Path to templates/states.yml.
 * @returns {{id:string,label:string,aliases:string[]}[]} Parsed state entries.
 */
export function loadCanonicalStates(statesPath) {
  const doc = yaml.load(readFileSync(statesPath, 'utf-8'));
  if (!doc || !Array.isArray(doc.states)) {
    throw new Error(`Malformed states file at ${statesPath}: expected a top-level "states" list`);
  }
  return doc.states.map(s => ({
    id: String(s.id ?? ''),
    label: String(s.label ?? ''),
    aliases: Array.isArray(s.aliases) ? s.aliases.map(String) : [],
  }));
}

/**
 * Resolve user input to a canonical state label, strictly.
 *
 * Case-insensitive match against each state's label, id, and aliases, after
 * stripping markdown bold. Unlike merge-tracker's lenient batch normalization
 * (which defaults unknowns to "Evaluated" so a whole merge isn't lost), this
 * is the strict variant for interactive/CLI use: unknown input returns null so
 * the caller can reject it before anything touches the tracker.
 *
 * @param {string} input - Raw state text from the user or a script.
 * @param {{id:string,label:string,aliases:string[]}[]} states - From loadCanonicalStates().
 * @returns {string|null} Canonical label (e.g. "Applied"), or null when unknown.
 */
export function resolveCanonicalState(input, states) {
  const clean = String(input ?? '').replace(/\*\*/g, '').trim().toLowerCase();
  if (!clean) return null;
  for (const s of states) {
    if (s.label.toLowerCase() === clean) return s.label;
    if (s.id.toLowerCase() === clean) return s.label;
    if (s.aliases.some(a => a.toLowerCase() === clean)) return s.label;
  }
  return null;
}

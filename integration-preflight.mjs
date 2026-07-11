#!/usr/bin/env node
/**
 * Read-only safety preflight for an upstream-bound integration worktree.
 *
 * Usage:
 *   node integration-preflight.mjs [--worktree PATH] [--json]
 */

import { execFileSync } from 'child_process';
import { realpathSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { USER_PATHS } from './update-system.mjs';

const USER_LAYER_SCAFFOLD = new Set([
  'writing-samples/README.md',
  'interview-prep/sessions/README.md',
  'interview-prep/sessions/.gitkeep',
]);

function git(worktree, ...args) {
  return execFileSync('git', ['-C', worktree, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function canonicalPath(path) {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

function parseArgs(argv) {
  const options = { json: false, worktree: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--worktree') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--worktree requires a path');
      options.worktree = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function parseWorktrees(raw) {
  const records = [];
  let record = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      record = { path: line.slice('worktree '.length) };
      records.push(record);
    } else if (record && line.startsWith('HEAD ')) {
      record.head = line.slice('HEAD '.length);
    } else if (record && line.startsWith('branch ')) {
      record.branch = line.slice('branch refs/heads/'.length);
    }
  }
  return records;
}

function changedPaths(worktree) {
  const paths = new Set();
  for (const args of [
    ['diff', '--name-only'],
    ['diff', '--name-only', '--cached'],
    ['ls-files', '--others', '--exclude-standard'],
  ]) {
    const output = git(worktree, ...args);
    for (const path of output.split('\n').filter(Boolean)) paths.add(path);
  }
  return [...paths].sort();
}

function isUserLayerPath(path) {
  if (USER_LAYER_SCAFFOLD.has(path)) return false;
  return USER_PATHS.some((userPath) => (
    userPath.endsWith('/') ? path.startsWith(userPath) : path === userPath
  ));
}

function userLayerChanges(worktree, upstreamMain, dirtyPaths) {
  const candidates = new Set(dirtyPaths);
  const committed = git(worktree, 'diff', '--name-only', `${upstreamMain}...HEAD`);
  for (const path of committed.split('\n').filter(Boolean)) candidates.add(path);
  const ignored = git(
    worktree,
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--',
    ...USER_PATHS,
  );
  for (const path of ignored.split('\n').filter(Boolean)) candidates.add(path);
  return [...candidates].filter(isUserLayerPath).sort();
}

function summarizePaths(paths, limit = 10) {
  if (paths.length <= limit) return paths.join(', ');
  return `${paths.slice(0, limit).join(', ')} (+${paths.length - limit} more)`;
}

export function inspectIntegrationWorktree(path) {
  const requestedPath = canonicalPath(path);
  const repositoryRoot = canonicalPath(git(requestedPath, 'rev-parse', '--show-toplevel'));
  const upstreamMain = git(requestedPath, 'rev-parse', 'refs/remotes/upstream/main');
  const originMain = git(requestedPath, 'rev-parse', 'refs/remotes/origin/main');
  const [originOnly, upstreamOnly] = git(
    requestedPath,
    'rev-list',
    '--left-right',
    '--count',
    'refs/remotes/origin/main...refs/remotes/upstream/main',
  ).split(/\s+/).map(Number);
  const head = git(requestedPath, 'rev-parse', 'HEAD');
  const branch = git(requestedPath, 'branch', '--show-current');
  const worktrees = parseWorktrees(git(requestedPath, 'worktree', 'list', '--porcelain'));
  const primaryWorktree = worktrees[0] ?? null;
  const candidateWorktree = worktrees.find((item) => canonicalPath(item.path) === repositoryRoot);
  const dirtyPaths = changedPaths(requestedPath);
  const userLayerPaths = userLayerChanges(requestedPath, upstreamMain, dirtyPaths);
  const clean = dirtyPaths.length === 0;
  const aligned = originMain === upstreamMain;
  const exactUpstreamTip = head === upstreamMain;
  const primaryPath = primaryWorktree ? canonicalPath(primaryWorktree.path) : null;
  const primaryProtectsFork = primaryWorktree?.branch === 'fork/main';
  const isolated = Boolean(
    candidateWorktree
    && primaryPath
    && primaryPath !== repositoryRoot
    && primaryProtectsFork,
  );
  const checks = [
    {
      id: 'mirror-aligned',
      ok: aligned,
      reason: aligned
        ? 'origin/main and upstream/main identify the same commit'
        : `origin/main (${originMain}) and upstream/main (${upstreamMain}) identify different commits`,
      remediation: aligned
        ? null
        : originOnly === 0
          ? 'git push origin upstream/main:main'
          : 'Reconcile the divergent origin/main branch without force-pushing, then rerun the preflight.',
    },
    {
      id: 'worktree-clean',
      ok: clean,
      reason: clean
        ? 'candidate integration worktree has no staged, unstaged, or untracked changes'
        : `candidate integration worktree has changes: ${summarizePaths(dirtyPaths)}`,
      remediation: clean
        ? null
        : 'In the candidate worktree, commit, stash, or remove every listed change, then rerun the preflight.',
    },
    {
      id: 'upstream-tip',
      ok: exactUpstreamTip,
      reason: exactUpstreamTip
        ? `candidate HEAD equals upstream/main (${upstreamMain})`
        : `candidate HEAD (${head}) does not equal upstream/main (${upstreamMain})`,
      remediation: exactUpstreamTip
        ? null
        : 'Create a fresh path and branch from the fetched upstream tip: git worktree add -b ticket/<issue>-<slug> <new-path> upstream/main',
    },
    {
      id: 'user-layer-safe',
      ok: userLayerPaths.length === 0,
      reason: userLayerPaths.length === 0
        ? 'candidate contains no changed or copied user-layer files'
        : `candidate contains user-layer files: ${summarizePaths(userLayerPaths)}`,
      remediation: userLayerPaths.length === 0
        ? null
        : 'Remove user-layer files from the integration worktree. Keep personal data only in the live fork checkout; use fictional fixtures under examples/ for tests.',
    },
    {
      id: 'isolated-worktree',
      ok: isolated,
      reason: isolated
        ? `candidate is separate from the primary/live fork/main checkout at ${primaryPath}`
        : primaryPath === repositoryRoot
          ? `candidate path is the primary/live fork/main checkout at ${repositoryRoot}`
          : primaryWorktree && !primaryProtectsFork
            ? `primary checkout at ${primaryPath} is on ${primaryWorktree.branch ?? 'a detached HEAD'}, not fork/main`
            : 'candidate is not a linked worktree with the primary checkout left on fork/main',
      remediation: isolated
        ? null
        : 'Leave fork/main checked out where it is and create a separate upstream-bound worktree: git worktree add -b ticket/<issue>-<slug> <new-path> upstream/main',
    },
    {
      id: 'named-branch',
      ok: Boolean(branch),
      reason: branch
        ? `candidate is on branch ${branch}`
        : 'candidate HEAD is detached',
      remediation: branch
        ? null
        : 'Create a named ticket branch at the exact upstream tip: git switch -c ticket/<issue>-<slug> upstream/main',
    },
  ];
  const ok = checks.every((check) => check.ok);

  return {
    ok,
    repositoryRoot,
    refs: { originMain, upstreamMain, aligned, originOnly, upstreamOnly },
    worktree: { path: repositoryRoot, branch, head, clean, dirtyPaths, exactUpstreamTip, isolated },
    primaryCheckout: primaryWorktree
      ? { path: primaryPath, branch: primaryWorktree.branch ?? null, head: primaryWorktree.head }
      : null,
    liveFork: primaryProtectsFork
      ? { path: primaryPath, branch: primaryWorktree.branch, head: primaryWorktree.head }
      : null,
    safety: { userLayerPaths },
    checks,
  };
}

function printHuman(result) {
  const mark = (value) => (value ? 'OK' : 'FAIL');
  console.log(`Integration preflight: ${result.ok ? 'PASS' : 'FAIL'}`);
  for (const check of result.checks) {
    console.log(`[${mark(check.ok)}] ${check.reason}`);
    if (!check.ok) console.log(`  Fix: ${check.remediation}`);
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    const result = inspectIntegrationWorktree(options.worktree);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    const json = process.argv.includes('--json');
    if (json) console.log(JSON.stringify({ ok: false, error: error.message }));
    else console.error(`Integration preflight failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

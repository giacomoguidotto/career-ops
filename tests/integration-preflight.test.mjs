import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fail, pass, NODE, ROOT } from './helpers.mjs';

const CLI = join(ROOT, 'integration-preflight.mjs');

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function commitFile(cwd, path, content, message) {
  writeFileSync(join(cwd, path), content);
  git(cwd, 'add', path);
  git(cwd, 'commit', '-m', message);
}

function createFixture() {
  const temp = mkdtempSync(join(tmpdir(), 'career-ops-integration-preflight-'));
  const live = join(temp, 'career-ops');
  const candidate = join(temp, 'candidate');
  mkdirSync(live);
  git(live, 'init', '--initial-branch=main');
  git(live, 'config', 'user.name', 'Test User');
  git(live, 'config', 'user.email', 'test@example.com');
  commitFile(live, 'bootstrap.txt', 'bootstrap\n', 'bootstrap');
  commitFile(live, '.gitignore', 'data/\noutput/\nreports/\n', 'ignore user layer');
  const previousUpstreamTip = git(live, 'rev-parse', 'HEAD');
  commitFile(live, 'system.txt', 'upstream\n', 'upstream baseline');
  const upstreamTip = git(live, 'rev-parse', 'HEAD');
  git(live, 'update-ref', 'refs/remotes/origin/main', upstreamTip);
  git(live, 'update-ref', 'refs/remotes/upstream/main', upstreamTip);
  git(live, 'switch', '-c', 'fork/main');
  commitFile(live, 'fork-only.txt', 'runtime\n', 'fork runtime');
  git(live, 'worktree', 'add', '-b', 'ticket/5-upstream-change', candidate, upstreamTip);
  return { temp, live, candidate, upstreamTip, previousUpstreamTip };
}

function withFixture(test) {
  const fixture = createFixture();
  try {
    test(fixture);
  } finally {
    rmSync(fixture.temp, { recursive: true, force: true });
  }
}

function runPreflightJson(worktree) {
  const result = spawnSync(NODE, [CLI, '--worktree', worktree, '--json'], {
    cwd: worktree,
    encoding: 'utf8',
  });
  let payload = null;
  try { payload = JSON.parse(result.stdout); } catch {}
  return { result, payload };
}

console.log('\nintegration-preflight.mjs — upstream worktree safety');

withFixture((fixture) => {
  git(fixture.live, 'update-ref', 'refs/remotes/origin/main', fixture.previousUpstreamTip);
  const { result, payload } = runPreflightJson(fixture.candidate);
  const check = payload?.checks?.find((item) => item.id === 'mirror-aligned');
  if (result.status === 1 && payload?.ok === false && payload?.refs?.aligned === false
      && check?.reason?.includes('origin/main')
      && check?.remediation === 'git push origin upstream/main:main') {
    pass('outdated origin/main is rejected with fast-forward remediation');
  } else {
    fail(`mirror mismatch was not actionable: status=${result.status} payload=${JSON.stringify(payload)}`);
  }
});

{
  const instructions = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  if (instructions.includes('| Upstream-bound work |')
      && instructions.includes('| Fork-only work |')
      && instructions.includes('| Upstream absorption |')
      && instructions.includes('node integration-preflight.mjs')) {
    pass('agent guidance documents the three-lane branch matrix and preflight');
  } else {
    fail('AGENTS.md is missing the upstream-bound, fork-only, and upstream-absorption branch matrix');
  }
}

withFixture((fixture) => {
  git(fixture.live, 'switch', '-c', 'repointed-root', fixture.upstreamTip);
  git(fixture.live, 'worktree', 'add', join(fixture.temp, 'displaced-fork'), 'fork/main');
  const { result, payload } = runPreflightJson(fixture.candidate);
  const check = payload?.checks?.find((item) => item.id === 'isolated-worktree');
  if (result.status === 1 && check?.ok === false
      && check.reason.includes('primary checkout')
      && check.reason.includes('fork/main')) {
    pass('linked fork/main cannot disguise a repointed primary checkout');
  } else {
    fail(`repointed primary checkout escaped protection: ${result.stdout}`);
  }
});

withFixture((fixture) => {
  writeFileSync(join(fixture.candidate, 'system.txt'), 'dirty\n');
  const { result, payload } = runPreflightJson(fixture.candidate);
  const check = payload?.checks?.find((item) => item.id === 'worktree-clean');
  if (result.status === 1 && check?.ok === false
      && check.reason.includes('system.txt')
      && check.remediation.includes('commit, stash, or remove')) {
    pass('dirty integration worktree is rejected with changed paths and remediation');
  } else {
    fail(`dirty worktree rejection was not actionable: ${result.stdout}`);
  }
});

withFixture((fixture) => {
  mkdirSync(join(fixture.candidate, 'plugins.local'));
  writeFileSync(join(fixture.candidate, 'plugins.local', 'README.md'), 'private plugin notes\n');
  mkdirSync(join(fixture.candidate, 'data'));
  writeFileSync(join(fixture.candidate, 'data', '.gitkeep'), 'not an approved scaffold mutation\n');
  const { result, payload } = runPreflightJson(fixture.candidate);
  const check = payload?.checks?.find((item) => item.id === 'user-layer-safe');
  if (result.status === 1 && check?.ok === false
      && check.reason.includes('plugins.local/README.md')
      && check.reason.includes('data/.gitkeep')) {
    pass('undocumented README and .gitkeep names do not bypass user-layer protection');
  } else {
    fail(`user-layer README escaped the preflight: ${result.stdout}`);
  }
});

withFixture((fixture) => {
  const { result, payload } = runPreflightJson(fixture.live);
  const check = payload?.checks?.find((item) => item.id === 'isolated-worktree');
  if (result.status === 1 && check?.ok === false
      && check.reason.includes('live fork/main checkout')
      && check.remediation.includes('git worktree add -b')) {
    pass('running preflight in live fork/main is rejected with isolation guidance');
  } else {
    fail(`live checkout was not explicitly protected: ${result.stdout}`);
  }
});

withFixture((fixture) => {
  mkdirSync(join(fixture.candidate, 'data'));
  writeFileSync(join(fixture.candidate, 'data', 'applications.md'), 'private tracker data\n');
  const { result, payload } = runPreflightJson(fixture.candidate);
  const check = payload?.checks?.find((item) => item.id === 'user-layer-safe');
  if (result.status === 1 && check?.ok === false
      && check.reason.includes('data/applications.md')
      && check.remediation.includes('Remove user-layer files from the integration worktree')) {
    pass('ignored user-layer copy is detected before implementation begins');
  } else {
    fail(`user-layer mutation escaped the preflight: ${result.stdout}`);
  }
});

withFixture((fixture) => {
  commitFile(fixture.candidate, 'implementation.txt', 'started too early\n', 'implementation');
  const { result, payload } = runPreflightJson(fixture.candidate);
  const check = payload?.checks?.find((item) => item.id === 'upstream-tip');
  if (result.status === 1 && check?.ok === false
      && check.reason.includes(fixture.upstreamTip)
      && check.remediation.includes('git worktree add -b')
      && check.remediation.includes('upstream/main')) {
    pass('clean branch that no longer equals upstream tip is rejected with recreation guidance');
  } else {
    fail(`incorrect base rejection was not actionable: ${result.stdout}`);
  }
});

withFixture((fixture) => {
  const before = {
    head: git(fixture.live, 'rev-parse', 'HEAD'),
    branch: git(fixture.live, 'branch', '--show-current'),
    status: git(fixture.live, 'status', '--porcelain=v1', '--untracked-files=all'),
  };
  const { result, payload } = runPreflightJson(fixture.candidate);
  const after = {
    head: git(fixture.live, 'rev-parse', 'HEAD'),
    branch: git(fixture.live, 'branch', '--show-current'),
    status: git(fixture.live, 'status', '--porcelain=v1', '--untracked-files=all'),
  };

  if (result.status === 0 && payload?.ok === true
      && payload?.refs?.aligned === true
      && payload?.worktree?.head === fixture.upstreamTip
      && payload?.liveFork?.path === realpathSync(fixture.live)) {
    pass('clean isolated worktree at the mirrored upstream tip passes');
  } else {
    fail(`valid upstream worktree rejected: status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`);
  }

  if (JSON.stringify(after) === JSON.stringify(before)) {
    pass('preflight leaves the live fork/main checkout unchanged');
  } else {
    fail(`live fork/main checkout changed: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }
});

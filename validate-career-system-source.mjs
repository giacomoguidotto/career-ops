#!/usr/bin/env node

import { execFileSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, extname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_EXPORTS = ['setup-career-system'];
const FORBIDDEN_CONCEPTS = [
  ['cross-system control plane', /agentic[ _-]os/i],
  ['constellation policy', /\bconstellation\b/i],
  ['Knowledge-domain coupling', /knowledge[ -]system/i],
  ['Mastery-domain coupling', /mastery[ -]system/i],
  ['cross-system setup command', /setup-agentic-os/i],
  ['cross-system capability namespace', /agentic-os\.[a-z]/i],
];

const NATIVE_PREFIXES = [
  '.agents/',
  'batch/',
  'dashboard/',
  'lib/',
  'modes/',
  'plugins/',
  'providers/',
  'scaffolder/',
  'seeds/',
  'skills/',
  'templates/',
];

const SOURCE_EXTENSIONS = new Set([
  '.css',
  '.go',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.tex',
  '.yaml',
  '.yml',
]);
const VALIDATOR_PATH = 'validate-career-system-source.mjs';
const USER_LAYER_PATHS = new Set([
  'article-digest.md',
  'cv.md',
  'modes/_custom.md',
  'modes/_profile.md',
]);

function walk(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) files.push(...walk(root, absolute));
    else files.push(relative(root, absolute).replaceAll('\\', '/'));
  }
  return files;
}

function trackedFiles(root) {
  try {
    return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return walk(root);
  }
}

function isNativeSource(path) {
  if (USER_LAYER_PATHS.has(path)) return false;
  if (path === VALIDATOR_PATH || path.startsWith('tests/') || path.startsWith('test/')) return false;
  if (!SOURCE_EXTENSIONS.has(extname(path))) return false;
  if (!path.includes('/')) return true;
  return NATIVE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function validatePublicExports(root, errors) {
  const publicRoot = join(root, 'skills/public');
  const entries = existsSync(publicRoot) ? readdirSync(publicRoot, { withFileTypes: true }) : [];
  const actual = entries.map((entry) => entry.name).sort();

  if (
    JSON.stringify(actual) !== JSON.stringify(PUBLIC_EXPORTS)
    || entries.some((entry) => !entry.isDirectory())
  ) {
    errors.push(`public Career exports must be exactly: ${PUBLIC_EXPORTS.join(', ')}`);
    return;
  }

  const skillPath = join(publicRoot, 'setup-career-system/SKILL.md');
  if (!existsSync(skillPath)) {
    errors.push('setup-career-system export is missing SKILL.md');
    return;
  }

  const skill = readFileSync(skillPath, 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill);
  if (!frontmatter || !/^name:[ \t]*setup-career-system[ \t]*\r?$/m.test(frontmatter[1])) {
    errors.push('setup-career-system SKILL.md must declare name: setup-career-system');
  }
}

export function validateCareerSystemSource(root = ROOT) {
  const errors = [];
  validatePublicExports(root, errors);

  for (const path of trackedFiles(root).filter(isNativeSource)) {
    const content = readFileSync(join(root, path), 'utf8');
    for (const [label, pattern] of FORBIDDEN_CONCEPTS) {
      if (pattern.test(content)) errors.push(`${path}: forbidden ${label}`);
    }
  }

  return errors;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const errors = validateCareerSystemSource();
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`FAIL: ${error}\n`);
    process.exit(1);
  }
  process.stdout.write('OK: Career-native source and public export boundary validated\n');
}

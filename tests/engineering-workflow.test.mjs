import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { fail, pass, ROOT } from './helpers.mjs';

function readRepoFile(relativePath) {
  const fullPath = join(ROOT, relativePath);
  return existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : '';
}

const workflowDoc = readRepoFile('docs/agents/engineering-workflow.md');
const agentsDoc = readRepoFile('AGENTS.md');
const contributingDoc = readRepoFile('CONTRIBUTING.md');
const contextDoc = readRepoFile('CONTEXT.md');
const issueTrackerDoc = readRepoFile('docs/agents/issue-tracker.md');
const triageDoc = readRepoFile('docs/agents/triage-labels.md');

const workflowEntryPoints = [
  '`to-spec`',
  '`to-tickets`',
  '`implement`',
  '`code-review`',
  '`domain-modeling`',
  '`improve-codebase-architecture`',
];

if (
  workflowDoc &&
  agentsDoc.includes('docs/agents/engineering-workflow.md') &&
  workflowEntryPoints.every((entryPoint) => workflowDoc.includes(entryPoint))
) {
  pass('normal agent guidance exposes the retained engineering workflow entry points');
} else {
  fail('normal agent guidance does not expose every retained engineering workflow entry point');
}

const domainTerms = [
  'Application',
  'Stage',
  'Owner',
  'Automation',
  'Hiring surface',
  'Candidacy cluster',
];

if (
  domainTerms.every((term) => contextDoc.includes(`**${term}**:`)) &&
  domainTerms.every((term) => workflowDoc.includes(term)) &&
  domainTerms.every((term) => contributingDoc.includes(term)) &&
  contributingDoc.includes('docs/agents/engineering-workflow.md')
) {
  pass('agent and contributor guidance use the canonical Application lifecycle vocabulary');
} else {
  fail('agent or contributor guidance drifts from the canonical Application lifecycle vocabulary');
}

if (
  issueTrackerDoc.includes('Issues and PRDs for this repo live as GitHub issues') &&
  issueTrackerDoc.includes('giacomoguidotto/career-ops') &&
  issueTrackerDoc.includes('--repo giacomoguidotto/career-ops') &&
  triageDoc.includes('| `ready-for-agent`') &&
  triageDoc.includes('Fully specified, ready for an AFK agent') &&
  triageDoc.includes('gh label create "<name>" --repo giacomoguidotto/career-ops') &&
  workflowDoc.includes('docs/agents/issue-tracker.md') &&
  workflowDoc.includes('docs/agents/triage-labels.md')
) {
  pass('GitHub tracker and ready-for-agent vocabulary remain documented');
} else {
  fail('GitHub tracker or ready-for-agent vocabulary is no longer discoverable');
}

if (
  workflowDoc.includes('npx skills@latest add giacomoguidotto/workspace') &&
  workflowDoc.includes('--full-depth') &&
  workflowDoc.includes('--global')
) {
  pass('engineering workflow documents a reproducible skill bootstrap');
} else {
  fail('engineering workflow names skills without a reproducible bootstrap');
}

const forbiddenSystemBindingPatterns = [
  /(?:^|[\s`(])\/Users\//m,
  /(?:^|[\s`(])\/home\/[^\s`]+/m,
  /[A-Za-z]:\\Users\\/,
  /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}/,
  /\b(?:kb-infra|Job Hunt Advance Audit|advance-workflow)\b/i,
  /\b(?:launchd|systemd|crontab)\b/i,
];

if (forbiddenSystemBindingPatterns.every((pattern) => !pattern.test(workflowDoc))) {
  pass('engineering workflow guidance stays free of personal infrastructure bindings');
} else {
  fail('engineering workflow guidance contains a personal path, credential, or external binding');
}

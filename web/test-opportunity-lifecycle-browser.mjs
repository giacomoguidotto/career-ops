import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  createFictionalOpportunityWorkspace,
  fingerprintFictionalWorkspace,
  removeFictionalOpportunityWorkspace,
  snapshotFictionalWorkspace,
} from '../tests/fixtures/fictional-opportunity-workspace.mjs';

const WEB_ROOT = import.meta.dirname;
const DIST_DIR = process.env.BUILD_DIST ?? '.next';
const ARTIFACT_DIR = join(WEB_ROOT, '.lifecycle-browser-artifacts');
rmSync(ARTIFACT_DIR, { recursive: true, force: true });

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error('could not reserve a browser-test port');
  return port;
}

async function waitUntilReady(url, child, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`web server exited ${child.exitCode}\n${output.join('')}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`web server did not become ready\n${output.join('')}`);
}

const fixture = createFictionalOpportunityWorkspace({
  materializeCore: true,
  includeAliases: true,
  includeUnknownStage: true,
  opportunityPatches: {
    2: {
      company: 'Northstar Fictional',
      role: 'Senior Applied AI Researcher',
      location: 'Remote, Europe',
      report: '[report](../reports/002-northstar-fictional.md)',
      pdf: '[pdf](../output/002-northstar-fictional.pdf)',
    },
  },
  attempts: [{
    id: 'A001',
    opportunity: 3,
    date: '2026-01-16T09:42:00Z',
    type: 'formal_application',
    channel: 'fictional_portal',
    recipient: 'Fictional Hiring Team',
    result: 'sent',
    notes: 'Confirmed fictional submission.',
  }],
  approachPlans: {
    '002-northstar-fictional.md': [
      '# Northstar Fictional Approach Plan',
      '',
      '**Stage:** approach_ready',
      '**Owner:** user',
      '**Suggests:** generate_approach_plan',
      '',
      '## Recommended route',
      '',
      'Review the fictional application route before acting elsewhere.',
      '',
    ].join('\n'),
  },
  reports: {
    '002-northstar-fictional.md': [
      '# Evaluation: Northstar Fictional',
      '',
      '**Date:** 2026-01-15',
      '**URL:** https://example.invalid/jobs/northstar',
      '**Score:** 4.6/5',
      '',
      '## Decision Snapshot',
      '',
      '**Decision:** Apply',
      '',
      '**Why:** Strong fictional fit with one capability to verify.',
      '',
      '## Machine Summary',
      '',
      '```yaml',
      'final_decision: apply',
      '```',
      '',
      '## A. Requirements',
      '',
      'Evidence from the fictional job description.',
      '',
    ].join('\n'),
  },
  extraOpportunities: [{
    num: 900,
    company: 'Fictional International Research Cooperative With A Deliberately Long Name',
    role: 'Principal Applied Artificial Intelligence Systems Researcher For Multilingual Public Interest Infrastructure',
    stage: 'Evaluated',
    score: '4.9/5',
    notes: 'Long localized content must wrap without hiding any facts.',
  }],
  files: {
    'cv.md': '# Fictional CV\n',
    'output/002-northstar-fictional.pdf': 'fictional pdf bytes',
    'modes/_profile.md': '# Fictional profile\n',
    'portals.yml': 'title_filter:\n  positive:\n    - researcher\n',
    'data/pipeline.md': '- [ ] https://fictional.example/jobs/1 | Inbox Research | Research Engineer | Remote\n',
    'doctor.mjs': [
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "if (!process.argv.includes('--read-only')) writeFileSync(join(process.cwd(), 'doctor-mutated-user-layer'), 'unsafe');",
      "process.stdout.write(JSON.stringify({ onboardingNeeded: false, missing: [], warnings: [], autoCopied: [] }) + '\\n');",
      '',
    ].join('\n'),
    'scan.mjs': [
      "const args = process.argv.slice(2);",
      "if (args.includes('--help')) { process.stdout.write('  --json structured output\\n'); process.exit(0); }",
      "process.stdout.write(JSON.stringify({",
      "  contract: { id: 'career-ops.scanner.company-first', version: 1 },",
      "  ordering: { kind: 'configured-priority', configuredSources: 1 },",
      "  companiesAvailable: 4, companiesScanned: 4, jobBoardsAvailable: 0, jobBoardsScanned: 0,",
      "  runCap: { limit: 30, deferred: 2 }, companyCap: { limit: 3, deferred: 1 },",
      "  unreachableTargets: 0, networkErrors: 0, otherErrors: 0, unhandledSources: 0, malformedSources: 0,",
      "  offers: [{ company: 'Priority Fictional', title: 'Research Engineer', url: 'https://jobs.example.test/company', location: 'Remote', postedAt: '2026-07-18', source: 'ashby-api' }]",
      "}) + '\\n');",
      '',
    ].join('\n'),
    'scan-ats-full.mjs': [
      "const args = process.argv.slice(2);",
      "if (args.includes('--help')) { process.stdout.write('  --json structured output\\n'); process.exit(0); }",
      "process.stdout.write(JSON.stringify({",
      "  contract: { id: 'career-ops.scanner.reverse-ats', version: 1 }, sources: ['greenhouse', 'lever', 'ashby', 'workday'], sampling: 'alphabetical', companyLimit: 150,",
      "  companiesAvailable: 12, companiesScanned: 8, capHit: true,",
      "  datasetStatus: { greenhouse: 'ok', lever: 'stale', ashby: 'ok', workday: 'empty' },",
      "  postingsDroppedNoDate: 3, unreachableBoards: 2, sourceRecordsDropped: 0,",
      "  offers: [{ company: 'Reverse Fictional', title: 'ML Researcher', url: 'https://jobs.example.test/reverse', location: 'Remote', postedAt: '2026-07-18', source: 'lever-full' }]",
      "}) + '\\n');",
      '',
    ].join('\n'),
  },
});
const before = fingerprintFictionalWorkspace(fixture.root);
const beforeSnapshot = snapshotFictionalWorkspace(fixture.root);
const logoPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const logoBytes = Buffer.concat([logoPng, Buffer.alloc(256)]);
let logoSourceRequests = 0;
const logoSource = createHttpServer((_request, response) => {
  logoSourceRequests += 1;
  response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': logoBytes.byteLength });
  response.end(logoBytes);
});
await new Promise((resolve, reject) => {
  logoSource.once('error', reject);
  logoSource.listen(0, '127.0.0.1', resolve);
});
const logoSourceAddress = logoSource.address();
if (typeof logoSourceAddress !== 'object' || !logoSourceAddress) throw new Error('could not start controlled logo source');
const logoSourceUrl = `http://127.0.0.1:${logoSourceAddress.port}/favicon`;
const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
const output = [];
const child = spawn(
  process.execPath,
  [join(WEB_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)],
  {
    cwd: WEB_ROOT,
    env: {
      ...process.env,
      BUILD_DIST: DIST_DIR,
      CAREER_OPS_ROOT: fixture.root,
      CAREER_OPS_LOGO_SOURCE_URL: logoSourceUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
child.stdout.on('data', (chunk) => output.push(String(chunk)));
child.stderr.on('data', (chunk) => output.push(String(chunk)));

let browser;
let context;
let page;
let traceStopped = false;
let passiveBaseline = before;
try {
  await waitUntilReady(`${baseUrl}/api/opportunities`, child, output);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  page = await context.newPage();
  const requests = [];
  page.on('request', (request) => requests.push({ method: request.method(), url: request.url() }));

  await page.goto(`${baseUrl}/api/doctor`);
  const doctor = JSON.parse(await page.locator('body').innerText());
  assert.equal(doctor.available, true);
  assert.equal(doctor.onboardingNeeded, false);

  const today = await page.goto(baseUrl);
  assert.equal(today?.ok(), true);
  await page.waitForLoadState('networkidle');
  await page.reload();
  await page.waitForLoadState('networkidle');

  await page.goto(`${baseUrl}/api/opportunities`);
  const list = JSON.parse(await page.locator('body').innerText());
  assert.equal(list.contract.id, 'career-ops.opportunity-lifecycle');
  assert.equal(list.opportunities.length > fixture.stages.length, true);
  assert.equal(list.opportunities.at(-1).rawStage, 'FUTURE_STAGE');
  await page.reload();
  const refreshedList = JSON.parse(await page.locator('body').innerText());
  assert.equal(refreshedList.revision, list.revision);

  await page.goto(`${baseUrl}/api/report/shape`);
  const reportShape = JSON.parse(await page.locator('body').innerText());
  assert.equal(reportShape.data.tracker.parsed, list.opportunities.length);

  await page.goto(`${baseUrl}/api/opportunities/1`);
  const focused = JSON.parse(await page.locator('body').innerText());
  assert.equal(focused.opportunity.opportunity, 1);
  assert.equal(focused.contract.version, list.contract.version);
  const unsafeId = await page.goto(`${baseUrl}/api/opportunities/9007199254740993`);
  assert.equal(unsafeId?.status(), 400);

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${baseUrl}/pipeline?selected=1`);
  await page.getByRole('heading', { name: 'Pipeline' }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'Pipeline' }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('selected'), '1');

  const firstRow = page.locator('[data-opportunity-id="1"]:visible');
  const secondRow = page.locator('[data-opportunity-id="2"]:visible');
  assert.equal(await firstRow.evaluate((element) => element.tagName), 'A');
  assert.equal(await firstRow.getAttribute('href'), '/pipeline/1');
  assert.equal(await firstRow.locator('button').count(), 0);
  await secondRow.hover();
  await page.getByTestId('pipeline-preview').getByText('Northstar Fictional', { exact: true }).waitFor();
  await page.getByTestId('pipeline-preview').getByRole('button', { name: 'Load Northstar Fictional logo' }).waitFor();
  const previewLink = page.getByTestId('pipeline-preview').getByRole('link', { name: 'Open Opportunity' });
  await previewLink.hover();
  assert.equal(await previewLink.getAttribute('href'), '/pipeline/2');
  assert.equal(new URL(page.url()).searchParams.get('selected'), '1');
  await secondRow.focus();
  assert.equal(new URL(page.url()).searchParams.get('selected'), '1');

  await firstRow.focus();
  await page.keyboard.press('Control+j');
  await page.keyboard.press('Alt+k');
  assert.equal(new URL(page.url()).searchParams.get('selected'), '1');
  await page.keyboard.press('j');
  await page.waitForURL((url) => url.searchParams.get('selected') === '2');
  assert.equal(await secondRow.getAttribute('data-selected'), 'true');
  assert.equal(await secondRow.evaluate((element) => document.activeElement === element), true);
  await page.keyboard.press('k');
  await page.waitForURL((url) => url.searchParams.get('selected') === '1');
  await firstRow.focus();
  await page.keyboard.press('Enter');
  await page.waitForURL((url) => url.pathname === '/pipeline/1');
  await page.goBack();
  await page.waitForURL((url) => url.pathname === '/pipeline' && url.searchParams.get('selected') === '1');

  await firstRow.focus();
  await page.keyboard.press('/');
  const pipelineSearch = page.getByRole('textbox', { name: 'Search Pipeline' });
  assert.equal(await pipelineSearch.evaluate((element) => document.activeElement === element), true);
  await pipelineSearch.fill('Northstar Fictional');
  await page.locator('[data-opportunity-id="2"]:visible').waitFor();
  assert.equal(await page.locator('[data-opportunity-id]:visible').count(), 1);
  await page.getByRole('button', { name: /Commands/ }).click();
  const filteredCommands = page.getByRole('dialog', { name: 'Pipeline commands' });
  await filteredCommands.waitFor();
  assert.equal(await filteredCommands.getByText(/Selected: #002/).isVisible(), true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'pipeline-commands-trigger');
  await pipelineSearch.focus();
  await page.keyboard.press('j');
  assert.equal(new URL(page.url()).searchParams.get('selected'), '1');
  await pipelineSearch.fill('');

  await firstRow.focus();
  await page.keyboard.press('?');
  await page.getByRole('dialog', { name: 'Keyboard navigation' }).waitFor();
  await page.keyboard.press('j');
  assert.equal(new URL(page.url()).searchParams.get('selected'), '1');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-opportunity-id') === '1');
  assert.equal(await firstRow.evaluate((element) => document.activeElement === element), true);

  const commandButton = page.getByRole('button', { name: /Commands/ });
  await commandButton.focus();
  await page.keyboard.press('Enter');
  const commandDialog = page.getByRole('dialog', { name: 'Pipeline commands' });
  await commandDialog.waitFor();
  const commandSearch = commandDialog.getByRole('textbox', { name: 'Search commands' });
  assert.equal(await commandSearch.evaluate((element) => document.activeElement === element), true);
  await commandSearch.fill('prepare');
  assert.equal(await commandDialog.getByRole('button', { name: /Prepare suggested artifact/ }).isVisible(), true);
  assert.equal(new URL(page.url()).pathname, '/pipeline');
  await commandDialog.getByRole('button', { name: /Prepare suggested artifact/ }).click();
  await page.getByRole('dialog', { name: 'Review preparation' }).waitFor();
  assert.equal(requests.some((request) => request.method !== 'GET' && request.method !== 'HEAD'), false);
  assert.equal(fingerprintFictionalWorkspace(fixture.root), before);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'pipeline-commands-trigger');
  assert.equal(await commandButton.evaluate((element) => document.activeElement === element), true);

  await page.getByRole('button', { name: /in inbox/ }).click();
  await page.getByRole('heading', { name: 'Inbox' }).waitFor();
  assert.equal(await page.getByText('Upstream triage, outside lifecycle Stages').isVisible(), true);
  const inboxUrl = page.url();
  await page.keyboard.press('j');
  await page.keyboard.press('k');
  await page.keyboard.press('Enter');
  assert.equal(page.url(), inboxUrl);
  await page.getByRole('button', { name: /Return to Stage ledger/ }).click();

  const stage = fixture.stages[1];
  await page.getByRole('button', { name: new RegExp(`^${stage.label}`) }).click();
  await page.waitForURL((url) => url.searchParams.get('stage') === stage.id && url.searchParams.has('selected'));
  const stageUrl = page.url();
  await page.reload();
  assert.equal(page.url(), stageUrl);
  assert.equal(await page.getByRole('button', { name: new RegExp(`^${stage.label}`) }).getAttribute('aria-pressed'), 'true');

  const offerOpportunityIds = fixture.stages
    .map((candidate, index) => ({ candidate, opportunity: index + 1 }))
    .filter(({ candidate }) => candidate.dashboard_group === 'offer')
    .map(({ opportunity }) => opportunity);
  assert.equal(offerOpportunityIds.length, 2);
  await page.goto(`${baseUrl}/pipeline?tab=OFFER`);
  await page.waitForURL((url) => url.searchParams.get('tab') === 'OFFER' && url.searchParams.has('selected'));
  assert.equal(new URL(page.url()).searchParams.has('stage'), false);
  for (const opportunity of offerOpportunityIds) {
    await page.locator(`[data-opportunity-id="${opportunity}"]:visible`).waitFor();
  }
  for (const offerStage of fixture.stages.filter((candidate) => candidate.dashboard_group === 'offer')) {
    assert.equal(await page.getByRole('button', { name: new RegExp(`^${offerStage.label}(?: \\d+)?$`) }).getAttribute('aria-pressed'), 'true');
  }
  await page.getByRole('button', { name: /in inbox/ }).click();
  await page.getByRole('heading', { name: 'Inbox' }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('tab'), 'OFFER');
  await page.getByRole('button', { name: /Return to Stage ledger/ }).click();
  await page.waitForURL((url) => url.searchParams.get('tab') === 'OFFER' && !url.searchParams.has('view'));
  for (const opportunity of offerOpportunityIds) {
    await page.locator(`[data-opportunity-id="${opportunity}"]:visible`).waitFor();
  }

  await page.getByRole('button', { name: /^All / }).click();
  await page.waitForURL((url) => !url.searchParams.has('stage') && !url.searchParams.has('tab') && url.searchParams.has('selected'));
  const sortControl = page.getByRole('combobox', { name: 'Sort Opportunities' });
  assert.deepEqual(await sortControl.locator('option').allTextContents(), ['Tracker order', 'Company', 'Role', 'Fit', 'Stage', 'Date']);
  await sortControl.selectOption('score');
  await page.waitForURL((url) => url.searchParams.get('sort') === 'score' && url.searchParams.get('dir') === '-1');
  await page.waitForFunction(() => document.querySelector('tbody [data-opportunity-id]')?.getAttribute('data-opportunity-id') === '900');
  assert.equal(await page.locator('tbody [data-opportunity-id]').first().getAttribute('data-opportunity-id'), '900');
  await page.getByRole('button', { name: 'Sort descending' }).click();
  await page.waitForURL((url) => url.searchParams.get('dir') === '1');
  await page.goto(`${baseUrl}/pipeline?sort=score&dir=-1`);
  await page.locator('[data-opportunity-id="900"]:visible').waitFor();
  await page.waitForURL((url) => url.searchParams.get('selected') === '900');
  assert.equal(await page.locator('tbody [data-opportunity-id]').first().getAttribute('data-opportunity-id'), '900');
  assert.equal(await page.locator('[data-opportunity-id="900"]:visible').getAttribute('data-selected'), 'true');
  await page.setViewportSize({ width: 320, height: 844 });
  await pipelineSearch.fill('Fictional International Research Cooperative');
  const longCard = page.locator('[data-opportunity-id="900"]:visible');
  await longCard.waitFor();
  assert.equal(await longCard.getByText(/Principal Applied Artificial Intelligence Systems Researcher/).isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  assert.notEqual(await longCard.evaluate((element) => getComputedStyle(element).whiteSpace), 'nowrap');
  await pipelineSearch.fill('');

  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const themeButton = page.getByRole('banner').getByRole('button', { name: /Switch to light mode|Switch to dark mode/ });
  const initialTheme = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  await themeButton.click();
  assert.notEqual(await page.evaluate(() => document.documentElement.classList.contains('dark')), initialTheme);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await themeButton.click();
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), initialTheme);
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  assert.equal(await page.locator('.pipeline-ledger button').first().evaluate((element) => parseFloat(getComputedStyle(element).transitionDuration) <= 0.00001), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);

  await page.setViewportSize({ width: 390, height: 844 });
  const phoneCard = page.locator('[data-opportunity-id="1"]:visible');
  assert.equal(await phoneCard.getAttribute('href'), '/pipeline/1');
  await phoneCard.click();
  await page.waitForURL((url) => url.pathname === '/pipeline/1');
  await page.goBack();

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${baseUrl}/pipeline?selected=1`);
  const loadLogo = page.getByRole('button', { name: 'Load Fictional Company 1 logo' }).first();
  await loadLogo.waitFor();
  assert.equal(requests.some((request) => request.url.includes('/api/logo?') && request.url.includes('persist=1')), false);
  assert.equal(fingerprintFictionalWorkspace(fixture.root), before);
  const persistedLogoRequest = page.waitForRequest((request) => request.url().includes('/api/logo?') && request.url().includes('persist=1'));
  const persistedLogoResponse = page.waitForResponse((response) => response.url().includes('/api/logo?') && response.url().includes('persist=1'));
  await loadLogo.click();
  const persistedLogo = await persistedLogoRequest;
  assert.equal((await persistedLogoResponse).status(), 200);
  const persistedDomain = new URL(persistedLogo.url()).searchParams.get('domain');
  const cachedLogoPath = join(fixture.root, '.career-ops-web', 'logo-cache', `${persistedDomain}.png`);
  assert.equal(existsSync(cachedLogoPath), true);
  assert.equal(logoSourceRequests, 1);
  passiveBaseline = fingerprintFictionalWorkspace(fixture.root);
  assert.notEqual(passiveBaseline, before);
  const cachedLogoRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/logo' && url.searchParams.get('domain') === persistedDomain && !url.searchParams.has('persist');
  });
  assert.equal(requests.some((request) => request.url.includes('/api/logo?') && request.url.includes('persist=1')), true);
  assert.equal(new URL(page.url()).pathname, '/pipeline');
  await page.reload();
  await cachedLogoRequest;
  await page.getByRole('heading', { name: 'Pipeline' }).waitFor();
  assert.equal(logoSourceRequests, 1);
  await page.goto(`${baseUrl}/pipeline/1`);
  await page.reload();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/pipeline/2`);
  await page.getByRole('heading', { name: 'Northstar Fictional', exact: true }).waitFor();
  const lifecycle = page.getByLabel(/Lifecycle: previous Evaluated, current Approach Ready/);
  await lifecycle.waitFor();
  assert.equal(await lifecycle.getByText('Agent-made').isVisible(), true);
  for (const section of ['Overview', 'Initial evaluation', 'Approach Plan', 'Materials', 'Attempts', 'History']) {
    assert.equal(await page.getByRole('navigation', { name: 'Opportunity sections' }).getByRole('link', { name: section }).isVisible(), true);
  }
  assert.equal(await page.getByRole('heading', { name: 'Decision Snapshot' }).isVisible(), true);
  assert.equal(await page.getByText('Source: 002-northstar-fictional.md').isVisible(), true);
  assert.equal(await page.locator('[data-history-type="artifact"]').count() >= 2, true);
  const nextStepBox = await page.getByText('Your next step').boundingBox();
  const evaluationBox = await page.getByRole('heading', { name: 'Initial evaluation' }).boundingBox();
  assert.equal(Boolean(nextStepBox && evaluationBox && nextStepBox.y < evaluationBox.y), true);
  const mobileAction = page.getByLabel('Primary Opportunity action');
  await page.locator('#history').scrollIntoViewIfNeeded();
  assert.equal(await mobileAction.isVisible(), true);
  const mobileActionLink = mobileAction.getByRole('link');
  const mobileActionBox = await mobileActionLink.boundingBox();
  assert.equal(Boolean(mobileActionBox && mobileActionBox.height >= 44), true);
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.equal(horizontalOverflow <= 0, true);

  await page.goto(`${baseUrl}/pipeline/3`);
  await page.getByRole('heading', { name: 'Attempts' }).waitFor();
  assert.equal(await page.locator('[data-history-type="attempt"]').count(), 1);
  assert.equal(await page.locator('[data-history-type="confirmed-attempt"]').count(), 1);

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  for (const review of [
    { name: 'desktop-light', viewport: { width: 1440, height: 960 }, colorScheme: 'light' },
    { name: 'desktop-dark', viewport: { width: 1440, height: 960 }, colorScheme: 'dark' },
    { name: 'mobile-light', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
    { name: 'mobile-dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark' },
  ]) {
    const reviewContext = await browser.newContext({
      viewport: review.viewport,
      colorScheme: review.colorScheme,
      reducedMotion: 'reduce',
    });
    const reviewPage = await reviewContext.newPage();
    await reviewPage.goto(`${baseUrl}/pipeline/2`);
    await reviewPage.getByRole('heading', { name: 'Northstar Fictional', exact: true }).waitFor();
    assert.equal(await reviewPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await reviewPage.screenshot({ path: join(ARTIFACT_DIR, `opportunity-${review.name}.png`), fullPage: true });
    await reviewContext.close();
  }

  const lifecycleScript = join(fixture.root, 'opportunity-lifecycle.mjs');
  const unavailableLifecycleScript = `${lifecycleScript}.unavailable`;
  renameSync(lifecycleScript, unavailableLifecycleScript);
  try {
    await page.goto(`${baseUrl}/pipeline?tab=INBOX`);
    await page.getByRole('heading', { name: 'Inbox' }).waitFor();
    assert.equal(await page.getByText('Lifecycle data is unavailable').isVisible(), true);
    assert.equal(await page.getByText('Inbox Research').isVisible(), true);
  } finally {
    renameSync(unavailableLifecycleScript, lifecycleScript);
  }

  await page.goto(`${baseUrl}/explore`);
  await page.getByRole('heading', { name: 'Explore' }).waitFor();
  await page.goto(`${baseUrl}/portals`);
  await page.getByRole('heading', { name: 'Portals' }).waitFor();

  assert.equal(requests.some((request) => request.method !== 'GET' && request.method !== 'HEAD'), false);
  assert.equal(requests.some((request) => request.url.includes('/api/run')), false);
  assert.equal(fingerprintFictionalWorkspace(fixture.root), passiveBaseline);

  await page.goto(`${baseUrl}/explore`);
  await page.getByRole('button', { name: 'Discover (free)' }).click();
  await page.getByLabel('Scanner completeness').waitFor();
  await page.getByText(/configured-priority order/).waitFor();
  await page.getByText(/alphabetical sampling/).waitFor();
  await page.getByText(/run cap 30, 2 deferred/).waitFor();
  await page.getByText(/3 records dropped for missing dates/).waitFor();
  await page.getByRole('button', { name: 'Adjust scan caps' }).click();
  await page.getByLabel('Tracked-company run cap').waitFor();
  for (const { width, height, theme } of [
    { width: 390, height: 844, theme: 'dark' },
    { width: 390, height: 844, theme: 'light' },
    { width: 1440, height: 960, theme: 'dark' },
    { width: 1440, height: 960, theme: 'light' },
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate((nextTheme) => localStorage.setItem('career-ops:theme', nextTheme), theme);
    await page.reload();
    await page.getByLabel('Scanner completeness').waitFor();
    assert.equal(await page.locator('html').evaluate((html) => html.classList.contains('dark')), theme === 'dark');
    assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= document.documentElement.clientWidth), true);
  }
  assert.equal(fingerprintFictionalWorkspace(fixture.root), passiveBaseline);
  await context.tracing.stop();
  traceStopped = true;
  console.log('PASS passive lifecycle and Pipeline browser journeys');
} catch (error) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  if (page) await page.screenshot({ path: join(ARTIFACT_DIR, 'failure.png'), fullPage: true });
  if (context && !traceStopped) {
    await context.tracing.stop({ path: join(ARTIFACT_DIR, 'trace.zip') });
    traceStopped = true;
  }
  const afterSnapshot = snapshotFictionalWorkspace(fixture.root);
  writeFileSync(join(ARTIFACT_DIR, 'fixture-manifest.json'), `${JSON.stringify({
    stageCount: fixture.stages.length,
    opportunityCount: fixture.opportunities.length,
    workspaceFingerprint: fingerprintFictionalWorkspace(fixture.root),
    changedPaths: beforeSnapshot
      ? [...new Set([
          ...Object.keys(beforeSnapshot),
          ...Object.keys(afterSnapshot),
        ])].filter((path) => beforeSnapshot[path] !== afterSnapshot[path])
      : [],
  }, null, 2)}\n`);
  throw error;
} finally {
  if (context && !traceStopped) await context.tracing.stop();
  await context?.close();
  await browser?.close();
  await new Promise((resolve) => logoSource.close(resolve));
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode != null) resolve();
    else child.once('exit', resolve);
    setTimeout(resolve, 5_000).unref();
  });
  removeFictionalOpportunityWorkspace(fixture.root);
}

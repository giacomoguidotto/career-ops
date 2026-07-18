import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  files: {
    'cv.md': '# Fictional CV\n',
    'modes/_profile.md': '# Fictional profile\n',
    'portals.yml': 'title_filter:\n  positive:\n    - researcher\n',
    'doctor.mjs': [
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "if (!process.argv.includes('--read-only')) writeFileSync(join(process.cwd(), 'doctor-mutated-user-layer'), 'unsafe');",
      "process.stdout.write(JSON.stringify({ onboardingNeeded: false, missing: [], warnings: [], autoCopied: [] }) + '\\n');",
      '',
    ].join('\n'),
  },
});
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
let beforeSnapshot = null;
try {
  await waitUntilReady(`${baseUrl}/api/opportunities`, child, output);
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  page = await context.newPage();
  const requests = [];
  page.on('request', (request) => requests.push({ method: request.method(), url: request.url() }));
  const before = fingerprintFictionalWorkspace(fixture.root);
  beforeSnapshot = snapshotFictionalWorkspace(fixture.root);

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

  await page.goto(`${baseUrl}/api/opportunities/1`);
  const focused = JSON.parse(await page.locator('body').innerText());
  assert.equal(focused.opportunity.opportunity, 1);
  assert.equal(focused.contract.version, list.contract.version);
  const unsafeId = await page.goto(`${baseUrl}/api/opportunities/9007199254740993`);
  assert.equal(unsafeId?.status(), 400);

  await page.goto(`${baseUrl}/pipeline?tab=ALL`);
  await page.getByRole('heading', { name: 'Pipeline' }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'Pipeline' }).waitFor();
  const loadLogo = page.getByRole('button', { name: 'Load Fictional Company 1 logo' });
  await loadLogo.waitFor();
  assert.equal(requests.some((request) => request.url.includes('/api/logo?') && request.url.includes('persist=1')), false);
  let authorizedLogo = false;
  const logoPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  await page.route('**/api/logo?*', async (route) => {
    if (route.request().url().includes('persist=1')) {
      authorizedLogo = true;
      await route.fulfill({ status: 200, contentType: 'image/png', body: logoPng });
    } else if (authorizedLogo) {
      await route.fulfill({ status: 200, contentType: 'image/png', body: logoPng });
    } else {
      await route.continue();
    }
  });
  const persistedLogoRequest = page.waitForRequest((request) => request.url().includes('/api/logo?') && request.url().includes('persist=1'));
  await loadLogo.click();
  const persistedLogo = await persistedLogoRequest;
  const persistedDomain = new URL(persistedLogo.url()).searchParams.get('domain');
  const cachedLogoRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/logo' && url.searchParams.get('domain') === persistedDomain && !url.searchParams.has('persist');
  });
  assert.equal(requests.some((request) => request.url.includes('/api/logo?') && request.url.includes('persist=1')), true);
  assert.equal(new URL(page.url()).pathname, '/pipeline');
  await page.reload();
  await cachedLogoRequest;
  await page.getByRole('heading', { name: 'Pipeline' }).waitFor();
  await page.goto(`${baseUrl}/pipeline/1`);
  await page.reload();

  await page.goto(`${baseUrl}/explore`);
  await page.getByRole('heading', { name: 'Explore' }).waitFor();
  await page.goto(`${baseUrl}/portals`);
  await page.getByRole('heading', { name: 'Portals' }).waitFor();

  assert.equal(requests.some((request) => request.method !== 'GET' && request.method !== 'HEAD'), false);
  assert.equal(requests.some((request) => request.url.includes('/api/run')), false);
  assert.equal(fingerprintFictionalWorkspace(fixture.root), before);
  await context.tracing.stop();
  traceStopped = true;
  console.log('PASS passive lifecycle browser journey');
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
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode != null) resolve();
    else child.once('exit', resolve);
    setTimeout(resolve, 5_000).unref();
  });
  removeFictionalOpportunityWorkspace(fixture.root);
}

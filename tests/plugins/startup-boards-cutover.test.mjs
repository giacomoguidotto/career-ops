// tests/plugins/startup-boards-cutover.test.mjs — fork cutover contract for issue #4.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';

import { fail, pass, ROOT } from '../helpers.mjs';
import { installFromRepo } from '../../plugin-install.mjs';
import { discoverPlugins, mergeProviderPlugins, pluginRoots, pluginStatus } from '../../plugins/_engine.mjs';
import { findInRegistry } from '../../plugins/_registry.mjs';
import { resolveProvider } from '../../providers/_registry.mjs';

console.log('\nPlugin cutover — startup boards');

const registryEntry = findInRegistry(ROOT, 'startup-boards');
if (registryEntry?.sha && registryEntry?.repo) {
  pass('startup-boards is registered at a pinned commit');
} else {
  fail('startup-boards must remain registered at a pinned commit');
}

for (const id of ['ycombinator', 'getro', 'consider']) {
  if (!existsSync(join(ROOT, 'providers', `${id}.mjs`))) {
    pass(`${id} is supplied only by the startup-boards plugin`);
  } else {
    fail(`${id} still has a duplicate bundled provider`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'co-startup-boards-cutover-'));
try {
  mkdirSync(join(tmp, 'plugins-registry'), { recursive: true });
  writeFileSync(
    join(tmp, 'plugins-registry', 'startup-boards.json'),
    readFileSync(join(ROOT, 'plugins-registry', 'startup-boards.json'), 'utf8'),
  );

  installFromRepo(tmp, {
    url: registryEntry.repo,
    sha: registryEntry.sha,
  });
  const manifests = discoverPlugins(pluginRoots(tmp));
  const manifest = manifests.find((candidate) => candidate.id === 'startup-boards');
  const status = pluginStatus(manifest, { plugins: { 'startup-boards': { enabled: true } } });
  if (manifest?.hooks.includes('provider') && status.enabled && status.missingEnv.length === 0) {
    pass('installed startup-boards is discovered as an enabled provider with no missing requirements');
  } else {
    fail('installed startup-boards provider was not discovered cleanly');
  }

  mkdirSync(join(tmp, 'config'), { recursive: true });
  writeFileSync(join(tmp, 'config', 'plugins.yml'), 'plugins:\n  startup-boards:\n    enabled: true\n');
  const providers = new Map();
  await mergeProviderPlugins(providers, { root: tmp });
  if (providers.size === 1 && providers.has('startup-boards')) {
    pass('scanner registration exposes one startup-boards provider and no duplicate board providers');
  } else {
    fail(`expected one startup-boards provider, got [${[...providers.keys()].join(', ')}]`);
  }

  const providerCalls = { ycombinator: 0, getro: 0, consider: 0 };
  const mergedProvider = providers.get('startup-boards');
  const routedProviders = new Map(providers);
  routedProviders.set('startup-boards', {
    ...mergedProvider,
    async fetch(entry) {
      providerCalls[entry.startup_board]++;
      return mergedProvider.fetch(entry);
    },
  });
  const scan = async (entry) => {
    const resolved = resolveProvider(entry, routedProviders);
    if (!resolved?.provider) throw new Error(`scanner did not resolve ${entry.startup_board}`);
    return resolved.provider.fetch(entry);
  };

  const ycPayload = {
    props: { jobPostings: [{
      title: 'Founding AI Engineer',
      url: '/companies/acme/jobs/1-founding-ai-engineer',
      companyName: 'Acme AI',
      location: 'Remote',
    }] },
  };
  const ycHtml = `<div data-page="${JSON.stringify(ycPayload).replace(/"/g, '&quot;')}"></div>`;
  const getroPayload = {
    props: { pageProps: { initialState: { jobs: { found: [{
      title: 'Platform Engineer',
      url: 'https://startup.example/jobs/platform',
      organization: { name: 'StartupCo' },
      locations: ['London, UK', 'Remote'],
      compensationAmountMinCents: 9000000,
      compensationAmountMaxCents: 12000000,
      compensationCurrency: 'GBP',
      compensationPeriod: 'year',
    }] } } } },
  };
  const getroHtml = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(getroPayload)}</script>`;
  const initialHtml = '<script>window.serverInitialData = {"board":{"id":"a16z","isParent":true}};</script>';
  const considerPayload = { jobs: [{
    title: 'Forward Deployed Engineer',
    url: '/companies/acme/jobs/fde',
    companyName: 'Acme',
    locations: ['London, UK'],
    remote: true,
  }] };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const href = String(url);
    if (href.startsWith('https://www.ycombinator.com/jobs/')) return new Response(ycHtml);
    if (href === 'https://example.com/jobs') return new Response(getroHtml);
    if (href === 'https://example.com/') return new Response(initialHtml);
    if (href === 'https://example.com/api-boards/search-jobs' && opts.method === 'POST') {
      return new Response(JSON.stringify(considerPayload), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected fixture request: ${opts.method || 'GET'} ${href}`);
  };

  let ycJobs, getroJobs, considerJobs;
  try {
    ycJobs = await scan({
      provider: 'startup-boards',
      startup_board: 'ycombinator',
      careers_url: 'https://www.ycombinator.com/jobs/role/software-engineer',
    });
    getroJobs = await scan({
      provider: 'startup-boards',
      startup_board: 'getro',
      careers_url: 'https://example.com/jobs',
    });
    considerJobs = await scan({
      provider: 'startup-boards',
      startup_board: 'consider',
      careers_url: 'https://example.com/',
      limit: 10,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const normalized =
    ycJobs.length === 1 && ycJobs[0].company === 'Acme AI' && ycJobs[0].location === 'Remote' &&
    getroJobs.length === 1 && getroJobs[0].company === 'StartupCo' && getroJobs[0].salary?.max === 120000 &&
    considerJobs.length === 1 && considerJobs[0].company === 'Acme' && considerJobs[0].location === 'London, UK, Remote';
  const uniqueUrls = new Set([...ycJobs, ...getroJobs, ...considerJobs].map(job => job.url));
  if (normalized && uniqueUrls.size === 3) {
    pass('scanner routing preserves unique normalized YC, Getro, and Consider plugin output');
  } else {
    fail('scanner routing did not preserve unique normalized startup-board output');
  }

  if (Object.values(providerCalls).every((count) => count === 1)) {
    pass('scanner executes each startup-board provider entry exactly once');
  } else {
    fail(`startup-board provider execution counts were ${JSON.stringify(providerCalls)}`);
  }

  const exposesInactiveProvider = async (enabled, reason) => {
    writeFileSync(join(tmp, 'config', 'plugins.yml'), `plugins:\n  startup-boards:\n    enabled: ${enabled}\n`);
    const inactiveProviders = new Map();
    await mergeProviderPlugins(inactiveProviders, { root: tmp });
    try { await inactiveProviders.get('startup-boards')?.fetch({}); }
    catch (error) { return reason.test(error.message); }
    return false;
  };

  const disabledIsExplicit = await exposesInactiveProvider(false, /inactive: disabled/i);
  if (disabledIsExplicit) pass('a disabled startup-boards plugin exposes an explicit inactive provider');
  else fail('a disabled startup-boards plugin fell back silently');

  rmSync(join(tmp, 'plugins.local'), { recursive: true, force: true });
  const missingIsExplicit = await exposesInactiveProvider(true, /inactive: not installed/i);
  if (missingIsExplicit) pass('a missing startup-boards plugin exposes an explicit inactive provider');
  else fail('a missing startup-boards plugin fell back silently');
} catch (error) {
  fail(`startup-boards cutover test crashed: ${error.message}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

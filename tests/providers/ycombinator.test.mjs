// tests/providers/ycombinator.test.mjs — provider-contract tests for YC Jobs.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — ycombinator');

try {
  const ycModule = await import(pathToFileURL(join(ROOT, 'providers/ycombinator.mjs')).href);
  const yc = ycModule.default;
  const { parseYCombinatorJobsPage } = ycModule;

  if (yc.id === 'ycombinator') pass('ycombinator.id is "ycombinator"');
  else fail(`ycombinator.id is ${JSON.stringify(yc.id)}`);

  const hit = yc.detect({ name: 'YC', careers_url: 'https://www.ycombinator.com/jobs/role/software-engineer' });
  if (hit?.url === 'https://www.ycombinator.com/jobs/role/software-engineer') {
    pass('ycombinator.detect() matches YC jobs pages');
  } else {
    fail(`ycombinator.detect() returned ${JSON.stringify(hit)}`);
  }

  if (yc.detect({ name: 'Spoof', careers_url: 'https://evil.example/www.ycombinator.com/jobs' }) === null) {
    pass('ycombinator.detect() rejects path-spoofed URLs');
  } else {
    fail('ycombinator.detect() must reject path-spoofed URLs');
  }

  const payload = {
    props: {
      jobPostings: [
        { title: 'Founding AI Engineer', url: '/companies/acme/jobs/1-founding-ai-engineer', companyName: 'Acme AI', location: 'Remote' },
        { title: '', url: '/companies/acme/jobs/2-empty-title', companyName: 'Acme AI', location: 'Remote' },
      ],
    },
  };
  const html = `<div data-page="${JSON.stringify(payload).replace(/"/g, '&quot;')}"></div>`;
  const jobs = parseYCombinatorJobsPage(html, 'https://www.ycombinator.com/jobs/role/all/remote');
  if (jobs.length === 1 && jobs[0].url === 'https://www.ycombinator.com/companies/acme/jobs/1-founding-ai-engineer') {
    pass('parseYCombinatorJobsPage extracts and resolves job postings');
  } else {
    fail(`parseYCombinatorJobsPage returned ${JSON.stringify(jobs)}`);
  }
} catch (e) {
  fail(`ycombinator provider tests crashed: ${e.message}`);
}

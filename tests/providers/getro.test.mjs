// tests/providers/getro.test.mjs — provider-contract tests for Getro boards.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — getro');

try {
  const getroModule = await import(pathToFileURL(join(ROOT, 'providers/getro.mjs')).href);
  const getro = getroModule.default;
  const { parseGetroJobsPage } = getroModule;

  if (getro.id === 'getro') pass('getro.id is "getro"');
  else fail(`getro.id is ${JSON.stringify(getro.id)}`);

  if (getro.detect({ name: 'X', careers_url: 'https://careers.example/jobs' }) === null) {
    pass('getro.detect() requires explicit provider routing');
  } else {
    fail('getro.detect() should not guess custom-domain boards');
  }

  const payload = {
    props: {
      pageProps: {
        initialState: {
          jobs: {
            found: [
              {
                title: 'Platform Engineer',
                url: 'https://startup.example/jobs/platform',
                organization: { name: 'StartupCo' },
                locations: ['London, UK', 'Remote'],
                compensationAmountMinCents: 9000000,
                compensationAmountMaxCents: 12000000,
                compensationCurrency: 'GBP',
                compensationPeriod: 'year',
              },
            ],
          },
        },
      },
    },
  };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;
  const jobs = parseGetroJobsPage(html, 'https://careers.example/jobs', 'Example Board');
  if (
    jobs.length === 1 &&
    jobs[0].company === 'StartupCo' &&
    jobs[0].salary?.min === 90000 &&
    jobs[0].location === 'London, UK, Remote'
  ) {
    pass('parseGetroJobsPage extracts company, locations, and annual salary');
  } else {
    fail(`parseGetroJobsPage returned ${JSON.stringify(jobs)}`);
  }
} catch (e) {
  fail(`getro provider tests crashed: ${e.message}`);
}

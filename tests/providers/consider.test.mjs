// tests/providers/consider.test.mjs — provider-contract tests for Consider boards.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — consider');

try {
  const considerModule = await import(pathToFileURL(join(ROOT, 'providers/consider.mjs')).href);
  const consider = considerModule.default;
  const {
    parseConsiderInitialData,
    parseConsiderJobsResponse,
  } = considerModule;

  if (consider.id === 'consider') pass('consider.id is "consider"');
  else fail(`consider.id is ${JSON.stringify(consider.id)}`);

  if (consider.detect({ name: 'X', careers_url: 'https://jobs.example.com/' }) === null) {
    pass('consider.detect() requires explicit provider routing');
  } else {
    fail('consider.detect() should not guess custom-domain boards');
  }

  const initialHtml = '<script>window.serverInitialData = {"board":{"id":"a16z","isParent":true},"fixedBoard":"a16z"};</script>';
  if (parseConsiderInitialData(initialHtml)?.board?.id === 'a16z') {
    pass('parseConsiderInitialData extracts board id');
  } else {
    fail('parseConsiderInitialData failed to extract board id');
  }

  const jobs = parseConsiderJobsResponse({
    jobs: [
      {
        title: 'Forward Deployed Engineer',
        url: '/companies/acme/jobs/fde',
        companyName: 'Acme',
        locations: ['London, UK'],
        remote: true,
        salary: { minValue: 100000, maxValue: 130000, currency: { value: 'GBP' }, period: { value: 'year' } },
      },
      { title: 'Bad URL', url: 'ftp://bad.example/job', companyName: 'BadCo' },
    ],
  }, 'https://jobs.example.com/', 'Board');
  if (
    jobs.length === 1 &&
    jobs[0].url === 'https://jobs.example.com/companies/acme/jobs/fde' &&
    jobs[0].location === 'London, UK, Remote' &&
    jobs[0].salary?.max === 130000
  ) {
    pass('parseConsiderJobsResponse extracts flat jobs and filters invalid URLs');
  } else {
    fail(`parseConsiderJobsResponse returned ${JSON.stringify(jobs)}`);
  }

  let capturedPayload = null;
  const fetched = await consider.fetch(
    { name: 'Consider Board', careers_url: 'https://jobs.example.com/', limit: 10 },
    {
      fetchText: async () => initialHtml,
      fetchJson: async (url, opts) => {
        if (url !== 'https://jobs.example.com/api-boards/search-jobs') throw new Error(`unexpected URL ${url}`);
        capturedPayload = JSON.parse(opts.body);
        return { jobs: [{ title: 'AI Engineer', url: 'https://jobs.example.com/job/1', companyName: 'Acme', locations: [] }] };
      },
    },
  );
  if (capturedPayload?.board?.id === 'a16z' && capturedPayload?.meta?.size === 10 && fetched.length === 1) {
    pass('consider.fetch() derives board id and POSTs search-jobs payload');
  } else {
    fail(`consider.fetch() payload/result wrong: ${JSON.stringify({ capturedPayload, fetched })}`);
  }
} catch (e) {
  fail(`consider provider tests crashed: ${e.message}`);
}

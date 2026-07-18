import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fail, pass, NODE, ROOT } from './helpers.mjs';

const CLI = join(ROOT, 'scan.mjs');
const REVERSE_CLI = join(ROOT, 'scan-ats-full.mjs');

console.log('\nscan.mjs CLI safety');

const temp = mkdtempSync(join(tmpdir(), 'career-ops-scan-cli-'));
try {
  const help = spawnSync(NODE, [CLI, '--help'], {
    cwd: temp,
    encoding: 'utf8',
  });

  if (help.status === 0
      && help.stdout.includes('Usage:')
      && help.stdout.includes('--json')
      && !help.stdout.includes('Portal Scan')
      && readdirSync(temp).length === 0) {
    pass('scan.mjs --help exits without running a scan');
  } else {
    fail(`scan.mjs --help was not side-effect free: status=${help.status} stdout=${JSON.stringify(help.stdout)} stderr=${JSON.stringify(help.stderr)}`);
  }

  const reverseHelp = spawnSync(NODE, [REVERSE_CLI, '--help'], {
    cwd: temp,
    encoding: 'utf8',
  });

  if (reverseHelp.status === 0
      && reverseHelp.stdout.includes('Usage:')
      && reverseHelp.stdout.includes('--json')
      && !reverseHelp.stdout.includes('Reverse ATS Scan')
      && readdirSync(temp).length === 0) {
    pass('scan-ats-full.mjs advertises its structured output capability');
  } else {
    fail(`scan-ats-full.mjs --help omitted --json or caused side effects: status=${reverseHelp.status} stdout=${JSON.stringify(reverseHelp.stdout)} stderr=${JSON.stringify(reverseHelp.stderr)}`);
  }

  const portals = join(temp, 'portals.yml');
  writeFileSync(portals, 'tracked_companies:\n  - name: Manual Source\n    scan_method: websearch\njob_boards: []\ntitle_filter:\n  positive: [engineer]\n');
  const structured = spawnSync(NODE, [CLI, '--dry-run', '--max-new=30', '--max-per-company=3', '--json'], {
    cwd: temp,
    env: { ...process.env, CAREER_OPS_PORTALS: portals },
    encoding: 'utf8',
  });
  let result = null;
  try { result = JSON.parse(structured.stdout); } catch { /* asserted below */ }
  if (structured.status === 0
      && result?.contract?.id === 'career-ops.scanner.company-first'
      && result?.ordering?.kind === 'configured-priority'
      && result?.runCap?.limit === 30
      && result?.companyCap?.limit === 3
      && result?.companiesAvailable === 1
      && result?.companiesScanned === 0
      && result?.unhandledSources === 1
      && Array.isArray(result?.offers)
      && !existsSync(join(temp, 'data', 'scan-history.tsv'))
      && !existsSync(join(temp, 'data', 'pipeline.md'))) {
    pass('scan.mjs --json emits the company-first completeness contract without dry-run writes');
  } else {
    fail(`scan.mjs --json contract failed: status=${structured.status} stdout=${JSON.stringify(structured.stdout)} stderr=${JSON.stringify(structured.stderr)}`);
  }

  const unknown = spawnSync(NODE, [CLI, '--definitely-unknown'], {
    cwd: temp,
    encoding: 'utf8',
  });

  if (unknown.status === 1
      && unknown.stderr.includes('Unknown option: --definitely-unknown')
      && !unknown.stdout.includes('Portal Scan')) {
    pass('scan.mjs rejects unknown options before running a scan');
  } else {
    fail(`scan.mjs accepted an unknown option: status=${unknown.status} stdout=${JSON.stringify(unknown.stdout)} stderr=${JSON.stringify(unknown.stderr)}`);
  }

  const short = spawnSync(NODE, [CLI, '-x'], {
    cwd: temp,
    encoding: 'utf8',
  });

  if (short.status === 1 && short.stderr.includes('Unknown option: -x')) {
    pass('scan.mjs rejects unknown short options before running a scan');
  } else {
    fail(`scan.mjs accepted an unknown short option: status=${short.status} stdout=${JSON.stringify(short.stdout)} stderr=${JSON.stringify(short.stderr)}`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

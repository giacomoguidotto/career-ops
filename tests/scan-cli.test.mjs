import { spawnSync } from 'child_process';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fail, pass, NODE, ROOT } from './helpers.mjs';

const CLI = join(ROOT, 'scan.mjs');

console.log('\nscan.mjs CLI safety');

const temp = mkdtempSync(join(tmpdir(), 'career-ops-scan-cli-'));
try {
  const help = spawnSync(NODE, [CLI, '--help'], {
    cwd: temp,
    encoding: 'utf8',
  });

  if (help.status === 0
      && help.stdout.includes('Usage:')
      && !help.stdout.includes('Portal Scan')
      && readdirSync(temp).length === 0) {
    pass('scan.mjs --help exits without running a scan');
  } else {
    fail(`scan.mjs --help was not side-effect free: status=${help.status} stdout=${JSON.stringify(help.stdout)} stderr=${JSON.stringify(help.stderr)}`);
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

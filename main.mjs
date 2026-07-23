#!/usr/bin/env node

import { GatewayInputError, invokeCapability } from './lib/career-system-gateway.mjs';

function usage() {
  return 'Usage: node main.mjs <versioned-career-capability> --input -';
}

async function readStdin() {
  let body = '';
  for await (const chunk of process.stdin) body += chunk;
  if (body.trim() === '') return {};

  try {
    return JSON.parse(body);
  } catch {
    throw new GatewayInputError('stdin must contain one JSON object');
  }
}

async function main() {
  const [capability, inputFlag, inputSource, ...extra] = process.argv.slice(2);
  if (!capability || inputFlag !== '--input' || inputSource !== '-' || extra.length > 0) {
    throw new GatewayInputError(usage());
  }

  const input = await readStdin();
  const output = await invokeCapability(capability, input);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error) => {
  const expected = error instanceof GatewayInputError;
  process.stderr.write(`${expected ? error.message : 'gateway failed'}\n`);
  process.exitCode = expected ? 2 : 1;
});

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WEB_ROOT = import.meta.dirname;
const ARTIFACT_ROOT = join(WEB_ROOT, ".lifecycle-browser-artifacts");
const ledger = JSON.parse(readFileSync(join(WEB_ROOT, "branch-parity-ledger.json"), "utf8"));
const caseDirectories = new Map([
  ["today-runway", "today"],
  ["grouped-work", "grouped"],
]);

function pngDimensions(path) {
  const contents = readFileSync(path);
  assert.deepEqual([...contents.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${path} is a PNG`);
  return { width: contents.readUInt32BE(16), height: contents.readUInt32BE(20) };
}

const renderedCases = new Set(ledger.rows.flatMap((row) => row.renderedCases));
for (const renderedCase of renderedCases) {
  const directory = caseDirectories.get(renderedCase) ?? "";
  for (const matrix of ledger.renderMatrix) {
    const path = join(ARTIFACT_ROOT, directory, `${renderedCase}-${matrix.id}.png`);
    assert.equal(existsSync(path), true, `${renderedCase} produced ${matrix.id}`);
    const dimensions = pngDimensions(path);
    assert.equal(dimensions.width, matrix.width, `${renderedCase} ${matrix.id} width`);
    assert.equal(dimensions.height >= matrix.height, true, `${renderedCase} ${matrix.id} covers the viewport`);
  }
}

for (const renderedCase of ["today-runway", "grouped-work"]) {
  const directory = caseDirectories.get(renderedCase);
  const manifest = JSON.parse(readFileSync(join(ARTIFACT_ROOT, directory, "fixture-manifest.json"), "utf8"));
  assert.equal(manifest.fictionalWorkspace, true, `${renderedCase} uses a fictional workspace`);
  assert.deepEqual(manifest.renderMatrix, ledger.renderMatrix.map((entry) => entry.id));
  for (const matrix of ledger.renderMatrix) {
    const trace = join(ARTIFACT_ROOT, directory, `${renderedCase}-${matrix.id}-trace.zip`);
    assert.equal(existsSync(trace) && statSync(trace).size > 0, true, `${renderedCase} produced ${matrix.id} reduced-motion trace`);
  }
}

assert.deepEqual(new Set(Object.keys(ledger.stateEvidence)), new Set(ledger.requiredStates));
assert.equal(ledger.accessibilityProofs.includes("WCAG 2.2 AA contrast"), true);
assert.equal(ledger.safetyProofs.includes("passive load spends no tokens"), true);

console.log("PASS generated branch-to-web parity evidence");

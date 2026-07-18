import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WEB_ROOT = import.meta.dirname;
const ROOT = join(WEB_ROOT, "..");
const ledger = JSON.parse(readFileSync(join(WEB_ROOT, "branch-parity-ledger.json"), "utf8"));

assert.equal(ledger.contractVersion, 1);
assert.equal(ledger.parentIssue, 35);
assert.equal(ledger.closureIssue, 55);
assert.deepEqual(ledger.rows.map((row) => row.ticket).sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index + 43));
assert.deepEqual(ledger.renderMatrix, [
  { id: "desktop-light", width: 1440, height: 960, colorScheme: "light" },
  { id: "desktop-dark", width: 1440, height: 960, colorScheme: "dark" },
  { id: "mobile-light", width: 390, height: 844, colorScheme: "light" },
  { id: "mobile-dark", width: 390, height: 844, colorScheme: "dark" },
]);
assert.deepEqual(new Set(ledger.requiredStates), new Set(["populated", "empty", "loading", "running", "success", "warning", "error", "disabled", "conflict", "recovery"]));
assert.deepEqual(new Set(ledger.safetyProofs), new Set([
  "passive load spends no tokens",
  "unconfirmed action records no reality",
  "unknown state is never guessed",
  "legacy reads never rewrite user data",
]));
assert.deepEqual(new Set(Object.keys(ledger.stateEvidence)), new Set(ledger.requiredStates));

const ids = new Set();
for (const row of ledger.rows) {
  assert.match(row.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.equal(ids.has(row.id), false, `duplicate parity row ${row.id}`);
  ids.add(row.id);
  assert.equal(Boolean(row.treatment) !== Boolean(row.noUiRationale), true, `${row.id} declares one settled treatment or no-UI rationale`);
  for (const field of ["capabilities", "automatedChecks", "renderedCases", "passingEvidence"]) {
    assert.equal(Array.isArray(row[field]) && row[field].length > 0, true, `${row.id}.${field} is non-empty`);
  }
  assert.equal(typeof row.implementationSlice, "string");
  for (const check of row.automatedChecks) {
    assert.equal(existsSync(join(ROOT, check)), true, `${row.id} references existing check ${check}`);
  }
}

const browserScript = readFileSync(join(WEB_ROOT, "test-opportunity-lifecycle-browser.mjs"), "utf8");
const todayScript = readFileSync(join(WEB_ROOT, "test-today-supervision-browser.mjs"), "utf8");
const groupedScript = readFileSync(join(WEB_ROOT, "test-grouped-work-browser.mjs"), "utf8");
const workflow = readFileSync(join(ROOT, ".github", "workflows", "web-ci.yml"), "utf8");
const renderedCases = new Set(ledger.rows.flatMap((row) => row.renderedCases));
for (const renderedCase of renderedCases) {
  assert.equal([browserScript, todayScript, groupedScript].some((source) => source.includes(renderedCase)), true, `rendered case ${renderedCase} is produced by a browser journey`);
}
for (const [state, cases] of Object.entries(ledger.stateEvidence)) {
  assert.equal(Array.isArray(cases) && cases.length > 0, true, `${state} has rendered evidence`);
  for (const renderedCase of cases) assert.equal(renderedCases.has(renderedCase), true, `${state} references known rendered case ${renderedCase}`);
}
for (const proof of ledger.accessibilityProofs) {
  assert.equal(typeof proof === "string" && proof.length > 0, true);
}
assert.match(workflow, /branch-parity-browser:/);
assert.match(workflow, /playwright install --with-deps chromium/);
assert.match(workflow, /npm run test:browser/);
assert.match(workflow, /if: failure\(\)/);
assert.match(workflow, /web\/\.lifecycle-browser-artifacts\//);

const css = readFileSync(join(WEB_ROOT, "src", "app", "globals.css"), "utf8");
const cssBlock = (pattern) => css.match(pattern)?.[1] ?? "";
const themeBlock = cssBlock(/@theme \{([\s\S]*?)\n\}/);
const lightBlock = cssBlock(/:root \{([\s\S]*?)\n\}/);
const darkBlock = cssBlock(/\.dark \{([\s\S]*?)\n\}/);
const variable = (block, name) => {
  const value = block.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();
  assert.ok(value, `CSS variable --${name} exists`);
  return value;
};
const color = (value) => {
  const hex = value.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (hex) return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const hsl = value.match(/^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/i);
  assert.ok(hsl, `supported color syntax: ${value}`);
  const hue = Number(hsl[1]);
  const saturation = Number(hsl[2]) / 100;
  const lightness = Number(hsl[3]) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = lightness - chroma / 2;
  const sector = hue < 60 ? [chroma, x, 0]
    : hue < 120 ? [x, chroma, 0]
      : hue < 180 ? [0, chroma, x]
        : hue < 240 ? [0, x, chroma]
          : hue < 300 ? [x, 0, chroma]
            : [chroma, 0, x];
  return sector.map((channel) => channel + m);
};
const luminance = (channels) => channels
  .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (foreground, background) => {
  const values = [luminance(color(foreground)), luminance(color(background))].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
};
for (const [theme, block] of [["light", lightBlock], ["dark", darkBlock]]) {
  for (const textToken of ["fg", "muted", "faint", "landing", "brand-text"]) {
    for (const surfaceToken of ["bg", "surface"]) {
      assert.equal(contrast(variable(block, textToken), variable(block, surfaceToken)) >= 4.5, true, `${theme} ${textToken} on ${surfaceToken} meets WCAG AA`);
    }
  }
}
assert.equal(contrast(variable(themeBlock, "color-brand-foreground"), variable(themeBlock, "color-brand")) >= 4.5, true, "brand button foreground meets WCAG AA");

console.log("PASS branch-to-web parity ledger");

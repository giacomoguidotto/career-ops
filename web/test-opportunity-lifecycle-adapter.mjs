import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  createFictionalOpportunityWorkspace,
  removeFictionalOpportunityWorkspace,
} from "../tests/fixtures/fictional-opportunity-workspace.mjs";
import {
  LifecycleAdapterError,
  listOpportunityLifecycle,
} from "./src/lib/core/opportunity-lifecycle.ts";

function clone(value) {
  return structuredClone(value);
}

function servePayload(root, value) {
  const serialized = `${JSON.stringify(value)}\n`;
  writeFileSync(
    path.join(root, "opportunity-lifecycle.mjs"),
    `process.stdout.write(${JSON.stringify(serialized)});\n`,
  );
}

function incompatible(root, mutate, code) {
  const valid = listOpportunityLifecycle(root);
  const malformed = clone(valid);
  mutate(malformed);
  servePayload(root, malformed);
  assert.throws(
    () => listOpportunityLifecycle(root),
    (error) => error instanceof LifecycleAdapterError && error.code === code && error.status === 503,
  );
}

test("adapter accepts the published lifecycle structure", () => {
  const fixture = createFictionalOpportunityWorkspace({ materializeCore: true, missingOptionalFiles: true });
  try {
    const result = listOpportunityLifecycle(fixture.root);
    assert.equal(result.contract.version, 1);
    assert.equal(result.opportunities.length, fixture.stages.length);
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

test("adapter rejects future versions and malformed domain values", () => {
  const cases = [
    [(result) => { result.contract.version = 999; }, "invalid-lifecycle-contract"],
    [(result) => { result.contract.capabilities.passiveRead = "yes"; }, "invalid-lifecycle-contract"],
    [(result) => { result.contract.stages[0].owner = "browser"; }, "invalid-lifecycle-contract"],
    [(result) => { result.opportunities[0].primaryAction.kind = "invented"; }, "invalid-opportunity-summary"],
  ];
  for (const [mutate, code] of cases) {
    const fixture = createFictionalOpportunityWorkspace({ materializeCore: true, missingOptionalFiles: true });
    try {
      incompatible(fixture.root, mutate, code);
    } finally {
      removeFictionalOpportunityWorkspace(fixture.root);
    }
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  createFictionalOpportunityWorkspace,
  removeFictionalOpportunityWorkspace,
} from "../tests/fixtures/fictional-opportunity-workspace.mjs";
import { listOpportunityLifecycle } from "./src/lib/core/opportunity-lifecycle.ts";
import { buildTodayRunway } from "./src/lib/today-runway.ts";

test("Today builds one mixed priority runway with explicit ownership exclusions", async () => {
  const fixture = createFictionalOpportunityWorkspace({
    materializeCore: true,
    opportunities: [
      { num: 1, company: "Agent One", role: "Engineer", stage: "Evaluated", score: "4.8/5" },
      { num: 2, company: "Agent Two", role: "Engineer", stage: "Responded", score: "4.5/5" },
      { num: 3, company: "User One", role: "Engineer", stage: "Approach Ready", score: "4.9/5" },
      { num: 4, company: "External One", role: "Engineer", stage: "Approached", score: "4.1/5" },
      { num: 5, company: "Terminal", role: "Engineer", stage: "Rejected", score: "5/5" },
    ],
  });
  try {
    const lifecycle = await listOpportunityLifecycle(fixture.root);
    const agentTwo = lifecycle.opportunities.find((item) => item.opportunity === 2);
    const external = lifecycle.opportunities.find((item) => item.opportunity === 4);
    external.attemptAttention.state = "urgent";
    external.attemptAttention.nextReview = "2026-07-17";
    agentTwo.candidacy.state = "research-required";
    agentTwo.capabilities.generate = false;
    agentTwo.primaryAction.enabled = false;

    const runway = buildTodayRunway(lifecycle.opportunities);
    assert.equal(runway.leading.opportunity.opportunity, 1);
    assert.equal(runway.leading.artifactLabel, "approach plan");
    assert.equal(runway.eligible.length, 1);
    assert.deepEqual(runway.researchRequired.map((item) => item.opportunity.opportunity), [2]);
    assert.deepEqual(runway.userOwned.map((item) => item.opportunity.opportunity), [3]);
    assert.deepEqual(runway.externalOwned.map((item) => item.opportunity.opportunity), [4]);
    assert.equal(runway.queue[0].opportunity.opportunity, 4, "urgent attention outranks Owner grouping");
    assert.equal(runway.queue.some((item) => item.opportunity.opportunity === 5), false, "terminal rows leave the action runway");
  } finally {
    removeFictionalOpportunityWorkspace(fixture.root);
  }
});

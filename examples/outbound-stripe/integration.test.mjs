import assert from "node:assert/strict";
import test from "node:test";
import { exploreScenarios } from "@cloudfault/core";
import { ambiguousStripeCreate, cloudfault, runScenario } from "./scenario.mjs";

test("Node MSW semantic adapter exposes ambiguous Stripe commit through a real workerd production build", async () => {
  const baseline = await runScenario([]);
  const ambiguous = await runScenario([ambiguousStripeCreate]);

  assert.equal(baseline.state.responseStatus, 200);
  assert.equal(baseline.state.charges, 1);
  assert.equal(ambiguous.state.responseStatus, 200);
  assert.equal(ambiguous.state.charges, 2);
  assert.ok(ambiguous.checks.some((check) => !check.valid && check.checker === "at-most-one-stripe-charge"));
  assert.ok(ambiguous.history.some((event) => event.type === "info" && event.outcome?.actual === "committed"));
});

test("bounded exploration reports the Stripe ambiguity as its one-element MFS", async () => {
  const result = await exploreScenarios(cloudfault.faultPoints, cloudfault.execute, {
    maxDepth: cloudfault.maxDepth,
  });
  assert.ok(result.firstFailure);
  assert.deepEqual(result.minimalFailureSet?.map((item) => item.id), [ambiguousStripeCreate.id]);
});

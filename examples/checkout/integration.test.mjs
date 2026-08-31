import assert from "node:assert/strict";
import test from "node:test";
import { createFailureArtifact, minimizeFailureSet } from "@cloudfault/core";
import { ambiguous, cloudfault, runScenario, stale } from "./scenario.mjs";

test("real workerd fixture exposes the stale-state + ambiguous-commit bug and reduces its MFS", async () => {
  const baseline = await runScenario([]);
  const staleOnly = await runScenario([stale]);
  const ambiguousOnly = await runScenario([ambiguous]);
  const combined = await runScenario([stale, ambiguous]);

  assert.equal(baseline.state.charges, 0);
  assert.equal(staleOnly.state.charges, 1);
  assert.equal(ambiguousOnly.state.charges, 0);
  assert.equal(combined.state.charges, 2);
  assert.ok(combined.checks.some((check) => !check.valid && check.checker === "at-most-one-new-charge"));

  const minimized = await minimizeFailureSet([stale, ambiguous], async (candidate) => {
    const result = await runScenario(candidate);
    return result.checks.some((check) => !check.valid);
  });
  assert.deepEqual(minimized.minimal.map((item) => item.id), [stale.id, ambiguous.id]);

  const artifact = createFailureArtifact({
    testName: cloudfault.name,
    run: combined,
    minimalFailureSet: minimized.minimal,
    replay: cloudfault.replay,
  });
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.minimalFailureSet.length, 2);
});

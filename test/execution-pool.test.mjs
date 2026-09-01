import test from "node:test";
import assert from "node:assert/strict";
import { executeScenarioBatch } from "../packages/core/dist/index.js";

const scenario = (id, estimatedCost = 0) => ({ id, perturbations: estimatedCost ? [{ id: `p-${id}`, target: "svc", kind: "latency", phase: "before-send", description: id, category: "provider", actualOutcome: "unknown", observedOutcome: "indeterminate", metadata: { estimatedCost } }] : [] });

test("parallel execution respects concurrency while preserving report order", async () => {
  let active = 0;
  let peak = 0;
  const scenarios = [scenario("a"), scenario("b"), scenario("c"), scenario("d")];
  const result = await executeScenarioBatch(scenarios, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, item.id === "a" ? 15 : 3));
    active -= 1;
    return { scenario: item, history: [], checks: [{ valid: true, checker: "ok" }] };
  }, { concurrency: 2 });
  assert.equal(peak, 2);
  assert.deepEqual(result.runs.map((run) => run.scenario.id), ["a", "b", "c", "d"]);
});

test("cost and run budgets prevent new work from being scheduled", async () => {
  const scenarios = [scenario("a", 1), scenario("b", 4), scenario("c", 1)];
  const executed = [];
  const result = await executeScenarioBatch(scenarios, async (item) => {
    executed.push(item.id);
    return { scenario: item, history: [], checks: [{ valid: true, checker: "ok" }] };
  }, { concurrency: 1, budget: { maxRuns: 2, maxEstimatedCost: 5 } });
  assert.deepEqual(executed, ["a"]);
  assert.deepEqual(result.skipped.map((item) => [item.scenario.id, item.reason]), [["b", "cost-budget"], ["c", "run-budget"]]);
});

test("stopOnFirstFailure stops scheduling later work", async () => {
  const scenarios = [scenario("a"), scenario("b"), scenario("c")];
  const result = await executeScenarioBatch(scenarios, async (item) => ({
    scenario: item,
    history: [],
    checks: [{ valid: item.id !== "a", checker: item.id === "a" ? "bug" : "ok" }],
  }), { concurrency: 1, stopOnFirstFailure: true });
  assert.equal(result.firstFailure?.scenario.id, "a");
  assert.deepEqual(result.skipped.map((item) => item.scenario.id), ["b", "c"]);
});

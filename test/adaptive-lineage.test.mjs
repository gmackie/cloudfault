import test from "node:test";
import assert from "node:assert/strict";
import { History, exploreAdaptiveLineage } from "../packages/core/dist/index.js";

const injected = (id, target, operation) => ({ id, target, operation, kind: "http-error", phase: "before-commit", description: id, category: "provider", actualOutcome: "not-committed", observedOutcome: "definite-failure" });
const failA = injected("fail-a", "A", "primary.call");
const failB = injected("fail-b", "B", "fallback.call");

test("adaptive exploration discovers fallback calls revealed only by earlier faults", async () => {
  const execute = async (scenario) => {
    const active = new Set(scenario.perturbations.map((item) => item.id));
    const history = new History(() => 1);
    const primary = { id: `primary-${scenario.id}`, name: "primary.call", process: "client", target: "A", resource: "order:1" };
    history.invoke(primary);
    if (active.has("fail-a")) {
      history.perturb(failA, primary);
      history.complete(primary, "fail");
      const fallback = { id: `fallback-${scenario.id}`, name: "fallback.call", process: "client", target: "B", resource: "order:1", parentId: primary.id };
      history.invoke(fallback);
      if (active.has("fail-b")) {
        history.perturb(failB, fallback);
        history.complete(fallback, "fail");
      } else history.complete(fallback, "ok");
    } else history.complete(primary, "ok");
    return {
      scenario,
      history: history.snapshot(),
      checks: [{ valid: !active.has("fail-b"), checker: "fallback-survives" }],
    };
  };
  const resolve = (call) => call.target === "A" ? [failA] : call.target === "B" ? [failB] : [];
  const result = await exploreAdaptiveLineage(execute, resolve, { maxDepth: 2, maxRuns: 10, stopOnFirstFailure: true });
  assert.equal(result.discoveredCalls, 2);
  assert.ok(result.faultPoints.some((point) => point.target === "B"));
  assert.ok(result.firstFailure?.scenario.perturbations.some((item) => item.id === "fail-b"));
  assert.deepEqual(result.minimalFailureSet?.map((item) => item.id), ["fail-b"]);
});

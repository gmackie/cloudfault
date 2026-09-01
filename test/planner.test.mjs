import assert from "node:assert/strict";
import test from "node:test";
import {
  defineIncident,
  executeScenarioPlan,
  planScenarios,
  runCloudFault,
} from "@cloudfault/core";

function fault(id, target) {
  return {
    id,
    target,
    operation: "op",
    kind: id,
    phase: "before-commit",
    category: "provider",
    description: id,
    actualOutcome: "not-committed",
    observedOutcome: "definite-failure",
  };
}

const a1 = fault("a1", "A");
const a2 = fault("a2", "A");
const b1 = fault("b1", "B");
const b2 = fault("b2", "B");
const c1 = fault("c1", "C");
const points = [
  { id: "A", target: "A", choices: [a1, a2] },
  { id: "B", target: "B", choices: [b1, b2] },
  { id: "C", target: "C", choices: [c1] },
];

test("pairwise planner produces full interaction coverage without exhaustive cartesian enumeration", () => {
  const pairwise = planScenarios(points, { strategy: "pairwise", maxScenarios: 100 });
  const exhaustive = planScenarios(points, { strategy: "exhaustive", maxDepth: 3, maxScenarios: 100 });
  assert.ok(pairwise.scenarios.length < exhaustive.scenarios.length);
  const signatures = new Set(pairwise.scenarios.map((scenario) => scenario.perturbations.map((item) => item.id).sort().join("+")));
  assert.equal(signatures.size, pairwise.scenarios.length);
});

test("hybrid planner composes depth-one, incidents, pairwise, and guided candidates without duplicates", () => {
  const incident = defineIncident({
    id: "storage",
    description: "correlated storage failure",
    perturbations: [b2, c1],
  });
  const previousRuns = [{
    scenario: { id: "a1", perturbations: [a1] },
    history: [],
    checks: [{ checker: "invariant", valid: false }],
  }];
  const plan = planScenarios(points, {
    strategy: "hybrid",
    maxDepth: 2,
    maxScenarios: 30,
    incidents: [incident],
    previousRuns,
  });
  assert.equal(plan.strategy, "hybrid");
  assert.ok(plan.scenarios.some((scenario) => scenario.metadata?.incident === "storage"));
  const signatures = plan.scenarios.map((scenario) => scenario.perturbations.map((item) => item.id).sort().join("+"));
  assert.equal(new Set(signatures).size, signatures.length);
});

test("planned execution still reduces failures to a minimal failure set", async () => {
  const plan = planScenarios(points, { strategy: "exhaustive", maxDepth: 2 });
  const result = await executeScenarioPlan(plan, async (scenario) => {
    const ids = new Set(scenario.perturbations.map((item) => item.id));
    const valid = !(ids.has("a1") && ids.has("b1"));
    return {
      scenario,
      history: [],
      checks: [{ checker: "a1+b1", valid }],
    };
  });
  assert.ok(result.firstFailure);
  assert.deepEqual(result.minimalFailureSet.map((item) => item.id).sort(), ["a1", "b1"]);
});

test("defineCloudFault/runCloudFault accepts the pairwise strategy", async () => {
  const result = await runCloudFault({
    name: "planner",
    strategy: "pairwise",
    faultPoints: points,
    stopOnFirstFailure: false,
    async execute(scenario) {
      return { scenario, history: [], checks: [{ checker: "always", valid: true }] };
    },
  });
  assert.equal(result.failure, undefined);
  assert.ok(result.exploration.runs.length > 0);
});

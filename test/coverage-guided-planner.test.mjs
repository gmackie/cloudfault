import test from "node:test";
import assert from "node:assert/strict";
import { planScenarios } from "../packages/core/dist/index.js";

const perturbation = (id) => ({ id, target: "svc", kind: "http-error", phase: "before-commit", description: id, category: "provider", actualOutcome: "not-committed", observedOutcome: "definite-failure" });

test("coverage-guided planner prioritizes unseen faults using previous-run history", () => {
  const a = perturbation("a");
  const b = perturbation("b");
  const c = perturbation("c");
  const points = [
    { id: "A", target: "svc", choices: [a] },
    { id: "B", target: "svc", choices: [b] },
    { id: "C", target: "svc", choices: [c] },
  ];
  const previousRuns = [
    { scenario: { id: "a", perturbations: [a] }, history: [], checks: [{ valid: true, checker: "ok" }] },
    { scenario: { id: "a+b", perturbations: [a, b] }, history: [], checks: [{ valid: false, checker: "bug" }] },
  ];
  const plan = planScenarios(points, {
    strategy: "coverage-guided",
    previousRuns,
    maxDepth: 2,
    maxScenarios: 4,
  });
  assert.equal(plan.strategy, "coverage-guided");
  assert.equal(plan.scenarios[0].perturbations.some((item) => item.id === "c"), true);
  assert.equal(plan.scenarios.some((scenario) => scenario.id === "a"), false);
});

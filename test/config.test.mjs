import assert from "node:assert/strict";
import test from "node:test";
import { assertValidCloudFaultConfig, validateCloudFaultConfig } from "@cloudfault/core";

function perturbation(id, target = "X") {
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

function validConfig(overrides = {}) {
  return {
    name: "config-test",
    faultPoints: [{ id: "X", target: "X", choices: [perturbation("x")] }],
    async execute(scenario) {
      return { scenario, history: [], checks: [{ checker: "ok", valid: true }] };
    },
    ...overrides,
  };
}

test("valid CloudFault config has no errors", () => {
  const issues = validateCloudFaultConfig(validConfig());
  assert.equal(issues.filter((issue) => issue.severity === "error").length, 0);
  assert.doesNotThrow(() => assertValidCloudFaultConfig(validConfig()));
});

test("config validation rejects duplicate perturbation IDs and invalid selectors", () => {
  const duplicate = perturbation("same");
  const second = { ...perturbation("same", "Y"), selector: { occurrence: 0 } };
  const config = validConfig({
    faultPoints: [
      { id: "X", target: "X", choices: [duplicate] },
      { id: "Y", target: "Y", choices: [second] },
    ],
  });
  const issues = validateCloudFaultConfig(config);
  assert.ok(issues.some((issue) => issue.path.endsWith(".id") && issue.message.includes("duplicate perturbation")));
  assert.ok(issues.some((issue) => issue.path.endsWith("selector.occurrence") && issue.severity === "error"));
  assert.throws(() => assertValidCloudFaultConfig(config), /Invalid CloudFault config/);
});

test("deep exhaustive configs get an actionable combinatorial warning", () => {
  const points = Array.from({ length: 9 }, (_, index) => ({
    id: `P${index}`,
    target: `P${index}`,
    choices: [perturbation(`p${index}`, `P${index}`)],
  }));
  const issues = validateCloudFaultConfig(validConfig({
    strategy: "exhaustive",
    maxDepth: 4,
    faultPoints: points,
  }));
  assert.ok(issues.some((issue) => issue.path === "maxScenarios" && issue.severity === "warning"));
});

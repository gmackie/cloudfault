import test from "node:test";
import assert from "node:assert/strict";
import { NegotiatedRemoteBackend, createRemoteExecutionHandler } from "../packages/core/dist/index.js";

function handler(features) {
  return createRemoteExecutionHandler({
    capabilities: { agent: "staging-test", runtime: "workerd", features },
    async execute(scenario) { return { scenario, history: [], checks: [{ valid: true, checker: "remote" }], state: { ran: true } }; },
  });
}

test("negotiated remote backend executes when required semantics are supported", async () => {
  const backend = new NegotiatedRemoteBackend({
    endpoint: "https://agent.example/run",
    fetch: handler(["kv", "d1-ambiguity", "streaming"]),
    requiredFeatures: ["kv", "streaming"],
  });
  const negotiation = await backend.capabilities();
  assert.equal(negotiation.compatible, true);
  const result = await backend.execute({ id: "remote", perturbations: [] });
  assert.equal(result.state.ran, true);
});

test("negotiated remote backend refuses unsupported scenarios before execution", async () => {
  let executions = 0;
  const fetch = createRemoteExecutionHandler({
    capabilities: { agent: "limited-agent", runtime: "workerd", features: ["kv"] },
    async execute(scenario) { executions++; return { scenario, history: [], checks: [] }; },
  });
  const backend = new NegotiatedRemoteBackend({
    endpoint: "https://agent.example/run",
    fetch,
    requiredFeatures: ["kv", "d1-ambiguity"],
  });
  await assert.rejects(() => backend.execute({ id: "unsupported", perturbations: [] }), /missing required features: d1-ambiguity/);
  assert.equal(executions, 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  SignedRemoteBackend,
  createRemoteExecutionHandler,
  createSignedRemoteAuthorizer,
  signRemoteRequest,
} from "../packages/core/dist/index.js";

test("signed remote backend negotiates and executes with body integrity", async () => {
  const secret = "cloudfault-shared-test-secret";
  let nonce = 0;
  const fetch = createRemoteExecutionHandler({
    authorize: createSignedRemoteAuthorizer(secret, { now: () => 1_800_000_000_000, maxSkewMs: 1_000 }),
    capabilities: { agent: "signed-agent", runtime: "workerd", features: ["kv", "streaming"] },
    async execute(scenario) { return { scenario, history: [], checks: [{ valid: true, checker: "signed" }], state: { id: scenario.id } }; },
  });
  const backend = new SignedRemoteBackend({
    endpoint: "https://agent.example/cloudfault",
    fetch,
    secret,
    now: () => 1_800_000_000_000,
    nonce: () => `nonce-${++nonce}`,
    requiredFeatures: ["kv"],
  });
  const result = await backend.execute({ id: "signed-case", perturbations: [] });
  assert.equal(result.state.id, "signed-case");
  assert.equal((await backend.capabilities()).compatible, true);
});

test("signed remote authorizer rejects replayed nonces and body tampering", async () => {
  const secret = "cloudfault-shared-test-secret";
  const now = 1_800_000_000_000;
  const endpoint = "https://agent.example/cloudfault";
  const body = JSON.stringify({ schema: "cloudfault.remote-execution", version: 1, scenario: { id: "x", perturbations: [] } });
  const signed = signRemoteRequest(secret, { method: "POST", url: endpoint, body, timestamp: now, nonce: "fixed-nonce" });
  const authorize = createSignedRemoteAuthorizer(secret, { now: () => now });
  const first = new Request(endpoint, { method: "POST", headers: { ...signed, "content-type": "application/json" }, body });
  const replay = new Request(endpoint, { method: "POST", headers: { ...signed, "content-type": "application/json" }, body });
  assert.equal(await authorize(first), true);
  assert.equal(await authorize(replay), false);

  const fresh = signRemoteRequest(secret, { method: "POST", url: endpoint, body, timestamp: now, nonce: "fresh-nonce" });
  const tampered = new Request(endpoint, { method: "POST", headers: { ...fresh, "content-type": "application/json" }, body: `${body} ` });
  assert.equal(await authorize(tampered), false);
});

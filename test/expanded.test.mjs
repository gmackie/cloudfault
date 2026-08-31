import test from "node:test";
import assert from "node:assert/strict";
import {
  History,
  MemoryScenarioCache,
  ScenarioController,
  cloudBackendBrownout,
  dependencyCoverage,
  discoverDependencyCalls,
  faultPointsFromHistory,
  guidedScenarios,
  importHar,
  pairwiseCoverage,
  pairwiseScenarios,
  retryStormIncident,
  scenarioFingerprint,
  withScenarioCache,
} from "@cloudfault/core";
import {
  AsyncJobLifecycle,
  OAuthTokenLifecycle,
  TokenBucket,
  planWebhookDeliveries,
} from "@cloudfault/adapter-sdk/capabilities";
import {
  githubWebhookSigner,
  slackWebhookSigner,
  stripeWebhookSigner,
  verifyGithubWebhookSignature,
  verifySlackSignature,
  verifyStripeWebhookSignature,
} from "@cloudfault/adapters";
import {
  createD1FaultProxy,
  createR2FaultProxy,
  d1CommitThenTimeout,
  observerRegionPerturbations,
  observerRegionProfiles,
  r2CommitThenTimeout,
} from "@cloudfault/cloudflare";

function perturbation(id, target, operation) {
  return {
    id, target, operation, kind: id, description: id,
    phase: "before-commit", category: "provider",
    actualOutcome: "not-committed", observedOutcome: "definite-failure",
  };
}

test("baseline history discovers logical dependency calls and creates scoped fault points", async () => {
  const history = new History(() => 1);
  const op = {
    id: "op-1", name: "payment.confirm", process: 1, target: "stripe",
    adapter: "stripe", resource: "pi_1", executionIndex: "root/stripe/1",
  };
  history.invoke(op);
  history.complete(op, "ok");
  const calls = discoverDependencyCalls(history.snapshot());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].occurrences, 1);
  const points = await faultPointsFromHistory(history.snapshot(), (call) => [perturbation("timeout", call.target, call.operation)]);
  assert.equal(points.length, 1);
  assert.equal(points[0].choices[0].selector.executionIndex, "root/stripe/1");
});

test("pairwise strategy covers every perturbation pair", () => {
  const points = ["A", "B", "C"].map((target) => ({
    id: target,
    target,
    choices: [perturbation(`${target}-1`, target, "op"), perturbation(`${target}-2`, target, "op")],
  }));
  const scenarios = pairwiseScenarios(points, { maxScenarios: 50 });
  const coverage = pairwiseCoverage(points, scenarios);
  assert.equal(coverage.ratio, 1);
});

test("scenario cache avoids repeating equivalent executions", async () => {
  const cache = new MemoryScenarioCache();
  let executions = 0;
  const run = withScenarioCache(async (scenario) => {
    executions++;
    return { scenario, history: [], checks: [{ checker: "ok", valid: true }] };
  }, { cache, testName: "cache" });
  const scenario = { id: "x", seed: 1, perturbations: [perturbation("p", "X", "op")] };
  assert.equal(scenarioFingerprint(scenario), scenarioFingerprint({ ...scenario, id: "different-display-id" }));
  await run(scenario);
  await run({ ...scenario, id: "another" });
  assert.equal(executions, 1);
});

test("dependency coverage reports exercised baseline surface", () => {
  const history = new History(() => 1);
  const op = { id: "x", name: "send", process: 1, target: "QUEUE" };
  history.invoke(op);
  const baseline = { scenario: { id: "baseline", perturbations: [] }, history: history.snapshot(), checks: [] };
  const runs = [{ scenario: { id: "q", perturbations: [perturbation("q", "QUEUE", "send")] }, history: [], checks: [] }];
  assert.equal(dependencyCoverage(baseline, runs).ratio, 1);
});

test("incident helpers compose correlated cloud and retry-storm perturbations", () => {
  assert.equal(retryStormIncident({ target: "stripe" }).perturbations.length, 2);
  assert.equal(cloudBackendBrownout("storage", ["D1", "R2"]).perturbations.length, 2);
});

test("HAR import produces a replayable workload corpus", () => {
  const records = importHar({ log: { entries: [{
    request: { method: "POST", url: "https://example.test/x", postData: { text: "{}", mimeType: "application/json" } },
    response: { status: 201 }, time: 12,
  }] } });
  assert.equal(records.length, 1);
  assert.equal(records[0].expectedStatus, 201);
  assert.equal(records[0].request.headers["content-type"], "application/json");
});

test("guided search rewards perturbations observed in failures", () => {
  const a = perturbation("a", "A", "op");
  const b = perturbation("b", "B", "op");
  const runs = [{
    scenario: { id: "a", perturbations: [a] }, history: [],
    checks: [{ checker: "invariant", valid: false }],
  }];
  const scenarios = guidedScenarios([
    { id: "A", target: "A", choices: [a] },
    { id: "B", target: "B", choices: [b] },
  ], runs, { maxDepth: 2 });
  assert.ok(scenarios.some((item) => item.perturbations.some((p) => p.id === "a")));
});

test("webhook delivery and provider signatures are deterministic", async () => {
  const events = [{ id: "evt", type: "x", payload: { ok: true }, createdAt: 1 }];
  assert.equal(planWebhookDeliveries(events, { duplicates: 1 }).length, 2);
  const body = JSON.stringify(events[0].payload);
  const stripeHeaders = await stripeWebhookSigner("secret").headers(body, 100);
  assert.equal(verifyStripeWebhookSignature(body, stripeHeaders["stripe-signature"], "secret", { now: 100 }), true);
  const githubHeaders = await githubWebhookSigner("secret").headers(body, 100);
  assert.equal(verifyGithubWebhookSignature(body, githubHeaders["x-hub-signature-256"], "secret"), true);
  const slackHeaders = new Headers(await slackWebhookSigner("secret").headers(body, 100));
  assert.equal(verifySlackSignature(body, slackHeaders, "secret", { now: 100 }), true);
});

test("OAuth, async job, and token bucket models expose common provider lifecycle faults", async () => {
  const oauth = new OAuthTokenLifecycle({ accessToken: "a", expiresAt: 100, refreshToken: "r" });
  assert.equal(oauth.valid(50), true);
  oauth.expire(50);
  assert.equal(oauth.valid(50), false);
  await oauth.refresh();
  const job = new AsyncJobLifecycle("job-1");
  job.start();
  assert.equal(job.succeed("done").status, "succeeded");
  const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1, now: 0 });
  assert.equal(bucket.take(1, 0), true);
  assert.equal(bucket.take(1, 0), false);
  assert.equal(bucket.retryAfterMs(1, 0), 1000);
});

test("D1 proxy preserves prepare/bind/run and can fail after a committed write", async () => {
  let writes = 0;
  const statement = {
    bind() { return this; },
    async first() { return null; }, async all() { return { results: [] }; }, async raw() { return []; },
    async run() { writes++; return { success: true }; },
  };
  const database = { prepare() { return statement; } };
  const scenario = { id: "d1", perturbations: [d1CommitThenTimeout("DB")] };
  const controller = new ScenarioController(scenario);
  const proxy = createD1FaultProxy(database, { controller, target: "DB" });
  await assert.rejects(() => proxy.prepare("INSERT").bind(1).run(), /may have committed/);
  assert.equal(writes, 1);
});

test("R2 proxy can model put commit ambiguity without changing Bucket shape", async () => {
  const objects = new Map();
  const bucket = {
    async head(key) { return objects.has(key) ? {} : null; },
    async get(key) { return objects.get(key) ?? null; },
    async put(key, value) { objects.set(key, value); return { key }; },
    async delete(key) { objects.delete(key); },
    async list() { return { objects: [...objects.keys()] }; },
  };
  const controller = new ScenarioController({ id: "r2", perturbations: [r2CommitThenTimeout("FILES")] });
  const proxy = createR2FaultProxy(bucket, { controller, target: "FILES" });
  await assert.rejects(() => proxy.put("a", "value"), /may have committed/);
  assert.equal(objects.get("a"), "value");
});

test("logical observer region profiles produce consistency and transport perturbations", () => {
  const values = observerRegionPerturbations(observerRegionProfiles.remote, {
    kv: [{ target: "CONFIG", keys: ["feature"] }],
    d1: [{ target: "DB" }],
    services: [{ target: "AUTH", operation: "fetch" }],
  });
  assert.ok(values.some((item) => item.kind === "stale-read"));
  assert.ok(values.some((item) => item.kind === "replica-lag"));
  assert.ok(values.some((item) => item.kind === "latency"));
});

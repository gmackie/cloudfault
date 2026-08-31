import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = process.cwd();
const core = await import(pathToFileURL(path.join(root, "packages/core/dist/index.js")));
const sdk = await import(pathToFileURL(path.join(root, "packages/adapter-sdk/dist/index.js")));
const stripe = await import(pathToFileURL(path.join(root, "packages/stripe/dist/index.js")));

test("execution indexing is context-relative instead of process-global", () => {
  const indexer = new core.ExecutionIndexer();
  const parent = indexer.assign({ id: "checkout", name: "checkout", process: 1, target: "app", resource: "order:1" });
  const first = indexer.assign({ id: "pay-1", name: "payment.create", process: 1, target: "stripe", resource: "order:1", parentId: parent.id });
  const second = indexer.assign({ id: "pay-2", name: "payment.create", process: 1, target: "stripe", resource: "order:1", parentId: parent.id });
  assert.equal(first.occurrence, 1);
  assert.equal(second.occurrence, 2);
  assert.match(first.executionIndex, /stripe\.payment\.create:order:1#1$/);
});

test("scenario controller activates a perturbation only at its selected occurrence", () => {
  const perturbation = sdk.rejectBeforeCommit({
    id: "stripe:create:second",
    target: "stripe",
    operation: "payment_intent.create",
    selector: { occurrence: 2 },
  });
  const controller = new core.ScenarioController({ id: "second", perturbations: [perturbation] });
  const first = controller.begin({ id: "1", name: "payment_intent.create", target: "stripe", process: 1 });
  const second = controller.begin({ id: "2", name: "payment_intent.create", target: "stripe", process: 1 });
  assert.equal(controller.eligible(first).length, 0);
  assert.equal(controller.eligible(second).length, 1);
  controller.activate(perturbation, second);
  assert.equal(controller.activationCount(perturbation.id), 1);
});

test("adapter runtime preserves commit-then-timeout ambiguity and idempotent retry", async () => {
  const request = new Request("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": "order-812",
    },
    body: new URLSearchParams({ amount: "4200", currency: "usd", confirm: "true" }),
  });
  const match = stripe.stripeAdapter.match(request);
  const fault = stripe.stripeAdapter.faultSpace(match.operation).find((item) => item.kind === "commit-then-timeout");
  const controller = new core.ScenarioController({ id: "ambiguous", perturbations: [fault] });
  const registry = new sdk.AdapterRegistry().register(stripe.stripeAdapter);
  const backend = new stripe.StripeMemoryBackend();
  const runtime = new sdk.AdapterRuntime({ registry, controller, upstream: (candidate) => backend.fetch(candidate) });

  await assert.rejects(() => runtime.fetch(request.clone()), sdk.CloudFaultIndeterminateError);
  assert.equal(backend.snapshot().successfulCharges, 1);
  assert.equal(controller.history.snapshot().some((event) => event.type === "info" && event.outcome?.actual === "committed"), true);

  const retried = await runtime.fetch(request.clone());
  assert.equal(retried.status, 200);
  assert.equal(backend.snapshot().successfulCharges, 1, "same idempotency key must not create a second charge");
});

test("a fresh idempotency context after ambiguous create can create a duplicate financial effect", async () => {
  const first = new Request("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "idempotency-key": "attempt-1" },
    body: new URLSearchParams({ amount: "4200", currency: "usd", confirm: "true" }),
  });
  const match = stripe.stripeAdapter.match(first);
  const fault = stripe.stripeAdapter.faultSpace(match.operation).find((item) => item.kind === "commit-then-timeout");
  const controller = new core.ScenarioController({ id: "ambiguous", perturbations: [fault] });
  const registry = new sdk.AdapterRegistry().register(stripe.stripeAdapter);
  const backend = new stripe.StripeMemoryBackend();
  const runtime = new sdk.AdapterRuntime({ registry, controller, upstream: (candidate) => backend.fetch(candidate) });
  await assert.rejects(() => runtime.fetch(first), sdk.CloudFaultIndeterminateError);

  const retry = new Request("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "idempotency-key": "attempt-2" },
    body: new URLSearchParams({ amount: "4200", currency: "usd", confirm: "true" }),
  });
  const response = await runtime.fetch(retry);
  assert.equal(response.status, 200);
  assert.equal(backend.snapshot().successfulCharges, 2);
});

test("failure artifacts round-trip and timeline preserves indeterminate outcome", () => {
  const history = new core.History(() => 100);
  const op = { id: "op", name: "charge", process: 1, target: "stripe" };
  history.invoke(op);
  history.complete(op, "info", undefined, { actual: "committed", observed: "indeterminate" });
  const run = { scenario: { id: "x", perturbations: [] }, history: history.snapshot(), checks: [{ valid: false, checker: "one-charge", message: "two" }] };
  const artifact = core.createFailureArtifact({ testName: "checkout", run, createdAt: "2026-08-31T00:00:00.000Z" });
  const parsed = core.parseFailureArtifact(core.serializeFailureArtifact(artifact));
  assert.equal(parsed.testName, "checkout");
  assert.match(core.renderFailureArtifact(parsed), /actual=committed/);
});

test("exploreScenarios finds and minimizes a multi-fault failure", async () => {
  const a = sdk.fault("a", { id: "a", target: "A" });
  const b = sdk.fault("b", { id: "b", target: "B" });
  const result = await core.exploreScenarios([
    { id: "A", target: "A", choices: [a] },
    { id: "B", target: "B", choices: [b] },
  ], async (scenario) => {
    const ids = new Set(scenario.perturbations.map((item) => item.id));
    return {
      scenario,
      history: [],
      checks: [{ valid: !(ids.has("a") && ids.has("b")), checker: "combo" }],
    };
  }, { maxDepth: 2 });
  assert.deepEqual(result.minimalFailureSet.map((item) => item.id), ["a", "b"]);
});

test("defineCloudFault/runCloudFault returns a failure artifact for minimized failures", async () => {
  const a = sdk.fault("a", { id: "a-runner", target: "A" });
  const config = core.defineCloudFault({
    name: "runner-demo",
    faultPoints: [{ id: "A", target: "A", choices: [a] }],
    maxDepth: 1,
    async execute(scenario) {
      return {
        scenario,
        history: [],
        checks: [{ valid: scenario.perturbations.length === 0, checker: "no-a" }],
      };
    },
  });
  const result = await core.runCloudFault(config);
  assert.ok(result.failure);
  assert.equal(result.failure.testName, "runner-demo");
  assert.deepEqual(result.failure.minimalFailureSet.map((item) => item.id), ["a-runner"]);
});

test("concurrent workload records logical client operations", async () => {
  const controller = new core.ScenarioController({ id: "baseline", perturbations: [] });
  const state = { count: 0 };
  const results = await core.runConcurrentWorkload({
    controller,
    state,
    clients: 3,
    stepsPerClient: 2,
    next(client, step) {
      return {
        name: "increment",
        resource: `counter:${client}`,
        async run({ state: current }) {
          await Promise.resolve();
          current.count++;
          return { step };
        },
      };
    },
  });
  assert.equal(results.length, 6);
  assert.equal(state.count, 6);
  assert.equal(controller.history.snapshot().filter((event) => event.type === "invoke").length, 6);
  assert.equal(controller.history.snapshot().filter((event) => event.type === "ok").length, 6);
});

test("adapter plugin contract registers multiple community adapters", () => {
  const one = sdk.defineAdapter({
    manifest: { name: "one", provider: "One", hosts: ["one.test"], capabilities: [] },
    match() { return null; },
    faultSpace() { return []; },
  });
  const two = sdk.defineAdapter({
    manifest: { name: "two", provider: "Two", hosts: ["two.test"], capabilities: [] },
    match() { return null; },
    faultSpace() { return []; },
  });
  const plugin = sdk.defineAdapterPlugin({ name: "community", adapters: [one, two] });
  const registry = new sdk.AdapterRegistry().registerPlugin(plugin);
  assert.deepEqual(registry.list().map((item) => item.name), ["one", "two"]);
  assert.deepEqual(sdk.adaptersFromPluginModule({ default: plugin }).map((item) => item.manifest.name), ["one", "two"]);
});

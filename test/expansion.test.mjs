import test from "node:test";
import assert from "node:assert/strict";
import {
  CoverageGuidance,
  History,
  RemoteHttpBackend,
  buildFailureWitness,
  coverageGuidedScenarios,
  createRemoteExecutionHandler,
} from "../packages/core/dist/index.js";
import { defineRulesAdapter } from "../packages/adapter-sdk/dist/index.js";
import { snapshotSemanticContract, validateContractEvolution } from "../packages/adapter-sdk/dist/contracts.js";
import { githubWebhookSigner, stripeWebhookSigner } from "../packages/adapter-sdk/dist/signers.js";
import { checkMonotonicObserverReads, checkReadYourWrites, observerDivergence } from "../packages/cloudflare/dist/index.js";
import { shrinkCounterexample } from "../packages/fast-check/dist/shrink.js";

const injected = (id, target = "svc") => ({ id, target, kind: "http-error", phase: "before-commit", description: id, category: "provider", actualOutcome: "not-committed", observedOutcome: "definite-failure" });

test("failure witness retains causal parents, perturbations, and indeterminate completions", () => {
  let clock = 0;
  const history = new History(() => ++clock);
  const parent = { id: "checkout", name: "checkout", process: "client", resource: "order:1" };
  const child = { id: "charge", name: "payment.confirm", process: "client", target: "stripe", resource: "order:1", parentId: parent.id };
  history.invoke(parent);
  history.invoke(child);
  history.perturb(injected("stripe-timeout", "stripe"), child);
  history.complete(child, "info", undefined, { actual: "committed", observed: "indeterminate" });
  history.complete(parent, "ok");
  const run = { scenario: { id: "failure", perturbations: [injected("stripe-timeout", "stripe")] }, history: history.snapshot(), checks: [{ valid: false, checker: "one-charge", message: "duplicate" }] };
  const witness = buildFailureWitness(run);
  assert.equal(witness.indeterminateOperations.length, 1);
  assert.ok(witness.relevantEvents.some((event) => event.operation?.id === "checkout"));
  assert.ok(witness.causalEdges.some((edge) => edge.kind === "parent"));
  assert.ok(witness.causalEdges.some((edge) => edge.kind === "perturbation"));
});

test("coverage guidance prioritizes unexecuted perturbations and pairs", () => {
  const a = injected("a"); const b = injected("b");
  const points = [{ id: "A", target: "svc", choices: [a] }, { id: "B", target: "svc", choices: [b] }];
  const guidance = new CoverageGuidance();
  guidance.observe({ scenario: { id: "a", perturbations: [a] }, history: [], checks: [{ valid: true, checker: "ok" }] });
  const ranked = coverageGuidedScenarios(points, guidance, { maxDepth: 2, maxScenarios: 3 });
  assert.equal(ranked[0].perturbations.some((item) => item.id === "b"), true);
});

test("remote agent and HTTP backend share the portable scenario protocol", async () => {
  const handler = createRemoteExecutionHandler({
    capabilities: { agent: "test-agent", runtime: "workerd", features: ["kv"] },
    async execute(scenario) { return { scenario, history: [], checks: [{ valid: true, checker: "remote" }], state: { seen: scenario.id } }; },
  });
  const backend = new RemoteHttpBackend({ endpoint: "https://agent.example/run", fetch: handler });
  const result = await backend.execute({ id: "remote-case", perturbations: [] });
  assert.equal(result.state.seen, "remote-case");
});

test("semantic contract snapshots detect unversioned breaking changes", () => {
  const build = (retry, contractVersion) => defineRulesAdapter({
    manifest: { name: "acme", provider: "Acme", version: "0.1.0", contractVersion, hosts: ["api.acme.test"], capabilities: ["payments"] },
    rules: [{ methods: ["POST"], path: "/charge", name: "charge.create", effect: "external-side-effect", retry }],
  });
  const cases = [{ name: "charge", request: () => new Request("https://api.acme.test/charge", { method: "POST" }), expected: { operation: "charge.create" } }];
  const before = snapshotSemanticContract(build("safe", "2026-09"), cases);
  const after = snapshotSemanticContract(build("unsafe", "2026-09"), cases);
  const result = validateContractEvolution(before, after);
  assert.equal(result.valid, false);
  assert.ok(result.breaking.some((item) => item.includes("retry")));
});

test("portable webhook signers generate provider-shaped signatures", async () => {
  const stripe = await stripeWebhookSigner("secret").headers("{\"id\":1}", 123);
  const github = await githubWebhookSigner("secret").headers("{\"id\":1}", 123);
  assert.match(stripe["Stripe-Signature"], /^t=123,v1=[0-9a-f]{64}$/);
  assert.match(github["X-Hub-Signature-256"], /^sha256=[0-9a-f]{64}$/);
});

test("observer consistency catches regression and failed read-your-writes", () => {
  const trace = {
    writes: [{ key: "k", version: 3, writer: "FRA", at: 2 }],
    reads: [
      { key: "k", observer: "FRA", version: 2, authoritativeVersion: 3, at: 1 },
      { key: "k", observer: "FRA", version: 1, authoritativeVersion: 3, at: 3 },
      { key: "k", observer: "DTW", version: 3, authoritativeVersion: 3, at: 3 },
    ],
  };
  assert.equal(checkMonotonicObserverReads(trace).valid, false);
  assert.equal(checkReadYourWrites(trace).valid, false);
  assert.equal(observerDivergence(trace)[0].spread, 2);
});

test("counterexample shrinker independently minimizes faults and workload", async () => {
  const a = injected("a"); const b = injected("b");
  const result = await shrinkCounterexample([a, b], ["noise", "charge", "noise2"], ({ perturbations, workload }) => perturbations.some((item) => item.id === "b") && workload.includes("charge"));
  assert.deepEqual(result.perturbations.map((item) => item.id), ["b"]);
  assert.deepEqual(result.workload, ["charge"]);
});

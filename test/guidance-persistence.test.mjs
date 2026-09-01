import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CoverageGuidance, FileCoverageGuidanceStore, History } from "../packages/core/dist/index.js";

const fault = (id) => ({ id, target: "svc", kind: "http-error", phase: "before-commit", description: id, category: "provider", actualOutcome: "not-committed", observedOutcome: "definite-failure" });

test("causal guidance distinguishes faults on the witness from incidental co-occurring faults", () => {
  const a = fault("causal");
  const b = fault("incidental");
  const history = new History(() => 1);
  const op = { id: "op", name: "charge", process: "client", target: "svc", resource: "order:1" };
  history.invoke(op);
  history.perturb(a, op);
  history.complete(op, "fail");
  const guidance = new CoverageGuidance();
  guidance.observe({
    scenario: { id: "causal+incidental", perturbations: [a, b] },
    history: history.snapshot(),
    checks: [{ valid: false, checker: "business-invariant" }],
  });
  const snapshot = guidance.snapshot();
  assert.equal(snapshot.failurePerturbations.causal, 1);
  assert.equal(snapshot.failurePerturbations.incidental, 1);
  assert.equal(snapshot.causalPerturbations.causal, 1);
  assert.equal(snapshot.causalPerturbations.incidental, undefined);
  assert.ok(guidance.score({ id: "causal-only", perturbations: [a] }) > guidance.score({ id: "incidental-only", perturbations: [b] }));
});

test("coverage guidance round-trips through the file store across CI-style processes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cloudfault-guidance-"));
  const file = path.join(directory, "guidance.json");
  const store = new FileCoverageGuidanceStore(file);
  const guidance = new CoverageGuidance();
  const a = fault("a");
  guidance.observe({ scenario: { id: "a", perturbations: [a] }, history: [], checks: [{ valid: true, checker: "ok" }] });
  await store.save(guidance);
  const restored = await store.load();
  assert.equal(restored.scenarioExecutions("a"), 1);
  assert.equal(restored.perturbationExecutions("a"), 1);
  const document = JSON.parse(await readFile(file, "utf8"));
  assert.equal(document.schema, "cloudfault.coverage-guidance-store");
  assert.equal(document.guidance.schema, "cloudfault.coverage-guidance");
});

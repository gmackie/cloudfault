import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSmokeExecute, SmokeHarnessError } from "@cloudfault/cloudflare/smoke";
import { d1CommitThenTimeout, duplicateQueueDelivery, queueConsumerFailure, queueProducerFailure, staleKvRead } from "@cloudfault/cloudflare";

const bindings = [
  { type: "kv", binding: "CACHE" },
  { type: "d1", binding: "DB" },
  { type: "queue-producer", binding: "JOBS" },
];

function fakeHarness({ status = 200, scheduled = "ok", startError } = {}) {
  const calls = { workers: undefined, fetches: [], closed: 0 };
  const nemesis = { reset() {}, setLag() {}, setObserver() {}, setNegative() {}, setMode() {}, async snapshot() { return { events: [] }; } };
  const factory = async (config) => {
    calls.workers = config.workers;
    if (startError) throw new Error(startError);
    return {
      async listen() { return { url: new URL("http://127.0.0.1:1") }; },
      getWorker(name) {
        if (name?.startsWith("cloudfault-")) return { getExport: async () => nemesis };
        return {
          async fetch(url) { calls.fetches.push(String(url)); return new Response("x", { status }); },
          async scheduled() { return { outcome: scheduled, noRetry: false }; },
        };
      },
      async close() { calls.closed += 1; },
    };
  };
  return { factory, calls };
}

function smoke(harness, extra = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cloudfault-smoke-"));
  fs.writeFileSync(path.join(directory, "wrangler.jsonc"), "{}");
  return createSmokeExecute({ config: path.join(directory, "wrangler.jsonc"), bindings, crons: ["0 * * * *"], createHarness: harness.factory, ...extra });
}

test("only KV and Queue-producer perturbations are applicable from outside the Worker", () => {
  const execute = smoke(fakeHarness());
  assert.equal(execute.supports(staleKvRead("CACHE", { region: "r" })), true);
  assert.equal(execute.supports(duplicateQueueDelivery("JOBS")), true);
  assert.equal(execute.supports(queueProducerFailure("JOBS")), true);
  assert.equal(execute.supports(queueConsumerFailure("JOBS")), false, "consumer-side faults need the consumer");
  assert.equal(execute.supports(d1CommitThenTimeout("DB")), false, "D1 needs an in-Worker proxy");
  const points = execute.applicableFaultPoints([
    { id: "DB", target: "DB", choices: [d1CommitThenTimeout("DB")] },
    { id: "JOBS", target: "JOBS", choices: [duplicateQueueDelivery("JOBS"), queueConsumerFailure("JOBS")] },
  ]);
  assert.deepEqual(points.map((point) => [point.id, point.choices.map((choice) => choice.kind)]), [["JOBS", ["duplicate-delivery"]]]);
});

test("KV and Queue bindings are rerouted through nemesis Workers written beside the config", async () => {
  const harness = fakeHarness();
  const execute = smoke(harness);
  const result = await execute({ id: "baseline", perturbations: [] });
  assert.ok(result.checks.every((check) => check.valid));
  const [app, ...nemesis] = harness.calls.workers;
  assert.deepEqual(app.bindingOverrides, { CACHE: "cloudfault-kv-nemesis-cache", JOBS: "cloudfault-queue-nemesis-jobs" });
  assert.equal(nemesis.length, 2);
  for (const worker of nemesis) assert.ok(fs.existsSync(worker.configPath), worker.configPath);
  assert.deepEqual(harness.calls.fetches, ["https://cloudfault.local/"]);
  assert.equal(harness.calls.closed, 1);
});

test("5xx responses and failed cron runs violate the smoke invariants", async () => {
  const result = await smoke(fakeHarness({ status: 503, scheduled: "exception" }))({ id: "baseline", perturbations: [] });
  const failed = Object.fromEntries(result.checks.map((check) => [check.checker, check.valid]));
  assert.deepEqual(failed, { "no-unexpected-responses": false, "scheduled-handlers-succeed": false });
  const expected = await smoke(fakeHarness({ status: 503 }), { requests: [{ path: "/health", expectStatus: 503 }], crons: [] })({ id: "baseline", perturbations: [] });
  assert.ok(expected.checks.every((check) => check.valid), "an explicitly expected status is not a failure");
});

test("a scenario with an inapplicable perturbation is refused, and a Worker that cannot start is a SmokeHarnessError", async () => {
  await assert.rejects(smoke(fakeHarness())({ id: "s", perturbations: [d1CommitThenTimeout("DB")] }), /cannot apply DB:d1\.run:commit-then-timeout/);
  await assert.rejects(smoke(fakeHarness({ startError: "Could not resolve main" }))({ id: "baseline", perturbations: [] }), SmokeHarnessError);
});

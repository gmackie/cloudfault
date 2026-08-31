import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const cloudflare = await import(pathToFileURL(path.join(process.cwd(), "packages/cloudflare/dist/index.js")));

test("Wrangler topology parser handles JSONC and discovers modern bindings", () => {
  const topology = cloudflare.discoverWranglerTopology(`{
    // application bindings
    "name": "api",
    "kv_namespaces": [{ "binding": "CACHE", "id": "x", }],
    "d1_databases": [{ "binding": "DB", "database_name": "db", "database_id": "x" }],
    "queues": { "producers": [{ "binding": "EVENTS", "queue": "events" }] },
    "services": [{ "binding": "AUTH", "service": "auth" }],
    "workflows": [{ "binding": "FLOW", "name": "flow", "class_name": "Flow" }],
  }`);
  assert.equal(topology.name, "api");
  assert.deepEqual(topology.bindings.map((item) => [item.type, item.binding]), [
    ["kv", "CACHE"],
    ["d1", "DB"],
    ["queue-producer", "EVENTS"],
    ["service", "AUTH"],
    ["workflow", "FLOW"],
  ]);
});

test("multi-key KV model exposes observer-specific stale positive and negative views", () => {
  const kv = new cloudflare.EventuallyConsistentKvStore();
  kv.put("feature:a", "off", 1);
  kv.put("feature:a", "on", 2);
  kv.put("feature:b", "new", 3);
  kv.setObserverLag("FRA", "feature:a", 1);
  kv.setObserverVersion("FRA", "feature:b", 0);
  assert.equal(kv.read("FRA", "feature:a").visibleValue, "off");
  assert.equal(kv.read("FRA", "feature:b").visibleValue, null);
  kv.converge("FRA");
  assert.equal(kv.read("FRA", "feature:a").visibleValue, "on");
  assert.equal(kv.read("FRA", "feature:b").visibleValue, "new");
});

test("queue delivery semantics duplicate messages and alter batch boundaries", () => {
  const batches = cloudflare.applyQueueDeliverySemantics([
    { id: "a", body: 1 },
    { id: "b", body: 2 },
    { id: "c", body: 3 },
  ], { duplicateIds: ["b"], batchSizes: [2, 1] });
  assert.deepEqual(batches.map((batch) => batch.map((message) => message.id)), [["a", "b"], ["b"], ["c"]]);
});

test("D1 session model preserves session monotonicity across lagging replicas", () => {
  const d1 = new cloudflare.D1SessionModel();
  d1.commit();
  d1.commit();
  d1.setReplicaVersion("replica-a", 1);
  assert.equal(d1.observe("replica-a"), 1);
  d1.recordWrite("session-a", 2);
  assert.equal(d1.observe("replica-a", "session-a"), 2);
});

test("nemesis project templates expose binding-compatible RPC methods", () => {
  const kv = cloudflare.kvNemesisProject({ name: "kv-test" });
  const queue = cloudflare.queueNemesisProject({ name: "queue-test" });
  const service = cloudflare.serviceNemesisProject({ name: "service-test", upstreamService: "real" });
  assert.match(kv.find((file) => file.path.endsWith("index.js")).content, /getWithMetadata/);
  assert.match(queue.find((file) => file.path.endsWith("index.js")).content, /sendBatch/);
  assert.match(service.find((file) => file.path.endsWith("index.js")).content, /commit-then-timeout/);
});

test("scenario configurator translates semantic and service faults into nemesis RPC plans", async () => {
  const calls = [];
  const exports = {
    kv: {
      reset() { calls.push(["kv", "reset"]); },
      setObserver(region) { calls.push(["kv", "observer", region]); },
      setLag(key, behind, reads, region) { calls.push(["kv", "lag", key, behind, reads, region]); },
    },
    queue: {
      reset() { calls.push(["queue", "reset"]); },
      setMode(mode) { calls.push(["queue", "mode", mode]); },
    },
    service: {
      reset() { calls.push(["service", "reset"]); },
      setPlan(plan) { calls.push(["service", "plan", plan]); },
    },
  };
  const harness = {
    getWorker(name) {
      return { async getExport() { return exports[name]; } };
    },
  };
  const bindings = [
    { target: "ORDER_STATE", worker: "kv", kind: "kv" },
    { target: "FULFILLMENT", worker: "queue", kind: "queue" },
    { target: "PAYMENTS", worker: "service", kind: "service", operations: { "payment.confirm": { method: "POST", path: "/confirm" } } },
  ];
  const stale = cloudflare.staleKvRead("ORDER_STATE", { key: "order:812", region: "FRA", versionsBehind: 2 });
  const duplicate = cloudflare.duplicateQueueDelivery("FULFILLMENT");
  const timeout = cloudflare.serviceTimeout("PAYMENTS", "payment.confirm");
  timeout.selector = { ...timeout.selector, occurrence: 2 };

  await cloudflare.resetNemesisBindings(harness, bindings);
  await cloudflare.applyScenarioToNemesisBindings(harness, { perturbations: [stale, duplicate, timeout] }, bindings);

  assert.deepEqual(calls.slice(0, 3), [["kv", "reset"], ["queue", "reset"], ["service", "reset"]]);
  assert.ok(calls.some((call) => call[0] === "kv" && call[1] === "observer" && call[2] === "FRA"));
  assert.ok(calls.some((call) => call[0] === "kv" && call[1] === "lag" && call[2] === "order:812" && call[3] === 2));
  assert.ok(calls.some((call) => call[0] === "queue" && call[1] === "mode" && call[2] === "duplicate"));
  const plan = calls.find((call) => call[0] === "service" && call[1] === "plan")?.[2];
  assert.deepEqual(plan, [{ method: "POST", path: "/confirm", occurrence: 2, kind: "commit-then-timeout" }]);
});

test("direct Miniflare queue dispatcher applies duplicate and rebatch semantics before dispatch", async () => {
  const dispatched = [];
  const miniflare = {
    async getWorker(name) {
      assert.equal(name, "consumer");
      return {
        async queue(queue, messages) {
          dispatched.push([queue, messages]);
          return { outcome: "ok" };
        },
      };
    },
    async dispose() {},
  };
  const duplicate = { ...cloudflare.duplicateQueueDelivery("EVENTS"), metadata: { messageIds: ["b"] } };
  const rebatch = { ...cloudflare.rebatchQueueDelivery("EVENTS"), metadata: { batchSizes: [2, 1] } };
  const results = await cloudflare.dispatchQueueScenario(miniflare, {
    worker: "consumer",
    queue: "events",
    target: "EVENTS",
    scenario: { perturbations: [duplicate, rebatch] },
    messages: [
      { id: "a", body: { n: 1 }, attempts: 1 },
      { id: "b", body: { n: 2 }, attempts: 1 },
      { id: "c", body: { n: 3 }, attempts: 1 },
    ],
  });
  assert.equal(results.length, 3);
  assert.deepEqual(dispatched.map(([, messages]) => messages.map((message) => message.id)), [["a", "b"], ["b"], ["c"]]);
});

test("direct Miniflare scheduled dispatcher models delay and duplicate execution", async () => {
  const dispatched = [];
  const miniflare = {
    async getWorker() {
      return {
        async scheduled(options) {
          dispatched.push(options);
          return { outcome: "ok", noRetry: false };
        },
      };
    },
    async dispose() {},
  };
  const results = await cloudflare.dispatchScheduledScenario(miniflare, {
    target: "NIGHTLY",
    scenario: {
      perturbations: [
        cloudflare.duplicateScheduledExecution("NIGHTLY"),
        cloudflare.delayedScheduledExecution("NIGHTLY", 5000),
      ],
    },
    scheduledTime: 1000,
    cron: "0 0 * * *",
  });
  assert.equal(results.length, 2);
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[0].scheduledTime.getTime(), 6000);
  assert.equal(dispatched[1].scheduledTime.getTime(), 6000);
});

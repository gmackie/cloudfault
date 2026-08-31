import test from "node:test";
import assert from "node:assert/strict";
import {
  EventuallyConsistentKV,
  queueDuplicateFault,
  duplicateMessages,
  d1DefaultDegradationFaults,
  r2CapacityFault,
} from "../packages/cloudflare/dist/index.js";

test("eventually consistent KV exposes observer-local versions", () => {
  const kv = new EventuallyConsistentKV();
  kv.write("v1");
  kv.write("v2");
  kv.setObserverVersion("FRA", 1);
  kv.converge("DTW");
  assert.deepEqual(kv.read("FRA"), { version: 1, value: "v1" });
  assert.deepEqual(kv.read("DTW"), { version: 2, value: "v2" });
});

test("queue helper duplicates a logical delivery", () => {
  const fault = queueDuplicateFault("EVENTS", 2);
  assert.equal(fault.category, "semantic");
  assert.deepEqual(duplicateMessages(["a", "b"], 0, 2), ["a", "a", "b"]);
});

test("backend degradation primitives are separate from legal semantics", () => {
  const d1 = d1DefaultDegradationFaults("DB");
  assert.equal(d1.length, 4);
  assert.ok(d1.every((fault) => fault.category === "degradation"));
  assert.equal(r2CapacityFault("OBJECTS").category, "degradation");
});

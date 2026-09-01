import test from "node:test";
import assert from "node:assert/strict";
import { History } from "../packages/core/dist/index.js";
import { mergeObserverHistories, observerTraceFromHistory, runMultiObserver } from "../packages/cloudflare/dist/index.js";

function observerHistory(observer, version, at) {
  const history = new History(() => at);
  const operation = { id: "read", name: "kv.get", process: "client", target: "CONFIG", resource: "feature" };
  history.invoke(operation, undefined, { observer, consistencyKey: "feature", consistencyOperation: "read", version, authoritativeVersion: 3 });
  history.complete(operation, "ok", { version }, undefined, { observer, consistencyKey: "feature", consistencyOperation: "read", version, authoritativeVersion: 3 });
  return history.snapshot();
}

test("merged observer histories namespace operation identity and preserve local sequence tags", () => {
  const merged = mergeObserverHistories([
    { observer: "FRA", history: observerHistory("FRA", 2, 20) },
    { observer: "DTW", history: observerHistory("DTW", 3, 10) },
  ]);
  assert.deepEqual(merged.map((event) => event.seq), [0, 1, 2, 3]);
  assert.ok(merged.some((event) => event.operation?.id === "FRA/read"));
  assert.ok(merged.some((event) => event.operation?.id === "DTW/read"));
  assert.ok(merged.every((event) => typeof event.tags?.observerSeq === "number"));
  const trace = observerTraceFromHistory(merged);
  assert.equal(trace.reads.length, 4);
  assert.ok(trace.reads.some((read) => read.observer === "FRA" && read.version === 2));
});

test("runMultiObserver executes observers concurrently and returns a single timeline", async () => {
  const result = await runMultiObserver(["FRA", "DTW"], async (observer) => ({ history: observerHistory(observer, observer === "FRA" ? 2 : 3, observer === "FRA" ? 20 : 10), value: observer }));
  assert.equal(result.observers.FRA.value, "FRA");
  assert.equal(result.observers.DTW.value, "DTW");
  assert.equal(result.history.length, 4);
});

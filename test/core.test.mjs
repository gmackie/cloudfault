import test from "node:test";
import assert from "node:assert/strict";
import {
  History,
  exploreFaultSets,
  fault,
  SeededRandom,
} from "../packages/core/dist/index.js";

test("History records indeterminate operations as info", () => {
  const history = new History(() => 100);
  history.invoke("p1", "charge");
  history.complete("p1", "info", { timeout: true }, {
    actualOutcome: "committed",
    observedOutcome: "indeterminate",
  });
  assert.equal(history.events()[1].type, "info");
  assert.equal(history.events()[1].meta.actualOutcome, "committed");
});

test("bounded search finds and minimizes a multi-fault failure", async () => {
  const a = fault("a", "fault A", { category: "semantic" });
  const b = fault("b", "fault B", { category: "external" });
  const c = fault("c", "irrelevant fault");

  const result = await exploreFaultSets([a, b, c], async (active) => {
    const ids = new Set(active.map((item) => item.id));
    const history = new History();
    return {
      history,
      check: ids.has("a") && ids.has("b")
        ? { valid: false, invariant: "demo", message: "A+B is invalid" }
        : { valid: true },
    };
  }, { stopOnFirstFailure: true });

  assert.equal(result.firstFailure.faults.length, 2);
  assert.deepEqual(result.minimalFailureSet.map((item) => item.id), ["a", "b"]);
});

test("seeded random is replayable", () => {
  const a = new SeededRandom(42);
  const b = new SeededRandom(42);
  assert.deepEqual([a.next(), a.next(), a.next()], [b.next(), b.next(), b.next()]);
});

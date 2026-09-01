import test from "node:test";
import assert from "node:assert/strict";
import { checkIdempotent, checkStateMachine, eventually, indeterminateOperations } from "../packages/core/dist/index.js";

test("eventually reports convergence", async () => {
  let value = 0;
  const result = await eventually(() => ++value, (current) => current >= 3, { timeoutMs: 100, intervalMs: 0, name: "converges" });
  assert.equal(result.valid, true);
  assert.equal(result.checker, "converges");
});

test("state machine rejects impossible business transitions", () => {
  const events = ["pay", "cancel"];
  const result = checkStateMachine(events, {
    name: "order-lifecycle",
    initial: "cart",
    transitions: [
      { from: "cart", to: "paid", when: (event) => event === "pay", label: "pay" },
      { from: "cart", to: "cancelled", when: (event) => event === "cancel", label: "cancel" },
    ],
  });
  assert.equal(result.valid, false);
  assert.match(result.message ?? "", /illegal transition/);
});

test("idempotency checker identifies duplicate side effects", () => {
  const result = checkIdempotent([
    { order: "812", charge: "ch_1" },
    { order: "812", charge: "ch_2" },
  ], (charge) => charge.order, { name: "one-charge-per-order" });
  assert.equal(result.valid, false);
  assert.equal(result.checker, "one-charge-per-order");
});

test("history helpers preserve indeterminate outcomes", () => {
  const history = [
    { seq: 0, at: 0, type: "info", process: "checkout", operation: { id: "1", name: "payment.confirm", process: "checkout" } },
    { seq: 1, at: 1, type: "ok", process: "checkout", operation: { id: "2", name: "order.persist", process: "checkout" } },
  ];
  assert.equal(indeterminateOperations(history, "payment.confirm").length, 1);
});

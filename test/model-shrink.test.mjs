import test from "node:test";
import assert from "node:assert/strict";
import { shrinkModelCounterexample, validateCommandSequence } from "../packages/fast-check/dist/model-shrink.js";

const injected = (id) => ({ id, target: "PAYMENTS", kind: "http-error", phase: "before-commit", description: id, category: "provider", actualOutcome: "not-committed", observedOutcome: "definite-failure" });

const model = {
  initialModel: () => ({ cart: false, items: 0, checkedOut: false }),
  precondition(command, state) {
    if (command === "create-cart") return !state.cart;
    if (command === "add-item") return state.cart && !state.checkedOut;
    if (command === "view-cart") return state.cart;
    if (command === "checkout") return state.cart && state.items > 0 && !state.checkedOut;
    return true;
  },
  apply(command, state) {
    const next = { ...state };
    if (command === "create-cart") next.cart = true;
    if (command === "add-item") next.items += 1;
    if (command === "checkout") next.checkedOut = true;
    return next;
  },
};

test("model validation rejects workloads whose prerequisites were deleted", () => {
  const invalid = validateCommandSequence(["checkout"], model);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.failedAt, 0);
});

test("model counterexample shrinking keeps prerequisites while removing irrelevant commands", async () => {
  const irrelevant = injected("irrelevant");
  const timeout = injected("ambiguous-payment");
  const result = await shrinkModelCounterexample(
    [irrelevant, timeout],
    ["noise", "create-cart", "view-cart", "add-item", "view-cart", "checkout", "noise2"],
    model,
    ({ perturbations, commands }) => perturbations.some((item) => item.id === "ambiguous-payment") && commands.includes("checkout"),
  );
  assert.deepEqual(result.perturbations.map((item) => item.id), ["ambiguous-payment"]);
  assert.deepEqual(result.commands, ["create-cart", "add-item", "checkout"]);
});

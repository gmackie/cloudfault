import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyStripePaymentConfirmation,
  stripeAdapter,
} from "../packages/stripe/dist/index.js";
import { AdapterRegistry } from "../packages/adapter-sdk/dist/index.js";

test("Stripe adapter classifies payment confirmation and idempotency", () => {
  const classified = classifyStripePaymentConfirmation("pi_123", "checkout:812");
  assert.equal(classified.operation.name, "payment_intent.confirm");
  assert.equal(classified.idempotencyKey, "checkout:812");
  assert.equal(classified.operation.semantics.ambiguityRisk, "high");

  const faults = stripeAdapter.faults(classified);
  const ambiguous = faults.find((fault) => fault.id === "commit-then-timeout");
  assert.equal(ambiguous.actualOutcome, "committed");
  assert.equal(ambiguous.observedOutcome, "indeterminate");
});

test("adapter registry dispatches by provider host", () => {
  const registry = new AdapterRegistry().register(stripeAdapter);
  const match = registry.classify({
    url: "https://api.stripe.com/v1/payment_intents/pi_abc/confirm",
    method: "POST",
  });
  assert.equal(match.provider, "Stripe");
  assert.equal(registry.list().length, 1);
});

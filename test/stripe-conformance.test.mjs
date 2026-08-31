import assert from "node:assert/strict";
import test from "node:test";
import { runAdapterConformance } from "@cloudfault/adapter-sdk/conformance";
import { stripeAdapter } from "@cloudfault/stripe";

const cases = [
  {
    name: "create-payment-intent",
    request: () => new Request("https://api.stripe.com/v1/payment_intents", {
      method: "POST",
      headers: { "Idempotency-Key": "order:812:payment" },
      body: new URLSearchParams({ amount: "4200", currency: "usd" }),
    }),
    expected: {
      operation: "payment_intent.create",
      effect: "external-side-effect",
      retry: "conditional",
      faultKinds: ["rate-limit", "commit-then-timeout", "commit-then-disconnect"],
    },
  },
  {
    name: "confirm-payment-intent",
    request: () => new Request("https://api.stripe.com/v1/payment_intents/pi_123/confirm", {
      method: "POST",
      headers: { "Idempotency-Key": "confirm:pi_123" },
    }),
    expected: {
      operation: "payment_intent.confirm",
      effect: "external-side-effect",
      retry: "conditional",
      resource: "pi_123",
      faultKinds: ["commit-then-timeout"],
    },
  },
  {
    name: "retrieve-payment-intent",
    request: () => new Request("https://api.stripe.com/v1/payment_intents/pi_123"),
    expected: {
      operation: "payment_intent.retrieve",
      effect: "query",
      retry: "safe",
      resource: "pi_123",
      faultKinds: ["rate-limit"],
    },
  },
  {
    name: "create-refund",
    request: () => new Request("https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: { "Idempotency-Key": "refund:order:812" },
      body: new URLSearchParams({ payment_intent: "pi_123" }),
    }),
    expected: {
      operation: "refund.create",
      effect: "external-side-effect",
      retry: "conditional",
      faultKinds: ["rate-limit", "commit-then-timeout"],
    },
  },
];

test("Stripe semantic subset is deterministic and exposes the expected failure contract", () => {
  const result = runAdapterConformance(stripeAdapter, cases);
  assert.equal(result.valid, true, result.checks.filter((item) => !item.valid).map((item) => `${item.case}: ${item.message}`).join("\n"));
  assert.equal(result.coverage.cases, 4);
  assert.equal(result.coverage.matched, 4);
  assert.ok(result.coverage.faultKinds.includes("commit-then-timeout"));
  assert.ok(result.coverage.faultKinds.includes("rate-limit"));
});

import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const { stripeAdapter } = await import(pathToFileURL(path.join(process.cwd(), "packages/stripe/dist/index.js")));

test("Stripe adapter classifies payment confirmation as external side effect", () => {
  const request = new Request("https://api.stripe.com/v1/payment_intents/pi_123/confirm", {
    method: "POST",
    headers: { "Idempotency-Key": "order-812" },
  });
  const match = stripeAdapter.match(request);
  assert.equal(match.operation.name, "payment_intent.confirm");
  assert.equal(match.operation.effect, "external-side-effect");
  assert.equal(match.operation.idempotencyKey, "order-812");
  assert.ok(stripeAdapter.faultSpace(match.operation).some((f) => f.kind === "commit-then-timeout"));
});

test("adapter registry supports third-party semantic plugins", async () => {
  const sdk = await import(pathToFileURL(path.join(process.cwd(), "packages/adapter-sdk/dist/index.js")));
  const registry = new sdk.AdapterRegistry().register(stripeAdapter);
  const classified = registry.classify(new Request("https://api.stripe.com/v1/payment_intents/pi_456/confirm", { method: "POST" }));
  assert.equal(classified.adapter.manifest.name, "stripe");
  assert.equal(classified.match.operation.name, "payment_intent.confirm");
});

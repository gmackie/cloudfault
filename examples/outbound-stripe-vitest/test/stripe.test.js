import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { ScenarioController } from "@cloudfault/core";
import { AdapterRegistry, AdapterRuntime, commitThenTimeout } from "@cloudfault/adapter-sdk";
import { StripeMemoryBackend, stripeAdapter } from "@cloudfault/stripe";
import worker from "../src/index.js";
import { network } from "./network.js";

const ambiguous = commitThenTimeout({
  id: "stripe:payment_intent.create:vitest-commit-timeout",
  target: "stripe",
  operation: "payment_intent.create",
  selector: { occurrence: 1 },
  description: "Stripe commits the first PaymentIntent while the Worker observes an indeterminate result",
});

function installStripeRuntime(perturbations) {
  const controller = new ScenarioController({
    id: perturbations.length ? perturbations.map((item) => item.id).join("+") : "baseline",
    perturbations,
  });
  const backend = new StripeMemoryBackend();
  const registry = new AdapterRegistry().register(stripeAdapter);
  const runtime = new AdapterRuntime({
    registry,
    controller,
    upstream: (request) => backend.fetch(request),
  });
  network.use(http.all("https://api.stripe.com/*", ({ request }) => runtime.fetch(request)));
  return { controller, backend };
}

async function pay(stableKey) {
  const ctx = createExecutionContext();
  const headers = stableKey ? { "x-cloudfault-stable-idempotency": "1" } : undefined;
  const response = await worker.fetch(new Request("https://checkout.test/orders/812/pay", {
    method: "POST",
    headers,
  }), {}, ctx);
  await waitOnExecutionContext(ctx);
  return { response, body: await response.json() };
}

function observedKeys(controller) {
  return controller.history.snapshot()
    .filter((event) => event.type === "invoke" && event.operation?.target === "stripe")
    .map((event) => event.value?.idempotencyKey)
    .filter((value) => typeof value === "string");
}

describe("CloudFault provider semantics inside the Workers runtime", () => {
  it("reproduces a duplicate financial effect after an ambiguous non-idempotent retry", async () => {
    const { controller, backend } = installStripeRuntime([ambiguous]);
    const result = await pay(false);
    const snapshot = backend.snapshot();

    expect(result.response.status).toBe(200);
    expect(snapshot.successfulCharges).toBe(2);
    expect(new Set(observedKeys(controller)).size).toBe(2);
    expect(controller.history.snapshot().some((event) =>
      event.type === "info" && event.outcome?.actual === "committed" && event.outcome?.observed === "indeterminate"
    )).toBe(true);
  });

  it("makes the same ambiguous retry safe with a stable provider idempotency key", async () => {
    const { controller, backend } = installStripeRuntime([ambiguous]);
    const result = await pay(true);
    const snapshot = backend.snapshot();
    const keys = observedKeys(controller);

    expect(result.response.status).toBe(200);
    expect(result.body.stableKey).toBe(true);
    expect(keys).toEqual(["order:812:payment", "order:812:payment"]);
    expect(snapshot.idempotencyKeys).toHaveLength(1);
    expect(snapshot.successfulCharges).toBe(1);
  });
});

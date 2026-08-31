import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import {
  ScenarioController,
  invariant,
  runCheckers,
} from "@cloudfault/core";
import {
  AdapterRegistry,
  commitThenTimeout,
} from "@cloudfault/adapter-sdk";
import { createMswNodeAdapterServer } from "@cloudfault/cloudflare";
import { StripeMemoryBackend, stripeAdapter } from "@cloudfault/stripe";

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(here, "worker", "wrangler.jsonc");

export const ambiguousStripeCreate = commitThenTimeout({
  id: "stripe:payment_intent.create:commit-timeout:first",
  target: "stripe",
  operation: "payment_intent.create",
  description: "Stripe commits the PaymentIntent, but the first response is lost",
  selector: { occurrence: 1 },
});

export const cloudfault = {
  name: "outbound-stripe/ambiguous-payment",
  faultPoints: [
    { id: "stripe-create-outcome", target: "stripe", choices: [ambiguousStripeCreate] },
  ],
  maxDepth: 1,
  replay: {
    module: "./examples/outbound-stripe/scenario.mjs",
    exportName: "runScenario",
    testName: "outbound-stripe",
  },
  execute: runScenario,
};

function normalizeScenario(input) {
  if (Array.isArray(input)) {
    return {
      id: input.length ? input.map((item) => item.id).join("+") : "baseline",
      perturbations: input,
    };
  }
  if (input?.perturbations) return input;
  return { id: "baseline", perturbations: [] };
}

export async function runScenario(input = { id: "baseline", perturbations: [] }, options = {}) {
  const scenario = normalizeScenario(input);
  const controller = new ScenarioController(scenario);
  const registry = new AdapterRegistry().register(stripeAdapter);
  const stripe = new StripeMemoryBackend();
  const network = await createMswNodeAdapterServer({
    registry,
    controller,
    upstream: (request) => stripe.fetch(request),
    onUnhandledRequest: "error",
  });
  const harness = createTestHarness({ workers: [{ configPath }] });
  const started = performance.now();
  const appOperation = controller.begin({
    id: "outbound-pay-order-812",
    name: "pay",
    process: "client-1",
    target: "app",
    resource: "order:812",
  });

  network.listen();
  try {
    await harness.listen();
    const app = harness.getWorker("cloudfault-outbound-stripe-app");
    const headers = options.stableKey ? { "x-cloudfault-stable-idempotency": "1" } : undefined;
    const response = await app.fetch("https://checkout.example/orders/812/pay", { method: "POST", headers });
    const body = await response.json();
    const stripeState = stripe.snapshot();
    const state = {
      responseStatus: response.status,
      response: body,
      stripe: stripeState,
      charges: stripeState.successfulCharges,
      stableKey: body?.stableKey === true,
    };
    controller.complete(appOperation, response.ok ? "ok" : "fail", state, {
      actual: response.ok ? "committed" : "unknown",
      observed: response.ok ? "success" : "definite-failure",
    });

    const checks = await runCheckers([
      invariant(
        "at-most-one-stripe-charge",
        ({ state: checked }) => checked.charges <= 1,
        ({ state: checked }) => `Expected <=1 Stripe charge, observed ${checked.charges}`,
      ),
    ], { history: controller.history.snapshot(), state });

    return {
      scenario,
      history: controller.history.snapshot(),
      checks,
      state,
      durationMs: performance.now() - started,
    };
  } finally {
    network.close();
    await harness.close();
  }
}

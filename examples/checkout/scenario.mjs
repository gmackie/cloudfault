import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { History, invariant, runCheckers } from "@cloudfault/core";
import { applyScenarioToNemesisBindings, resetNemesisBindings, staleKvRead } from "@cloudfault/cloudflare";
import { commitThenTimeout } from "@cloudfault/adapter-sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const worker = (name) => path.join(here, "workers", name, "wrangler.jsonc");

export const stale = staleKvRead("ORDER_STATE", { region: "FRA", key: "order:812", versionsBehind: 1 });
export const ambiguous = commitThenTimeout({
  id: "PAYMENTS:charge:commit-timeout",
  target: "PAYMENTS",
  operation: "charge",
  description: "payment service commits a charge but the Worker observes a timeout",
});


const nemesisBindings = [
  { target: "ORDER_STATE", worker: "cloudfault-kv-nemesis", kind: "kv" },
  { target: "FULFILLMENT", worker: "cloudfault-queue-nemesis", kind: "queue" },
  {
    target: "PAYMENTS",
    worker: "cloudfault-payment-nemesis",
    kind: "service",
    operations: { charge: { method: "POST", path: "/charge" } },
  },
];

export const cloudfault = {
  name: "checkout/stale-kv+ambiguous-payment",
  faultPoints: [
    { id: "order-state-visibility", target: "ORDER_STATE", choices: [stale] },
    { id: "payment-outcome", target: "PAYMENTS", choices: [ambiguous] },
  ],
  maxDepth: 2,
  replay: { module: "./examples/checkout/scenario.mjs", exportName: "runScenario", testName: "checkout" },
  execute: runScenario,
};

function normalizeScenario(input) {
  if (Array.isArray(input)) return { id: input.length ? input.map((item) => item.id).join("+") : "baseline", perturbations: input };
  if (input?.perturbations) return input;
  return { id: "baseline", perturbations: [] };
}

/** Execute one scenario against production-shaped Workers inside workerd. */
export async function runScenario(input = { id: "baseline", perturbations: [] }) {
  const scenario = normalizeScenario(input);
  const perturbations = scenario.perturbations;
  const ids = new Set(perturbations.map((item) => item.id));
  const harness = createTestHarness({
    workers: [
      {
        configPath: worker("app"),
        bindingOverrides: {
          ORDER_STATE: "cloudfault-kv-nemesis",
          FULFILLMENT: "cloudfault-queue-nemesis",
          PAYMENTS: "cloudfault-payment-nemesis",
        },
      },
      { configPath: worker("payments") },
      { configPath: worker("payment-nemesis") },
      { configPath: worker("kv-nemesis") },
      { configPath: worker("queue-nemesis") },
    ],
  });

  const history = new History();
  const checkout = { id: "checkout-812", name: "checkout", process: "client-1", target: "app", resource: "order:812" };
  history.invoke(checkout);
  const started = performance.now();

  try {
    await harness.listen();
    const app = harness.getWorker("cloudfault-checkout-app");
    await app.applyD1Migrations("DB");

    const kv = await harness.getWorker("cloudfault-kv-nemesis").getExport();
    const payments = await harness.getWorker("cloudfault-payment-worker").getExport();
    const paymentNemesis = await harness.getWorker("cloudfault-payment-nemesis").getExport();
    const queue = await harness.getWorker("cloudfault-queue-nemesis").getExport();

    await resetNemesisBindings(harness, nemesisBindings);
    await payments.reset();
    await kv.seed("order:812", "PENDING");
    await kv.seedVersion("order:812", "PAID");
    await applyScenarioToNemesisBindings(harness, scenario, nemesisBindings);

    const response = await app.fetch("https://checkout.example/orders/812/checkout", { method: "POST" });
    const body = await response.json();
    const paymentState = await payments.snapshot();
    const kvState = await kv.snapshot();
    const queueState = await queue.snapshot();
    const nemesisEvents = await paymentNemesis.events();

    if (ids.has(stale.id) && kvState.events.some((event) => event.type === "semantic")) history.perturb(stale, checkout);
    if (ids.has(ambiguous.id) && nemesisEvents.some((event) => event.type === "fault")) history.perturb(ambiguous, checkout);

    const state = {
      responseStatus: response.status,
      response: body,
      charges: paymentState.charges.length,
      queueMessages: queueState.messages.length,
      paymentState,
      kvState,
      nemesisEvents,
    };
    history.complete(checkout, response.ok ? "ok" : "fail", state, {
      actual: response.ok ? "committed" : "unknown",
      observed: response.ok ? "success" : "definite-failure",
    });
    const checks = await runCheckers([
      invariant("at-most-one-new-charge", ({ state }) => state.charges <= 1, ({ state }) => `Expected <=1 new charge, observed ${state.charges}`),
      invariant("one-fulfillment-per-successful-checkout", ({ state }) => !state.response.charged || state.queueMessages === 1),
    ], { history: history.snapshot(), state });

    return { scenario, history: history.snapshot(), checks, state, durationMs: performance.now() - started };
  } finally {
    await harness.close();
  }
}

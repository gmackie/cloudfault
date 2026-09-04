import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const core = await import(pathToFileURL(path.join(process.cwd(), "packages/core/dist/index.js")));
const capabilities = await import(pathToFileURL(path.join(process.cwd(), "packages/adapter-sdk/dist/capabilities.js")));
const shrink = await import(pathToFileURL(path.join(process.cwd(), "packages/fast-check/dist/shrink.js")));

const TARGET = "WEBHOOKS";

const event = (id, type, payload = {}) => ({ id, type, payload });

/**
 * The workload a payment webhook actually produces: several *related* events
 * about one order, in a meaningful order. Against a single event neither
 * `webhook-reorder` nor `webhook-delay` says anything at all.
 */
const ORDER_EVENTS = [
  event("evt_1", "order.created", { order: "o1" }),
  event("evt_2", "order.paid", { order: "o1", amount: 500 }),
  event("evt_3", "order.fulfilled", { order: "o1" }),
];

/** An order projection that is order-dependent and idempotency-aware. */
function ledger({ idempotent = true } = {}) {
  const state = { status: "none", charges: 0, seen: new Set(), errors: [] };
  return {
    state,
    apply(delivery) {
      const { event: emitted } = delivery;
      if (idempotent && state.seen.has(emitted.id)) return { applied: false };
      state.seen.add(emitted.id);
      if (emitted.type === "order.created") state.status = "created";
      if (emitted.type === "order.paid") {
        if (state.status !== "created") state.errors.push(`paid before created (${emitted.id})`);
        state.status = "paid";
        state.charges += 1;
      }
      if (emitted.type === "order.fulfilled") state.status = "fulfilled";
      return { applied: true };
    },
  };
}

async function run(perturbations, options = {}) {
  const controller = new core.ScenarioController({ id: "events", perturbations });
  const app = ledger(options);
  const result = await core.runEventWorkload({
    controller,
    events: options.events ?? ORDER_EVENTS,
    target: TARGET,
    deliver: ({ delivery }) => app.apply(delivery),
  });
  return { controller, app, result };
}

test("a multi-event workload delivers in creation order by default", async () => {
  const { controller, app, result } = await run([]);

  assert.deepEqual(result.plan.deliveries.map((d) => d.event.id), ["evt_1", "evt_2", "evt_3"]);
  assert.equal(app.state.status, "fulfilled");
  assert.deepEqual(app.state.errors, []);

  const checks = await core.runCheckers(
    [core.checkDeliveryOrder(), core.checkDeliveryUniqueness(), core.checkDeliveryCompleteness(ORDER_EVENTS)],
    { history: controller.history.snapshot(), state: app.state },
  );
  assert.deepEqual(checks.map((c) => c.valid), [true, true, true]);
});

test("delaying one event of several is what reordering actually is", async () => {
  // Delay the FIRST event. With three events in flight it now arrives last,
  // which is a legal at-least-once/unordered delivery and a broken projection.
  const { controller, app, result } = await run([capabilities.eventDelay(TARGET, "evt_1", 10)]);

  assert.deepEqual(result.plan.deliveries.map((d) => d.event.id), ["evt_2", "evt_3", "evt_1"]);
  assert.deepEqual(app.state.errors, ["paid before created (evt_2)"]);

  const [order] = await core.runCheckers([core.checkDeliveryOrder()], {
    history: controller.history.snapshot(),
    state: app.state,
  });
  assert.equal(order.valid, false);
  assert.deepEqual(order.details.observed, ["evt_2", "evt_3", "evt_1"]);
  assert.deepEqual(order.details.inversions, [{ before: "evt_3", after: "evt_1" }]);
});

test("a scoped reorder moves exactly one event past its successor", async () => {
  const { result } = await run([capabilities.eventReorder(TARGET, "evt_1", 1)]);
  assert.deepEqual(result.plan.deliveries.map((d) => d.event.id), ["evt_2", "evt_1", "evt_3"]);
});

test("duplicate delivery is legal; duplicate application is the bug", async () => {
  const duplicate = capabilities.eventDuplicate(TARGET, "evt_2", 1);

  const idempotent = await run([duplicate], { idempotent: true });
  assert.deepEqual(idempotent.result.plan.deliveries.map((d) => d.event.id), ["evt_1", "evt_2", "evt_2", "evt_3"]);
  assert.equal(idempotent.app.state.charges, 1);
  const okChecks = await core.runCheckers([core.checkDeliveryUniqueness(), core.checkDeliveryCompleteness(ORDER_EVENTS)], {
    history: idempotent.controller.history.snapshot(),
    state: idempotent.app.state,
  });
  assert.deepEqual(okChecks.map((c) => c.valid), [true, true], "an idempotent handler survives the same deliveries");

  const naive = await run([duplicate], { idempotent: false });
  assert.equal(naive.app.state.charges, 2);
  const [uniqueness] = await core.runCheckers([core.checkDeliveryUniqueness()], {
    history: naive.controller.history.snapshot(),
    state: naive.app.state,
  });
  assert.equal(uniqueness.valid, false);
  assert.match(uniqueness.message, /evt_2x2/);
  // The delivery count is identical in both runs. Only `applied` differs, which
  // is why the trace records it separately.
  assert.equal(uniqueness.details.deliveries.evt_2, 2);
});

test("delivery perturbations are activated through the controller so they can be minimized", async () => {
  const { controller } = await run([
    capabilities.eventDelay(TARGET, "evt_1", 10),
    capabilities.eventDuplicate(TARGET, "evt_3", 1),
  ]);
  const activations = controller.activations().map((a) => a.perturbationId);
  assert.deepEqual(activations, [`${TARGET}:evt_1:webhook-delay`, `${TARGET}:evt_3:webhook-duplicate`]);
  // And they show up as `fault` events attached to the event they perturbed.
  const faults = controller.history.snapshot().filter((e) => e.type === "fault");
  assert.deepEqual(faults.map((e) => e.operation.resource), ["evt_1", "evt_3"]);
});

test("the minimal workload still shrinks: six events reduce to the pair that matters", async () => {
  const noise = [
    event("evt_0", "order.note"),
    event("evt_1", "order.created", { order: "o1" }),
    event("evt_x", "order.note"),
    event("evt_2", "order.paid", { order: "o1", amount: 500 }),
    event("evt_y", "order.note"),
    event("evt_3", "order.fulfilled", { order: "o1" }),
  ];
  const perturbations = [capabilities.eventDelay(TARGET, "evt_1", 100)];

  // The bug is "events were applied out of creation order", read off the
  // history by the checker rather than guessed at from application state -- so
  // a workload of one event cannot reproduce it, and neither can any workload
  // without the delay.
  const reproduces = async (workload) => {
    if (!workload.length) return false;
    const { controller, app } = await run(perturbations, { events: workload });
    const [order] = await core.runCheckers([core.checkDeliveryOrder()], {
      history: controller.history.snapshot(),
      state: app.state,
    });
    return !order.valid;
  };

  assert.equal(await reproduces(noise), true);
  assert.equal(await reproduces([noise[3]]), false, "a single event cannot be out of order");
  const result = await shrink.shrinkSequence(noise, reproduces);

  // Delta debugging finds *a* 1-minimal witness, not a canonical one: the
  // delayed event plus any single event it can now overtake is a valid answer.
  // The property worth asserting is the minimality, not the identity.
  assert.equal(result.minimal.length, 2, `minimal workload was ${JSON.stringify(result.minimal.map((e) => e.id))}`);
  assert.equal(result.minimal[0].id, "evt_1", "the delayed event must survive shrinking");
  for (let index = 0; index < result.minimal.length; index += 1) {
    const without = result.minimal.filter((_e, position) => position !== index);
    assert.equal(await reproduces(without), false, "the witness is 1-minimal");
  }
  assert.ok(result.attempts > 1);
});

test("the combined counterexample shrinker reduces faults and workload together", async () => {
  const events = [
    event("evt_1", "order.created", { order: "o1" }),
    event("evt_2", "order.paid", { order: "o1", amount: 500 }),
    event("evt_3", "order.fulfilled", { order: "o1" }),
  ];
  const candidates = [
    capabilities.eventDelay(TARGET, "evt_1", 100),
    capabilities.eventDuplicate(TARGET, "evt_3", 1),
    capabilities.eventReorder(TARGET, "evt_3", 1),
  ];

  const reproduces = async ({ perturbations, workload }) => {
    if (!workload.length) return false;
    const { controller, app } = await run(perturbations, { events: workload });
    const [order] = await core.runCheckers([core.checkDeliveryOrder()], {
      history: controller.history.snapshot(),
      state: app.state,
    });
    return !order.valid;
  };

  const result = await shrink.shrinkCounterexample(candidates, events, reproduces);
  assert.deepEqual(result.perturbations.map((p) => p.id), [`${TARGET}:evt_1:webhook-delay`]);
  assert.equal(result.workload.length, 2);
  assert.equal(result.workload[0].id, "evt_1");
  assert.equal(await reproduces({ perturbations: [], workload: result.workload }), false, "the fault is required");
});

test("planEventDeliveries orders by arrival time and keeps creation order on ties", () => {
  const modifiers = new Map([
    ["b", { duplicates: 1, delayMs: 0, movePositions: 0, reverseAll: false, causes: ["dup"] }],
  ]);
  const plan = core.planEventDeliveries(
    [event("a", "t"), event("b", "t"), event("c", "t")],
    modifiers,
  );
  assert.deepEqual(plan.deliveries.map((d) => `${d.event.id}#${d.attempt}`), ["a#1", "b#1", "b#2", "c#1"]);
  assert.deepEqual(plan.deliveries.map((d) => d.position), [0, 1, 2, 3]);
  assert.deepEqual(plan.activated, ["dup"]);
});

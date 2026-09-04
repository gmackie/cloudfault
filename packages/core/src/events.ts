import type { ScenarioController } from "./controller.js";
import type { Checker } from "./checker.js";
import type { CheckResult, HistoryEvent, OperationRef, Perturbation } from "./types.js";

/**
 * Multi-event workloads.
 *
 * `webhook-reorder` and `webhook-delay` are meaningless against a workload that
 * emits one event: there is nothing to reorder it against and nothing for a
 * delay to arrive after. Both only become faults once a workload emits several
 * *related* events, so this module supplies the missing half — an event
 * sequence, a perturbation-driven delivery plan, and checkers that reason about
 * the resulting order and duplication.
 *
 * The workload stays a plain array of events, so `shrinkSequence()` can still
 * delta-debug it down to the minimal pair that exposes a bug.
 */

export interface DeliverableEvent<T = unknown> {
  id: string;
  type: string;
  payload: T;
  /** Logical creation time. Defaults to the event's index, giving a stable order. */
  createdAt?: number;
}

export interface EventDelivery<T = unknown> {
  deliveryId: string;
  event: DeliverableEvent<T>;
  /** 1-based attempt for this event. Attempt > 1 is a duplicate delivery. */
  attempt: number;
  /** 0-based position in creation order. */
  sourceIndex: number;
  /** 0-based position in the order actually delivered. */
  position: number;
  /** Logical arrival time, which is what reordering actually comes from. */
  deliverAt: number;
  /** Perturbations that shaped this delivery, for the failure report. */
  causes: readonly string[];
}

/** What a handler may report so the checkers can tell delivery from effect. */
export interface DeliveryOutcome {
  /**
   * Did this delivery change application state? An idempotent handler returns
   * `false` for a duplicate it recognised. Anything that is not explicitly
   * `false` counts as applied.
   */
  applied?: boolean;
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- *
 * Plan
 * -------------------------------------------------------------------------- */

/**
 * Delivery-phase perturbation kinds this planner understands. The names match
 * `webhookFaults()` in the adapter SDK; the second name in each pair is the
 * provider-neutral alias, so Queue and Scheduled deliveries can use the same
 * planner without pretending to be webhooks.
 */
const DUPLICATE_KINDS = new Set(["webhook-duplicate", "duplicate-delivery"]);
const DELAY_KINDS = new Set(["webhook-delay", "delivery-delay"]);
const REORDER_KINDS = new Set(["webhook-reorder", "delivery-reorder"]);

interface EventModifiers {
  duplicates: number;
  delayMs: number;
  movePositions: number;
  reverseAll: boolean;
  causes: string[];
}

function emptyModifiers(): EventModifiers {
  return { duplicates: 0, delayMs: 0, movePositions: 0, reverseAll: false, causes: [] };
}

function applyPerturbation(modifiers: EventModifiers, perturbation: Perturbation): void {
  const metadata = perturbation.metadata ?? {};
  if (DUPLICATE_KINDS.has(perturbation.kind)) {
    modifiers.duplicates += Number(metadata.duplicates ?? 1);
  } else if (DELAY_KINDS.has(perturbation.kind)) {
    modifiers.delayMs += Number(metadata.delayMs ?? 1);
  } else if (REORDER_KINDS.has(perturbation.kind)) {
    // A reorder scoped to one event moves that event later; an unscoped one
    // reverses the whole batch, which is what `planWebhookDeliveries` has
    // always meant by `reorder: true`.
    if (perturbation.selector?.resource) modifiers.movePositions += Number(metadata.positions ?? 1);
    else modifiers.reverseAll = true;
  } else {
    return;
  }
  modifiers.causes.push(perturbation.id);
}

export interface DeliveryPlan<T = unknown> {
  deliveries: readonly EventDelivery<T>[];
  /** Perturbation ids that shaped the plan, in activation order. */
  activated: readonly string[];
}

/**
 * Expand logical events into delivery attempts under a set of already-activated
 * delivery-phase perturbations.
 *
 * Order comes out of arrival time rather than being asserted separately:
 * delaying one event of several is *how* reordering happens in practice, so a
 * `webhook-delay` on event 1 of 3 genuinely lands it after events 2 and 3.
 */
export function planEventDeliveries<T>(
  events: readonly DeliverableEvent<T>[],
  perEvent: ReadonlyMap<string, EventModifiers>,
): DeliveryPlan<T> {
  const activated: string[] = [];
  let reverseAll = false;
  const expanded: EventDelivery<T>[] = [];

  events.forEach((event, sourceIndex) => {
    const modifiers = perEvent.get(event.id) ?? emptyModifiers();
    activated.push(...modifiers.causes);
    if (modifiers.reverseAll) reverseAll = true;
    const createdAt = event.createdAt ?? sourceIndex;
    // A move of N lands the event a half-step past the Nth following event, so
    // it arrives strictly after it rather than tying with it and being pulled
    // back by the stable sort.
    const shift = modifiers.movePositions === 0 ? 0 : modifiers.movePositions + 0.5;
    for (let copy = 0; copy <= modifiers.duplicates; copy += 1) {
      expanded.push({
        deliveryId: `${event.id}:delivery:${copy + 1}`,
        event,
        attempt: copy + 1,
        sourceIndex,
        position: -1,
        deliverAt: createdAt + modifiers.delayMs + shift,
        causes: [...modifiers.causes],
      });
    }
  });

  // Stable by arrival time, so equal times preserve creation order.
  const ordered = expanded
    .map((delivery, index) => ({ delivery, index }))
    .sort((a, b) => a.delivery.deliverAt - b.delivery.deliverAt || a.index - b.index)
    .map((entry) => entry.delivery);
  if (reverseAll) ordered.reverse();

  return {
    deliveries: ordered.map((delivery, position) => ({ ...delivery, position })),
    activated: [...new Set(activated)],
  };
}

/* -------------------------------------------------------------------------- *
 * Run
 * -------------------------------------------------------------------------- */

export interface EventWorkloadContext<T, State> {
  delivery: EventDelivery<T>;
  controller: ScenarioController;
  state: State;
  operation: OperationRef;
}

export interface EventWorkloadOptions<T, State, R extends DeliveryOutcome | void> {
  controller: ScenarioController;
  events: readonly DeliverableEvent<T>[];
  state?: State;
  deliver(context: EventWorkloadContext<T, State>): Promise<R> | R;
  /** Logical target the delivery perturbations are addressed to. */
  target?: string;
  process?: string | number;
  /** Logical operation name for one delivery attempt. */
  operationName?: string;
  /** Sleep for the modelled delay instead of only using it to order arrivals. */
  realDelays?: boolean;
}

export interface DeliveryResult<T, R> {
  delivery: EventDelivery<T>;
  status: "ok" | "fail";
  value?: R;
  error?: unknown;
}

export interface EventWorkloadResult<T, R> {
  plan: DeliveryPlan<T>;
  results: readonly DeliveryResult<T, R>[];
}

const DEFAULT_TARGET = "EVENTS";
const DEFAULT_OPERATION = "event.deliver";

/**
 * Emit several related events and deliver them under the scenario's
 * delivery-phase perturbations.
 *
 * One `event.emit` operation is begun per logical event so delivery
 * perturbations can be addressed by `selector.resource` (the event id) and
 * activated through the controller — which is what keeps them visible to the
 * activation log, the MFS reducer and the causal report. Each delivery attempt
 * is then a child operation of its event, so duplicates and reorderings show up
 * as lineage rather than as loose history noise.
 */
export async function runEventWorkload<T, State = undefined, R extends DeliveryOutcome | void = DeliveryOutcome>(
  options: EventWorkloadOptions<T, State, R>,
): Promise<EventWorkloadResult<T, R>> {
  const controller = options.controller;
  const target = options.target ?? DEFAULT_TARGET;
  const process = options.process ?? "delivery";
  const operationName = options.operationName ?? DEFAULT_OPERATION;

  const perEvent = new Map<string, EventModifiers>();
  const eventOperations = new Map<string, OperationRef>();

  for (const event of options.events) {
    const emit = controller.begin({
      id: `event:${event.id}`,
      name: "event.emit",
      process,
      target,
      resource: event.id,
    }, { type: event.type });
    eventOperations.set(event.id, emit);

    const modifiers = emptyModifiers();
    for (const perturbation of controller.eligible(emit, "delivery")) {
      controller.activate(perturbation, emit);
      applyPerturbation(modifiers, perturbation);
    }
    perEvent.set(event.id, modifiers);
    controller.complete(emit, "ok", { causes: modifiers.causes }, {
      observed: "success",
      // Emitting is a local act; it says nothing about any provider commit.
      actualSource: "unknown",
      actual: "unknown",
    });
  }

  const plan = planEventDeliveries(options.events, perEvent);
  const results: DeliveryResult<T, R>[] = [];

  for (const delivery of plan.deliveries) {
    if (options.realDelays && delivery.deliverAt > delivery.sourceIndex) {
      await new Promise((resolve) => setTimeout(resolve, delivery.deliverAt - delivery.sourceIndex));
    }
    const operation = controller.begin({
      id: delivery.deliveryId,
      name: operationName,
      process,
      target,
      resource: delivery.event.id,
      parentId: eventOperations.get(delivery.event.id)?.id,
      attempt: delivery.attempt,
    }, {
      eventId: delivery.event.id,
      type: delivery.event.type,
      attempt: delivery.attempt,
      sourceIndex: delivery.sourceIndex,
      position: delivery.position,
    });

    try {
      const value = await options.deliver({
        delivery,
        controller,
        state: options.state as State,
        operation,
      });
      const applied = !(value && typeof value === "object" && (value as DeliveryOutcome).applied === false);
      controller.complete(operation, "ok", {
        eventId: delivery.event.id,
        attempt: delivery.attempt,
        sourceIndex: delivery.sourceIndex,
        position: delivery.position,
        applied,
      }, { observed: "success" });
      results.push({ delivery, status: "ok", value });
    } catch (error) {
      controller.complete(operation, "fail", {
        eventId: delivery.event.id,
        attempt: delivery.attempt,
        sourceIndex: delivery.sourceIndex,
        position: delivery.position,
        applied: false,
        error: error instanceof Error ? error.message : String(error),
      }, { observed: "definite-failure" });
      results.push({ delivery, status: "fail", error });
    }
  }

  return { plan, results };
}

/* -------------------------------------------------------------------------- *
 * Checkers
 * -------------------------------------------------------------------------- */

export interface DeliveryObservation {
  eventId: string;
  attempt: number;
  sourceIndex: number;
  position: number;
  applied: boolean;
  status: "ok" | "fail";
}

/** Project the delivery completions out of a history, in the order they happened. */
export function deliveryTrace(
  history: readonly HistoryEvent[],
  operationName = DEFAULT_OPERATION,
): readonly DeliveryObservation[] {
  const trace: DeliveryObservation[] = [];
  for (const event of history) {
    if (event.operation?.name !== operationName) continue;
    if (event.type !== "ok" && event.type !== "fail") continue;
    const value = (event.value ?? {}) as Record<string, unknown>;
    trace.push({
      eventId: String(value.eventId ?? event.operation.resource ?? ""),
      attempt: Number(value.attempt ?? event.operation.attempt ?? 1),
      sourceIndex: Number(value.sourceIndex ?? -1),
      position: Number(value.position ?? -1),
      applied: value.applied !== false,
      status: event.type,
    });
  }
  return trace;
}

export interface DeliveryCheckerOptions {
  name?: string;
  operation?: string;
  /** Only consider deliveries whose event id passes. Defaults to all. */
  include?: (observation: DeliveryObservation) => boolean;
}

/**
 * Were the events *applied* in creation order?
 *
 * Only applied deliveries count: an idempotent handler that recognises and
 * discards a duplicate has not reordered anything. Failing this means the
 * application's state depends on delivery order and the provider does not
 * guarantee one.
 */
export function checkDeliveryOrder<State = unknown>(options: DeliveryCheckerOptions = {}): Checker<State> {
  const name = options.name ?? "delivery-order-preserved";
  return {
    name,
    check({ history }): CheckResult {
      const applied = deliveryTrace(history, options.operation)
        .filter((observation) => observation.status === "ok" && observation.applied)
        .filter((observation) => options.include?.(observation) ?? true);
      const inversions: Array<{ before: string; after: string }> = [];
      for (let index = 1; index < applied.length; index += 1) {
        const previous = applied[index - 1]!;
        const current = applied[index]!;
        if (current.sourceIndex < previous.sourceIndex) {
          inversions.push({ before: previous.eventId, after: current.eventId });
        }
      }
      if (inversions.length === 0) {
        return { valid: true, checker: name, details: { applied: applied.length } };
      }
      return {
        valid: false,
        checker: name,
        message: `${inversions.length} event(s) were applied out of creation order`,
        details: { inversions, observed: applied.map((observation) => observation.eventId) },
      };
    },
  };
}

/**
 * Was any single logical event applied more than once?
 *
 * Duplicate *delivery* is legal — at-least-once is what these providers promise.
 * Duplicate *application* is the bug. Separating the two is the entire reason
 * the delivery trace records `applied` rather than just counting attempts.
 */
export function checkDeliveryUniqueness<State = unknown>(options: DeliveryCheckerOptions = {}): Checker<State> {
  const name = options.name ?? "each-event-applied-at-most-once";
  return {
    name,
    check({ history }): CheckResult {
      const counts = new Map<string, number>();
      const deliveries = new Map<string, number>();
      for (const observation of deliveryTrace(history, options.operation)) {
        if (!(options.include?.(observation) ?? true)) continue;
        deliveries.set(observation.eventId, (deliveries.get(observation.eventId) ?? 0) + 1);
        if (observation.status === "ok" && observation.applied) {
          counts.set(observation.eventId, (counts.get(observation.eventId) ?? 0) + 1);
        }
      }
      const repeated = [...counts.entries()].filter(([, count]) => count > 1);
      if (repeated.length === 0) {
        return {
          valid: true,
          checker: name,
          details: { events: counts.size, deliveries: [...deliveries.values()].reduce((a, b) => a + b, 0) },
        };
      }
      return {
        valid: false,
        checker: name,
        message: `${repeated.length} event(s) were applied more than once: ${repeated.map(([id, count]) => `${id}x${count}`).join(", ")}`,
        details: { repeated: Object.fromEntries(repeated), deliveries: Object.fromEntries(deliveries) },
      };
    },
  };
}

/**
 * Did every emitted event get applied at least once?
 *
 * The counterpart to uniqueness: a handler that swallows a delivery it should
 * have processed loses the event entirely, which duplicate-detection alone will
 * happily call a success.
 */
export function checkDeliveryCompleteness<State = unknown>(
  events: readonly DeliverableEvent<unknown>[],
  options: DeliveryCheckerOptions = {},
): Checker<State> {
  const name = options.name ?? "every-event-applied";
  return {
    name,
    check({ history }): CheckResult {
      const applied = new Set(
        deliveryTrace(history, options.operation)
          .filter((observation) => observation.status === "ok" && observation.applied)
          .map((observation) => observation.eventId),
      );
      const missing = events.map((event) => event.id).filter((id) => !applied.has(id));
      if (missing.length === 0) return { valid: true, checker: name, details: { applied: applied.size } };
      return {
        valid: false,
        checker: name,
        message: `${missing.length} event(s) were never applied: ${missing.join(", ")}`,
        details: { missing },
      };
    },
  };
}

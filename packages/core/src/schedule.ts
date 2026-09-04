import type { ScenarioController } from "./controller.js";
import type { CheckResult, SemanticVariation } from "./types.js";

/**
 * Bounded deterministic interleaving exploration.
 *
 * ## What this is, and what it deliberately is not
 *
 * CloudFault records the interleaving that happened. It does not enumerate the
 * interleavings that could have happened, and building something that does — a
 * model checker over a JavaScript runtime — is research-grade work that this
 * module does not attempt.
 *
 * What it does instead is the useful bounded fragment: **actors declare their
 * own suspension points, and every ordering of those declared points is
 * enumerated and replayed deterministically.** That is enough to find the
 * canonical concurrency bug in a Workers application — two callers that both
 * read a guard before either writes it — and it is enough to prove the fixed
 * version survives every ordering rather than merely surviving the ordering
 * that happened to occur.
 *
 * ## The honest limitations
 *
 * 1. **Only declared points.** A suspension the author did not mark with
 *    `yield()` is invisible. Every real `await` is a suspension point; this
 *    explores the ones you named. It is a scoped model, not a sound one: it
 *    finds bugs, it does not prove their absence.
 * 2. **No partial-order reduction.** Independent operations are interleaved
 *    anyway, so the schedule count is C(n+m, n) for two actors and grows
 *    multinomially beyond that. `maxSchedules` (default 64) is a hard bound,
 *    and `truncated` says when it bit.
 * 3. **Yield counts are discovered by a probe run.** An actor whose number of
 *    suspension points depends on what it observed can diverge from the planned
 *    schedule. That is detected and reported (`divergent`), never silently
 *    accepted as if the plan had been followed.
 * 4. **One process.** This schedules cooperating async actors inside a single
 *    JavaScript isolate. It does not model two workerd isolates, two colos, or
 *    the storage layer's own concurrency.
 *
 * Within those bounds it is deterministic and replayable: a failing schedule is
 * a plain array of actor names, so it minimizes and re-runs like any other
 * witness.
 */

/** The order in which actors are released, one entry per suspension point. */
export type Schedule = readonly string[];

export interface ActorContext {
  readonly name: string;
  /**
   * Declare a suspension point. Resolves when the schedule releases this actor.
   * Everything between two `yield()` calls runs without interruption from
   * another actor.
   */
  yield(label?: string): Promise<void>;
}

export interface ScheduledActor<R = unknown> {
  name: string;
  run(context: ActorContext): Promise<R> | R;
}

export interface ActorResult<R = unknown> {
  name: string;
  status: "ok" | "fail";
  value?: R;
  error?: unknown;
}

export interface InterleavingRun<R = unknown> {
  schedule: Schedule;
  /** The order actors were actually released in. Differs from `schedule` only when divergent. */
  observed: Schedule;
  /** Labels passed to `yield()`, in release order, for reading a failing schedule. */
  labels: readonly string[];
  results: readonly ActorResult<R>[];
  /** True when an actor's suspension points did not match the plan. */
  divergent: boolean;
}

class InterleavingDeadlockError extends Error {
  constructor(schedule: Schedule, waiting: readonly string[]) {
    super(
      `Interleaving [${schedule.join(", ")}] deadlocked: ${waiting.join(", ")} never reached a suspension point `
      + "or completed. An actor is probably waiting on work that only another actor can perform.",
    );
    this.name = "InterleavingDeadlockError";
  }
}

interface ParkedActor {
  resume: () => void;
  label: string;
}

class Scheduler {
  readonly #parked = new Map<string, ParkedActor>();
  readonly #done = new Set<string>();
  readonly #names: readonly string[];
  #wake?: () => void;

  constructor(names: readonly string[]) {
    this.#names = names;
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  #settled(): Promise<void> {
    return new Promise<void>((resolve) => { this.#wake = resolve; });
  }

  park(name: string, label: string): Promise<void> {
    return new Promise<void>((resume) => {
      this.#parked.set(name, { resume, label });
      this.#signal();
    });
  }

  finish(name: string): void {
    this.#done.add(name);
    this.#parked.delete(name);
    this.#signal();
  }

  /** Wait until every actor is either parked at a suspension point or finished. */
  async quiesce(timeoutMs: number, schedule: Schedule): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.#names.some((name) => !this.#parked.has(name) && !this.#done.has(name))) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new InterleavingDeadlockError(
          schedule,
          this.#names.filter((name) => !this.#parked.has(name) && !this.#done.has(name)),
        );
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.#settled(),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); }),
      ]);
      if (timer) clearTimeout(timer);
    }
  }

  ready(): readonly string[] {
    return this.#names.filter((name) => this.#parked.has(name));
  }

  release(name: string): string {
    const parked = this.#parked.get(name);
    if (!parked) throw new Error(`Actor '${name}' is not parked`);
    this.#parked.delete(name);
    parked.resume();
    return parked.label;
  }

  allDone(): boolean {
    return this.#names.every((name) => this.#done.has(name));
  }
}

export interface RunInterleavingOptions {
  /** Milliseconds to wait for actors to reach a suspension point. */
  timeoutMs?: number;
}

/**
 * Run a set of actors under one schedule.
 *
 * At most one actor runs at a time, and the code between two `yield()` calls is
 * atomic with respect to the other actors — which is what makes a failing
 * schedule replayable rather than merely reproducible-if-you're-lucky.
 *
 * A schedule shorter than the number of suspension points reached, or naming an
 * actor that is not parked, falls back to the first ready actor and sets
 * `divergent`. That is reported rather than hidden: a divergent run is evidence
 * about *some* interleaving, not about the one that was asked for.
 */
export async function runInterleaving<R>(
  actors: readonly ScheduledActor<R>[],
  schedule: Schedule,
  options: RunInterleavingOptions = {},
): Promise<InterleavingRun<R>> {
  if (actors.length === 0) throw new RangeError("runInterleaving needs at least one actor");
  const names = actors.map((actor) => actor.name);
  if (new Set(names).size !== names.length) throw new Error("actor names must be unique");

  const scheduler = new Scheduler(names);
  const results: ActorResult<R>[] = [];
  const timeoutMs = options.timeoutMs ?? 5_000;

  const running = actors.map(async (actor) => {
    const context: ActorContext = {
      name: actor.name,
      yield: (label = "") => scheduler.park(actor.name, label),
    };
    try {
      const value = await actor.run(context);
      results.push({ name: actor.name, status: "ok", value });
    } catch (error) {
      results.push({ name: actor.name, status: "fail", error });
    } finally {
      scheduler.finish(actor.name);
    }
  });

  const observed: string[] = [];
  const labels: string[] = [];
  let divergent = false;
  let step = 0;

  while (!scheduler.allDone()) {
    await scheduler.quiesce(timeoutMs, schedule);
    const ready = scheduler.ready();
    if (ready.length === 0) break;
    const planned = schedule[step];
    const chosen = planned !== undefined && ready.includes(planned) ? planned : ready[0]!;
    if (chosen !== planned) divergent = true;
    step += 1;
    observed.push(chosen);
    labels.push(scheduler.release(chosen));
  }

  await Promise.all(running);
  results.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
  return { schedule, observed, labels, results, divergent };
}

/* -------------------------------------------------------------------------- *
 * Enumeration
 * -------------------------------------------------------------------------- */

export interface EnumerateSchedulesOptions {
  maxSchedules?: number;
}

export interface ScheduleEnumeration {
  schedules: readonly Schedule[];
  /** True when `maxSchedules` cut the enumeration short. */
  truncated: boolean;
  /** How many schedules exist in total, whether or not they were enumerated. */
  total: number;
}

function multinomial(counts: readonly number[]): number {
  const total = counts.reduce((sum, count) => sum + count, 0);
  let result = 1;
  let assigned = 0;
  for (const count of counts) {
    assigned += count;
    // C(assigned, count), computed incrementally to keep the numbers small.
    let choose = 1;
    for (let index = 0; index < count; index += 1) {
      choose = (choose * (assigned - index)) / (index + 1);
    }
    result *= choose;
  }
  void total;
  return Math.round(result);
}

/**
 * Every ordering of the actors' declared suspension points.
 *
 * For two actors with n and m points this is C(n+m, n); beyond two it is the
 * multinomial coefficient. Both grow fast, which is exactly why `maxSchedules`
 * is a hard bound rather than advice.
 */
export function enumerateSchedules(
  counts: Readonly<Record<string, number>>,
  options: EnumerateSchedulesOptions = {},
): ScheduleEnumeration {
  const limit = Math.max(1, options.maxSchedules ?? 64);
  const names = Object.keys(counts).filter((name) => (counts[name] ?? 0) > 0);
  const total = multinomial(names.map((name) => counts[name]!));
  const schedules: Schedule[] = [];

  const walk = (remaining: Record<string, number>, prefix: string[]): void => {
    if (schedules.length >= limit) return;
    const available = names.filter((name) => (remaining[name] ?? 0) > 0);
    if (available.length === 0) {
      schedules.push([...prefix]);
      return;
    }
    for (const name of available) {
      walk({ ...remaining, [name]: remaining[name]! - 1 }, [...prefix, name]);
      if (schedules.length >= limit) return;
    }
  };
  walk({ ...counts }, []);

  return { schedules, truncated: schedules.length < total, total };
}

/**
 * A schedule expressed as a `SemanticVariation`.
 *
 * An interleaving is legal behaviour, not a fault: the provider did nothing
 * wrong and neither did the transport. An application that breaks under one has
 * a bug regardless. Modelling it as a variation rather than a `Fault` keeps that
 * distinction, and lets a failing schedule ride through the same minimization
 * and reporting path as everything else.
 */
export function scheduleVariation(schedule: Schedule, target = "SCHEDULER"): SemanticVariation {
  return {
    id: `${target}:schedule:${schedule.join(">")}`,
    target,
    kind: "interleaving",
    description: `Actors are released in the order ${schedule.join(" -> ")}`,
    metadata: { schedule: [...schedule] },
  };
}

/* -------------------------------------------------------------------------- *
 * Exploration
 * -------------------------------------------------------------------------- */

export interface InterleavingSetup<State, R> {
  state: State;
  actors: readonly ScheduledActor<R>[];
}

export interface InterleavingCheckContext<State, R> {
  state: State;
  results: readonly ActorResult<R>[];
  run: InterleavingRun<R>;
}

export interface ExploreInterleavingsOptions<State, R> {
  /**
   * Build a *fresh* state and actor set for one schedule. Called once per
   * schedule; sharing state between schedules would make the exploration
   * order-dependent and the witnesses unreplayable.
   */
  setup(): Promise<InterleavingSetup<State, R>> | InterleavingSetup<State, R>;
  check(context: InterleavingCheckContext<State, R>): Promise<CheckResult> | CheckResult;
  /** Declared suspension points per actor. Discovered by a probe run when absent. */
  yieldPoints?: Readonly<Record<string, number>>;
  maxSchedules?: number;
  timeoutMs?: number;
  stopOnFirstFailure?: boolean;
  /** Records each explored schedule as a `SemanticVariation` in the history. */
  controller?: ScenarioController;
}

export interface ScheduleOutcome<State, R> {
  schedule: Schedule;
  run: InterleavingRun<R>;
  state: State;
  check: CheckResult;
}

export interface InterleavingExploration<State, R> {
  /** The probe run used to discover suspension points, when one was needed. */
  probe?: InterleavingRun<R>;
  yieldPoints: Readonly<Record<string, number>>;
  enumeration: ScheduleEnumeration;
  outcomes: readonly ScheduleOutcome<State, R>[];
  failures: readonly ScheduleOutcome<State, R>[];
  /** Schedules whose actors did not follow the plan. */
  divergent: readonly Schedule[];
}

/**
 * Enumerate and replay every ordering of the actors' declared suspension
 * points, checking an invariant after each.
 *
 * The result is two-sided and both sides matter. A failure is a concrete,
 * replayable schedule that breaks the invariant. No failure across a complete
 * (non-truncated, non-divergent) enumeration is a real statement — bounded by
 * limitation 1 above, but a real one: *no ordering of the points you declared
 * breaks this*.
 */
export async function exploreInterleavings<State, R>(
  options: ExploreInterleavingsOptions<State, R>,
): Promise<InterleavingExploration<State, R>> {
  let probe: InterleavingRun<R> | undefined;
  let yieldPoints = options.yieldPoints;

  if (!yieldPoints) {
    // Discover the suspension points by running once with no plan at all: the
    // scheduler releases whoever is ready, which is a legal interleaving and
    // costs one extra execution.
    const setup = await options.setup();
    probe = await runInterleaving(setup.actors, [], { timeoutMs: options.timeoutMs });
    const counts: Record<string, number> = {};
    for (const name of probe.observed) counts[name] = (counts[name] ?? 0) + 1;
    for (const actor of setup.actors) counts[actor.name] ??= 0;
    yieldPoints = counts;
  }

  const enumeration = enumerateSchedules(yieldPoints, { maxSchedules: options.maxSchedules });
  const outcomes: ScheduleOutcome<State, R>[] = [];
  const failures: ScheduleOutcome<State, R>[] = [];
  const divergent: Schedule[] = [];

  for (const schedule of enumeration.schedules) {
    const setup = await options.setup();
    if (options.controller) {
      const variation = scheduleVariation(schedule);
      options.controller.history.perturb(variation, undefined, "scheduler");
    }
    const run = await runInterleaving(setup.actors, schedule, { timeoutMs: options.timeoutMs });
    if (run.divergent) divergent.push(schedule);
    const check = await options.check({ state: setup.state, results: run.results, run });
    const outcome: ScheduleOutcome<State, R> = { schedule, run, state: setup.state, check };
    outcomes.push(outcome);
    if (!check.valid) {
      failures.push(outcome);
      if (options.stopOnFirstFailure !== false) break;
    }
  }

  return { probe, yieldPoints, enumeration, outcomes, failures, divergent };
}

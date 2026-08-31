import type { FaultPoint, Perturbation, RunResult, Scenario } from "@cloudfault/core";

export interface ArbitraryLike<T> {
  map<U>(mapper: (value: T) => U): ArbitraryLike<U>;
  filter?(predicate: (value: T) => boolean): ArbitraryLike<T>;
}

export interface SchedulerLike {
  schedule<T>(task: Promise<T>, label?: string): Promise<T>;
  scheduleFunction<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
    label?: string,
  ): (...args: TArgs) => Promise<TResult>;
  waitAll(): Promise<void>;
  report?(): readonly unknown[];
}

export interface FastCheckRunDetails<TCounterexample = unknown> {
  failed: boolean;
  interrupted?: boolean;
  numRuns?: number;
  numSkips?: number;
  counterexample?: readonly TCounterexample[] | null;
  counterexamplePath?: string;
  seed?: number;
  error?: unknown;
  errorInstance?: Error;
}

export interface FastCheckLike {
  constant<T>(value: T): ArbitraryLike<T>;
  constantFrom<T>(...values: T[]): ArbitraryLike<T>;
  array<T>(arb: ArbitraryLike<T>, constraints?: { minLength?: number; maxLength?: number }): ArbitraryLike<T[]>;
  tuple?<T extends unknown[]>(...arbs: { [K in keyof T]: ArbitraryLike<T[K]> }): ArbitraryLike<T>;
  record?<T extends Record<string, unknown>>(record: { [K in keyof T]: ArbitraryLike<T[K]> }): ArbitraryLike<T>;
  integer?(constraints?: { min?: number; max?: number }): ArbitraryLike<number>;
  scheduler?(): ArbitraryLike<SchedulerLike>;
  asyncProperty?<T>(arb: ArbitraryLike<T>, predicate: (value: T) => boolean | void | Promise<boolean | void>): unknown;
  property?<T>(arb: ArbitraryLike<T>, predicate: (value: T) => boolean | void): unknown;
  check?(property: unknown, parameters?: Record<string, unknown>): FastCheckRunDetails;
  assert?(property: unknown, parameters?: Record<string, unknown>): void | Promise<void>;
}

/**
 * Build a fast-check arbitrary without making fast-check a hard dependency of
 * the rest of CloudFault. Systematic bounded search remains the default mode;
 * this bridge is intended for workload/data generation and fuzz/soak modes.
 */
export function perturbationSequenceArbitrary(
  fc: FastCheckLike,
  points: readonly FaultPoint[],
  maxLength = 8,
): ArbitraryLike<readonly Perturbation[]> {
  const all = points.flatMap((point) => point.choices);
  if (all.length === 0) return fc.constant([] as readonly Perturbation[]);
  return fc.array(fc.constantFrom(...all), { minLength: 0, maxLength }).map((items) => {
    // A fault point represents alternate perturbations for one logical site.
    // Keep the first generated choice for each point so fuzzed scenarios do
    // not accidentally request two incompatible outcomes at the same site.
    const pointByPerturbation = new Map<string, string>();
    for (const point of points) for (const choice of point.choices) pointByPerturbation.set(choice.id, point.id);
    const selected = new Map<string, Perturbation>();
    for (const item of items) {
      const point = pointByPerturbation.get(item.id) ?? item.id;
      if (!selected.has(point)) selected.set(point, item);
    }
    return [...selected.values()];
  });
}

export function scenarioArbitrary(
  fc: FastCheckLike,
  points: readonly FaultPoint[],
  options: { maxPerturbations?: number; seed?: number; idPrefix?: string } = {},
): ArbitraryLike<Scenario> {
  return perturbationSequenceArbitrary(fc, points, options.maxPerturbations ?? 8).map((perturbations) => ({
    id: `${options.idPrefix ?? "fuzz"}:${perturbations.map((item) => item.id).join("+") || "baseline"}`,
    perturbations,
    seed: options.seed,
    metadata: { strategy: "fast-check" },
  }));
}

export interface FastCheckCounterexample<T = unknown> {
  seed?: number;
  path?: string;
  numRuns?: number;
  numSkips?: number;
  value?: T;
  error?: unknown;
}

/**
 * Ask fast-check to generate and shrink CloudFault scenarios. The predicate
 * returns true for acceptable histories and false for a counterexample.
 */
export async function findScenarioCounterexample<State>(
  fc: FastCheckLike,
  points: readonly FaultPoint[],
  execute: (scenario: Scenario) => Promise<RunResult<State>>,
  predicate: (run: RunResult<State>) => boolean | Promise<boolean>,
  options: {
    numRuns?: number;
    seed?: number;
    path?: string;
    maxPerturbations?: number;
  } = {},
): Promise<FastCheckCounterexample<Scenario> | undefined> {
  if (!fc.asyncProperty || !fc.check) throw new Error("fast-check bridge requires asyncProperty() and check()");
  const arbitrary = scenarioArbitrary(fc, points, {
    maxPerturbations: options.maxPerturbations,
    seed: options.seed,
  });
  const property = fc.asyncProperty(arbitrary, async (scenario) => predicate(await execute(scenario)));
  const details = await Promise.resolve(fc.check(property, {
    numRuns: options.numRuns ?? 100,
    seed: options.seed,
    path: options.path,
    endOnFailure: false,
  }) as FastCheckRunDetails<Scenario>);
  if (!details.failed) return undefined;
  return {
    seed: details.seed ?? options.seed,
    path: details.counterexamplePath,
    numRuns: details.numRuns,
    numSkips: details.numSkips,
    value: details.counterexample?.[0],
    error: details.errorInstance ?? details.error,
  };
}

export interface WorkloadCommand<Model, Real> {
  name: string;
  check(model: Readonly<Model>): boolean;
  run(model: Model, real: Real): void | Promise<void>;
  toString?(): string;
}

/**
 * Generate ordinary CloudFault workload commands while preserving fast-check's
 * array shrinking. This intentionally does not require fast-check's own model
 * command interface, which keeps application models framework-agnostic.
 */
export function workloadCommandsArbitrary<Model, Real>(
  fc: FastCheckLike,
  commands: readonly ArbitraryLike<WorkloadCommand<Model, Real>>[],
  options: { minCommands?: number; maxCommands?: number } = {},
): ArbitraryLike<readonly WorkloadCommand<Model, Real>[]> {
  if (!commands.length) return fc.constant([] as readonly WorkloadCommand<Model, Real>[]);
  // constantFrom over arbitrary objects is not oneOf; create one array per
  // command family and flatten their generated command values using tuple when
  // available. For broad compatibility, callers may also pass a pre-combined
  // arbitrary as the sole command arbitrary.
  if (commands.length === 1) {
    return fc.array(commands[0]!, {
      minLength: options.minCommands ?? 0,
      maxLength: options.maxCommands ?? 50,
    });
  }
  if (!fc.tuple) throw new Error("Multiple command arbitraries require fast-check tuple() support");
  const combined = fc.tuple(...commands as [ArbitraryLike<WorkloadCommand<Model, Real>>, ...ArbitraryLike<WorkloadCommand<Model, Real>>[]])
    .map((values) => values[Math.floor(Math.random() * values.length)]!);
  return fc.array(combined, {
    minLength: options.minCommands ?? 0,
    maxLength: options.maxCommands ?? 50,
  });
}

export async function executeWorkloadCommands<Model, Real>(
  commands: readonly WorkloadCommand<Model, Real>[],
  model: Model,
  real: Real,
): Promise<readonly string[]> {
  const executed: string[] = [];
  for (const command of commands) {
    if (!command.check(model)) continue;
    await command.run(model, real);
    executed.push(command.toString?.() ?? command.name);
  }
  return executed;
}

export interface ScheduleWitness {
  report: readonly unknown[];
}

/**
 * Run application-created async operations through fast-check's scheduler so
 * promise resolution ordering becomes part of the generated/shrunk witness.
 */
export async function runScheduledWorkload<T>(
  scheduler: SchedulerLike,
  tasks: readonly { label: string; run(): Promise<T> }[],
): Promise<{ results: readonly T[]; witness: ScheduleWitness }> {
  const scheduled = tasks.map((task) => scheduler.schedule(task.run(), task.label));
  await scheduler.waitAll();
  const results = await Promise.all(scheduled);
  return { results, witness: { report: scheduler.report?.() ?? [] } };
}

export async function loadFastCheck(): Promise<FastCheckLike> {
  try {
    return (await Function("return import('fast-check')")()) as FastCheckLike;
  } catch (error) {
    throw new Error("@cloudfault/fast-check requires fast-check >= 4", { cause: error });
  }
}

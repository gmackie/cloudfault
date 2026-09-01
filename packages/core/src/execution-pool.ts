import { performance } from "node:perf_hooks";
import { checksFailed } from "./checker.js";
import type { RunResult, Scenario } from "./types.js";

export interface ScenarioBudget {
  maxRuns?: number;
  maxEstimatedCost?: number;
  maxWallTimeMs?: number;
}

export interface ScenarioCost {
  scenario: string;
  estimated: number;
}

export type ScenarioCostEstimator = (scenario: Scenario) => number;

export function defaultScenarioCost(scenario: Scenario): number {
  return 1 + scenario.perturbations.reduce((sum, perturbation) => {
    const explicit = perturbation.metadata?.estimatedCost;
    const latency = perturbation.metadata?.delayMs;
    const retry = perturbation.metadata?.retries;
    return sum
      + (typeof explicit === "number" && Number.isFinite(explicit) ? Math.max(0, explicit) : 0)
      + (typeof latency === "number" && latency > 0 ? Math.min(latency / 1_000, 30) : 0)
      + (typeof retry === "number" && retry > 0 ? Math.min(retry, 10) : 0);
  }, 0);
}

export interface BatchExecutionOptions {
  concurrency?: number;
  stopOnFirstFailure?: boolean;
  budget?: ScenarioBudget;
  estimateCost?: ScenarioCostEstimator;
}

export interface SkippedScenario {
  scenario: Scenario;
  reason: "run-budget" | "cost-budget" | "time-budget" | "failure-stop";
}

export interface BatchExecutionResult<State = unknown> {
  runs: readonly RunResult<State>[];
  skipped: readonly SkippedScenario[];
  estimatedCost: number;
  elapsedMs: number;
  firstFailure?: RunResult<State>;
}

/**
 * Execute independent scenarios concurrently while preserving deterministic
 * output order. Once stop/budget conditions trigger, no new scenarios are
 * scheduled; already-running scenarios are allowed to finish so their runtime
 * is not left in an indeterminate test-harness state.
 */
export async function executeScenarioBatch<State>(
  scenarios: readonly Scenario[],
  execute: (scenario: Scenario) => Promise<RunResult<State>>,
  options: BatchExecutionOptions = {},
): Promise<BatchExecutionResult<State>> {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const stopOnFirstFailure = options.stopOnFirstFailure ?? false;
  const estimate = options.estimateCost ?? defaultScenarioCost;
  const started = performance.now();
  const results = new Map<number, RunResult<State>>();
  const skipped = new Map<number, SkippedScenario>();
  let nextIndex = 0;
  let scheduled = 0;
  let estimatedCost = 0;
  let stoppedForFailure = false;
  let firstFailureIndex: number | undefined;

  function budgetReason(index: number): SkippedScenario["reason"] | undefined {
    if (stoppedForFailure) return "failure-stop";
    if (options.budget?.maxWallTimeMs !== undefined && performance.now() - started >= options.budget.maxWallTimeMs) return "time-budget";
    if (options.budget?.maxRuns !== undefined && scheduled >= options.budget.maxRuns) return "run-budget";
    const cost = estimate(scenarios[index]!);
    if (options.budget?.maxEstimatedCost !== undefined && estimatedCost + cost > options.budget.maxEstimatedCost) return "cost-budget";
    return undefined;
  }

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= scenarios.length) return;
      const scenario = scenarios[index]!;
      const reason = budgetReason(index);
      if (reason) {
        skipped.set(index, { scenario, reason });
        continue;
      }
      const cost = estimate(scenario);
      scheduled += 1;
      estimatedCost += cost;
      const run = await execute(scenario);
      results.set(index, run);
      if (checksFailed(run.checks) && firstFailureIndex === undefined) {
        firstFailureIndex = index;
        if (stopOnFirstFailure) stoppedForFailure = true;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, scenarios.length)) }, () => worker()));

  // Anything never reached because all workers exhausted after a stop is made
  // explicit in the report rather than silently disappearing.
  for (let index = 0; index < scenarios.length; index += 1) {
    if (results.has(index) || skipped.has(index)) continue;
    skipped.set(index, { scenario: scenarios[index]!, reason: stoppedForFailure ? "failure-stop" : "run-budget" });
  }

  const orderedRuns = [...results.entries()].sort(([a], [b]) => a - b).map(([, run]) => run);
  const orderedSkipped = [...skipped.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
  return {
    runs: orderedRuns,
    skipped: orderedSkipped,
    estimatedCost,
    elapsedMs: performance.now() - started,
    firstFailure: firstFailureIndex === undefined ? undefined : results.get(firstFailureIndex),
  };
}

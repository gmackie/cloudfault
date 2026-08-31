import { checksFailed } from "./checker.js";
import type {
  ExplorationResult,
  FaultPoint,
  Perturbation,
  RunResult,
  Scenario,
} from "./types.js";

export interface ExploreOptions {
  maxDepth?: number;
  includeEmpty?: boolean;
  maxScenarios?: number;
  stopOnFirstFailure?: boolean;
  minimizeFailure?: boolean;
}

function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  const output: T[][] = [];
  const visit = (start: number, chosen: T[]) => {
    if (chosen.length === size) {
      output.push([...chosen]);
      return;
    }
    for (let i = start; i <= items.length - (size - chosen.length); i++) {
      const item = items[i];
      if (item !== undefined) visit(i + 1, [...chosen, item]);
    }
  };
  visit(0, []);
  return output;
}

function cartesianChoices(points: readonly FaultPoint[]): Perturbation[][] {
  let rows: Perturbation[][] = [[]];
  for (const point of points) {
    const next: Perturbation[][] = [];
    for (const row of rows) {
      for (const choice of point.choices) next.push([...row, choice]);
    }
    rows = next;
  }
  return rows;
}

/**
 * Enumerates bounded perturbation combinations systematically instead of
 * relying on random independent failure probabilities.
 */
export function enumerateScenarios(
  points: readonly FaultPoint[],
  options: ExploreOptions = {},
): readonly Scenario[] {
  const maxDepth = Math.min(options.maxDepth ?? 1, points.length);
  const maxScenarios = options.maxScenarios ?? Number.POSITIVE_INFINITY;
  const scenarios: Scenario[] = [];

  if (options.includeEmpty) scenarios.push({ id: "baseline", perturbations: [] });

  for (let depth = 1; depth <= maxDepth; depth++) {
    for (const selectedPoints of combinations(points, depth)) {
      for (const perturbations of cartesianChoices(selectedPoints)) {
        scenarios.push({
          id: perturbations.map((item) => item.id).join("+"),
          perturbations,
        });
        if (scenarios.length >= maxScenarios) return scenarios;
      }
    }
  }

  return scenarios;
}

export interface MinimalFailureSetResult<T extends Perturbation = Perturbation> {
  original: readonly T[];
  minimal: readonly T[];
  attempts: number;
}

/**
 * 1-minimal delta reduction: remove perturbations one at a time until no
 * single remaining perturbation can be removed while preserving failure.
 */
export async function minimizeFailureSet<T extends Perturbation>(
  perturbations: readonly T[],
  reproducesFailure: (candidate: readonly T[]) => boolean | Promise<boolean>,
): Promise<MinimalFailureSetResult<T>> {
  let candidate = [...perturbations];
  let attempts = 0;
  let changed = true;

  if (!(await reproducesFailure(candidate))) {
    attempts++;
    throw new Error("Cannot minimize a perturbation set that does not reproduce the failure");
  }
  attempts++;

  while (changed) {
    changed = false;
    for (let i = 0; i < candidate.length; i++) {
      const reduced = candidate.filter((_, index) => index !== i);
      attempts++;
      if (await reproducesFailure(reduced)) {
        candidate = reduced;
        changed = true;
        break;
      }
    }
  }

  return { original: [...perturbations], minimal: candidate, attempts };
}

export interface ExecuteScenarioOptions {
  seed?: number;
}

/**
 * Execute a bounded systematic exploration and optionally reduce the first
 * failure to a 1-minimal perturbation set. Baseline is always executed first.
 */
export async function exploreScenarios<State>(
  points: readonly FaultPoint[],
  execute: (scenario: Scenario) => Promise<RunResult<State>>,
  options: ExploreOptions & ExecuteScenarioOptions = {},
): Promise<ExplorationResult<State>> {
  const baselineScenario: Scenario = { id: "baseline", perturbations: [], seed: options.seed };
  const baseline = await execute(baselineScenario);
  const runs: RunResult<State>[] = [];

  const scenarios = enumerateScenarios(points, {
    ...options,
    includeEmpty: false,
  });

  let firstFailure: RunResult<State> | undefined;
  for (const rawScenario of scenarios) {
    const scenario = { ...rawScenario, seed: options.seed };
    const result = await execute(scenario);
    runs.push(result);
    if (checksFailed(result.checks)) {
      firstFailure = result;
      if (options.stopOnFirstFailure ?? true) break;
    }
  }

  if (!firstFailure || options.minimizeFailure === false) {
    return { baseline, runs, firstFailure };
  }

  const minimized = await minimizeFailureSet(firstFailure.scenario.perturbations, async (candidate) => {
    const scenario: Scenario = {
      id: candidate.length ? candidate.map((item) => item.id).join("+") : "baseline",
      perturbations: candidate,
      seed: options.seed,
    };
    const result = await execute(scenario);
    return checksFailed(result.checks);
  });

  return {
    baseline,
    runs,
    firstFailure,
    minimalFailureSet: minimized.minimal,
    minimizationAttempts: minimized.attempts,
  };
}

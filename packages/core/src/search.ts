import type { Fault, FaultScenario, ScenarioResult, SearchResult } from "./types.js";

function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  const output: T[][] = [];

  function walk(start: number, current: T[]) {
    if (current.length === size) {
      output.push([...current]);
      return;
    }
    for (let index = start; index <= items.length - (size - current.length); index++) {
      current.push(items[index]!);
      walk(index + 1, current);
      current.pop();
    }
  }

  walk(0, []);
  return output;
}

export interface ExploreOptions {
  maxDepth?: number;
  stopOnFirstFailure?: boolean;
}

export async function exploreFaultSets(
  faults: readonly Fault[],
  run: (faults: readonly Fault[]) => Promise<ScenarioResult>,
  options: ExploreOptions = {},
): Promise<SearchResult> {
  const maxDepth = Math.min(options.maxDepth ?? faults.length, faults.length);
  const scenarios: FaultScenario[] = [];

  for (let depth = 0; depth <= maxDepth; depth++) {
    for (const active of combinations(faults, depth)) {
      const result = await run(active);
      const scenario: FaultScenario = { faults: active, result };
      scenarios.push(scenario);
      if (!result.check.valid && options.stopOnFirstFailure) {
        const minimalFailureSet = await minimizeFailureSet(active, run);
        return { scenarios, firstFailure: scenario, minimalFailureSet };
      }
    }
  }

  const firstFailure = scenarios.find((scenario) => !scenario.result.check.valid);
  const minimalFailureSet = firstFailure
    ? await minimizeFailureSet(firstFailure.faults, run)
    : undefined;

  return { scenarios, firstFailure, minimalFailureSet };
}

/**
 * Returns a 1-minimal failure-inducing set: removing any single remaining
 * element causes the test to stop failing. This intentionally does not claim
 * to find a globally minimum-cardinality set.
 */
export async function minimizeFailureSet(
  faults: readonly Fault[],
  run: (faults: readonly Fault[]) => Promise<ScenarioResult>,
): Promise<readonly Fault[]> {
  let current = [...faults];
  const initial = await run(current);
  if (initial.check.valid) return [];

  let index = 0;
  while (index < current.length) {
    const candidate = current.filter((_, candidateIndex) => candidateIndex !== index);
    const result = await run(candidate);
    if (!result.check.valid) {
      current = candidate;
      index = 0;
    } else {
      index += 1;
    }
  }

  return current;
}

export function fault(
  id: string,
  label: string,
  options: Partial<Omit<Fault, "id" | "label">> = {},
): Fault {
  return {
    id,
    label,
    category: options.category ?? "degradation",
    ...options,
  };
}

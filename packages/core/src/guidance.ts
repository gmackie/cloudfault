import { checksFailed } from "./checker.js";
import type { FaultPoint, Perturbation, RunResult, Scenario } from "./types.js";

export interface PerturbationStats {
  id: string;
  executions: number;
  failures: number;
  failureRate: number;
  firstSeenOrder: number;
}

export function perturbationStats(runs: readonly RunResult[]): ReadonlyMap<string, PerturbationStats> {
  const stats = new Map<string, { executions: number; failures: number; firstSeenOrder: number }>();
  runs.forEach((run, runIndex) => {
    const failed = checksFailed(run.checks);
    for (const perturbation of run.scenario.perturbations) {
      const current = stats.get(perturbation.id) ?? { executions: 0, failures: 0, firstSeenOrder: runIndex };
      current.executions++;
      if (failed) current.failures++;
      stats.set(perturbation.id, current);
    }
  });
  return new Map([...stats.entries()].map(([id, value]) => [id, {
    id,
    ...value,
    failureRate: value.executions ? value.failures / value.executions : 0,
  }]));
}

function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  const result: T[][] = [];
  const visit = (start: number, chosen: T[]) => {
    if (chosen.length === size) {
      result.push(chosen);
      return;
    }
    for (let index = start; index < items.length; index++) visit(index + 1, [...chosen, items[index]!]);
  };
  visit(0, []);
  return result;
}

export interface GuidedSearchOptions {
  maxDepth?: number;
  maxScenarios?: number;
  seed?: number;
  /** Reward trying perturbations that have not been executed before. */
  noveltyWeight?: number;
  /** Reward perturbations that have appeared in failing histories. */
  failureWeight?: number;
  /** Slightly prefer smaller scenarios for easier diagnosis. */
  complexityPenalty?: number;
}

/**
 * Generate bounded combinations ordered by feedback from previous runs. This
 * is intentionally model-agnostic: an autoresearch/agent loop can update the
 * run corpus and ask for the next high-value candidates without coupling core
 * to a particular optimizer.
 */
export function guidedScenarios(
  points: readonly FaultPoint[],
  previousRuns: readonly RunResult[],
  options: GuidedSearchOptions = {},
): readonly Scenario[] {
  const maxDepth = Math.min(options.maxDepth ?? 2, points.length);
  const maxScenarios = options.maxScenarios ?? 100;
  const noveltyWeight = options.noveltyWeight ?? 1;
  const failureWeight = options.failureWeight ?? 4;
  const complexityPenalty = options.complexityPenalty ?? 0.15;
  const stats = perturbationStats(previousRuns);
  const previouslyRun = new Set(previousRuns.map((run) =>
    [...run.scenario.perturbations].map((item) => item.id).sort().join("|"),
  ));

  const candidates: Array<{ scenario: Scenario; score: number }> = [];
  for (let depth = 1; depth <= maxDepth; depth++) {
    for (const selected of combinations(points, depth)) {
      let rows: Perturbation[][] = [[]];
      for (const point of selected) {
        rows = rows.flatMap((row) => point.choices.map((choice) => [...row, choice]));
      }
      for (const perturbations of rows) {
        const signature = perturbations.map((item) => item.id).sort().join("|");
        if (previouslyRun.has(signature)) continue;
        let score = -complexityPenalty * perturbations.length;
        for (const item of perturbations) {
          const stat = stats.get(item.id);
          if (!stat) score += noveltyWeight;
          else score += stat.failureRate * failureWeight + 1 / (stat.executions + 1) * noveltyWeight;
        }
        candidates.push({
          score,
          scenario: {
            id: `guided:${perturbations.map((item) => item.id).join("+")}`,
            perturbations,
            seed: options.seed,
            metadata: { strategy: "guided", score },
          },
        });
      }
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.scenario.id.localeCompare(b.scenario.id))
    .slice(0, maxScenarios)
    .map((item) => item.scenario);
}

export interface SearchObjective {
  name: string;
  score(run: RunResult): number;
}

export function failureObjective(): SearchObjective {
  return {
    name: "failure",
    score(run) {
      if (!checksFailed(run.checks)) return 0;
      // Prefer smaller counterexamples when two candidates both fail.
      return 1_000 - run.scenario.perturbations.length;
    },
  };
}

export function composeObjectives(...objectives: readonly SearchObjective[]): SearchObjective {
  return {
    name: objectives.map((item) => item.name).join("+"),
    score(run) {
      return objectives.reduce((total, objective) => total + objective.score(run), 0);
    },
  };
}

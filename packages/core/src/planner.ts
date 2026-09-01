import { checksFailed } from "./checker.js";
import { pairwiseScenarios } from "./covering.js";
import { CoverageGuidance, coverageGuidedScenarios, type GuidedScenarioOptions } from "./guided.js";
import { guidedScenarios, type GuidedSearchOptions } from "./guidance.js";
import { incidentScenario, type IncidentProfile } from "./incidents.js";
import { enumerateScenarios, minimizeFailureSet, type ExploreOptions } from "./search.js";
import type {
  ExplorationResult,
  FaultPoint,
  RunResult,
  Scenario,
} from "./types.js";

export type SearchStrategy = "exhaustive" | "pairwise" | "guided" | "coverage-guided" | "incidents" | "hybrid";

export interface ScenarioPlanOptions extends ExploreOptions {
  strategy?: SearchStrategy;
  seed?: number;
  previousRuns?: readonly RunResult[];
  incidents?: readonly IncidentProfile[];
  guided?: GuidedSearchOptions;
  coverageGuided?: GuidedScenarioOptions;
}

export interface ScenarioPlan {
  strategy: SearchStrategy;
  scenarios: readonly Scenario[];
  metadata: {
    faultPoints: number;
    perturbations: number;
    incidents: number;
    previousRuns: number;
  };
}

function deduplicateScenarios(scenarios: readonly Scenario[]): readonly Scenario[] {
  const seen = new Set<string>();
  const output: Scenario[] = [];
  for (const scenario of scenarios) {
    const signature = [...scenario.perturbations].map((item) => item.id).sort().join("|");
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    output.push(scenario);
  }
  return output;
}

function limitScenarios(scenarios: readonly Scenario[], maxScenarios?: number): readonly Scenario[] {
  return Number.isFinite(maxScenarios) ? scenarios.slice(0, maxScenarios) : scenarios;
}

/**
 * Build a deterministic scenario plan without coupling planning to execution.
 * CI can print/inspect a plan, an optimizer can reorder it, and local/staging
 * backends can execute exactly the same ordered scenario list.
 */
export function planScenarios(
  points: readonly FaultPoint[],
  options: ScenarioPlanOptions = {},
): ScenarioPlan {
  const strategy = options.strategy ?? "exhaustive";
  const seed = options.seed;
  const exhaustive = () => enumerateScenarios(points, {
    maxDepth: options.maxDepth ?? 1,
    maxScenarios: options.maxScenarios,
    includeEmpty: false,
  }).map((scenario) => ({ ...scenario, seed, metadata: { ...scenario.metadata, strategy: "exhaustive" } }));
  const pairwise = () => pairwiseScenarios(points, {
    includeBaseline: false,
    seed,
    maxScenarios: options.maxScenarios,
  });
  const guided = () => guidedScenarios(
    points,
    options.previousRuns ?? [],
    {
      maxDepth: options.guided?.maxDepth ?? options.maxDepth ?? 2,
      maxScenarios: options.guided?.maxScenarios ?? options.maxScenarios,
      seed,
      noveltyWeight: options.guided?.noveltyWeight,
      failureWeight: options.guided?.failureWeight,
      complexityPenalty: options.guided?.complexityPenalty,
    },
  );
  const coverageGuided = () => {
    const guidance = new CoverageGuidance();
    for (const run of options.previousRuns ?? []) guidance.observe(run);
    return coverageGuidedScenarios(points, guidance, {
      maxDepth: options.coverageGuided?.maxDepth ?? options.maxDepth ?? 3,
      maxCandidates: options.coverageGuided?.maxCandidates,
      maxScenarios: options.coverageGuided?.maxScenarios ?? options.maxScenarios,
      seed,
      includePreviouslyExecuted: options.coverageGuided?.includePreviouslyExecuted,
    });
  };
  const incidents = () => (options.incidents ?? []).map((incident) =>
    incidentScenario(incident, { seed, metadata: { strategy: "incidents" } }),
  );

  let scenarios: readonly Scenario[];
  switch (strategy) {
    case "exhaustive": scenarios = exhaustive(); break;
    case "pairwise": scenarios = pairwise(); break;
    case "guided": scenarios = guided(); break;
    case "coverage-guided": scenarios = coverageGuided(); break;
    case "incidents": scenarios = incidents(); break;
    case "hybrid":
      scenarios = [
        ...enumerateScenarios(points, { maxDepth: 1, includeEmpty: false }),
        ...incidents(),
        ...pairwise(),
        ...coverageGuided(),
        ...guided(),
      ];
      break;
  }

  const deduplicated = limitScenarios(deduplicateScenarios(scenarios), options.maxScenarios);
  return {
    strategy,
    scenarios: deduplicated,
    metadata: {
      faultPoints: points.length,
      perturbations: points.reduce((count, point) => count + point.choices.length, 0),
      incidents: options.incidents?.length ?? 0,
      previousRuns: options.previousRuns?.length ?? 0,
    },
  };
}

export interface ExecuteScenarioPlanOptions {
  seed?: number;
  stopOnFirstFailure?: boolean;
  minimizeFailure?: boolean;
}

/** Execute an already-planned scenario list through the normal checker/MFS path. */
export async function executeScenarioPlan<State>(
  plan: ScenarioPlan,
  execute: (scenario: Scenario) => Promise<RunResult<State>>,
  options: ExecuteScenarioPlanOptions = {},
): Promise<ExplorationResult<State>> {
  const baselineScenario: Scenario = { id: "baseline", perturbations: [], seed: options.seed };
  const baseline = await execute(baselineScenario);
  const runs: RunResult<State>[] = [];
  let firstFailure: RunResult<State> | undefined;

  for (const planned of plan.scenarios) {
    const result = await execute({ ...planned, seed: planned.seed ?? options.seed });
    runs.push(result);
    if (checksFailed(result.checks)) {
      firstFailure = result;
      if (options.stopOnFirstFailure ?? true) break;
    }
  }

  if (!firstFailure || options.minimizeFailure === false) return { baseline, runs, firstFailure };

  const minimized = await minimizeFailureSet(firstFailure.scenario.perturbations, async (candidate) => {
    const result = await execute({
      id: candidate.length ? candidate.map((item) => item.id).join("+") : "baseline",
      perturbations: candidate,
      seed: options.seed,
      metadata: { strategy: plan.strategy, minimization: true },
    });
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

export async function exploreWithStrategy<State>(
  points: readonly FaultPoint[],
  execute: (scenario: Scenario) => Promise<RunResult<State>>,
  options: ScenarioPlanOptions & ExecuteScenarioPlanOptions = {},
): Promise<ExplorationResult<State> & { plan: ScenarioPlan }> {
  const plan = planScenarios(points, options);
  const result = await executeScenarioPlan(plan, execute, options);
  return { ...result, plan };
}

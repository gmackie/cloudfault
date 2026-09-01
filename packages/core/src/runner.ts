import { createFailureArtifact } from "./artifact.js";
import { checksFailed } from "./checker.js";
import type { GuidedSearchOptions } from "./guidance.js";
import type { IncidentProfile } from "./incidents.js";
import { exploreWithStrategy, type SearchStrategy } from "./planner.js";
import type { ExploreOptions } from "./search.js";
import type {
  ExplorationResult,
  FailureArtifact,
  FaultPoint,
  ReplayDescriptor,
  RunResult,
  Scenario,
} from "./types.js";

export interface CloudFaultConfig<State = unknown> {
  name: string;
  faultPoints: readonly FaultPoint[];
  execute(scenario: Scenario): Promise<RunResult<State>>;
  strategy?: SearchStrategy;
  maxDepth?: number;
  maxScenarios?: number;
  seed?: number;
  stopOnFirstFailure?: boolean;
  minimizeFailure?: boolean;
  incidents?: readonly IncidentProfile[];
  previousRuns?: readonly RunResult[];
  guided?: GuidedSearchOptions;
  replay?: ReplayDescriptor;
  metadata?: Record<string, unknown>;
}

export function defineCloudFault<State>(config: CloudFaultConfig<State>): CloudFaultConfig<State> {
  return config;
}

export interface RunCloudFaultResult<State = unknown> {
  exploration: ExplorationResult<State>;
  failure?: FailureArtifact<State>;
}

export async function runCloudFault<State>(
  config: CloudFaultConfig<State>,
  overrides: ExploreOptions & {
    seed?: number;
    strategy?: SearchStrategy;
    incidents?: readonly IncidentProfile[];
    previousRuns?: readonly RunResult[];
    guided?: GuidedSearchOptions;
  } = {},
): Promise<RunCloudFaultResult<State>> {
  const exploration = await exploreWithStrategy(config.faultPoints, config.execute, {
    strategy: overrides.strategy ?? config.strategy ?? "exhaustive",
    maxDepth: overrides.maxDepth ?? config.maxDepth ?? 1,
    maxScenarios: overrides.maxScenarios ?? config.maxScenarios,
    stopOnFirstFailure: overrides.stopOnFirstFailure ?? config.stopOnFirstFailure ?? true,
    minimizeFailure: overrides.minimizeFailure ?? config.minimizeFailure ?? true,
    seed: overrides.seed ?? config.seed,
    incidents: overrides.incidents ?? config.incidents,
    previousRuns: overrides.previousRuns ?? config.previousRuns,
    guided: overrides.guided ?? config.guided,
  });

  if (!exploration.firstFailure || !checksFailed(exploration.firstFailure.checks)) {
    return { exploration };
  }

  return {
    exploration,
    failure: createFailureArtifact({
      testName: config.name,
      run: exploration.firstFailure,
      minimalFailureSet: exploration.minimalFailureSet,
      replay: config.replay,
      metadata: {
        ...config.metadata,
        searchStrategy: exploration.plan.strategy,
        plannedScenarios: exploration.plan.scenarios.length,
        minimizationAttempts: exploration.minimizationAttempts,
        exploredRuns: exploration.runs.length,
      },
    }),
  };
}

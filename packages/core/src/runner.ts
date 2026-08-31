import { createFailureArtifact } from "./artifact.js";
import { checksFailed } from "./checker.js";
import { exploreScenarios, type ExploreOptions } from "./search.js";
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
  maxDepth?: number;
  maxScenarios?: number;
  seed?: number;
  stopOnFirstFailure?: boolean;
  minimizeFailure?: boolean;
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
  overrides: ExploreOptions & { seed?: number } = {},
): Promise<RunCloudFaultResult<State>> {
  const exploration = await exploreScenarios(config.faultPoints, config.execute, {
    maxDepth: overrides.maxDepth ?? config.maxDepth ?? 1,
    maxScenarios: overrides.maxScenarios ?? config.maxScenarios,
    stopOnFirstFailure: overrides.stopOnFirstFailure ?? config.stopOnFirstFailure ?? true,
    minimizeFailure: overrides.minimizeFailure ?? config.minimizeFailure ?? true,
    seed: overrides.seed ?? config.seed,
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
        minimizationAttempts: exploration.minimizationAttempts,
        exploredRuns: exploration.runs.length,
      },
    }),
  };
}

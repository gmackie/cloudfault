import { checksFailed } from "./checker.js";
import type { FaultSpaceResolver } from "./discovery.js";
import { CoverageGuidance, coverageGuidedScenarios, type GuidanceSnapshot } from "./guided.js";
import { LineageFrontier } from "./lineage.js";
import { minimizeFailureSet } from "./search.js";
import type { ExplorationResult, FaultPoint, RunResult, Scenario } from "./types.js";

export interface AdaptiveExplorationOptions {
  seed?: number;
  maxDepth?: number;
  maxRuns?: number;
  maxCandidates?: number;
  stopOnFirstFailure?: boolean;
  minimizeFailure?: boolean;
  guidance?: CoverageGuidance;
}

export interface AdaptiveExplorationResult<State = unknown> extends ExplorationResult<State> {
  faultPoints: readonly FaultPoint[];
  discoveredCalls: number;
  guidance: GuidanceSnapshot;
}

function addFaultPoints(target: Map<string, FaultPoint>, points: readonly FaultPoint[]): number {
  let added = 0;
  for (const point of points) {
    const existing = target.get(point.id);
    if (!existing) {
      target.set(point.id, point);
      added += 1;
      continue;
    }
    const choices = new Map(existing.choices.map((choice) => [choice.id, choice]));
    for (const choice of point.choices) choices.set(choice.id, choice);
    target.set(point.id, { ...existing, choices: [...choices.values()] });
  }
  return added;
}

/**
 * Filibuster-style live discovery plus coverage-guided search. Every execution
 * can reveal previously unreachable dependency calls; those calls immediately
 * contribute fault points to the same search session.
 */
export async function exploreAdaptiveLineage<State>(
  execute: (scenario: Scenario) => Promise<RunResult<State>>,
  resolve: FaultSpaceResolver,
  options: AdaptiveExplorationOptions = {},
): Promise<AdaptiveExplorationResult<State>> {
  const guidance = options.guidance ?? new CoverageGuidance();
  const frontier = new LineageFrontier();
  const points = new Map<string, FaultPoint>();
  const executed = new Set<string>();
  const runs: RunResult<State>[] = [];
  const maxRuns = Math.max(1, options.maxRuns ?? 100);

  const baseline = await execute({ id: "baseline", perturbations: [], seed: options.seed, metadata: { strategy: "adaptive-lineage" } });
  guidance.observe(baseline);
  const baselineExpansion = await frontier.expand(baseline.history, resolve);
  addFaultPoints(points, baselineExpansion.newFaultPoints);
  let firstFailure: RunResult<State> | undefined;

  while (runs.length < maxRuns && points.size) {
    const candidates = coverageGuidedScenarios([...points.values()], guidance, {
      maxDepth: options.maxDepth ?? 2,
      maxCandidates: options.maxCandidates ?? 2_000,
      maxScenarios: options.maxCandidates ?? 2_000,
      seed: options.seed,
      includePreviouslyExecuted: true,
    }).filter((scenario) => !executed.has(scenario.id));
    if (!candidates.length) break;
    const scenario = candidates[0]!;
    executed.add(scenario.id);
    const result = await execute({ ...scenario, metadata: { ...scenario.metadata, strategy: "adaptive-lineage" } });
    runs.push(result);
    guidance.observe(result);
    const expansion = await frontier.expand(result.history, resolve);
    addFaultPoints(points, expansion.newFaultPoints);
    if (checksFailed(result.checks) && !firstFailure) {
      firstFailure = result;
      if (options.stopOnFirstFailure ?? true) break;
    }
  }

  if (!firstFailure || options.minimizeFailure === false) {
    return {
      baseline,
      runs,
      firstFailure,
      faultPoints: [...points.values()],
      discoveredCalls: frontier.discoveredCalls,
      guidance: guidance.snapshot(),
    };
  }

  const minimized = await minimizeFailureSet(firstFailure.scenario.perturbations, async (candidate) => {
    const run = await execute({
      id: candidate.map((item) => item.id).join("+") || "baseline",
      perturbations: candidate,
      seed: options.seed,
      metadata: { strategy: "adaptive-lineage", minimization: true },
    });
    return checksFailed(run.checks);
  });
  return {
    baseline,
    runs,
    firstFailure,
    minimalFailureSet: minimized.minimal,
    minimizationAttempts: minimized.attempts,
    faultPoints: [...points.values()],
    discoveredCalls: frontier.discoveredCalls,
    guidance: guidance.snapshot(),
  };
}

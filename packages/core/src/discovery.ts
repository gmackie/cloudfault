import type {
  FaultPoint,
  HistoryEvent,
  OperationRef,
  Perturbation,
  RunResult,
} from "./types.js";

export interface DiscoveredDependencyCall {
  key: string;
  target: string;
  operation: string;
  adapter?: string;
  resource?: string;
  callsite?: string;
  executionIndex?: string;
  occurrences: number;
  processes: readonly (string | number)[];
  sample: OperationRef;
}

function dependencyKey(operation: OperationRef): string {
  return [
    operation.target ?? "",
    operation.adapter ?? "",
    operation.name,
    operation.resource ?? "",
    operation.callsite ?? "",
    operation.executionIndex ?? "",
  ].join("|");
}

/**
 * Extract the logical dependency surface touched by a baseline execution.
 * Only invoke events are used, so retries/completions do not inflate the
 * discovered call graph.
 */
export function discoverDependencyCalls(history: readonly HistoryEvent[]): readonly DiscoveredDependencyCall[] {
  const calls = new Map<string, {
    sample: OperationRef;
    count: number;
    processes: Set<string | number>;
  }>();

  for (const event of history) {
    if (event.type !== "invoke" || !event.operation?.target) continue;
    const key = dependencyKey(event.operation);
    const current = calls.get(key);
    if (current) {
      current.count++;
      current.processes.add(event.process);
    } else {
      calls.set(key, {
        sample: event.operation,
        count: 1,
        processes: new Set([event.process]),
      });
    }
  }

  return [...calls.entries()].map(([key, value]) => ({
    key,
    target: value.sample.target!,
    operation: value.sample.name,
    adapter: value.sample.adapter,
    resource: value.sample.resource,
    callsite: value.sample.callsite,
    executionIndex: value.sample.executionIndex,
    occurrences: value.count,
    processes: [...value.processes],
    sample: value.sample,
  }));
}

export type FaultSpaceResolver = (
  call: DiscoveredDependencyCall,
) => readonly Perturbation[] | Promise<readonly Perturbation[]>;

/**
 * Convert a baseline history into concrete fault points. The resolver can be
 * backed by provider adapters, Cloudflare contract packs, or application-owned
 * semantics. Perturbations are automatically scoped to the discovered target,
 * operation and stable execution index when the adapter did not already set a
 * more specific selector.
 */
export async function faultPointsFromHistory(
  history: readonly HistoryEvent[],
  resolve: FaultSpaceResolver,
): Promise<readonly FaultPoint[]> {
  const calls = discoverDependencyCalls(history);
  const points: FaultPoint[] = [];

  for (const call of calls) {
    const choices = (await resolve(call)).map((choice) => ({
      ...choice,
      selector: choice.selector ?? {
        target: call.target,
        operation: call.operation,
        resource: call.resource,
        callsite: call.callsite,
        executionIndex: call.executionIndex,
      },
    }));
    if (!choices.length) continue;
    points.push({
      id: `discovered:${call.key}`,
      target: call.target,
      choices,
    });
  }

  return points;
}

export interface DependencyCoverage {
  discovered: number;
  exercised: number;
  unexercised: readonly DiscoveredDependencyCall[];
  exercisedKeys: readonly string[];
  ratio: number;
}

/**
 * Report how much of the baseline dependency surface was exercised by at
 * least one perturbation across subsequent runs.
 */
export function dependencyCoverage(
  baseline: RunResult,
  runs: readonly RunResult[],
): DependencyCoverage {
  const discovered = discoverDependencyCalls(baseline.history);
  const exercised = new Set<string>();

  for (const run of runs) {
    for (const perturbation of run.scenario.perturbations) {
      for (const call of discovered) {
        const selector = perturbation.selector;
        if (perturbation.target !== call.target && selector?.target !== call.target) continue;
        if (perturbation.operation && perturbation.operation !== call.operation) continue;
        if (selector?.operation && selector.operation !== call.operation) continue;
        if (selector?.resource && selector.resource !== call.resource) continue;
        if (selector?.executionIndex && selector.executionIndex !== call.executionIndex) continue;
        exercised.add(call.key);
      }
    }
  }

  const unexercised = discovered.filter((call) => !exercised.has(call.key));
  return {
    discovered: discovered.length,
    exercised: exercised.size,
    unexercised,
    exercisedKeys: [...exercised],
    ratio: discovered.length === 0 ? 1 : exercised.size / discovered.length,
  };
}

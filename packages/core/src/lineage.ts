import {
  discoverDependencyCalls,
  type DiscoveredDependencyCall,
  type FaultSpaceResolver,
} from "./discovery.js";
import type {
  FaultPoint,
  HistoryEvent,
  OperationRef,
  RunResult,
  Scenario,
} from "./types.js";

export interface LineageNode {
  operation: OperationRef;
  parent?: string;
  children: readonly string[];
  invokedAt: number;
  completedAt?: number;
  completion?: HistoryEvent["type"];
}

/** Build a logical parent/child operation graph from one CloudFault history. */
export function buildOperationLineage(history: readonly HistoryEvent[]): ReadonlyMap<string, LineageNode> {
  const mutable = new Map<string, {
    operation: OperationRef;
    parent?: string;
    children: string[];
    invokedAt: number;
    completedAt?: number;
    completion?: HistoryEvent["type"];
  }>();

  for (const event of history) {
    const operation = event.operation;
    if (!operation) continue;
    if (event.type === "invoke") {
      if (!mutable.has(operation.id)) {
        mutable.set(operation.id, {
          operation,
          parent: operation.parentId,
          children: [],
          invokedAt: event.at,
        });
      }
      if (operation.parentId) {
        const parent = mutable.get(operation.parentId);
        if (parent && !parent.children.includes(operation.id)) parent.children.push(operation.id);
      }
    } else if (["ok", "fail", "info"].includes(event.type)) {
      const node = mutable.get(operation.id);
      if (node) {
        node.completedAt = event.at;
        node.completion = event.type;
      }
    }
  }

  // Parents can appear after a child in merged/distributed histories. Make a
  // second pass so child edges are complete regardless of event merge order.
  for (const node of mutable.values()) {
    if (!node.parent) continue;
    const parent = mutable.get(node.parent);
    if (parent && !parent.children.includes(node.operation.id)) parent.children.push(node.operation.id);
  }

  return new Map([...mutable.entries()].map(([id, node]) => [id, {
    ...node,
    children: [...node.children],
  }]));
}

export function operationAncestors(
  lineage: ReadonlyMap<string, LineageNode>,
  operationId: string,
): readonly OperationRef[] {
  const result: OperationRef[] = [];
  const visited = new Set<string>();
  let current = lineage.get(operationId);
  while (current?.parent && !visited.has(current.parent)) {
    visited.add(current.parent);
    const parent = lineage.get(current.parent);
    if (!parent) break;
    result.push(parent.operation);
    current = parent;
  }
  return result;
}

export function operationDescendants(
  lineage: ReadonlyMap<string, LineageNode>,
  operationId: string,
): readonly OperationRef[] {
  const result: OperationRef[] = [];
  const queue = [...(lineage.get(operationId)?.children ?? [])];
  const visited = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = lineage.get(id);
    if (!node) continue;
    result.push(node.operation);
    queue.push(...node.children);
  }
  return result;
}

export interface LineageFrontierExpansion {
  newCalls: readonly DiscoveredDependencyCall[];
  newFaultPoints: readonly FaultPoint[];
  totalCalls: number;
  totalPerturbations: number;
}

/**
 * Filibuster-style incremental discovery session. It never invents a fault
 * location from source alone: a semantic call becomes eligible only after some
 * baseline/faulted execution actually invoked it. If an injected failure
 * reveals a fallback/recovery call that the happy path never touched, feeding
 * that run into expand() adds the new call to the next exploration frontier.
 */
export class LineageFrontier {
  readonly #seenCalls = new Set<string>();
  readonly #seenPerturbations = new Set<string>();
  #callCount = 0;

  get discoveredCalls(): number { return this.#callCount; }
  get discoveredPerturbations(): number { return this.#seenPerturbations.size; }

  hasCall(key: string): boolean { return this.#seenCalls.has(key); }
  hasPerturbation(id: string): boolean { return this.#seenPerturbations.has(id); }

  async expand(
    history: readonly HistoryEvent[],
    resolve: FaultSpaceResolver,
  ): Promise<LineageFrontierExpansion> {
    const discovered = discoverDependencyCalls(history);
    const newCalls = discovered.filter((call) => !this.#seenCalls.has(call.key));
    const points: FaultPoint[] = [];

    for (const call of newCalls) {
      this.#seenCalls.add(call.key);
      this.#callCount++;
      const choices = (await resolve(call))
        .filter((choice) => !this.#seenPerturbations.has(choice.id))
        .map((choice) => ({
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
      for (const choice of choices) this.#seenPerturbations.add(choice.id);
      points.push({
        id: `lineage:${call.key}`,
        target: call.target,
        choices,
      });
    }

    return {
      newCalls,
      newFaultPoints: points,
      totalCalls: this.discoveredCalls,
      totalPerturbations: this.discoveredPerturbations,
    };
  }
}

export interface LineageDiscoveryOptions {
  seed?: number;
  maxRounds?: number;
  maxRuns?: number;
}

export interface LineageDiscoveryResult<State = unknown> {
  baseline: RunResult<State>;
  runs: readonly RunResult<State>[];
  faultPoints: readonly FaultPoint[];
  rounds: number;
  discoveredCalls: number;
}

/**
 * Incrementally exercise each newly discovered perturbation once in isolation,
 * then feed the resulting histories back into the frontier. This is a bounded
 * call-graph discovery phase, not the final multi-fault search; pass the
 * returned faultPoints to exhaustive/pairwise/hybrid planning afterwards.
 */
export async function discoverLineageFaultSpace<State>(
  execute: (scenario: Scenario) => Promise<RunResult<State>>,
  resolve: FaultSpaceResolver,
  options: LineageDiscoveryOptions = {},
): Promise<LineageDiscoveryResult<State>> {
  const frontier = new LineageFrontier();
  const allPoints: FaultPoint[] = [];
  const runs: RunResult<State>[] = [];
  const baseline = await execute({ id: "baseline-lineage", perturbations: [], seed: options.seed });
  let pending = (await frontier.expand(baseline.history, resolve)).newFaultPoints;
  let rounds = 0;
  const maxRounds = Math.max(1, options.maxRounds ?? 8);
  const maxRuns = Math.max(1, options.maxRuns ?? 500);

  while (pending.length && rounds < maxRounds && runs.length < maxRuns) {
    rounds++;
    const current = pending;
    pending = [];
    allPoints.push(...current);
    for (const point of current) {
      for (const choice of point.choices) {
        if (runs.length >= maxRuns) break;
        const run = await execute({
          id: `lineage-discovery:${choice.id}`,
          perturbations: [choice],
          seed: options.seed,
          metadata: { strategy: "lineage-discovery", round: rounds },
        });
        runs.push(run);
        const expansion = await frontier.expand(run.history, resolve);
        pending.push(...expansion.newFaultPoints);
      }
    }
  }

  // If the last round discovered points but hit maxRounds, preserve them in the
  // returned space even though they were not themselves used to reveal deeper
  // callsites.
  allPoints.push(...pending);
  return {
    baseline,
    runs,
    faultPoints: allPoints,
    rounds,
    discoveredCalls: frontier.discoveredCalls,
  };
}

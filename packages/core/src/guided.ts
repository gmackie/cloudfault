import { checksFailed } from "./checker.js";
import { pairwiseScenarios } from "./covering.js";
import { buildFailureWitness } from "./diagnostics.js";
import { enumerateScenarios, minimizeFailureSet } from "./search.js";
import type { ExplorationResult, FaultPoint, HistoryEvent, Perturbation, RunResult, Scenario } from "./types.js";

function operationKey(run: RunResult): readonly string[] {
  return run.history
    .filter((event) => event.type === "invoke" && event.operation)
    .map((event) => `${event.operation!.target ?? event.operation!.adapter ?? "app"}|${event.operation!.name}|${event.operation!.resource ?? ""}`);
}

function pairKeys(perturbations: readonly Perturbation[]): readonly string[] {
  const ids = perturbations.map((item) => item.id).sort();
  const pairs: string[] = [];
  for (let left = 0; left < ids.length; left++) for (let right = left + 1; right < ids.length; right++) pairs.push(`${ids[left]}|${ids[right]}`);
  return pairs;
}

function operationLabel(event: HistoryEvent | undefined): string {
  const op = event?.operation;
  return op ? `${op.target ?? op.adapter ?? "app"}.${op.name}:${op.resource ?? ""}` : event ? String(event.process) : "unknown";
}

export interface GuidanceSnapshot {
  schema?: "cloudfault.coverage-guidance";
  version?: 1;
  scenarios: number;
  failures: number;
  operationSignatures: number;
  scenarioExecutions?: Readonly<Record<string, number>>;
  perturbationExecutions: Readonly<Record<string, number>>;
  pairExecutions: Readonly<Record<string, number>>;
  operationExecutions?: Readonly<Record<string, number>>;
  failurePerturbations?: Readonly<Record<string, number>>;
  causalPerturbations?: Readonly<Record<string, number>>;
  causalSignatures?: Readonly<Record<string, number>>;
}

function addCounts(target: Map<string, number>, values: Readonly<Record<string, number>> | undefined): void {
  for (const [key, value] of Object.entries(values ?? {})) target.set(key, (target.get(key) ?? 0) + value);
}

export class CoverageGuidance {
  readonly #scenarioCounts = new Map<string, number>();
  readonly #perturbationCounts = new Map<string, number>();
  readonly #pairCounts = new Map<string, number>();
  readonly #operationCounts = new Map<string, number>();
  readonly #failurePerturbations = new Map<string, number>();
  readonly #causalPerturbations = new Map<string, number>();
  readonly #causalSignatures = new Map<string, number>();
  #failures = 0;

  constructor(snapshot?: GuidanceSnapshot) {
    if (snapshot) this.merge(snapshot);
  }

  merge(snapshot: GuidanceSnapshot): this {
    addCounts(this.#scenarioCounts, snapshot.scenarioExecutions);
    addCounts(this.#perturbationCounts, snapshot.perturbationExecutions);
    addCounts(this.#pairCounts, snapshot.pairExecutions);
    addCounts(this.#operationCounts, snapshot.operationExecutions);
    addCounts(this.#failurePerturbations, snapshot.failurePerturbations);
    addCounts(this.#causalPerturbations, snapshot.causalPerturbations);
    addCounts(this.#causalSignatures, snapshot.causalSignatures);
    this.#failures += snapshot.failures ?? 0;
    return this;
  }

  observe(run: RunResult): void {
    this.#scenarioCounts.set(run.scenario.id, (this.#scenarioCounts.get(run.scenario.id) ?? 0) + 1);
    for (const perturbation of run.scenario.perturbations) this.#perturbationCounts.set(perturbation.id, (this.#perturbationCounts.get(perturbation.id) ?? 0) + 1);
    for (const pair of pairKeys(run.scenario.perturbations)) this.#pairCounts.set(pair, (this.#pairCounts.get(pair) ?? 0) + 1);
    for (const operation of operationKey(run)) this.#operationCounts.set(operation, (this.#operationCounts.get(operation) ?? 0) + 1);
    if (checksFailed(run.checks)) {
      this.#failures += 1;
      for (const perturbation of run.scenario.perturbations) this.#failurePerturbations.set(perturbation.id, (this.#failurePerturbations.get(perturbation.id) ?? 0) + 1);
      const witness = buildFailureWitness(run);
      for (const event of witness.perturbationEvents) {
        const id = typeof event.tags?.perturbationId === "string" ? event.tags.perturbationId : undefined;
        if (id) this.#causalPerturbations.set(id, (this.#causalPerturbations.get(id) ?? 0) + 1);
      }
      const bySeq = new Map(run.history.map((event) => [event.seq, event]));
      for (const edge of witness.causalEdges) {
        const signature = `${edge.kind}|${operationLabel(bySeq.get(edge.from))}->${operationLabel(bySeq.get(edge.to))}`;
        this.#causalSignatures.set(signature, (this.#causalSignatures.get(signature) ?? 0) + 1);
      }
    }
  }

  scenarioExecutions(id: string): number { return this.#scenarioCounts.get(id) ?? 0; }
  perturbationExecutions(id: string): number { return this.#perturbationCounts.get(id) ?? 0; }

  score(scenario: Scenario): number {
    let score = scenario.perturbations.length ? 0 : -10_000;
    for (const perturbation of scenario.perturbations) {
      const count = this.#perturbationCounts.get(perturbation.id) ?? 0;
      score += count === 0 ? 1_000 : 120 / (count + 1);
      score += (this.#failurePerturbations.get(perturbation.id) ?? 0) * 20;
      // Prefer faults that were actually on a causal witness over faults that
      // merely co-occurred somewhere in a failing scenario.
      score += (this.#causalPerturbations.get(perturbation.id) ?? 0) * 45;
      const selector = perturbation.selector;
      if (selector?.operation) {
        const prefix = `${selector.target ?? perturbation.target}.${selector.operation}:`;
        const relatedCausal = [...this.#causalSignatures.entries()].reduce((sum, [key, occurrences]) => sum + (key.includes(prefix) ? occurrences : 0), 0);
        score += Math.min(relatedCausal * 4, 40);
      }
    }
    for (const pair of pairKeys(scenario.perturbations)) {
      const count = this.#pairCounts.get(pair) ?? 0;
      score += count === 0 ? 250 : 20 / (count + 1);
    }
    score -= (this.#scenarioCounts.get(scenario.id) ?? 0) * 2_000;
    score -= Math.max(0, scenario.perturbations.length - 3) * 5;
    return score;
  }

  snapshot(): GuidanceSnapshot {
    return {
      schema: "cloudfault.coverage-guidance",
      version: 1,
      scenarios: [...this.#scenarioCounts.values()].reduce((sum, value) => sum + value, 0),
      failures: this.#failures,
      operationSignatures: this.#operationCounts.size,
      scenarioExecutions: Object.fromEntries([...this.#scenarioCounts.entries()].sort()),
      perturbationExecutions: Object.fromEntries([...this.#perturbationCounts.entries()].sort()),
      pairExecutions: Object.fromEntries([...this.#pairCounts.entries()].sort()),
      operationExecutions: Object.fromEntries([...this.#operationCounts.entries()].sort()),
      failurePerturbations: Object.fromEntries([...this.#failurePerturbations.entries()].sort()),
      causalPerturbations: Object.fromEntries([...this.#causalPerturbations.entries()].sort()),
      causalSignatures: Object.fromEntries([...this.#causalSignatures.entries()].sort()),
    };
  }
}

export interface GuidedScenarioOptions {
  maxDepth?: number;
  maxCandidates?: number;
  maxScenarios?: number;
  seed?: number;
  includePreviouslyExecuted?: boolean;
}

export function coverageGuidedScenarios(
  points: readonly FaultPoint[],
  guidance: CoverageGuidance,
  options: GuidedScenarioOptions = {},
): readonly Scenario[] {
  const candidateCap = Math.max(options.maxScenarios ?? 100, options.maxCandidates ?? 2_000);
  const candidates = [
    ...enumerateScenarios(points, { maxDepth: options.maxDepth ?? Math.min(3, points.length), maxScenarios: candidateCap }),
    ...pairwiseScenarios(points, { includeBaseline: false, seed: options.seed, maxScenarios: candidateCap }),
  ];
  const unique = new Map<string, Scenario>();
  for (const scenario of candidates) {
    const normalized = { ...scenario, seed: options.seed ?? scenario.seed, metadata: { ...scenario.metadata, strategy: "coverage-guided" } };
    if (!options.includePreviouslyExecuted && guidance.scenarioExecutions(normalized.id) > 0) continue;
    unique.set(normalized.id, normalized);
  }
  return [...unique.values()]
    .sort((left, right) => guidance.score(right) - guidance.score(left) || left.id.localeCompare(right.id))
    .slice(0, options.maxScenarios ?? 100);
}

export interface GuidedExplorationResult<State = unknown> extends ExplorationResult<State> {
  guidance: GuidanceSnapshot;
}

export async function exploreCoverageGuided<State>(
  points: readonly FaultPoint[],
  execute: (scenario: Scenario) => Promise<RunResult<State>>,
  options: GuidedScenarioOptions & { stopOnFirstFailure?: boolean; minimizeFailure?: boolean; guidance?: CoverageGuidance } = {},
): Promise<GuidedExplorationResult<State>> {
  const guidance = options.guidance ?? new CoverageGuidance();
  const baseline = await execute({ id: "baseline", perturbations: [], seed: options.seed, metadata: { strategy: "coverage-guided" } });
  guidance.observe(baseline);
  const runs: RunResult<State>[] = [];
  const remaining = new Map(coverageGuidedScenarios(points, guidance, { ...options, maxScenarios: options.maxCandidates ?? 2_000 }).map((scenario) => [scenario.id, scenario]));
  let firstFailure: RunResult<State> | undefined;
  const maxRuns = options.maxScenarios ?? 100;

  while (remaining.size && runs.length < maxRuns) {
    const next = [...remaining.values()].sort((left, right) => guidance.score(right) - guidance.score(left) || left.id.localeCompare(right.id))[0]!;
    remaining.delete(next.id);
    const result = await execute(next);
    runs.push(result);
    guidance.observe(result);
    if (checksFailed(result.checks)) {
      firstFailure = result;
      if (options.stopOnFirstFailure ?? true) break;
    }
  }

  if (!firstFailure || options.minimizeFailure === false) return { baseline, runs, firstFailure, guidance: guidance.snapshot() };
  const minimized = await minimizeFailureSet(firstFailure.scenario.perturbations, async (candidate) => {
    const run = await execute({ id: candidate.map((item) => item.id).join("+") || "baseline", perturbations: candidate, seed: options.seed });
    return checksFailed(run.checks);
  });
  return { baseline, runs, firstFailure, minimalFailureSet: minimized.minimal, minimizationAttempts: minimized.attempts, guidance: guidance.snapshot() };
}

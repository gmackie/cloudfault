import { ExecutionIndexer } from "./execution-index.js";
import { History } from "./history.js";
import type {
  FaultPhase,
  OperationRef,
  OutcomeMetadata,
  Perturbation,
  PerturbationActivation,
  PerturbationSelector,
  Scenario,
} from "./types.js";

function isFault(value: Perturbation): value is Perturbation & { phase: FaultPhase } {
  return "phase" in value;
}

function operationTarget(operation: OperationRef): string | undefined {
  return operation.target ?? operation.adapter;
}

function matchesSelector(
  selector: PerturbationSelector | undefined,
  perturbation: Perturbation,
  operation: OperationRef,
  occurrence: number,
  phase?: FaultPhase,
): boolean {
  const target = operationTarget(operation);
  if (perturbation.target && target && perturbation.target !== target) return false;
  if (perturbation.operation && perturbation.operation !== operation.name) return false;
  if (isFault(perturbation) && phase && perturbation.phase !== phase) return false;
  if (!selector) return true;
  if (selector.target && selector.target !== target) return false;
  if (selector.operation && selector.operation !== operation.name) return false;
  if (selector.resource && selector.resource !== operation.resource) return false;
  if (selector.process !== undefined && selector.process !== operation.process) return false;
  if (selector.callsite && selector.callsite !== operation.callsite) return false;
  if (selector.executionIndex && selector.executionIndex !== operation.executionIndex) return false;
  if (selector.occurrence !== undefined && selector.occurrence !== occurrence) return false;
  // statementIndex addresses one sub-operation of a multi-statement operation.
  // The enclosing operation (a D1 batch) carries no statementIndex, so it is
  // deliberately *not* filtered by this: the batch executor has to be able to
  // discover a statement-scoped fault in order to apply it at the right index.
  if (
    selector.statementIndex !== undefined
    && operation.statementIndex !== undefined
    && selector.statementIndex !== operation.statementIndex
  ) {
    return false;
  }
  return true;
}

export interface ScenarioControllerOptions {
  history?: History;
  indexer?: ExecutionIndexer;
  defaultMaxActivations?: number;
}

/**
 * Runtime state for one scenario. The controller is intentionally runtime-
 * agnostic: MSW, auxiliary Workers, Miniflare shims, or staging proxies can
 * all ask the same controller which perturbations should activate.
 */
export class ScenarioController {
  readonly scenario: Scenario;
  readonly history: History;
  readonly indexer: ExecutionIndexer;
  readonly #defaultMaxActivations: number;
  readonly #activations = new Map<string, number>();
  readonly #operationOccurrences = new Map<string, number>();
  readonly #activationLog: PerturbationActivation[] = [];

  constructor(scenario: Scenario, options: ScenarioControllerOptions = {}) {
    this.scenario = scenario;
    this.history = options.history ?? new History();
    this.indexer = options.indexer ?? new ExecutionIndexer();
    this.#defaultMaxActivations = options.defaultMaxActivations ?? 1;
  }

  begin<T extends OperationRef>(operation: T, value?: unknown): T & { executionIndex: string; occurrence: number } {
    const indexed = this.indexer.assign(operation);
    const occurrenceKey = [
      indexed.parentId ?? "root",
      operationTarget(indexed) ?? "app",
      indexed.name,
      indexed.resource ?? "*",
      indexed.callsite ?? "*",
    ].join("\u0000");
    const occurrence = (this.#operationOccurrences.get(occurrenceKey) ?? 0) + 1;
    this.#operationOccurrences.set(occurrenceKey, occurrence);
    const complete = { ...indexed, occurrence };
    this.history.invoke(complete, value);
    return complete;
  }

  eligible(operation: OperationRef, phase?: FaultPhase): readonly Perturbation[] {
    const occurrence = operation.occurrence ?? 1;
    return this.scenario.perturbations.filter((perturbation) => {
      const selector = perturbation.selector;
      const count = this.#activations.get(perturbation.id) ?? 0;
      const max = selector?.maxActivations ?? this.#defaultMaxActivations;
      if (count >= max) return false;
      return matchesSelector(selector, perturbation, operation, occurrence, phase);
    });
  }

  activate(perturbation: Perturbation, operation: OperationRef): PerturbationActivation {
    const count = (this.#activations.get(perturbation.id) ?? 0) + 1;
    this.#activations.set(perturbation.id, count);
    this.history.perturb(perturbation, operation);
    const activation: PerturbationActivation = {
      perturbationId: perturbation.id,
      operationId: operation.id,
      executionIndex: operation.executionIndex,
      occurrence: operation.occurrence ?? 1,
      at: performance.now(),
    };
    this.#activationLog.push(activation);
    return activation;
  }

  take(operation: OperationRef, phase?: FaultPhase): Perturbation | undefined {
    const perturbation = this.eligible(operation, phase)[0];
    if (perturbation) this.activate(perturbation, operation);
    return perturbation;
  }

  complete(
    operation: OperationRef,
    type: "ok" | "fail" | "info",
    value?: unknown,
    outcome?: OutcomeMetadata,
  ): void {
    this.history.complete(operation, type, value, outcome);
  }

  activations(): readonly PerturbationActivation[] {
    return this.#activationLog.map((item) => ({ ...item }));
  }

  activationCount(perturbationId: string): number {
    return this.#activations.get(perturbationId) ?? 0;
  }
}

export type CompletionType = "ok" | "fail" | "info";
export type HistoryEventType = "invoke" | CompletionType | "fault" | "semantic" | "checkpoint";

/**
 * Jepsen-style logical operation identity. `info` completion means that the
 * caller cannot determine whether the operation took effect.
 */
export interface OperationRef {
  id: string;
  name: string;
  process: string | number;
  /** Logical dependency target, e.g. STRIPE, DB, ORDER_STATE. */
  target?: string;
  /** Semantic adapter name, e.g. stripe. */
  adapter?: string;
  /** Logical resource identity, e.g. order:812 or pi_123. */
  resource?: string;
  /** Parent logical operation id. */
  parentId?: string;
  /** Stable source/call-site fingerprint when available. */
  callsite?: string;
  /** Stable, context-relative execution index. */
  executionIndex?: string;
  /** 1-based occurrence of this operation within its logical context. */
  occurrence?: number;
  /** Retry/attempt number when known. */
  attempt?: number;
}

export type ActualOutcome = "committed" | "not-committed" | "unknown";
export type ObservedOutcome = "success" | "definite-failure" | "indeterminate";

export interface OutcomeMetadata {
  actual?: ActualOutcome;
  observed?: ObservedOutcome;
  detail?: string;
}

export interface HistoryEvent<T = unknown> {
  seq: number;
  at: number;
  type: HistoryEventType;
  process: string | number;
  operation?: OperationRef;
  value?: T;
  outcome?: OutcomeMetadata;
  tags?: Record<string, string | number | boolean>;
}

export type FaultPhase =
  | "before-send"
  | "before-commit"
  | "after-commit-before-response"
  | "during-response"
  | "after-response"
  | "delivery";

export type FaultCategory = "provider" | "cloudflare" | "transport" | "resource" | "application";

/**
 * A selector describes *where* a perturbation is eligible to activate.
 * Occurrence is 1-based and context-relative; omitting it means the first
 * matching operation unless `maxActivations` is increased.
 */
export interface PerturbationSelector {
  target?: string;
  operation?: string;
  resource?: string;
  process?: string | number;
  callsite?: string;
  executionIndex?: string;
  occurrence?: number;
  maxActivations?: number;
}

export interface Fault {
  id: string;
  target: string;
  kind: string;
  phase: FaultPhase;
  description: string;
  operation?: string;
  category?: FaultCategory;
  selector?: PerturbationSelector;
  actualOutcome?: ActualOutcome;
  observedOutcome?: ObservedOutcome;
  metadata?: Record<string, unknown>;
}

/** A legal semantic variation is not necessarily a failure. */
export interface SemanticVariation {
  id: string;
  target: string;
  kind: string;
  description: string;
  operation?: string;
  selector?: PerturbationSelector;
  metadata?: Record<string, unknown>;
}

export type Perturbation = Fault | SemanticVariation;

export interface FaultPoint {
  id: string;
  target: string;
  choices: readonly Perturbation[];
}

export interface Scenario {
  id: string;
  perturbations: readonly Perturbation[];
  seed?: number;
  metadata?: Record<string, unknown>;
}

export interface CheckResult {
  valid: boolean;
  checker: string;
  message?: string;
  details?: unknown;
}

export interface RunResult<State = unknown> {
  scenario: Scenario;
  history: readonly HistoryEvent[];
  checks: readonly CheckResult[];
  state?: State;
  durationMs?: number;
}

export interface PerturbationActivation {
  perturbationId: string;
  operationId: string;
  executionIndex?: string;
  occurrence: number;
  at: number;
}

export interface ExplorationResult<State = unknown> {
  baseline?: RunResult<State>;
  runs: readonly RunResult<State>[];
  firstFailure?: RunResult<State>;
  minimalFailureSet?: readonly Perturbation[];
  minimizationAttempts?: number;
}

export interface ReplayDescriptor {
  /** Module that knows how to execute the test again. */
  module?: string;
  exportName?: string;
  testName?: string;
  args?: Record<string, unknown>;
}

export interface FailureArtifact<State = unknown> {
  schema: "cloudfault.failure";
  schemaVersion: 1;
  createdAt: string;
  testName: string;
  seed?: number;
  scenario: Scenario;
  minimalFailureSet?: readonly Perturbation[];
  history: readonly HistoryEvent[];
  checks: readonly CheckResult[];
  state?: State;
  replay?: ReplayDescriptor;
  environment?: Record<string, string | number | boolean | null>;
  metadata?: Record<string, unknown>;
}

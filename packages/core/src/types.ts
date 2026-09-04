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
  /**
   * 0-based index of this sub-operation inside a multi-statement parent, e.g.
   * the Nth statement of a `D1Database.batch([...])`. Absent on operations that
   * are not sub-operations.
   */
  statementIndex?: number;
  /** Caller-minted correlation token an `OutcomeOracle` can be asked about. */
  token?: string;
}

export type ActualOutcome = "committed" | "not-committed" | "unknown";
export type ObservedOutcome = "success" | "definite-failure" | "indeterminate";

/**
 * Where `OutcomeMetadata.actual` came from. This exists so a reader can tell an
 * answer from a guess:
 *
 * - `oracle`   — a privileged backend was asked and answered (`OutcomeOracle`).
 * - `declared` — the injected fault itself defines the outcome, because
 *                CloudFault chose the moment of failure (it cut the wire after
 *                a call that had already returned).
 * - `inferred` — deduced from an observable proxy such as a 2xx status or a
 *                normally-returned binding call. Sound only for backends whose
 *                success implies durability.
 * - `unknown`  — nothing could establish it. Never upgrade this to a guess.
 */
export type ActualOutcomeSource = "oracle" | "declared" | "inferred" | "unknown";

/** One sub-operation of a multi-statement operation, as the provider reports it. */
export interface AppliedSubOperation {
  index: number;
  committed: boolean;
  detail?: string;
}

export interface OutcomeMetadata {
  actual?: ActualOutcome;
  observed?: ObservedOutcome;
  detail?: string;
  /** Provenance of `actual`. Absent means the writer did not say. */
  actualSource?: ActualOutcomeSource;
  /** Provider-side commit ordering for the resource, when an oracle supplied it. */
  version?: number;
  /** Which sub-operations durably applied, when an oracle supplied it. */
  applied?: readonly AppliedSubOperation[];
  /** Free-form provider evidence (rows_written, etag, changes, ...). */
  evidence?: Record<string, unknown>;
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
  /**
   * Addresses one statement inside a multi-statement operation (the Nth
   * statement of a D1 batch). An operation that is *not* a sub-operation
   * carries no `statementIndex` and is therefore not filtered by this, so the
   * enclosing batch executor can still discover a statement-scoped fault and
   * apply it at the right index.
   */
  statementIndex?: number;
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

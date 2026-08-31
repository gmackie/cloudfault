export type HistoryEventType = "invoke" | "ok" | "fail" | "info";

export type ActualOutcome = "committed" | "not-committed" | "unknown";
export type ObservedOutcome = "success" | "failure" | "indeterminate";

export interface EventMeta {
  target?: string;
  adapter?: string;
  faultId?: string;
  semantic?: boolean;
  actualOutcome?: ActualOutcome;
  observedOutcome?: ObservedOutcome;
  [key: string]: unknown;
}

export interface HistoryEvent<T = unknown> {
  sequence: number;
  time: number;
  process: string;
  type: HistoryEventType;
  operation?: string;
  value?: T;
  meta?: EventMeta;
}

export type FaultCategory = "semantic" | "degradation" | "external" | "transport";

export interface Fault {
  id: string;
  label: string;
  target?: string;
  category: FaultCategory;
  metadata?: Record<string, unknown>;
}

export interface CheckSuccess {
  valid: true;
}

export interface CheckFailure {
  valid: false;
  invariant?: string;
  message: string;
  witness?: unknown;
}

export type CheckResult = CheckSuccess | CheckFailure;

export interface ScenarioResult {
  history: { events(): readonly HistoryEvent[] };
  check: CheckResult;
  state?: unknown;
}

export interface FaultScenario {
  faults: readonly Fault[];
  result: ScenarioResult;
}

export interface SearchResult {
  scenarios: readonly FaultScenario[];
  firstFailure?: FaultScenario;
  minimalFailureSet?: readonly Fault[];
}

export interface Invariant<TState = unknown> {
  name: string;
  check(state: TState): CheckResult;
}

export interface OperationIdentity {
  /** A logical identifier such as checkout or queue-consumer. */
  parent?: string;
  /** Provider or Cloudflare primitive. */
  target: string;
  /** Semantic operation such as payment.confirm. */
  operation: string;
  /** Logical resource identity when known, e.g. order:812. */
  resource?: string;
  /** Callsite fingerprint, intentionally opaque to core. */
  callsite?: string;
  /** Context-local occurrence rather than process-global occurrence. */
  ordinal?: number;
  /** Future Distributed Execution Index ancestry. */
  ancestry?: readonly string[];
}

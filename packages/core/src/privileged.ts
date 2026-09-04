import type {
  ActualOutcome,
  ActualOutcomeSource,
  AppliedSubOperation,
  ObservedOutcome,
  OutcomeMetadata,
} from "./types.js";

/**
 * The privileged oracle.
 *
 * CloudFault's outcome model is two-axis: what the application *observed*, and
 * what the provider *actually did*. The observed axis is free — it is whatever
 * the application saw. The actual axis is not: nothing about a destroyed
 * response tells you whether the write landed. Before this interface existed,
 * `OutcomeMetadata.actual` was populated three ways, none of which asked a
 * backend anything: declared on the fault, inferred from `response.ok`, or
 * assumed by a binding proxy.
 *
 * An `OutcomeOracle` is a backend that can be *asked*.
 *
 * ## Why the token is caller-minted
 *
 * The fault that matters most is commit-then-response-lost: the write commits
 * and then the response is destroyed. There is no response to read a
 * correlation id off. So a response-minted token cannot answer the only
 * question worth asking. A caller that mints the token *before* sending can
 * always come back and ask about an attempt whose response it deliberately
 * destroyed.
 *
 * ## The honesty rule
 *
 * An oracle that cannot answer must say so. `outcomeFor()` resolving to
 * `undefined` (or throwing, or 404-ing over HTTP) degrades to
 * `actual: "unknown"`, never to `"committed"`. A proxied real provider has no
 * privileged knowledge at all and must remain `unknown` in the history — see
 * `docs/adapter-authoring.md`.
 */
export type OperationToken = string;

export interface PrivilegedOutcome {
  /** The provider's own answer. Never inferred from an HTTP status. */
  actual: ActualOutcome;
  /**
   * What the provider allowed the caller to observe, when the provider itself
   * chose that (for example `error-after-commit`, where the caller is told the
   * operation failed and it did not).
   */
  observed?: ObservedOutcome;
  /** Provider-side commit ordering for the resource, for consistency checkers. */
  version?: number;
  /** For batch/multi-statement operations: which sub-operations durably applied. */
  applied?: readonly AppliedSubOperation[];
  /** Free-form provider evidence (rows_written, etag, changes, last_row_id, ...). */
  evidence?: Record<string, unknown>;
}

export interface OutcomeOracle {
  /** Identifies the oracle in history detail lines. */
  readonly name?: string;
  /**
   * Answer for one attempt, by the token the caller minted and the backend
   * recorded. Resolving to `undefined` means "I cannot answer", which is a
   * legitimate and load-bearing reply — it must not be read as a failure or as
   * a commit.
   */
  outcomeFor(token: OperationToken): Promise<PrivilegedOutcome | undefined>;
  /** Monotonic commit counter for a logical resource, e.g. `d1:<uuid>`. */
  versionOf?(resource: string): Promise<number | undefined>;
  /** Full privileged state, for state-only invariants at the end of a run. */
  snapshot?(): Promise<unknown>;
  /** Return to a clean baseline between scenarios. */
  reset?(): Promise<void>;
}

/** The header a caller-minted token travels on, in both directions. */
export const OPERATION_TOKEN_HEADER = "x-emulate-operation";

/** Mint a token before sending, so the attempt stays askable after the response dies. */
export function mintOperationToken(prefix = "op"): OperationToken {
  const random = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID().replace(/-/g, "")
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
  return `${prefix}_${random}`;
}

/**
 * Ask the oracle without ever letting a failure become a guess.
 *
 * A thrown error (unreachable emulator, malformed body) and a `undefined`
 * answer are the same thing here: no privileged knowledge. Both return
 * `undefined`, which `outcomeMetadata()` turns into `actual: "unknown"`.
 */
export async function askOracle(
  oracle: OutcomeOracle | undefined,
  token: OperationToken | undefined,
): Promise<PrivilegedOutcome | undefined> {
  if (!oracle || !token) return undefined;
  try {
    return (await oracle.outcomeFor(token)) ?? undefined;
  } catch {
    return undefined;
  }
}

export interface OutcomeMetadataOptions {
  /** What the application observed. Always known locally. */
  observed: ObservedOutcome;
  /**
   * The outcome the *injected fault* declares. Sound only when CloudFault chose
   * the moment of failure itself; recorded as `actualSource: "declared"`.
   */
  declared?: ActualOutcome;
  /**
   * An outcome deduced from an observable proxy (a 2xx status, a binding call
   * that returned normally). Recorded as `actualSource: "inferred"`.
   */
  inferred?: ActualOutcome;
  detail?: string;
  /**
   * Sub-operation results CloudFault itself established — for example when it
   * applied a batch prefix statement by statement and therefore knows exactly
   * which statements ran. Used only when no oracle answered.
   */
  applied?: readonly AppliedSubOperation[];
  /** Locally-established evidence. Used only when no oracle answered. */
  evidence?: Record<string, unknown>;
}

/**
 * Build the history outcome, preferring privileged knowledge and labelling
 * where the answer came from.
 *
 * Precedence is oracle > declared > inferred > unknown. `actualSource` makes
 * the difference auditable: a reader (or a test) can tell "the backend was
 * asked" from "we assumed a 200 meant durable".
 */
export function outcomeMetadata(
  privileged: PrivilegedOutcome | undefined,
  options: OutcomeMetadataOptions,
): OutcomeMetadata {
  if (privileged) {
    return {
      actual: privileged.actual,
      observed: privileged.observed ?? options.observed,
      actualSource: "oracle",
      detail: options.detail,
      version: privileged.version,
      applied: privileged.applied,
      evidence: privileged.evidence,
    };
  }
  // A declared or inferred `"unknown"` is not an answer, so it does not earn a
  // provenance either: "nobody established this" is the whole content of it.
  const declared = options.declared === "unknown" ? undefined : options.declared;
  const inferred = options.inferred === "unknown" ? undefined : options.inferred;
  const actual: ActualOutcome = declared ?? inferred ?? "unknown";
  const source: ActualOutcomeSource = declared ? "declared" : inferred ? "inferred" : "unknown";
  return {
    actual,
    observed: options.observed,
    actualSource: source,
    detail: options.detail,
    applied: options.applied,
    evidence: options.evidence,
  };
}

/**
 * In-memory oracle for tests and for backends that live in the same process as
 * the workload (the shape `StripeMemoryBackend` would grow into). It records
 * nothing on its own: a backend calls `record()` *after* the effect is durable.
 */
export class RecordingOutcomeOracle implements OutcomeOracle {
  readonly name: string;
  readonly #outcomes = new Map<OperationToken, PrivilegedOutcome>();
  readonly #versions = new Map<string, number>();

  constructor(name = "recording") {
    this.name = name;
  }

  record(token: OperationToken, outcome: PrivilegedOutcome): void {
    this.#outcomes.set(token, { ...outcome });
  }

  bumpVersion(resource: string): number {
    const next = (this.#versions.get(resource) ?? 0) + 1;
    this.#versions.set(resource, next);
    return next;
  }

  async outcomeFor(token: OperationToken): Promise<PrivilegedOutcome | undefined> {
    const outcome = this.#outcomes.get(token);
    return outcome ? { ...outcome } : undefined;
  }

  async versionOf(resource: string): Promise<number | undefined> {
    return this.#versions.get(resource);
  }

  async snapshot(): Promise<{ outcomes: Record<string, PrivilegedOutcome>; versions: Record<string, number> }> {
    return {
      outcomes: Object.fromEntries(this.#outcomes),
      versions: Object.fromEntries(this.#versions),
    };
  }

  async reset(): Promise<void> {
    this.#outcomes.clear();
    this.#versions.clear();
  }
}

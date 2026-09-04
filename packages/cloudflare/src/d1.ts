import {
  askOracle,
  outcomeMetadata,
  ScenarioController,
  type AppliedSubOperation,
  type Fault,
  type OperationRef,
  type OutcomeOracle,
  type Perturbation,
  type SemanticVariation,
} from "@cloudfault/core";

function d1Fault(target: string, kind: string, description: string, metadata?: Record<string, unknown>): Fault {
  return {
    id: `${target}:${kind}`,
    target,
    kind,
    phase: "before-commit",
    category: "cloudflare",
    description,
    actualOutcome: "unknown",
    observedOutcome: "definite-failure",
    selector: { target },
    metadata,
  };
}

export function d1TransientNetworkError(target = "D1"): Fault {
  return d1Fault(target, "transient-network-error", `${target} encounters a transient network failure`);
}
export function d1StorageReset(target = "D1"): Fault {
  return d1Fault(target, "storage-reset", `${target} storage path resets during an operation`);
}
export function d1ReplicaUnavailable(target = "D1"): Fault {
  return d1Fault(target, "replica-unavailable", `${target} read replica becomes temporarily unavailable`);
}
export function d1OperationTimeout(target = "D1"): Fault {
  return d1Fault(target, "operation-timeout", `${target} operation exceeds its storage/network deadline`);
}
export function d1CommitThenTimeout(target = "D1", operation = "d1.run"): Fault {
  return {
    id: `${target}:${operation}:commit-then-timeout`,
    target,
    operation,
    kind: "commit-then-timeout",
    phase: "after-commit-before-response",
    category: "cloudflare",
    description: `${target} commits a write but the caller loses the result`,
    actualOutcome: "committed",
    observedOutcome: "indeterminate",
    selector: { target, operation },
  };
}

/* ------------------------------------------------------------------------- *
 * Batch fault vocabulary
 *
 * FIDELITY NOTE, and it governs everything below.
 *
 * Real D1 `batch()` is ATOMIC: the statements run inside an implicit
 * transaction, and either all of them commit or none of them do. Cloudflare
 * documents this, and Miniflare's D1 implementation honours it. So of the four
 * batch faults here, three model something D1 can genuinely do to you and the
 * fourth does not:
 *
 *   d1BatchRejectBeforeCommit     real: the batch never reaches storage.
 *   d1BatchCommitThenResponseLost real: the batch commits and the caller loses
 *                                 the answer. This is THE D1 fault.
 *   d1BatchErrorAfterCommit       real: the batch commits and the caller is told
 *                                 it failed. Worse than ambiguity, because the
 *                                 application acts on a definite wrong answer.
 *   d1PartialBatchApplication     NOT REAL. A contract probe. See below.
 * ------------------------------------------------------------------------- */

/**
 * Fault kinds that model nothing Cloudflare does.
 *
 * A contract probe tests whether an application's assumptions are *portable* —
 * whether it silently depends on a guarantee that is real today but is neither
 * checked nor documented in the application's own code. That is worth
 * discovering; presenting it as D1 behaviour would be a lie. So probes are
 * refused unless the proxy is constructed with `allowContractProbes: true`,
 * mirroring the emulate emulator, which refuses the same kinds unless a plan
 * opts in.
 */
export const D1_CONTRACT_PROBE_KINDS: ReadonlySet<string> = new Set([
  "partial-batch-application",
]);

export class D1ContractProbeRefusedError extends Error {
  readonly perturbation: Perturbation;
  constructor(perturbation: Perturbation) {
    super(
      `'${perturbation.kind}' is a contract probe, not a fidelity claim: real D1 batches are atomic, `
      + `so this outcome cannot happen against Cloudflare. Construct the proxy with `
      + `{ allowContractProbes: true } to run it as a portability probe.`,
    );
    this.name = "D1ContractProbeRefusedError";
    this.perturbation = perturbation;
  }
}

/** The batch is refused before any statement reaches storage. Nothing applies. */
export function d1BatchRejectBeforeCommit(target = "D1"): Fault {
  return {
    id: `${target}:d1.batch:reject-before-commit`,
    target,
    operation: "d1.batch",
    kind: "reject-before-commit",
    phase: "before-commit",
    category: "cloudflare",
    description: `${target} rejects a batch before any statement commits`,
    actualOutcome: "not-committed",
    observedOutcome: "definite-failure",
    selector: { target, operation: "d1.batch" },
  };
}

/**
 * The batch commits in full and the caller loses the response. Real D1: a
 * `batch()` whose subrequest exceeds its deadline. Every statement landed; the
 * caller cannot know that. A blind retry re-applies the whole batch.
 */
export function d1BatchCommitThenResponseLost(target = "D1"): Fault {
  return {
    id: `${target}:d1.batch:commit-then-response-lost`,
    target,
    operation: "d1.batch",
    kind: "commit-then-response-lost",
    phase: "after-commit-before-response",
    category: "cloudflare",
    description: `${target} commits a batch but the caller loses the response`,
    actualOutcome: "committed",
    observedOutcome: "indeterminate",
    selector: { target, operation: "d1.batch" },
  };
}

/**
 * The batch commits in full and the caller is told it failed. Real D1, and
 * nastier than ambiguity: the application has a definite answer and it is
 * wrong, so compensating logic runs against state that already changed.
 */
export function d1BatchErrorAfterCommit(target = "D1"): Fault {
  return {
    id: `${target}:d1.batch:error-after-commit`,
    target,
    operation: "d1.batch",
    kind: "error-after-commit",
    phase: "after-commit-before-response",
    category: "cloudflare",
    description: `${target} commits a batch and then answers with an error`,
    actualOutcome: "committed",
    observedOutcome: "definite-failure",
    selector: { target, operation: "d1.batch" },
  };
}

/**
 * CONTRACT PROBE — real D1 batches are atomic and never do this.
 *
 * Statements `[0, statementIndex)` durably apply and `[statementIndex, n)` do
 * not, then the caller sees a failure. Running it requires
 * `allowContractProbes: true`; it answers "does this write survive a
 * non-atomic multi-statement backend?", which is what you want to know before
 * the code moves to a backend that offers no such guarantee.
 *
 * @param statementIndex 0-based index of the first statement that does NOT apply.
 */
export function d1PartialBatchApplication(target = "D1", statementIndex = 1): Fault {
  return {
    id: `${target}:d1.batch:partial-batch-application:${statementIndex}`,
    target,
    operation: "d1.batch",
    kind: "partial-batch-application",
    phase: "after-commit-before-response",
    category: "cloudflare",
    description:
      `CONTRACT PROBE (real D1 batches are atomic): ${target} applies batch statements `
      + `[0,${statementIndex}) and drops the rest`,
    actualOutcome: "committed",
    observedOutcome: "indeterminate",
    selector: { target, operation: "d1.batch", statementIndex },
    metadata: { statementIndex, contractProbe: true },
  };
}

/** Sequential-consistency/session model for D1 read-replica tests. */
export class D1SessionModel {
  #primaryVersion = 0;
  readonly #replicas = new Map<string, number>();
  readonly #sessions = new Map<string, number>();

  commit(): number { return ++this.#primaryVersion; }
  primaryVersion(): number { return this.#primaryVersion; }
  setReplicaVersion(replica: string, version: number): void {
    if (version < 0 || version > this.#primaryVersion) throw new Error(`Invalid replica version ${version}`);
    this.#replicas.set(replica, version);
  }
  observe(replica: string, session?: string): number {
    const replicaVersion = this.#replicas.get(replica) ?? this.#primaryVersion;
    if (!session) return replicaVersion;
    const minimum = this.#sessions.get(session) ?? 0;
    const observed = Math.max(replicaVersion, minimum);
    this.#sessions.set(session, observed);
    return observed;
  }
  recordWrite(session: string, version = this.#primaryVersion): void {
    this.#sessions.set(session, Math.max(this.#sessions.get(session) ?? 0, version));
  }
}

export function d1ReplicaLag(target: string, replica: string, versionsBehind = 1): SemanticVariation {
  return {
    id: `${target}:replica-lag:${replica}:${versionsBehind}`,
    target,
    kind: "replica-lag",
    description: `${target} replica ${replica} observes ${versionsBehind} committed version(s) behind primary`,
    selector: { target },
    metadata: { replica, versionsBehind },
  };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(columnName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<unknown>;
  run<T = unknown>(): Promise<T>;
  raw<T = unknown>(options?: unknown): Promise<T[]>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch?<T = unknown>(statements: readonly D1PreparedStatementLike[]): Promise<T[]>;
  exec?<T = unknown>(query: string): Promise<T>;
  dump?(): Promise<ArrayBuffer>;
}

export class D1InjectedError extends Error {
  readonly perturbation: Perturbation;
  constructor(perturbation: Perturbation) {
    super(`CloudFault injected D1 fault '${perturbation.kind}'`);
    this.name = "D1InjectedError";
    this.perturbation = perturbation;
  }
}

export class D1IndeterminateError extends Error {
  readonly perturbation: Perturbation;
  constructor(perturbation: Perturbation) {
    super(`D1 operation may have committed: '${perturbation.kind}'`);
    this.name = "D1IndeterminateError";
    this.perturbation = perturbation;
  }
}

export interface D1FaultProxyOptions {
  target?: string;
  process?: string | number;
  controller: ScenarioController;
  callsite?: string;
  /**
   * A privileged backend that can be *asked* what actually happened, rather
   * than having it inferred. Without one, `actual` falls back to what the
   * injected fault declares (sound only because CloudFault chose the moment of
   * failure) or to `unknown`.
   */
  oracle?: OutcomeOracle;
  /**
   * Mints the caller-minted correlation token for an operation and hands it to
   * whatever propagates it to the privileged backend — an `x-emulate-operation`
   * header on an HTTP-backed D1 client, a per-request slot on a local fake.
   * Return `undefined` to skip the oracle for this operation.
   *
   * The token is minted *before* the call precisely so an operation whose
   * response CloudFault destroyed can still be asked about.
   */
  token?: (operation: OperationRef) => string | undefined;
  /**
   * Permit fault kinds in `D1_CONTRACT_PROBE_KINDS`, which model behaviour real
   * D1 does not have. Off by default so a probe can never be mistaken for
   * fidelity.
   */
  allowContractProbes?: boolean;
}

interface OutcomeSeam {
  oracle?: OutcomeOracle;
  token?: string;
}

async function completeFailure(
  controller: ScenarioController,
  operation: OperationRef,
  perturbation: Perturbation,
  seam: OutcomeSeam = {},
): Promise<never> {
  const fault = "phase" in perturbation ? perturbation : undefined;
  const observed = fault?.observedOutcome ?? "definite-failure";
  const indeterminate = observed === "indeterminate";
  const privileged = await askOracle(seam.oracle, seam.token);
  controller.complete(
    operation,
    indeterminate ? "info" : "fail",
    undefined,
    outcomeMetadata(privileged, {
      observed,
      declared: fault?.actualOutcome,
      detail: perturbation.description,
    }),
  );
  if (indeterminate) throw new D1IndeterminateError(perturbation);
  throw new D1InjectedError(perturbation);
}

function operationRef(
  target: string,
  process: string | number,
  name: string,
  sql: string,
  callsite?: string,
): OperationRef {
  return {
    id: `${target}:${name}:${Math.random().toString(36).slice(2)}`,
    name,
    target,
    process,
    resource: sql,
    callsite,
  };
}
/**
 * A shape any `D1Database` satisfies, including `@cloudflare/workers-types`'
 * `D1Database`, whose method signatures are more specific than
 * `D1DatabaseLike`'s and therefore not mutually assignable with it. It exists
 * only so consumers do not need a type assertion to wrap a real binding; the
 * returned proxy keeps the caller's exact type.
 */
export interface D1DatabaseCompatible {
  prepare(query: string): unknown;
}

/** Reads the cut point for a partial-batch probe: the first statement that does NOT apply. */
function statementCut(perturbation: Perturbation, count: number): number {
  const fromSelector = perturbation.selector?.statementIndex;
  const fromMetadata = perturbation.metadata?.statementIndex;
  const raw = typeof fromSelector === "number"
    ? fromSelector
    : typeof fromMetadata === "number"
      ? fromMetadata
      : 1;
  return Math.max(0, Math.min(count, Math.trunc(raw)));
}

/**
 * Wrap a D1 binding without changing its fluent statement-builder shape.
 * `prepare().bind().all()/first()/raw()/run()` still behave like the underlying
 * object; CloudFault only interposes at terminal operations, and at `batch()`.
 *
 * `batch()` matters more than the single-statement path: `@effect/sql-d1`,
 * Drizzle and every hand-rolled guarded write express their multi-statement
 * unit of work through it, so a proxy that only interposes on
 * `prepare().bind().run()` cannot reach an application's most important
 * invariants at all.
 */
export function createD1FaultProxy<T extends D1DatabaseLike>(database: T, options: D1FaultProxyOptions): T;
export function createD1FaultProxy<T extends D1DatabaseCompatible>(database: T, options: D1FaultProxyOptions): T;
export function createD1FaultProxy(
  database: D1DatabaseLike,
  options: D1FaultProxyOptions,
): D1DatabaseLike {
  const target = options.target ?? "D1";
  const process = options.process ?? "d1";
  const controller = options.controller;
  const oracle = options.oracle;

  /**
   * Proxied statement -> the real statement it wraps, plus its SQL.
   *
   * `batch()` must hand the runtime the *real* statements: workerd reads
   * internal state off a `D1PreparedStatement`, and a Proxy in front of it is
   * not a safe substitute. Unwrapping here is what lets the fluent surface stay
   * proxied while the batch call itself stays native.
   */
  const wrapped = new WeakMap<object, { real: D1PreparedStatementLike; sql: string }>();

  const begin = (name: string, sql: string, extra?: Partial<OperationRef>, value?: unknown) => {
    const ref: OperationRef = {
      ...operationRef(target, process, name, sql, options.callsite),
      ...extra,
    };
    const token = options.token?.(ref);
    return controller.begin(token ? { ...ref, token } : ref, value);
  };

  const refuseProbe = (perturbation: Perturbation, operation?: OperationRef): void => {
    if (!D1_CONTRACT_PROBE_KINDS.has(perturbation.kind) || options.allowContractProbes) return;
    if (operation) {
      controller.complete(operation, "fail", undefined, {
        actual: "not-committed",
        observed: "definite-failure",
        actualSource: "declared",
        detail: `contract probe '${perturbation.kind}' refused`,
      });
    }
    throw new D1ContractProbeRefusedError(perturbation);
  };

  async function terminal<TResult>(name: string, sql: string, action: () => Promise<TResult>): Promise<TResult> {
    const operation = begin(name, sql);
    const seam: OutcomeSeam = { oracle, token: operation.token };
    const before = controller.take(operation, "before-commit") ?? controller.take(operation, "before-send");
    if (before) {
      refuseProbe(before, operation);
      return completeFailure(controller, operation, before, seam);
    }
    try {
      const result = await action();
      const after = controller.take(operation, "after-commit-before-response")
        ?? controller.take(operation, "during-response");
      if (after) {
        refuseProbe(after, operation);
        return completeFailure(controller, operation, after, seam);
      }
      const privileged = await askOracle(oracle, seam.token);
      controller.complete(operation, "ok", undefined, outcomeMetadata(privileged, {
        observed: "success",
        // The binding call returned normally, so the effect is durable as far
        // as the binding can tell. That is a deduction from an observable
        // proxy, not privileged knowledge, so it is labelled `inferred`.
        inferred: "committed",
      }));
      return result;
    } catch (error) {
      if (error instanceof D1InjectedError || error instanceof D1IndeterminateError) throw error;
      controller.complete(operation, "fail", undefined, {
        actual: "unknown",
        observed: "definite-failure",
        actualSource: "unknown",
        detail: String(error),
      });
      throw error;
    }
  }

  const wrapStatement = (real: D1PreparedStatementLike, sql: string): D1PreparedStatementLike => {
    const proxy = new Proxy(real as object, {
      get(statementTarget, key, receiver) {
        if (key === "bind") return (...values: unknown[]) => wrapStatement(real.bind(...values), sql);
        if (key === "first" || key === "all" || key === "run" || key === "raw") {
          return (...args: unknown[]) =>
            terminal(`d1.${String(key)}`, sql, () =>
              (Reflect.get(statementTarget, key) as (...values: unknown[]) => Promise<unknown>).apply(statementTarget, args));
        }
        return Reflect.get(statementTarget, key, receiver);
      },
    }) as D1PreparedStatementLike;
    wrapped.set(proxy as object, { real, sql });
    return proxy;
  };

  const unwrap = (statement: D1PreparedStatementLike): { real: D1PreparedStatementLike; sql: string } =>
    wrapped.get(statement as object) ?? { real: statement, sql: "<unwrapped statement>" };

  /**
   * CONTRACT PROBE PATH — real D1 never takes it.
   *
   * Applying a prefix requires bypassing `batch()` entirely and running the
   * statements one at a time, because the whole point of the real call is that
   * it is atomic. `refuseProbe` has already established that the caller asked
   * for this explicitly.
   */
  async function applyPrefix(
    operation: OperationRef,
    entries: readonly { real: D1PreparedStatementLike; sql: string }[],
    probe: Perturbation,
    seam: OutcomeSeam,
  ): Promise<never> {
    const cut = statementCut(probe, entries.length);
    const applied: AppliedSubOperation[] = [];
    let failure: unknown;

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const child = begin("d1.batch.statement", entry.sql, { parentId: operation.id, statementIndex: index });
      if (index >= cut || failure) {
        controller.complete(child, "fail", undefined, {
          actual: "not-committed",
          observed: "definite-failure",
          actualSource: "declared",
          detail: `${probe.kind}: statement dropped`,
        });
        applied.push({ index, committed: false, detail: "dropped by contract probe" });
        continue;
      }
      try {
        await entry.real.run();
        controller.complete(child, "ok", undefined, {
          actual: "committed",
          observed: "success",
          actualSource: "inferred",
        });
        applied.push({ index, committed: true });
      } catch (error) {
        failure = error;
        controller.complete(child, "fail", undefined, {
          actual: "unknown",
          observed: "definite-failure",
          actualSource: "unknown",
          detail: String(error),
        });
        applied.push({ index, committed: false, detail: String(error) });
      }
    }

    const privileged = await askOracle(seam.oracle, seam.token);
    const committedAny = applied.some((entry) => entry.committed);
    controller.complete(operation, "info", { statements: entries.length, appliedThrough: cut }, outcomeMetadata(privileged, {
      observed: "indeterminate",
      // CloudFault ran the prefix itself, so it genuinely knows which
      // statements landed even with no oracle configured. `declared`, not
      // `inferred`: the harness caused the outcome it is reporting.
      declared: committedAny ? "committed" : "not-committed",
      detail: probe.description ?? probe.kind,
      applied,
    }));
    if (failure) throw failure;
    throw new D1IndeterminateError(probe);
  }

  async function batch<TResult>(input: readonly D1PreparedStatementLike[]): Promise<TResult[]> {
    const entries = [...input].map(unwrap);
    const operation = begin("d1.batch", entries.map((entry) => entry.sql).join("; "), undefined, {
      statements: entries.length,
    });
    const seam: OutcomeSeam = { oracle, token: operation.token };

    const before = controller.take(operation, "before-commit") ?? controller.take(operation, "before-send");
    if (before) {
      refuseProbe(before, operation);
      return completeFailure(controller, operation, before, seam);
    }

    // A partial application has to be decided *before* dispatch, because
    // applying a prefix means not calling the atomic batch at all. Peek at the
    // after-commit phase without consuming any other eligible fault.
    const probe = controller
      .eligible(operation, "after-commit-before-response")
      .find((perturbation) => D1_CONTRACT_PROBE_KINDS.has(perturbation.kind));
    if (probe) {
      refuseProbe(probe, operation);
      controller.activate(probe, operation);
      return applyPrefix(operation, entries, probe, seam);
    }

    try {
      const runBatch = database.batch;
      if (typeof runBatch !== "function") throw new TypeError("The wrapped D1 binding does not implement batch()");
      // Real D1 batches are atomic: every statement below commits, or none does.
      const results = await runBatch.call(database, entries.map((entry) => entry.real)) as TResult[];
      const after = controller.take(operation, "after-commit-before-response")
        ?? controller.take(operation, "during-response");
      if (after) {
        refuseProbe(after, operation);
        return completeFailure(controller, operation, after, {
          ...seam,
          // Atomicity is what lets a batch-scoped fault report every statement
          // as applied without asking anyone: the call returned.
        });
      }
      const privileged = await askOracle(oracle, seam.token);
      controller.complete(operation, "ok", { statements: entries.length }, outcomeMetadata(privileged, {
        observed: "success",
        inferred: "committed",
        applied: entries.map((_entry, index) => ({ index, committed: true })),
      }));
      return results;
    } catch (error) {
      if (
        error instanceof D1InjectedError
        || error instanceof D1IndeterminateError
        || error instanceof D1ContractProbeRefusedError
      ) throw error;
      controller.complete(operation, "fail", undefined, {
        actual: "unknown",
        observed: "definite-failure",
        actualSource: "unknown",
        detail: String(error),
      });
      throw error;
    }
  }

  return new Proxy(database as object, {
    get(targetObject, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => wrapStatement((targetObject as D1DatabaseLike).prepare(sql), sql);
      }
      if (property === "batch" && typeof (targetObject as D1DatabaseLike).batch === "function") return batch;
      return Reflect.get(targetObject, property, receiver);
    },
  }) as D1DatabaseLike;
}

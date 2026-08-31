import { ScenarioController, type Fault, type OperationRef, type Perturbation, type SemanticVariation } from "@cloudfault/core";

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
}

function completeFailure(controller: ScenarioController, operation: OperationRef, perturbation: Perturbation): never {
  const fault = "phase" in perturbation ? perturbation : undefined;
  const actual = fault?.actualOutcome ?? "unknown";
  const observed = fault?.observedOutcome ?? "definite-failure";
  const indeterminate = observed === "indeterminate";
  controller.complete(operation, indeterminate ? "info" : "fail", undefined, {
    actual,
    observed,
    detail: perturbation.description,
  });
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
 * Wrap a D1 binding without changing its fluent statement-builder shape.
 * `prepare().bind().all()/first()/raw()/run()` still behave like the underlying
 * object; CloudFault only interposes at terminal operations.
 */
export function createD1FaultProxy<T extends D1DatabaseLike>(
  database: T,
  options: D1FaultProxyOptions,
): T {
  const target = options.target ?? "D1";
  const process = options.process ?? "d1";
  const controller = options.controller;

  const wrap = (statement: D1PreparedStatementLike, sql: string): D1PreparedStatementLike => ({
    bind(...values: unknown[]) {
      return wrap(statement.bind(...values), sql);
    },
    async first<TValue = unknown>(columnName?: string): Promise<TValue | null> {
      return terminal<TValue | null>("d1.first", () => statement.first<TValue>(columnName));
    },
    async all<TValue = unknown>(): Promise<unknown> {
      return terminal("d1.all", () => statement.all<TValue>());
    },
    async raw<TValue = unknown>(rawOptions?: unknown): Promise<TValue[]> {
      return terminal<TValue[]>("d1.raw", () => statement.raw<TValue>(rawOptions));
    },
    async run<TValue = unknown>(): Promise<TValue> {
      return terminal<TValue>("d1.run", () => statement.run<TValue>());
    },
  });

  async function terminal<TResult>(name: string, invoke: () => Promise<TResult>): Promise<TResult> {
    const operation = controller.begin(operationRef(target, process, name, currentSql!, options.callsite));
    const before = controller.take(operation, "before-commit") ?? controller.take(operation, "before-send");
    if (before) return completeFailure(controller, operation, before);
    try {
      const result = await invoke();
      const after = controller.take(operation, "after-commit-before-response") ?? controller.take(operation, "during-response");
      if (after) return completeFailure(controller, operation, after);
      controller.complete(operation, "ok", undefined, { actual: "committed", observed: "success" });
      return result;
    } catch (error) {
      if (error instanceof D1InjectedError || error instanceof D1IndeterminateError) throw error;
      controller.complete(operation, "fail", undefined, { actual: "unknown", observed: "definite-failure", detail: String(error) });
      throw error;
    }
  }

  // The terminal helper is shared by statement wrappers. The JS call stack is
  // synchronous between prepare() and terminal invocation, so a small scoped
  // variable keeps the implementation structural without mutating statements.
  let currentSql: string | undefined;
  const proxy = new Proxy(database as D1DatabaseLike, {
    get(targetObject, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => {
          currentSql = sql;
          const statement = targetObject.prepare(sql);
          const wrapped = wrap(statement, sql);
          // Rebind terminal operations to a closure with the correct SQL so
          // interleaved prepared statements do not share currentSql.
          const bindSql = (method: "first" | "all" | "run" | "raw") => async (...args: unknown[]) => {
            const operation = controller.begin(operationRef(target, process, `d1.${method}`, sql, options.callsite));
            const before = controller.take(operation, "before-commit") ?? controller.take(operation, "before-send");
            if (before) return completeFailure(controller, operation, before);
            try {
              const result = await (statement[method] as (...values: unknown[]) => Promise<unknown>)(...args);
              const after = controller.take(operation, "after-commit-before-response") ?? controller.take(operation, "during-response");
              if (after) return completeFailure(controller, operation, after);
              controller.complete(operation, "ok", undefined, { actual: "committed", observed: "success" });
              return result;
            } catch (error) {
              if (error instanceof D1InjectedError || error instanceof D1IndeterminateError) throw error;
              controller.complete(operation, "fail", undefined, { actual: "unknown", observed: "definite-failure", detail: String(error) });
              throw error;
            }
          };
          const statementProxy = new Proxy(wrapped, {
            get(statementTarget, key, statementReceiver) {
              if (key === "bind") {
                return (...values: unknown[]) => createStatementProxy(statement.bind(...values), sql);
              }
              if (key === "first" || key === "all" || key === "run" || key === "raw") return bindSql(key);
              return Reflect.get(statementTarget, key, statementReceiver);
            },
          });
          return statementProxy;
        };
      }
      return Reflect.get(targetObject, property, receiver);
    },
  });

  function createStatementProxy(statement: D1PreparedStatementLike, sql: string): D1PreparedStatementLike {
    return new Proxy(statement, {
      get(statementTarget, key, receiver) {
        if (key === "bind") return (...values: unknown[]) => createStatementProxy(statement.bind(...values), sql);
        if (key === "first" || key === "all" || key === "run" || key === "raw") {
          return async (...args: unknown[]) => {
            const operation = controller.begin(operationRef(target, process, `d1.${String(key)}`, sql, options.callsite));
            const before = controller.take(operation, "before-commit") ?? controller.take(operation, "before-send");
            if (before) return completeFailure(controller, operation, before);
            try {
              const result = await (statementTarget[key] as (...values: unknown[]) => Promise<unknown>)(...args);
              const after = controller.take(operation, "after-commit-before-response") ?? controller.take(operation, "during-response");
              if (after) return completeFailure(controller, operation, after);
              controller.complete(operation, "ok", undefined, { actual: "committed", observed: "success" });
              return result;
            } catch (error) {
              if (error instanceof D1InjectedError || error instanceof D1IndeterminateError) throw error;
              controller.complete(operation, "fail", undefined, { actual: "unknown", observed: "definite-failure", detail: String(error) });
              throw error;
            }
          };
        }
        return Reflect.get(statementTarget, key, receiver);
      },
    }) as D1PreparedStatementLike;
  }

  return proxy as T;
}

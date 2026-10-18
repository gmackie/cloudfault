import {
  askOracle,
  outcomeMetadata,
  ScenarioController,
  type Fault,
  type FaultPhase,
  type OperationRef,
  type OutcomeOracle,
  type Perturbation,
  type SemanticVariation,
} from "@cloudfault/core";

/**
 * Hyperdrive is a connection string, not an API: the Worker talks Postgres
 * through a driver over a socket Hyperdrive pools and, for reads, caches. So
 * CloudFault cannot interpose on the binding itself. It interposes on the
 * driver's query entry point instead (`createHyperdriveFaultProxy`), and models
 * the failures that live between the Worker and the origin database.
 */

function hyperdriveFault(target: string, kind: string, phase: FaultPhase, description: string, outcome: Pick<Fault, "actualOutcome" | "observedOutcome">): Fault {
  return { id: `${target}:${kind}`, target, kind, phase, category: "cloudflare", description, ...outcome, selector: { target } };
}

/** The origin database (or the tunnel to it) refuses the connection; nothing ran. */
export function hyperdriveOriginUnavailable(target = "HYPERDRIVE"): Fault {
  return hyperdriveFault(target, "origin-unavailable", "before-send", `${target} cannot reach the origin database`, { actualOutcome: "not-committed", observedOutcome: "definite-failure" });
}

/** Every pooled origin connection is busy; the query is rejected before it is sent. */
export function hyperdrivePoolExhausted(target = "HYPERDRIVE"): Fault {
  return hyperdriveFault(target, "connection-pool-exhausted", "before-send", `${target} has no free origin connection`, { actualOutcome: "not-committed", observedOutcome: "definite-failure" });
}

/** The query exceeds its deadline after reaching the origin, so whether it committed is unknown. */
export function hyperdriveQueryTimeout(target = "HYPERDRIVE"): Fault {
  return hyperdriveFault(target, "query-timeout", "during-response", `${target} query times out after reaching the origin`, { actualOutcome: "unknown", observedOutcome: "indeterminate" });
}

/** The origin commits the statement but the caller loses the result. */
export function hyperdriveCommitThenTimeout(target = "HYPERDRIVE"): Fault {
  return hyperdriveFault(target, "commit-then-timeout", "after-commit-before-response", `${target} commits a write but the caller loses the result`, { actualOutcome: "committed", observedOutcome: "indeterminate" });
}

/**
 * Hyperdrive caches the results of non-mutating queries (60 seconds by
 * default), so a read can legally return a result older than a write the same
 * application just made. That is a semantic variation, not a failure.
 */
export function hyperdriveCachedRead(target = "HYPERDRIVE"): SemanticVariation {
  return {
    id: `${target}:cached-read`,
    target,
    kind: "cached-read",
    description: `${target} serves a read from its query cache instead of the origin`,
    selector: { target },
  };
}

export class HyperdriveInjectedError extends Error {
  readonly perturbation: Perturbation;
  constructor(perturbation: Perturbation) {
    super(`CloudFault injected Hyperdrive fault '${perturbation.kind}'`);
    this.name = "HyperdriveInjectedError";
    this.perturbation = perturbation;
  }
}

export class HyperdriveIndeterminateError extends Error {
  readonly perturbation: Perturbation;
  constructor(perturbation: Perturbation) {
    super(`Hyperdrive query may have committed: '${perturbation.kind}'`);
    this.name = "HyperdriveIndeterminateError";
    this.perturbation = perturbation;
  }
}

export interface HyperdriveFaultProxyOptions {
  controller: ScenarioController;
  target?: string;
  process?: string | number;
  callsite?: string;
  /** Methods to interpose on, for drivers with a client object (`pg`). Default: query, unsafe. */
  methods?: readonly string[];
  oracle?: OutcomeOracle;
  token?: (operation: OperationRef) => string | undefined;
}

const READ_ONLY = /^\s*(\(\s*)*(select|show|explain|values|table)\b/i;

function isFault(perturbation: Perturbation): perturbation is Fault {
  return "phase" in perturbation;
}

/** SQL text from `pg`'s (text | { text }) or postgres.js' tagged-template strings array. */
function sqlText(args: readonly unknown[]): string {
  const [first] = args;
  if (typeof first === "string") return first;
  if (Array.isArray(first)) return first.join("?");
  if (first && typeof first === "object" && typeof (first as { text?: unknown }).text === "string") return (first as { text: string }).text;
  return "<query>";
}

function cacheKey(args: readonly unknown[]): string {
  try { return JSON.stringify(args); } catch { return sqlText(args); }
}

/**
 * Wrap a Postgres client reached through Hyperdrive. A callable client
 * (postgres.js' `sql\`...\``) is interposed on its call; a client object
 * (`pg`'s `client.query()`) on the listed methods. Everything else passes
 * through untouched, so the driver keeps its shape.
 *
 * Read-only queries remember their last result so `hyperdriveCachedRead` can
 * replay it: the cached view is one the real cache could have served.
 */
export function createHyperdriveFaultProxy<T extends object>(client: T, options: HyperdriveFaultProxyOptions): T {
  const target = options.target ?? "HYPERDRIVE";
  const process = options.process ?? "hyperdrive";
  const methods = new Set(options.methods ?? ["query", "unsafe"]);
  const { controller, oracle } = options;
  const cache = new Map<string, unknown>();

  const fail = async (operation: OperationRef, fault: Fault, token?: string): Promise<never> => {
    controller.activate(fault, operation);
    const indeterminate = fault.observedOutcome === "indeterminate";
    controller.complete(operation, indeterminate ? "info" : "fail", undefined, outcomeMetadata(await askOracle(oracle, token), {
      observed: fault.observedOutcome ?? "definite-failure",
      declared: fault.actualOutcome,
      detail: fault.description,
    }));
    throw indeterminate ? new HyperdriveIndeterminateError(fault) : new HyperdriveInjectedError(fault);
  };

  const run = async (name: string, args: readonly unknown[], action: () => unknown): Promise<unknown> => {
    const sql = sqlText(args);
    const ref: OperationRef = { id: `${target}:${name}:${Math.random().toString(36).slice(2)}`, name, target, process, resource: sql, callsite: options.callsite };
    const token = options.token?.(ref);
    const operation = controller.begin(token ? { ...ref, token } : ref);
    const faultAt = (phase: FaultPhase) => controller.eligible(operation, phase).find(isFault);

    const before = faultAt("before-send") ?? faultAt("before-commit");
    if (before) return fail(operation, before, token);

    const readOnly = READ_ONLY.test(sql);
    const key = cacheKey(args);
    if (readOnly && cache.has(key)) {
      const cached = controller.eligible(operation).find((item) => !isFault(item) && item.kind === "cached-read");
      if (cached) {
        controller.activate(cached, operation);
        controller.complete(operation, "ok", undefined, { observed: "success", actual: "not-committed", actualSource: "declared", detail: cached.description });
        return cache.get(key);
      }
    }

    let result: unknown;
    try {
      result = await action();
    } catch (error) {
      controller.complete(operation, "fail", undefined, { actual: "unknown", observed: "definite-failure", actualSource: "unknown", detail: String(error) });
      throw error;
    }
    const after = faultAt("after-commit-before-response") ?? faultAt("during-response");
    if (after) return fail(operation, after, token);
    if (readOnly) cache.set(key, result);
    controller.complete(operation, "ok", undefined, outcomeMetadata(await askOracle(oracle, token), {
      observed: "success",
      inferred: readOnly ? "not-committed" : "committed",
    }));
    return result;
  };

  return new Proxy(client, {
    apply(callable, thisArg, args) {
      const call = () => Reflect.apply(callable as (...items: unknown[]) => unknown, thisArg, args);
      // postgres.js also calls `sql(...)` to build identifier and value
      // fragments; only a tagged-template call is a query.
      const [first] = args;
      if (!Array.isArray(first) || !("raw" in first)) return call();
      return run("hyperdrive.query", args, call);
    },
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof property !== "string" || !methods.has(property) || typeof value !== "function") return value;
      return (...args: unknown[]) => run(`hyperdrive.${property}`, args, () => Reflect.apply(value, object, args));
    },
  });
}

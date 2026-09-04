import {
  askOracle,
  outcomeMetadata,
  ScenarioController,
  type Fault,
  type OperationRef,
  type OutcomeOracle,
  type Perturbation,
} from "@cloudfault/core";

export function r2CapacityError(target = "R2", status = 503): Fault {
  return {
    id: `${target}:capacity:${status}`,
    target,
    kind: "capacity-5xx",
    phase: "before-commit",
    category: "cloudflare",
    description: `${target} returns a transient ${status} under capacity/degradation pressure`,
    actualOutcome: "not-committed",
    observedOutcome: "definite-failure",
    selector: { target },
    metadata: { status },
  };
}

export function r2CommitThenTimeout(target = "R2", operation = "r2.put"): Fault {
  return {
    id: `${target}:${operation}:commit-then-timeout`,
    target,
    operation,
    kind: "commit-then-timeout",
    phase: "after-commit-before-response",
    category: "cloudflare",
    description: `${target} commits ${operation} but the caller loses the response`,
    actualOutcome: "committed",
    observedOutcome: "indeterminate",
    selector: { target, operation },
  };
}

export interface R2BucketLike {
  head(key: string): Promise<unknown>;
  get(key: string, options?: unknown): Promise<unknown>;
  put(key: string, value: unknown, options?: unknown): Promise<unknown>;
  delete(keys: string | readonly string[]): Promise<unknown>;
  list(options?: unknown): Promise<unknown>;
  createMultipartUpload?(key: string, options?: unknown): Promise<unknown>;
  resumeMultipartUpload?(key: string, uploadId: string): unknown;
}

export class R2InjectedError extends Error {
  readonly perturbation: Perturbation;
  constructor(perturbation: Perturbation) {
    super(`CloudFault injected R2 fault '${perturbation.kind}'`);
    this.name = "R2InjectedError";
    this.perturbation = perturbation;
  }
}

export class R2IndeterminateError extends Error {
  readonly perturbation: Perturbation;
  constructor(perturbation: Perturbation) {
    super(`R2 operation may have committed: '${perturbation.kind}'`);
    this.name = "R2IndeterminateError";
    this.perturbation = perturbation;
  }
}

export interface R2FaultProxyOptions {
  controller: ScenarioController;
  target?: string;
  process?: string | number;
  callsite?: string;
  /** A privileged backend that can be asked what actually happened. See `OutcomeOracle`. */
  oracle?: OutcomeOracle;
  /** Mints and propagates the caller-minted correlation token for an operation. */
  token?: (operation: OperationRef) => string | undefined;
}

function opRef(target: string, process: string | number, name: string, resource?: string, callsite?: string): OperationRef {
  return {
    id: `${target}:${name}:${Math.random().toString(36).slice(2)}`,
    name,
    target,
    process,
    resource,
    callsite,
  };
}

async function injected(
  controller: ScenarioController,
  operation: OperationRef,
  perturbation: Perturbation,
  seam: { oracle?: OutcomeOracle; token?: string } = {},
): Promise<never> {
  const fault = "phase" in perturbation ? perturbation : undefined;
  const observed = fault?.observedOutcome ?? "definite-failure";
  const privileged = await askOracle(seam.oracle, seam.token);
  controller.complete(
    operation,
    observed === "indeterminate" ? "info" : "fail",
    undefined,
    outcomeMetadata(privileged, {
      observed,
      declared: fault?.actualOutcome,
      detail: perturbation.description,
    }),
  );
  if (observed === "indeterminate") throw new R2IndeterminateError(perturbation);
  throw new R2InjectedError(perturbation);
}

/**
 * A shape any `R2Bucket` satisfies, including `@cloudflare/workers-types`'
 * `R2Bucket`. Its only purpose is to spare consumers a type assertion when the
 * concrete binding's signatures are narrower than `R2BucketLike`'s; the proxy
 * still returns the caller's exact type.
 */
export interface R2BucketCompatible {
  put(key: string, value: never, options?: never): unknown;
}

/** Structural R2 wrapper that preserves the Bucket method surface. */
export function createR2FaultProxy<T extends R2BucketLike>(bucket: T, options: R2FaultProxyOptions): T;
export function createR2FaultProxy<T extends R2BucketCompatible>(bucket: T, options: R2FaultProxyOptions): T;
export function createR2FaultProxy(bucket: R2BucketLike, options: R2FaultProxyOptions): R2BucketLike {
  const target = options.target ?? "R2";
  const process = options.process ?? "r2";
  const controller = options.controller;

  const invoke = async <TResult>(
    name: string,
    resource: string | undefined,
    mutation: boolean,
    action: () => Promise<TResult>,
  ): Promise<TResult> => {
    const ref = opRef(target, process, name, resource, options.callsite);
    const token = options.token?.(ref);
    const operation = controller.begin(token ? { ...ref, token } : ref);
    const seam = { oracle: options.oracle, token };
    const before = controller.take(operation, mutation ? "before-commit" : "before-send")
      ?? controller.take(operation, "before-commit");
    if (before) return injected(controller, operation, before, seam);
    try {
      const result = await action();
      if (mutation) {
        const after = controller.take(operation, "after-commit-before-response") ?? controller.take(operation, "during-response");
        if (after) return injected(controller, operation, after, seam);
      }
      const privileged = await askOracle(options.oracle, token);
      controller.complete(operation, "ok", undefined, outcomeMetadata(privileged, {
        observed: "success",
        // A binding call that returned normally is evidence, not privileged
        // knowledge; a read says nothing about durability at all.
        inferred: mutation ? "committed" : "unknown",
      }));
      return result;
    } catch (error) {
      if (error instanceof R2InjectedError || error instanceof R2IndeterminateError) throw error;
      controller.complete(operation, "fail", undefined, {
        actual: "unknown",
        observed: "definite-failure",
        actualSource: "unknown",
        detail: String(error),
      });
      throw error;
    }
  };

  return new Proxy(bucket as object, {
    get(targetObject: R2BucketLike, property, receiver) {
      if (property === "head") return (key: string) => invoke("r2.head", key, false, () => targetObject.head(key));
      if (property === "get") return (key: string, getOptions?: unknown) => invoke("r2.get", key, false, () => targetObject.get(key, getOptions));
      if (property === "put") return (key: string, value: unknown, putOptions?: unknown) => invoke("r2.put", key, true, () => targetObject.put(key, value, putOptions));
      if (property === "delete") return (keys: string | readonly string[]) => invoke("r2.delete", typeof keys === "string" ? keys : [...keys].join(","), true, () => targetObject.delete(keys));
      if (property === "list") return (listOptions?: unknown) => invoke("r2.list", undefined, false, () => targetObject.list(listOptions));
      return Reflect.get(targetObject, property, receiver);
    },
  }) as R2BucketLike;
}

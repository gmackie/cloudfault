import { ScenarioController, type Fault, type OperationRef, type Perturbation } from "@cloudfault/core";

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

function injected(controller: ScenarioController, operation: OperationRef, perturbation: Perturbation): never {
  const fault = "phase" in perturbation ? perturbation : undefined;
  const observed = fault?.observedOutcome ?? "definite-failure";
  controller.complete(operation, observed === "indeterminate" ? "info" : "fail", undefined, {
    actual: fault?.actualOutcome ?? "unknown",
    observed,
    detail: perturbation.description,
  });
  if (observed === "indeterminate") throw new R2IndeterminateError(perturbation);
  throw new R2InjectedError(perturbation);
}

/** Structural R2 wrapper that preserves the Bucket method surface. */
export function createR2FaultProxy<T extends R2BucketLike>(bucket: T, options: R2FaultProxyOptions): T {
  const target = options.target ?? "R2";
  const process = options.process ?? "r2";
  const controller = options.controller;

  const invoke = async <TResult>(
    name: string,
    resource: string | undefined,
    mutation: boolean,
    action: () => Promise<TResult>,
  ): Promise<TResult> => {
    const operation = controller.begin(opRef(target, process, name, resource, options.callsite));
    const before = controller.take(operation, mutation ? "before-commit" : "before-send")
      ?? controller.take(operation, "before-commit");
    if (before) return injected(controller, operation, before);
    try {
      const result = await action();
      if (mutation) {
        const after = controller.take(operation, "after-commit-before-response") ?? controller.take(operation, "during-response");
        if (after) return injected(controller, operation, after);
      }
      controller.complete(operation, "ok", undefined, {
        actual: mutation ? "committed" : "unknown",
        observed: "success",
      });
      return result;
    } catch (error) {
      if (error instanceof R2InjectedError || error instanceof R2IndeterminateError) throw error;
      controller.complete(operation, "fail", undefined, {
        actual: "unknown",
        observed: "definite-failure",
        detail: String(error),
      });
      throw error;
    }
  };

  return new Proxy(bucket, {
    get(targetObject, property, receiver) {
      if (property === "head") return (key: string) => invoke("r2.head", key, false, () => targetObject.head(key));
      if (property === "get") return (key: string, getOptions?: unknown) => invoke("r2.get", key, false, () => targetObject.get(key, getOptions));
      if (property === "put") return (key: string, value: unknown, putOptions?: unknown) => invoke("r2.put", key, true, () => targetObject.put(key, value, putOptions));
      if (property === "delete") return (keys: string | readonly string[]) => invoke("r2.delete", typeof keys === "string" ? keys : [...keys].join(","), true, () => targetObject.delete(keys));
      if (property === "list") return (listOptions?: unknown) => invoke("r2.list", undefined, false, () => targetObject.list(listOptions));
      return Reflect.get(targetObject, property, receiver);
    },
  }) as T;
}

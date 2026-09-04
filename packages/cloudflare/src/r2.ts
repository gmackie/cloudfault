import {
  askOracle,
  outcomeMetadata,
  ScenarioController,
  type AppliedSubOperation,
  type Fault,
  type OperationRef,
  type OutcomeOracle,
  type Perturbation,
} from "@cloudfault/core";

/**
 * The operation names this proxy reports, so a selector never has to be
 * spelled from memory. The multipart names are the ones that matter: a
 * multipart upload is four separate round trips to R2, and only the last one
 * makes the object visible.
 */
export const R2_OPERATIONS = {
  head: "r2.head",
  get: "r2.get",
  put: "r2.put",
  delete: "r2.delete",
  list: "r2.list",
  createMultipartUpload: "r2.createMultipartUpload",
  uploadPart: "r2.uploadPart",
  completeMultipartUpload: "r2.completeMultipartUpload",
  abortMultipartUpload: "r2.abortMultipartUpload",
} as const;

/** Resource identity for one part, so a fault can name the exact part it kills. */
export function r2PartResource(key: string, partNumber: number): string {
  return `${key}#${partNumber}`;
}

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

/* ------------------------------------------------------------------------- *
 * Multipart fault vocabulary
 *
 * FIDELITY NOTE, and it governs everything below.
 *
 * A multipart upload is four separate round trips — create, N x uploadPart,
 * complete (or abort) — and only `complete` makes the object visible. Real R2
 * `complete` is ATOMIC: the object appears with every part the caller listed,
 * or it does not appear at all. So of the faults here, two model something R2
 * genuinely does and one does not:
 *
 *   r2MultipartCommitThenTimeout  real: the object materialises and the caller
 *                                 loses the response. THE multipart fault: the
 *                                 caller's natural recovery is to abort, and
 *                                 aborting a completed upload does not remove
 *                                 the object.
 *   r2PartUploadError             real: one part upload is rejected. Nothing is
 *                                 visible yet, and the parts already uploaded
 *                                 are billed storage until someone aborts.
 *   r2PartialMultipartCompletion  NOT REAL. A contract probe. See below.
 * ------------------------------------------------------------------------- */

/**
 * The object materialises and then the caller loses the response. Provable
 * exactly like the single-shot `put` case: the object IS there afterward, and
 * the caller cannot know it.
 */
export function r2MultipartCommitThenTimeout(target = "R2"): Fault {
  const operation = R2_OPERATIONS.completeMultipartUpload;
  return {
    id: `${target}:${operation}:commit-then-timeout`,
    target,
    operation,
    kind: "commit-then-timeout",
    phase: "after-commit-before-response",
    category: "cloudflare",
    description: `${target} completes a multipart upload but the caller loses the response`,
    actualOutcome: "committed",
    observedOutcome: "indeterminate",
    selector: { target, operation },
  };
}

/**
 * One part upload is rejected before it lands. Definite failure, and nothing
 * about the object changed: `complete` was never called, so there is nothing
 * to see in the bucket — only orphaned parts.
 */
export function r2PartUploadError(target: string, key: string, partNumber: number, status = 503): Fault {
  const operation = R2_OPERATIONS.uploadPart;
  const resource = r2PartResource(key, partNumber);
  return {
    id: `${target}:${operation}:${resource}:capacity:${status}`,
    target,
    operation,
    kind: "capacity-5xx",
    phase: "before-commit",
    category: "cloudflare",
    description: `${target} rejects part ${partNumber} of '${key}' with a transient ${status}`,
    actualOutcome: "not-committed",
    observedOutcome: "definite-failure",
    selector: { target, operation, resource },
    metadata: { status, key, partNumber },
  };
}

/**
 * CONTRACT PROBE — real R2 completes a multipart upload atomically and never
 * does this.
 *
 * The object materialises from parts `[0, partIndex)` of the list the caller
 * passed to `complete()`, and the caller sees an indeterminate result. Running
 * it requires `allowContractProbes: true`; it answers "does this code verify
 * what it uploaded, or does it treat `complete()` returning as proof that every
 * part landed?", which is what you want to know before the same code runs
 * against an S3-compatible backend that does not promise atomic completion.
 *
 * @param partIndex 0-based index into the caller's part list of the first part
 *                  that does NOT land.
 */
export function r2PartialMultipartCompletion(target = "R2", partIndex = 1): Fault {
  const operation = R2_OPERATIONS.completeMultipartUpload;
  return {
    id: `${target}:${operation}:partial-multipart-completion:${partIndex}`,
    target,
    operation,
    kind: "partial-multipart-completion",
    phase: "after-commit-before-response",
    category: "cloudflare",
    description:
      `CONTRACT PROBE (real R2 completes a multipart upload atomically): ${target} materialises parts `
      + `[0,${partIndex}) and drops the rest`,
    actualOutcome: "committed",
    observedOutcome: "indeterminate",
    selector: { target, operation },
    metadata: { partIndex, contractProbe: true },
  };
}

/**
 * Fault kinds that model nothing Cloudflare does. Mirrors
 * `D1_CONTRACT_PROBE_KINDS`: a probe is refused unless the proxy is built with
 * `allowContractProbes: true`, so it can never be mistaken for fidelity.
 */
export const R2_CONTRACT_PROBE_KINDS: ReadonlySet<string> = new Set([
  "partial-multipart-completion",
]);

export class R2ContractProbeRefusedError extends Error {
  readonly perturbation: Perturbation;
  constructor(perturbation: Perturbation) {
    super(
      `'${perturbation.kind}' is a contract probe, not a fidelity claim: real R2 completes a multipart `
      + `upload atomically, so this outcome cannot happen against Cloudflare. Construct the proxy with `
      + `{ allowContractProbes: true } to run it as a portability probe.`,
    );
    this.name = "R2ContractProbeRefusedError";
    this.perturbation = perturbation;
  }
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
  /**
   * Permit fault kinds in `R2_CONTRACT_PROBE_KINDS`, which model behaviour real
   * R2 does not have. Off by default.
   */
  allowContractProbes?: boolean;
}

/**
 * The `R2MultipartUpload` surface, structurally. Every real
 * `R2MultipartUpload` satisfies it; declaring it here is what lets the proxy
 * wrap the handle without importing `@cloudflare/workers-types`.
 */
export interface R2MultipartUploadLike {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(partNumber: number, value: unknown, options?: unknown): Promise<unknown>;
  abort(): Promise<unknown>;
  complete(uploadedParts: readonly unknown[]): Promise<unknown>;
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

interface OutcomeSeam {
  oracle?: OutcomeOracle;
  token?: string;
}

/** Reads the cut point for a partial-completion probe: the first part that does NOT land. */
function partCut(perturbation: Perturbation, count: number): number {
  const fromMetadata = perturbation.metadata?.partIndex;
  const raw = typeof fromMetadata === "number" ? fromMetadata : 1;
  return Math.max(0, Math.min(count, Math.trunc(raw)));
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

  const refuseProbe = (perturbation: Perturbation, operation?: OperationRef): void => {
    if (!R2_CONTRACT_PROBE_KINDS.has(perturbation.kind) || options.allowContractProbes) return;
    if (operation) {
      controller.complete(operation, "fail", undefined, {
        actual: "not-committed",
        observed: "definite-failure",
        actualSource: "declared",
        detail: `contract probe '${perturbation.kind}' refused`,
      });
    }
    throw new R2ContractProbeRefusedError(perturbation);
  };

  const invoke = async <TResult>(
    name: string,
    resource: string | undefined,
    mutation: boolean,
    action: () => Promise<TResult>,
    /**
     * Decides a contract probe *before* dispatch, for operations whose probe
     * cannot be expressed as "let the real call happen, then lie about it".
     * See `applyPartPrefix`.
     */
    probeHandler?: (probe: Perturbation, operation: OperationRef, seam: OutcomeSeam) => Promise<never>,
  ): Promise<TResult> => {
    const ref = opRef(target, process, name, resource, options.callsite);
    const token = options.token?.(ref);
    const operation = controller.begin(token ? { ...ref, token } : ref);
    const seam = { oracle: options.oracle, token };
    const before = controller.take(operation, mutation ? "before-commit" : "before-send")
      ?? controller.take(operation, "before-commit");
    if (before) {
      refuseProbe(before, operation);
      return injected(controller, operation, before, seam);
    }
    if (probeHandler) {
      const probe = controller
        .eligible(operation, "after-commit-before-response")
        .find((perturbation) => R2_CONTRACT_PROBE_KINDS.has(perturbation.kind));
      if (probe) {
        refuseProbe(probe, operation);
        controller.activate(probe, operation);
        return probeHandler(probe, operation, seam);
      }
    }
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
      if (
        error instanceof R2InjectedError
        || error instanceof R2IndeterminateError
        || error instanceof R2ContractProbeRefusedError
      ) throw error;
      controller.complete(operation, "fail", undefined, {
        actual: "unknown",
        observed: "definite-failure",
        actualSource: "unknown",
        detail: String(error),
      });
      throw error;
    }
  };

  /**
   * CONTRACT PROBE PATH — real R2 never takes it.
   *
   * Materialising a prefix means completing the upload with only part of the
   * caller's list, because the whole point of the real call is that it is
   * all-or-nothing. `refuseProbe` has already established that the caller asked
   * for this explicitly.
   */
  async function applyPartPrefix(
    operation: OperationRef,
    upload: R2MultipartUploadLike,
    parts: readonly unknown[],
    probe: Perturbation,
    seam: OutcomeSeam,
  ): Promise<never> {
    const cut = partCut(probe, parts.length);
    let failure: unknown;
    let committed = false;
    try {
      await upload.complete(parts.slice(0, cut));
      committed = cut > 0;
    } catch (error) {
      failure = error;
    }
    const applied: AppliedSubOperation[] = parts.map((_part, index) => ({
      index,
      committed: committed && index < cut,
      detail: failure
        ? String(failure)
        : index < cut ? undefined : "dropped by contract probe",
    }));
    const privileged = await askOracle(seam.oracle, seam.token);
    controller.complete(operation, "info", { parts: parts.length, appliedThrough: cut }, outcomeMetadata(privileged, {
      observed: "indeterminate",
      // CloudFault chose which parts to complete with, so it genuinely knows
      // what landed even with no oracle configured: `declared`, not `inferred`.
      declared: committed ? "committed" : "not-committed",
      detail: probe.description ?? probe.kind,
      applied,
    }));
    if (failure) throw failure;
    throw new R2IndeterminateError(probe);
  }

  /**
   * Wraps the `R2MultipartUpload` handle so every one of its round trips goes
   * through the same seam as `put`. Without this the handle escapes the proxy
   * entirely and a multipart write is invisible to CloudFault.
   *
   * `Reflect.get` is deliberately called without the receiver: `key` and
   * `uploadId` are native accessors, and invoking them with the proxy as `this`
   * throws.
   */
  const wrapMultipart = (upload: R2MultipartUploadLike, key: string): R2MultipartUploadLike =>
    new Proxy(upload as object, {
      get(uploadTarget: R2MultipartUploadLike, property) {
        if (property === "uploadPart") {
          return (partNumber: number, value: unknown, partOptions?: unknown) =>
            invoke(
              R2_OPERATIONS.uploadPart,
              r2PartResource(key, partNumber),
              // A stored part is a durable, billable effect of its own, even
              // though it makes nothing visible under the object's key.
              true,
              () => uploadTarget.uploadPart(partNumber, value, partOptions),
            );
        }
        if (property === "complete") {
          return (uploadedParts: readonly unknown[]) =>
            invoke(
              R2_OPERATIONS.completeMultipartUpload,
              key,
              // The mutation whose commit matters: this is the call that makes
              // the object visible under `key`.
              true,
              () => uploadTarget.complete(uploadedParts),
              (probe, operation, seam) => applyPartPrefix(operation, uploadTarget, uploadedParts, probe, seam),
            );
        }
        if (property === "abort") {
          return () => invoke(R2_OPERATIONS.abortMultipartUpload, key, true, () => uploadTarget.abort());
        }
        return Reflect.get(uploadTarget, property);
      },
    }) as R2MultipartUploadLike;

  return new Proxy(bucket as object, {
    get(targetObject: R2BucketLike, property, receiver) {
      if (property === "head") return (key: string) => invoke("r2.head", key, false, () => targetObject.head(key));
      if (property === "get") return (key: string, getOptions?: unknown) => invoke("r2.get", key, false, () => targetObject.get(key, getOptions));
      if (property === "put") return (key: string, value: unknown, putOptions?: unknown) => invoke("r2.put", key, true, () => targetObject.put(key, value, putOptions));
      if (property === "delete") return (keys: string | readonly string[]) => invoke("r2.delete", typeof keys === "string" ? keys : [...keys].join(","), true, () => targetObject.delete(keys));
      if (property === "list") return (listOptions?: unknown) => invoke("r2.list", undefined, false, () => targetObject.list(listOptions));
      if (property === "createMultipartUpload" && typeof targetObject.createMultipartUpload === "function") {
        return (key: string, createOptions?: unknown) =>
          invoke(
            R2_OPERATIONS.createMultipartUpload,
            key,
            // The upload session is itself durable server-side state: a create
            // whose response is lost leaves an orphan nobody will ever abort.
            true,
            async () => wrapMultipart(
              await targetObject.createMultipartUpload!(key, createOptions) as R2MultipartUploadLike,
              key,
            ),
          );
      }
      if (property === "resumeMultipartUpload" && typeof targetObject.resumeMultipartUpload === "function") {
        // Synchronous by contract, and it performs no I/O — it just mints a
        // handle for an upload id. Recording an operation for it would be
        // fiction, and awaiting it would break the signature. What it must do
        // is hand back a *wrapped* handle, so a resumed upload's parts and
        // completion are instrumented exactly like a freshly created one's.
        return (key: string, uploadId: string) =>
          wrapMultipart(targetObject.resumeMultipartUpload!(key, uploadId) as R2MultipartUploadLike, key);
      }
      return Reflect.get(targetObject, property, receiver);
    },
  }) as R2BucketLike;
}

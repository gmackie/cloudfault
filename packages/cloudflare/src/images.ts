import {
  ScenarioController,
  type Fault,
  type OperationRef,
  type Perturbation,
} from "@cloudfault/core";

/**
 * The Images binding transforms bytes; it has no durable state of its own, so
 * every failure is a definite one. What it threatens is the caller: an upload
 * flow that stores the original and then fails to derive a variant must not
 * leave a record pointing at a variant that was never produced.
 */
export const IMAGES_OPERATIONS = {
  info: "images.info",
  output: "images.output",
} as const;

/** The transformation is rejected (bad input, unsupported format, limits). */
export function imagesTransformError(target = "IMAGES", status = 415): Fault {
  return {
    id: `${target}:transform-error:${status}`,
    target,
    operation: IMAGES_OPERATIONS.output,
    kind: "transform-error",
    phase: "before-commit",
    category: "cloudflare",
    description: `${target} rejects the transformation with ${status}`,
    actualOutcome: "not-committed",
    observedOutcome: "definite-failure",
    selector: { target, operation: IMAGES_OPERATIONS.output },
    metadata: { status },
  };
}

/** The Images service is temporarily unavailable for any call. */
export function imagesUnavailable(target = "IMAGES", status = 503): Fault {
  return {
    id: `${target}:unavailable:${status}`,
    target,
    kind: "images-unavailable",
    phase: "before-commit",
    category: "cloudflare",
    description: `${target} returns a transient ${status}`,
    actualOutcome: "not-committed",
    observedOutcome: "definite-failure",
    selector: { target },
    metadata: { status },
  };
}

export class ImagesInjectedError extends Error {
  readonly perturbation: Perturbation;
  constructor(perturbation: Perturbation) {
    super(`CloudFault injected Images fault '${perturbation.kind}'`);
    this.name = "ImagesInjectedError";
    this.perturbation = perturbation;
  }
}

export interface ImagesFaultProxyOptions {
  controller: ScenarioController;
  target?: string;
  process?: string | number;
  callsite?: string;
}

/**
 * Wrap an Images binding. `info()` and the terminal `output()` of an
 * `input().transform()...output()` chain are interposed; the builder calls in
 * between pass through, re-wrapped so the chain still reaches `output()`.
 */
export function createImagesFaultProxy<T extends object>(binding: T, options: ImagesFaultProxyOptions): T {
  const target = options.target ?? "IMAGES";
  const process = options.process ?? "images";
  const { controller } = options;

  const run = async <R>(name: string, action: () => Promise<R>): Promise<R> => {
    const ref: OperationRef = { id: `${target}:${name}:${Math.random().toString(36).slice(2)}`, name, target, process, callsite: options.callsite };
    const operation = controller.begin(ref);
    const fault = controller.eligible(operation, "before-commit").find((item): item is Fault => "phase" in item);
    if (fault) {
      controller.activate(fault, operation);
      controller.complete(operation, "fail", undefined, { actual: "not-committed", observed: "definite-failure", actualSource: "declared", detail: fault.description });
      throw new ImagesInjectedError(fault);
    }
    try {
      const result = await action();
      controller.complete(operation, "ok", undefined, { observed: "success", actual: "not-committed", actualSource: "inferred" });
      return result;
    } catch (error) {
      controller.complete(operation, "fail", undefined, { actual: "unknown", observed: "definite-failure", actualSource: "unknown", detail: String(error) });
      throw error;
    }
  };

  const wrapTransformer = (transformer: object): object => new Proxy(transformer, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "output") return (...args: unknown[]) => run(IMAGES_OPERATIONS.output, () => Reflect.apply(value, object, args) as Promise<unknown>);
      return (...args: unknown[]) => {
        const next = Reflect.apply(value, object, args);
        return next && typeof next === "object" ? wrapTransformer(next) : next;
      };
    },
  });

  return new Proxy(binding, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== "function") return value;
      if (property === "info") return (...args: unknown[]) => run(IMAGES_OPERATIONS.info, () => Reflect.apply(value, object, args) as Promise<unknown>);
      if (property === "input") return (...args: unknown[]) => wrapTransformer(Reflect.apply(value, object, args) as object);
      return value.bind(object);
    },
  });
}

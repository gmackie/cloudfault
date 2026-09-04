import type { OutcomeOracle, PrivilegedOutcome } from "@cloudfault/core";

export type { OutcomeOracle, PrivilegedOutcome };

export interface FetchLikeBackend {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

export interface EmulateBridgeOptions {
  /** Optional base URL when the emulator expects requests under a local origin. */
  baseUrl?: string;
  /** Preserve the original Host header when rewriting the URL. */
  preserveHost?: boolean;
}

/**
 * Adapt any stateful emulator exposing a fetch-like method (including service
 * packages patterned after `emulate`) into the provider-neutral upstream
 * function expected by CloudFault's AdapterRuntime.
 */
export function emulateBackend(
  backend: FetchLikeBackend | ((request: Request) => Promise<Response>),
  options: EmulateBridgeOptions = {},
): (request: Request) => Promise<Response> {
  return async (request) => {
    let target = request;
    if (options.baseUrl) {
      const original = new URL(request.url);
      const rewritten = new URL(`${original.pathname}${original.search}`, options.baseUrl);
      const headers = new Headers(request.headers);
      if (!options.preserveHost) headers.delete("host");
      target = new Request(rewritten, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method.toUpperCase()) ? undefined : await request.clone().arrayBuffer(),
      });
    }
    if (typeof backend === "function") return backend(target);
    return backend.fetch(target);
  };
}

export interface DynamicEmulatorOptions {
  specifier: string;
  exportName?: string;
  factoryArgs?: readonly unknown[];
  bridge?: EmulateBridgeOptions;
}

/**
 * Lazy bridge for optional emulator packages. CloudFault never hard-depends on
 * emulate or provider-specific emulators: users install the desired package
 * and identify the factory/default export here.
 */
export async function loadEmulatorBackend(
  options: DynamicEmulatorOptions,
): Promise<(request: Request) => Promise<Response>> {
  const module = await Function("specifier", "return import(specifier)")(options.specifier) as Record<string, unknown>;
  const candidate = options.exportName ? module[options.exportName] : module.default ?? module;
  let backend: unknown = candidate;
  if (typeof candidate === "function") {
    backend = await (candidate as (...args: unknown[]) => unknown)(...(options.factoryArgs ?? []));
  }
  if (typeof backend === "function") return emulateBackend(backend as (request: Request) => Promise<Response>, options.bridge);
  if (backend && typeof backend === "object" && typeof (backend as FetchLikeBackend).fetch === "function") {
    return emulateBackend(backend as FetchLikeBackend, options.bridge);
  }
  throw new Error(`Emulator '${options.specifier}' did not expose a fetch-compatible backend`);
}

/**
 * A stateful emulator that is also a privileged oracle: it serves the provider
 * API *and* can be asked what it actually did. This is the shape
 * `StripeMemoryBackend` would grow into, and the shape the emulate Cloudflare
 * emulator already has.
 */
export interface OracleBackend extends FetchLikeBackend, OutcomeOracle {}

export interface HttpOutcomeOracleOptions {
  /** Control-plane origin, e.g. `http://localhost:4007`. */
  baseUrl: string;
  /** Route prefix the control/oracle plane is mounted under. */
  prefix?: string;
  fetch?: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
  headers?: Record<string, string>;
  name?: string;
}

/**
 * `OutcomeOracle` over the HTTP control plane that the emulate Cloudflare
 * emulator exposes:
 *
 * ```text
 * GET /_cloudfault/outcome/:token    -> PrivilegedOutcome | 404
 * GET /_cloudfault/version/:resource -> { resource, version }
 * GET /_cloudfault/snapshot          -> { ... }
 * POST /_cloudfault/reset            -> 204
 * ```
 *
 * The 404 is load-bearing and is preserved here rather than smoothed over: an
 * unknown token means the backend has no record of that attempt, so the honest
 * answer is `undefined` -> `actual: "unknown"`. Inferring `committed` from a
 * prior 200 is precisely the shortcut this seam exists to remove, so this
 * client never does it — including when the emulator is simply unreachable.
 */
export function httpOutcomeOracle(options: HttpOutcomeOracleOptions): OutcomeOracle {
  const prefix = options.prefix ?? "/_cloudfault";
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input as RequestInfo, init));
  const url = (path: string) => new URL(`${prefix}${path}`, options.baseUrl).toString();
  const headers = options.headers;

  const readJson = async (response: Response): Promise<unknown | undefined> => {
    if (response.status === 404) return undefined;
    if (!response.ok) return undefined;
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  };

  return {
    name: options.name ?? "http-oracle",
    async outcomeFor(token) {
      const response = await doFetch(url(`/outcome/${encodeURIComponent(token)}`), { headers });
      const body = await readJson(response);
      if (!body || typeof body !== "object") return undefined;
      const outcome = body as PrivilegedOutcome;
      // A body without an `actual` is not an answer; treat it as no answer
      // rather than defaulting it to anything.
      if (outcome.actual !== "committed" && outcome.actual !== "not-committed" && outcome.actual !== "unknown") {
        return undefined;
      }
      return outcome;
    },
    async versionOf(resource) {
      const response = await doFetch(url(`/version/${resource.split("/").map(encodeURIComponent).join("/")}`), { headers });
      const body = await readJson(response) as { version?: number | null } | undefined;
      return typeof body?.version === "number" ? body.version : undefined;
    },
    async snapshot() {
      const response = await doFetch(url("/snapshot"), { headers });
      return await readJson(response);
    },
    async reset() {
      await doFetch(url("/reset"), { method: "POST", headers });
    },
  };
}

/**
 * Post a CloudFault `Perturbation[]` to an emulator's control plane so faults
 * are injected *inside* the backend rather than at the wire.
 *
 * Contract probes (behaviour the real provider does not have) are refused by
 * the emulator with a 400 unless `allowContractProbes` is set. That refusal is
 * surfaced as an error rather than swallowed, so a probe can never run by
 * accident.
 */
export async function postFaultPlan(
  options: HttpOutcomeOracleOptions & {
    perturbations: readonly unknown[];
    allowContractProbes?: boolean;
  },
): Promise<void> {
  const prefix = options.prefix ?? "/_cloudfault";
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input as RequestInfo, init));
  const response = await doFetch(new URL(`${prefix}/plan`, options.baseUrl).toString(), {
    method: "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify({
      perturbations: options.perturbations,
      allowContractProbes: options.allowContractProbes === true,
    }),
  });
  if (response.ok) return;
  const detail = await response.text().catch(() => "");
  throw new Error(`Emulator refused the fault plan (${response.status}): ${detail}`);
}

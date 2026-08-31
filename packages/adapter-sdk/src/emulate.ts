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

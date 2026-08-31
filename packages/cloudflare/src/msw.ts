import { AdapterRegistry, AdapterRuntime, CloudFaultIndeterminateError, CloudFaultInjectedError } from "@cloudfault/adapter-sdk";
import type { ScenarioController } from "@cloudfault/core";

interface MswCoreLike {
  http: { all(path: string | RegExp, resolver: (info: { request: Request }) => Promise<Response> | Response): unknown };
  bypass(input: Request): Request;
  HttpResponse: { error(): Response };
}

interface MswNodeLike {
  setupServer(...handlers: unknown[]): {
    listen(options?: { onUnhandledRequest?: "bypass" | "warn" | "error" }): void;
    resetHandlers(...handlers: unknown[]): void;
    use(...handlers: unknown[]): void;
    close(): void;
  };
}

async function dynamicImport(specifier: string): Promise<unknown> {
  return Function("specifier", "return import(specifier)")(specifier) as Promise<unknown>;
}

export interface MswAdapterRuntimeOptions {
  registry: AdapterRegistry;
  controller: ScenarioController;
  process?: string | number;
  onUnhandledRequest?: "bypass" | "warn" | "error";
  /** Optional stateful/sandbox backend. Defaults to bypassing MSW to the real upstream. */
  upstream?: (request: Request) => Promise<Response>;
}

/**
 * Creates host-scoped MSW handlers for semantic adapters. These handlers can
 * be installed in either `msw/node` (createTestHarness) or `@msw/cloudflare`
 * (Workers Vitest integration).
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hostPattern(pattern: string): string {
  if (pattern.startsWith("*.")) {
    return `(?:[^./]+\\.)+${escapeRegExp(pattern.slice(2))}`;
  }
  return escapeRegExp(pattern);
}

export async function createMswAdapterHandlers(options: MswAdapterRuntimeOptions): Promise<readonly unknown[]> {
  let msw: MswCoreLike;
  try {
    msw = await dynamicImport("msw") as MswCoreLike;
  } catch (error) {
    throw new Error("CloudFault MSW integration requires msw >= 2.14.1", { cause: error });
  }

  const runtime = new AdapterRuntime({
    registry: options.registry,
    controller: options.controller,
    process: options.process ?? "external-fetch",
    upstream: options.upstream ?? ((request) => fetch(msw.bypass(request))),
  });

  return options.registry.hosts().map((host) => msw.http.all(new RegExp(`^https?://${hostPattern(host)}(?::\\d+)?(?:/|$)`), async ({ request }) => {
    try {
      return await runtime.fetch(request);
    } catch (error) {
      if (error instanceof CloudFaultIndeterminateError || error instanceof CloudFaultInjectedError) {
        return msw.HttpResponse.error();
      }
      throw error;
    }
  }));
}

export interface MswNodeAdapterServer {
  listen(): void;
  reset(): void;
  close(): void;
}

/** Official test-harness path: Node-side MSW intercepts outbound workerd fetch. */
export async function createMswNodeAdapterServer(options: MswAdapterRuntimeOptions): Promise<MswNodeAdapterServer> {
  let node: MswNodeLike;
  try {
    node = await dynamicImport("msw/node") as MswNodeLike;
  } catch (error) {
    throw new Error("createMswNodeAdapterServer() requires msw >= 2.14.1", { cause: error });
  }
  const handlers = await createMswAdapterHandlers(options);
  const server = node.setupServer(...handlers);
  return {
    listen() { server.listen({ onUnhandledRequest: options.onUnhandledRequest ?? "bypass" }); },
    reset() { server.resetHandlers(...handlers); },
    close() { server.close(); },
  };
}

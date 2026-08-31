import type { RunResult, Scenario } from "./types.js";

export interface ExecutionContext {
  testName?: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

/**
 * ExecutionBackend is the boundary between CloudFault's search/model layer and
 * a concrete runtime (workerd, a deployed staging Worker, a custom simulator,
 * or a remote test agent).
 */
export interface ExecutionBackend<State = unknown> {
  readonly name: string;
  execute(scenario: Scenario, context?: ExecutionContext): Promise<RunResult<State>>;
  close?(): Promise<void>;
}

export class FunctionExecutionBackend<State = unknown> implements ExecutionBackend<State> {
  readonly name: string;
  readonly #execute: (scenario: Scenario, context?: ExecutionContext) => Promise<RunResult<State>>;

  constructor(
    name: string,
    execute: (scenario: Scenario, context?: ExecutionContext) => Promise<RunResult<State>>,
  ) {
    this.name = name;
    this.#execute = execute;
  }

  execute(scenario: Scenario, context?: ExecutionContext): Promise<RunResult<State>> {
    return this.#execute(scenario, context);
  }
}

export interface RemoteHttpBackendOptions<State = unknown> {
  endpoint: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  decode?: (response: Response) => Promise<RunResult<State>>;
}

/**
 * Minimal staging/remote backend protocol. A remote CloudFault agent receives
 * a Scenario as JSON and returns a portable RunResult. Authentication is
 * intentionally caller-owned through headers so this works with Access,
 * service tokens, or ordinary bearer tokens.
 */
export class RemoteHttpBackend<State = unknown> implements ExecutionBackend<State> {
  readonly name = "remote-http";
  readonly #options: RemoteHttpBackendOptions<State>;

  constructor(options: RemoteHttpBackendOptions<State>) {
    this.#options = options;
  }

  async execute(scenario: Scenario, context: ExecutionContext = {}): Promise<RunResult<State>> {
    const fetcher = this.#options.fetch ?? globalThis.fetch;
    if (!fetcher) throw new Error("RemoteHttpBackend requires a fetch implementation");
    const configured = typeof this.#options.headers === "function"
      ? await this.#options.headers()
      : this.#options.headers;
    const headers = new Headers(configured);
    headers.set("content-type", "application/json");
    headers.set("accept", "application/json");

    const controller = context.timeoutMs ? new AbortController() : undefined;
    const timer = context.timeoutMs
      ? setTimeout(() => controller!.abort(new Error(`CloudFault remote execution exceeded ${context.timeoutMs}ms`)), context.timeoutMs)
      : undefined;

    try {
      const response = await fetcher(this.#options.endpoint, {
        method: "POST",
        headers,
        signal: controller?.signal,
        body: JSON.stringify({
          schema: "cloudfault.remote-execution",
          version: 1,
          scenario,
          context,
        }),
      });
      if (!response.ok) {
        throw new Error(`CloudFault remote backend returned ${response.status}: ${await response.text()}`);
      }
      return this.#options.decode
        ? this.#options.decode(response)
        : await response.json() as RunResult<State>;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export async function executeWithBackend<State>(
  backend: ExecutionBackend<State>,
  scenario: Scenario,
  context?: ExecutionContext,
): Promise<RunResult<State>> {
  return backend.execute(scenario, context);
}

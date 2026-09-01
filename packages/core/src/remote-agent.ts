import type { ExecutionContext } from "./backend.js";
import type { RunResult, Scenario } from "./types.js";

export interface RemoteAgentCapabilities {
  schema: "cloudfault.remote-capabilities";
  version: 1;
  agent: string;
  runtime?: string;
  features?: readonly string[];
  metadata?: Record<string, unknown>;
}

export interface RemoteExecutionEnvelope {
  schema: "cloudfault.remote-execution";
  version: 1;
  scenario: Scenario;
  context?: ExecutionContext;
}

export interface RemoteAgentOptions<State = unknown> {
  execute(scenario: Scenario, context?: ExecutionContext): Promise<RunResult<State>>;
  authorize?: (request: Request) => boolean | Promise<boolean>;
  capabilities?: Omit<RemoteAgentCapabilities, "schema" | "version">;
  maxBodyBytes?: number;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

export function createRemoteExecutionHandler<State = unknown>(options: RemoteAgentOptions<State>): (request: Request) => Promise<Response> {
  return async (request) => {
    if (options.authorize && !(await options.authorize(request))) return json({ error: "unauthorized" }, 401);
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname.endsWith("/capabilities") || url.searchParams.has("capabilities"))) {
      return json({ schema: "cloudfault.remote-capabilities", version: 1, agent: "cloudfault-agent", ...options.capabilities } satisfies RemoteAgentCapabilities);
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const text = await request.text();
    if (text.length > (options.maxBodyBytes ?? 1_000_000)) return json({ error: "payload_too_large" }, 413);
    let envelope: RemoteExecutionEnvelope;
    try { envelope = JSON.parse(text) as RemoteExecutionEnvelope; }
    catch { return json({ error: "invalid_json" }, 400); }
    if (envelope.schema !== "cloudfault.remote-execution" || envelope.version !== 1 || !envelope.scenario) return json({ error: "invalid_envelope" }, 400);
    try { return json(await options.execute(envelope.scenario, envelope.context)); }
    catch (error) {
      return json({
        error: "execution_failed",
        message: error instanceof Error ? error.message : String(error),
      }, 500);
    }
  };
}

export async function queryRemoteCapabilities(
  endpoint: string,
  options: { fetch?: typeof globalThis.fetch; headers?: HeadersInit } = {},
): Promise<RemoteAgentCapabilities> {
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new Error("queryRemoteCapabilities requires fetch");
  const url = new URL(endpoint);
  url.searchParams.set("capabilities", "1");
  const response = await fetcher(url, { headers: options.headers });
  if (!response.ok) throw new Error(`CloudFault remote capability query returned ${response.status}`);
  const value = await response.json() as RemoteAgentCapabilities;
  if (value.schema !== "cloudfault.remote-capabilities" || value.version !== 1) throw new Error("Remote endpoint returned an incompatible capability document");
  return value;
}

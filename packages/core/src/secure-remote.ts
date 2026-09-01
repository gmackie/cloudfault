import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ExecutionBackend, ExecutionContext, RemoteHttpBackendOptions } from "./backend.js";
import { negotiateRemoteCapabilities, type CapabilityNegotiation } from "./negotiated-remote.js";
import type { RemoteAgentCapabilities } from "./remote-agent.js";
import type { RunResult, Scenario } from "./types.js";

export interface RemoteSignatureInput {
  method: string;
  url: string;
  body?: string;
  timestamp?: number;
  nonce?: string;
}

export interface RemoteSignatureHeaders {
  "x-cloudfault-timestamp": string;
  "x-cloudfault-nonce": string;
  "x-cloudfault-signature": string;
}

function bodyHash(body = ""): string {
  return createHash("sha256").update(body).digest("hex");
}

function canonicalRequest(input: Required<Pick<RemoteSignatureInput, "method" | "url">> & { body: string; timestamp: number; nonce: string }): string {
  const url = new URL(input.url);
  return [
    "cloudfault-request-v1",
    input.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    String(input.timestamp),
    input.nonce,
    bodyHash(input.body),
  ].join("\n");
}

export function signRemoteRequest(secret: string, input: RemoteSignatureInput): RemoteSignatureHeaders {
  const timestamp = input.timestamp ?? Date.now();
  const nonce = input.nonce ?? randomBytes(16).toString("hex");
  const canonical = canonicalRequest({ method: input.method, url: input.url, body: input.body ?? "", timestamp, nonce });
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  return {
    "x-cloudfault-timestamp": String(timestamp),
    "x-cloudfault-nonce": nonce,
    "x-cloudfault-signature": `v1=${signature}`,
  };
}

export interface RemoteReplayCache {
  has(nonce: string): boolean | Promise<boolean>;
  add(nonce: string, expiresAt: number): void | Promise<void>;
  prune?(now: number): void | Promise<void>;
}

export class MemoryRemoteReplayCache implements RemoteReplayCache {
  readonly #nonces = new Map<string, number>();
  has(nonce: string): boolean {
    const expiresAt = this.#nonces.get(nonce);
    if (expiresAt === undefined) return false;
    if (expiresAt < Date.now()) { this.#nonces.delete(nonce); return false; }
    return true;
  }
  add(nonce: string, expiresAt: number): void { this.#nonces.set(nonce, expiresAt); }
  prune(now = Date.now()): void { for (const [nonce, expiresAt] of this.#nonces) if (expiresAt < now) this.#nonces.delete(nonce); }
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface SignedRemoteAuthorizerOptions {
  maxSkewMs?: number;
  replayCache?: RemoteReplayCache;
  now?: () => number;
}

/** Authorizer compatible with createRemoteExecutionHandler({ authorize }). */
export function createSignedRemoteAuthorizer(
  secret: string,
  options: SignedRemoteAuthorizerOptions = {},
): (request: Request) => Promise<boolean> {
  const replay = options.replayCache ?? new MemoryRemoteReplayCache();
  const now = options.now ?? Date.now;
  const maxSkewMs = Math.max(1, options.maxSkewMs ?? 5 * 60_000);
  return async (request) => {
    const timestamp = Number(request.headers.get("x-cloudfault-timestamp"));
    const nonce = request.headers.get("x-cloudfault-nonce");
    const received = request.headers.get("x-cloudfault-signature");
    if (!Number.isFinite(timestamp) || !nonce || !received?.startsWith("v1=")) return false;
    const current = now();
    if (Math.abs(current - timestamp) > maxSkewMs) return false;
    await replay.prune?.(current);
    if (await replay.has(nonce)) return false;
    const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.clone().text();
    const expected = signRemoteRequest(secret, { method: request.method, url: request.url, body, timestamp, nonce })["x-cloudfault-signature"];
    if (!constantTimeEqual(received, expected)) return false;
    await replay.add(nonce, current + maxSkewMs * 2);
    return true;
  };
}

export interface SignedRemoteBackendOptions<State = unknown> extends Omit<RemoteHttpBackendOptions<State>, "headers"> {
  secret: string;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  capabilityEndpoint?: string;
  requiredFeatures?: readonly string[];
  name?: string;
  nonce?: () => string;
  now?: () => number;
}

async function configuredHeaders(value: SignedRemoteBackendOptions["headers"]): Promise<Headers> {
  return new Headers(typeof value === "function" ? await value() : value);
}

export class SignedRemoteBackend<State = unknown> implements ExecutionBackend<State> {
  readonly name: string;
  readonly #options: SignedRemoteBackendOptions<State>;
  #negotiation?: Promise<CapabilityNegotiation>;

  constructor(options: SignedRemoteBackendOptions<State>) {
    this.#options = options;
    this.name = options.name ?? "signed-remote-http";
  }

  async #fetch(method: string, endpoint: string, body = "", timeoutMs?: number): Promise<Response> {
    const fetcher = this.#options.fetch ?? globalThis.fetch;
    if (!fetcher) throw new Error("SignedRemoteBackend requires fetch");
    const headers = await configuredHeaders(this.#options.headers);
    const signed = signRemoteRequest(this.#options.secret, {
      method,
      url: endpoint,
      body,
      timestamp: this.#options.now?.(),
      nonce: this.#options.nonce?.(),
    });
    for (const [key, value] of Object.entries(signed)) headers.set(key, value);
    headers.set("accept", "application/json");
    if (body) headers.set("content-type", "application/json");
    const controller = timeoutMs ? new AbortController() : undefined;
    const timer = timeoutMs ? setTimeout(() => controller!.abort(new Error(`CloudFault signed remote request exceeded ${timeoutMs}ms`)), timeoutMs) : undefined;
    try {
      return await fetcher(endpoint, { method, headers, body: body || undefined, signal: controller?.signal });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async capabilities(): Promise<CapabilityNegotiation> {
    this.#negotiation ??= (async () => {
      const url = new URL(this.#options.capabilityEndpoint ?? this.#options.endpoint);
      url.searchParams.set("capabilities", "1");
      const response = await this.#fetch("GET", url.toString());
      if (!response.ok) throw new Error(`CloudFault signed capability query returned ${response.status}`);
      const capabilities = await response.json() as RemoteAgentCapabilities;
      if (capabilities.schema !== "cloudfault.remote-capabilities" || capabilities.version !== 1) throw new Error("Remote agent returned incompatible capabilities");
      return negotiateRemoteCapabilities(capabilities, this.#options.requiredFeatures ?? []);
    })();
    return this.#negotiation;
  }

  async execute(scenario: Scenario, context: ExecutionContext = {}): Promise<RunResult<State>> {
    const negotiation = await this.capabilities();
    if (!negotiation.compatible) throw new Error(`CloudFault remote agent '${negotiation.capabilities.agent}' is missing required features: ${negotiation.missing.join(", ")}`);
    const body = JSON.stringify({ schema: "cloudfault.remote-execution", version: 1, scenario, context });
    const response = await this.#fetch("POST", this.#options.endpoint, body, context.timeoutMs);
    if (!response.ok) throw new Error(`CloudFault signed remote backend returned ${response.status}: ${await response.text()}`);
    return this.#options.decode ? this.#options.decode(response) : await response.json() as RunResult<State>;
  }
}

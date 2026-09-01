import { RemoteHttpBackend, type ExecutionBackend, type ExecutionContext, type RemoteHttpBackendOptions } from "./backend.js";
import { queryRemoteCapabilities, type RemoteAgentCapabilities } from "./remote-agent.js";
import type { RunResult, Scenario } from "./types.js";

export interface NegotiatedRemoteBackendOptions<State = unknown> extends RemoteHttpBackendOptions<State> {
  requiredFeatures?: readonly string[];
  capabilityEndpoint?: string;
  name?: string;
}

export interface CapabilityNegotiation {
  capabilities: RemoteAgentCapabilities;
  required: readonly string[];
  missing: readonly string[];
  compatible: boolean;
}

export function negotiateRemoteCapabilities(
  capabilities: RemoteAgentCapabilities,
  required: readonly string[],
): CapabilityNegotiation {
  const available = new Set(capabilities.features ?? []);
  const missing = [...new Set(required)].filter((feature) => !available.has(feature)).sort();
  return { capabilities, required: [...new Set(required)].sort(), missing, compatible: missing.length === 0 };
}

async function resolveHeaders(value: RemoteHttpBackendOptions["headers"]): Promise<HeadersInit | undefined> {
  return typeof value === "function" ? await value() : value;
}

/**
 * Same ExecutionBackend interface as local execution, with a one-time remote
 * capability handshake before the first scenario. This prevents a planner from
 * silently running a test on a staging agent that cannot model required faults.
 */
export class NegotiatedRemoteBackend<State = unknown> implements ExecutionBackend<State> {
  readonly name: string;
  readonly #remote: RemoteHttpBackend<State>;
  readonly #options: NegotiatedRemoteBackendOptions<State>;
  #negotiation?: Promise<CapabilityNegotiation>;

  constructor(options: NegotiatedRemoteBackendOptions<State>) {
    this.#options = options;
    this.name = options.name ?? "negotiated-remote-http";
    this.#remote = new RemoteHttpBackend<State>(options);
  }

  async capabilities(): Promise<CapabilityNegotiation> {
    this.#negotiation ??= (async () => {
      const capabilities = await queryRemoteCapabilities(this.#options.capabilityEndpoint ?? this.#options.endpoint, {
        fetch: this.#options.fetch,
        headers: await resolveHeaders(this.#options.headers),
      });
      return negotiateRemoteCapabilities(capabilities, this.#options.requiredFeatures ?? []);
    })();
    return this.#negotiation;
  }

  async execute(scenario: Scenario, context?: ExecutionContext): Promise<RunResult<State>> {
    const negotiation = await this.capabilities();
    if (!negotiation.compatible) {
      throw new Error(`CloudFault remote agent '${negotiation.capabilities.agent}' is missing required features: ${negotiation.missing.join(", ")}`);
    }
    return this.#remote.execute(scenario, context);
  }
}

export function createBearerAuthorizer(token: string): (request: Request) => boolean {
  return (request) => request.headers.get("authorization") === `Bearer ${token}`;
}

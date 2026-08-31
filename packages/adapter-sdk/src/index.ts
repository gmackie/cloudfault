export type IdempotencySemantics = "none" | "intrinsic" | "key-supported";
export type AmbiguityRisk = "none" | "low" | "high";

export interface AdapterManifest {
  name: string;
  provider: string;
  unofficial?: boolean;
  hosts: string[];
  capabilities?: string[];
}

export interface OperationSemantics {
  sideEffect: boolean;
  externallyVisible: boolean;
  idempotency: IdempotencySemantics;
  ambiguityRisk: AmbiguityRisk;
  eventualVisibility?: {
    minMs: number;
    maxMs: number;
  };
}

export interface OperationMatch {
  method?: string;
  path: RegExp;
}

export interface OperationDefinition {
  name: string;
  kind: "query" | "mutation";
  match: OperationMatch;
  semantics: OperationSemantics;
}

export interface ClassifiedOperation {
  adapter: string;
  provider: string;
  operation: OperationDefinition;
  url: URL;
  method: string;
  idempotencyKey?: string;
}

export interface AdapterRequest {
  url: string | URL;
  method?: string;
  headers?: Headers | Record<string, string>;
}

export interface SemanticAdapter {
  manifest: AdapterManifest;
  operations: OperationDefinition[];
  classify(request: AdapterRequest): ClassifiedOperation | null;
  faults?(operation: ClassifiedOperation): SemanticFaultTemplate[];
}

export interface SemanticFaultTemplate {
  id: string;
  label: string;
  phase: "before-send" | "before-commit" | "after-commit-before-response" | "response";
  actualOutcome: "committed" | "not-committed" | "unknown";
  observedOutcome: "success" | "failure" | "indeterminate";
  detail?: Record<string, unknown>;
}

function normalizeHeaders(headers?: AdapterRequest["headers"]): Headers {
  if (headers instanceof Headers) return headers;
  return new Headers(headers ?? {});
}

export function defineAdapter(input: Omit<SemanticAdapter, "classify">): SemanticAdapter {
  return {
    ...input,
    classify(request) {
      const url = request.url instanceof URL ? request.url : new URL(request.url);
      if (!input.manifest.hosts.includes(url.hostname)) return null;

      const method = (request.method ?? "GET").toUpperCase();
      for (const operation of input.operations) {
        if (operation.match.method && operation.match.method.toUpperCase() !== method) continue;
        operation.match.path.lastIndex = 0;
        if (!operation.match.path.test(url.pathname)) continue;
        const headers = normalizeHeaders(request.headers);
        return {
          adapter: input.manifest.name,
          provider: input.manifest.provider,
          operation,
          url,
          method,
          idempotencyKey: headers.get("Idempotency-Key") ?? undefined,
        };
      }
      return null;
    },
  };
}

export function mutation(
  name: string,
  options: Omit<OperationDefinition, "name" | "kind">,
): OperationDefinition {
  return { name, kind: "mutation", ...options };
}

export function query(
  name: string,
  options: Omit<OperationDefinition, "name" | "kind">,
): OperationDefinition {
  return { name, kind: "query", ...options };
}

export function commitThenTimeout(id = "commit-then-timeout"): SemanticFaultTemplate {
  return {
    id,
    label: "provider commits, caller times out",
    phase: "after-commit-before-response",
    actualOutcome: "committed",
    observedOutcome: "indeterminate",
  };
}

export function commitThenDisconnect(id = "commit-then-disconnect"): SemanticFaultTemplate {
  return {
    id,
    label: "provider commits, connection disconnects before response",
    phase: "after-commit-before-response",
    actualOutcome: "committed",
    observedOutcome: "indeterminate",
  };
}

export function rejectBeforeCommit(id = "reject-before-commit"): SemanticFaultTemplate {
  return {
    id,
    label: "provider rejects before commit",
    phase: "before-commit",
    actualOutcome: "not-committed",
    observedOutcome: "failure",
  };
}

export function rateLimited(retryAfterMs?: number): SemanticFaultTemplate {
  return {
    id: "rate-limited",
    label: "provider returns rate limit",
    phase: "before-commit",
    actualOutcome: "not-committed",
    observedOutcome: "failure",
    detail: retryAfterMs === undefined ? undefined : { retryAfterMs },
  };
}

export class AdapterRegistry {
  readonly #adapters: SemanticAdapter[] = [];

  register(adapter: SemanticAdapter): this {
    this.#adapters.push(adapter);
    return this;
  }

  classify(request: AdapterRequest): ClassifiedOperation | null {
    for (const adapter of this.#adapters) {
      const result = adapter.classify(request);
      if (result) return result;
    }
    return null;
  }

  list(): readonly SemanticAdapter[] {
    return this.#adapters;
  }
}

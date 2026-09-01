import {
  CloudFaultIndeterminateError,
  CloudFaultInjectedError,
  type AdapterExecutionContext,
  type SemanticAdapter,
  type SemanticOperation,
} from "@cloudfault/adapter-sdk";
import { oauthFaults, streamFaults, webhookFaults } from "@cloudfault/adapter-sdk/capabilities";
import { firstPartyAdapters } from "./catalog.js";

type ProviderPerturbation = ReturnType<SemanticAdapter["faultSpace"]>[number];

function fault(
  adapter: SemanticAdapter,
  operation: SemanticOperation,
  kind: string,
  options: {
    semanticKind?: string;
    status?: number;
    body?: unknown;
    headers?: Record<string, string>;
    actualOutcome?: "committed" | "not-committed" | "unknown";
    observedOutcome?: "success" | "definite-failure" | "indeterminate";
    phase?: "before-send" | "before-commit" | "after-commit-before-response" | "during-response" | "after-response" | "delivery";
    description: string;
    category?: "provider" | "cloudflare" | "transport" | "resource" | "application";
  },
): ProviderPerturbation {
  return {
    id: `${adapter.manifest.name}:${operation.name}:${kind}`,
    target: adapter.manifest.name,
    operation: operation.name,
    kind,
    phase: options.phase ?? "before-commit",
    description: options.description,
    category: options.category ?? "provider",
    actualOutcome: options.actualOutcome ?? "not-committed",
    observedOutcome: options.observedOutcome ?? "definite-failure",
    metadata: {
      semanticKind: options.semanticKind ?? kind,
      status: options.status,
      body: options.body,
      headers: options.headers,
    },
  } as ProviderPerturbation;
}

function semantic(
  adapter: SemanticAdapter,
  operation: SemanticOperation,
  kind: string,
  description: string,
  metadata: Record<string, unknown> = {},
): ProviderPerturbation {
  return {
    id: `${adapter.manifest.name}:${operation.name}:${kind}`,
    target: adapter.manifest.name,
    operation: operation.name,
    kind,
    description,
    metadata,
  } as ProviderPerturbation;
}

function dedupe(items: readonly ProviderPerturbation[]): readonly ProviderPerturbation[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function providerFaults(adapter: SemanticAdapter, operation: SemanticOperation): readonly ProviderPerturbation[] {
  const name = adapter.manifest.name;
  const result: ProviderPerturbation[] = [];

  if (adapter.manifest.capabilities.includes("streaming")) {
    result.push(...streamFaults(name, operation.name));
  }
  if (adapter.manifest.capabilities.includes("oauth")) {
    result.push(...oauthFaults(name, operation.name));
  }
  if (adapter.manifest.capabilities.includes("regional-failures")) {
    result.push(fault(adapter, operation, "region-unavailable", {
      status: 503,
      description: `${adapter.manifest.provider} regional endpoint is temporarily unavailable`,
      body: { error: "ServiceUnavailable", message: "CloudFault injected regional unavailability" },
    }));
  }

  if (name === "anthropic") {
    result.push(fault(adapter, operation, "anthropic-overloaded", {
      status: 529,
      description: "Anthropic API returns overloaded_error",
      body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
    }));
  }

  if (name === "github") {
    result.push(fault(adapter, operation, "github-secondary-rate-limit", {
      status: 403,
      description: "GitHub secondary rate limit rejects the request and requires backoff",
      headers: { "retry-after": "60" },
      body: { message: "You have exceeded a secondary rate limit." },
    }));
  }

  if (name === "slack") {
    result.push(fault(adapter, operation, "slack-application-error", {
      status: 200,
      description: "Slack Web API returns HTTP 200 with ok=false",
      body: { ok: false, error: "cloudfault_injected_error" },
      actualOutcome: "not-committed",
      observedOutcome: "definite-failure",
    }));
  }

  if (name === "shopify" && operation.name === "graphql.execute") {
    result.push(fault(adapter, operation, "shopify-graphql-throttled", {
      status: 200,
      description: "Shopify GraphQL returns HTTP 200 with a THROTTLED error payload",
      body: {
        data: null,
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        extensions: { cost: { throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 50 } } },
      },
    }));
  }

  if (name === "openai" && operation.name.includes("response")) {
    result.push(fault(adapter, operation, "openai-long-request-timeout", {
      status: 504,
      description: "Long-running model request times out before a complete response",
      actualOutcome: "unknown",
      observedOutcome: "indeterminate",
      phase: "during-response",
      category: "transport",
      body: { error: { type: "timeout_error", message: "CloudFault injected long-request timeout" } },
    }));
  }

  return result;
}

function responseFromProviderFault(perturbation: ProviderPerturbation): Response | undefined {
  if (!("phase" in perturbation)) return undefined;
  const status = typeof perturbation.metadata?.status === "number" ? perturbation.metadata.status : undefined;
  if (status === undefined) return undefined;
  const body = perturbation.metadata?.body;
  const headers = new Headers({ "content-type": "application/json" });
  const configuredHeaders = perturbation.metadata?.headers;
  if (configuredHeaders && typeof configuredHeaders === "object") {
    for (const [key, value] of Object.entries(configuredHeaders as Record<string, string>)) headers.set(key, value);
  }
  return new Response(typeof body === "string" ? body : JSON.stringify(body ?? { error: perturbation.kind }), { status, headers });
}

function interruptedResponse(response: Response, afterChunks: number): Response {
  const reader = response.body?.getReader();
  if (!reader) return new Response(new ReadableStream({ start(controller) { controller.error(new Error("CloudFault interrupted empty stream")); } }), { status: response.status, headers: response.headers });
  let delivered = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (delivered >= afterChunks) {
        try { await reader.cancel("CloudFault stream interruption"); } catch {}
        controller.error(new Error(`CloudFault interrupted stream after ${afterChunks} chunk(s)`));
        return;
      }
      const next = await reader.read();
      if (next.done) { controller.close(); return; }
      delivered += 1;
      controller.enqueue(next.value);
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function genericExecute(context: AdapterExecutionContext): Promise<Response> {
  const { operation, perturbation, upstream, controller, operationRef } = context;
  try {
    if (perturbation && "phase" in perturbation) {
      if (perturbation.kind === "token-expired" || perturbation.kind === "token-revoked") {
        controller.complete(operationRef, "fail", { status: 401 }, { actual: "not-committed", observed: "definite-failure", detail: perturbation.kind });
        return new Response(JSON.stringify({ error: "invalid_token", error_description: perturbation.kind }), { status: 401, headers: { "content-type": "application/json", "www-authenticate": "Bearer" } });
      }

      if (perturbation.kind === "stream-interrupt") {
        const response = await upstream();
        controller.complete(operationRef, "info", { upstreamStatus: response.status }, {
          actual: operation.effect === "query" ? "unknown" : "committed",
          observed: "indeterminate",
          detail: "stream-interrupt",
        });
        return interruptedResponse(response, Math.max(0, Number(perturbation.metadata?.afterChunks ?? 1)));
      }

      const providerResponse = responseFromProviderFault(perturbation);
      if (providerResponse) {
        const successStatusWithErrorPayload = providerResponse.ok && ["slack-application-error", "shopify-graphql-throttled"].includes(perturbation.kind);
        controller.complete(operationRef, successStatusWithErrorPayload ? "fail" : providerResponse.ok ? "ok" : "fail", { status: providerResponse.status }, {
          actual: perturbation.actualOutcome ?? "not-committed",
          observed: perturbation.observedOutcome ?? "definite-failure",
          detail: String(perturbation.metadata?.semanticKind ?? perturbation.kind),
        });
        return providerResponse;
      }

      if (perturbation.kind === "rate-limit") {
        const retryAfter = perturbation.metadata?.retryAfterSeconds;
        const headers = new Headers({ "content-type": "application/json" });
        if (typeof retryAfter === "number") headers.set("retry-after", String(retryAfter));
        controller.complete(operationRef, "fail", { status: 429 }, { actual: "not-committed", observed: "definite-failure", detail: "rate-limit" });
        return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "CloudFault injected rate limit" } }), { status: 429, headers });
      }

      if (perturbation.kind === "http-error" || perturbation.kind === "reject-before-commit") {
        const status = typeof perturbation.metadata?.status === "number" ? perturbation.metadata.status : 503;
        controller.complete(operationRef, "fail", { status }, { actual: perturbation.actualOutcome ?? "not-committed", observed: perturbation.observedOutcome ?? "definite-failure" });
        return new Response(typeof perturbation.metadata?.body === "string" ? perturbation.metadata.body : JSON.stringify(perturbation.metadata?.body ?? { error: perturbation.kind }), { status, headers: { "content-type": "application/json" } });
      }

      if (perturbation.kind === "timeout-before-send") {
        controller.complete(operationRef, "fail", undefined, { actual: "not-committed", observed: "definite-failure", detail: "timeout-before-send" });
        throw new CloudFaultInjectedError("CloudFault injected timeout before send", perturbation);
      }

      if (perturbation.kind === "latency") await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(perturbation.metadata?.delayMs ?? 0))));

      if (perturbation.kind === "malformed-json") {
        const response = await upstream();
        controller.complete(operationRef, "info", { upstreamStatus: response.status }, { actual: operation.effect === "query" ? "unknown" : "committed", observed: "indeterminate", detail: "malformed-json" });
        const headers = new Headers(response.headers); headers.set("content-type", "application/json");
        return new Response('{"cloudfault":', { status: response.status, headers });
      }

      if (perturbation.kind === "commit-then-timeout" || perturbation.kind === "commit-then-disconnect") {
        const response = await upstream();
        controller.complete(operationRef, "info", { upstreamStatus: response.status }, { actual: perturbation.actualOutcome ?? "committed", observed: "indeterminate", detail: perturbation.kind });
        throw new CloudFaultIndeterminateError(`CloudFault injected ${perturbation.kind} after provider commit`, perturbation, operationRef);
      }
    }

    const response = await upstream();
    controller.complete(operationRef, response.ok ? "ok" : "fail", { status: response.status }, {
      actual: operation.effect === "query" ? "unknown" : response.ok ? "committed" : "unknown",
      observed: response.ok ? "success" : "definite-failure",
    });
    return response;
  } catch (error) {
    if (error instanceof CloudFaultIndeterminateError || error instanceof CloudFaultInjectedError) throw error;
    controller.complete(operationRef, "info", { error: error instanceof Error ? error.message : String(error) }, { actual: "unknown", observed: "indeterminate" });
    throw error;
  }
}

export function withProviderSemantics(adapter: SemanticAdapter): SemanticAdapter {
  return {
    manifest: adapter.manifest,
    match: (request) => adapter.match(request),
    faultSpace(operation, request) {
      return dedupe([...adapter.faultSpace(operation, request), ...providerFaults(adapter, operation)]);
    },
    execute(context) {
      const semanticKind = context.perturbation?.metadata?.semanticKind;
      const custom = context.perturbation && (
        context.perturbation.kind === "stream-interrupt" ||
        context.perturbation.kind === "token-expired" ||
        context.perturbation.kind === "token-revoked" ||
        typeof semanticKind === "string"
      );
      if (!custom && adapter.execute) return adapter.execute(context);
      return genericExecute(context);
    },
  };
}

export const semanticFirstPartyAdapters: readonly SemanticAdapter[] = firstPartyAdapters.map(withProviderSemantics);

export function semanticAdapter(name: string): SemanticAdapter | undefined {
  return semanticFirstPartyAdapters.find((adapter) => adapter.manifest.name === name);
}

/** Provider lifecycle events that are not direct responses to one API call. */
export function providerLifecyclePerturbations(adapter: SemanticAdapter): readonly ProviderPerturbation[] {
  const result: ProviderPerturbation[] = [];
  if (adapter.manifest.capabilities.includes("webhooks") || adapter.manifest.capabilities.includes("callbacks")) result.push(...webhookFaults(adapter.manifest.name));
  if (adapter.manifest.capabilities.some((capability) => ["async-jobs", "async-operations", "deployments"].includes(capability))) {
    const operation: SemanticOperation = { name: "async-job.visibility", effect: "query", retry: "safe" };
    result.push(
      semantic(adapter, operation, "async-job-stalled", `${adapter.manifest.provider} asynchronous operation remains pending beyond the caller's expected window`, { status: "running" }),
      semantic(adapter, operation, "async-job-delayed-visibility", `${adapter.manifest.provider} asynchronous result becomes visible later than the triggering request`, { delayedVisibility: true }),
    );
  }
  if (adapter.manifest.name === "algolia") {
    const operation: SemanticOperation = { name: "index.visibility", effect: "query", retry: "safe" };
    result.push(semantic(adapter, operation, "index-not-yet-visible", "Algolia write task has been accepted but the updated index is not yet observed by the test workload", { requiresTaskCompletion: true }));
  }
  return dedupe(result);
}

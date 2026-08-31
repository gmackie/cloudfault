import {
  commitThenDisconnect,
  commitThenTimeout,
  defineAdapter,
  rateLimit,
  rejectBeforeCommit,
  type RequestMatch,
} from "@cloudfault/adapter-sdk";
import type { Perturbation } from "@cloudfault/core";

const paymentIntent = /^\/v1\/payment_intents\/([^/]+)$/;
const paymentIntentConfirm = /^\/v1\/payment_intents\/([^/]+)\/confirm$/;
const refund = /^\/v1\/refunds(?:\/([^/]+))?$/;

function formBoolean(value: FormDataEntryValue | null): boolean {
  return value === "true" || value === "1";
}

function requestIdempotency(request: Request): string | undefined {
  return request.headers.get("Idempotency-Key") ?? undefined;
}

export const stripeAdapter = defineAdapter({
  manifest: {
    name: "stripe",
    provider: "Stripe",
    version: "0.1.0",
    contractVersion: "2026 semantic subset",
    unofficial: true,
    hosts: ["api.stripe.com"],
    capabilities: ["payments", "idempotency", "rate-limits", "outcome-ambiguity", "webhooks"],
  },

  match(request: Request): RequestMatch | null {
    const url = new URL(request.url);
    if (!this.manifest.hosts.includes(url.hostname)) return null;

    const confirm = paymentIntentConfirm.exec(url.pathname);
    if (request.method === "POST" && confirm) {
      const paymentIntentId = confirm[1]!;
      const idempotencyKey = requestIdempotency(request);
      return {
        operation: {
          name: "payment_intent.confirm",
          effect: "external-side-effect",
          resource: paymentIntentId,
          retry: idempotencyKey ? "conditional" : "unsafe",
          idempotencyKey,
          metadata: { method: request.method, path: url.pathname },
        },
        params: { paymentIntent: paymentIntentId },
      };
    }

    if (request.method === "POST" && url.pathname === "/v1/payment_intents") {
      const idempotencyKey = requestIdempotency(request);
      return {
        operation: {
          name: "payment_intent.create",
          // Creating a PI alone is a mutation; a create+confirm request can move money.
          // The runtime/backend may refine this based on the body, but we conservatively
          // treat it as an external side effect because Stripe accepts `confirm=true`.
          effect: "external-side-effect",
          retry: idempotencyKey ? "conditional" : "unsafe",
          idempotencyKey,
          metadata: { method: request.method, path: url.pathname },
        },
      };
    }

    const pi = paymentIntent.exec(url.pathname);
    if (request.method === "GET" && pi) {
      return {
        operation: {
          name: "payment_intent.retrieve",
          effect: "query",
          resource: pi[1],
          retry: "safe",
          metadata: { method: request.method, path: url.pathname },
        },
      };
    }

    const refundMatch = refund.exec(url.pathname);
    if (request.method === "POST" && refundMatch) {
      const idempotencyKey = requestIdempotency(request);
      return {
        operation: {
          name: "refund.create",
          effect: "external-side-effect",
          resource: refundMatch[1],
          retry: idempotencyKey ? "conditional" : "unsafe",
          idempotencyKey,
          metadata: { method: request.method, path: url.pathname },
        },
      };
    }

    if (request.method === "GET") {
      return {
        operation: {
          name: "stripe.query",
          effect: "query",
          retry: "safe",
          metadata: { method: request.method, path: url.pathname },
        },
      };
    }

    return {
      operation: {
        name: "stripe.mutation",
        effect: "mutation",
        retry: request.headers.has("Idempotency-Key") ? "conditional" : "unknown",
        idempotencyKey: requestIdempotency(request),
        metadata: { method: request.method, path: url.pathname },
      },
    };
  },

  faultSpace(operation): readonly Perturbation[] {
    const target = "stripe";
    const common: Perturbation[] = [
      rateLimit({
        id: `stripe:${operation.name}:429`,
        target,
        operation: operation.name,
        retryAfterSeconds: 2,
      }),
      rejectBeforeCommit({
        id: `stripe:${operation.name}:reject`,
        target,
        operation: operation.name,
        metadata: { status: 503 },
      }),
    ];

    if (operation.effect === "external-side-effect" || operation.effect === "mutation") {
      common.push(
        commitThenTimeout({
          id: `stripe:${operation.name}:commit-timeout`,
          target,
          operation: operation.name,
          description: `${operation.name} commits at Stripe but the caller times out before observing the response`,
        }),
        commitThenDisconnect({
          id: `stripe:${operation.name}:commit-disconnect`,
          target,
          operation: operation.name,
          description: `${operation.name} commits at Stripe but the response connection is lost`,
        }),
      );
    }

    return common;
  },
});

export interface StripePaymentIntent {
  id: string;
  object: "payment_intent";
  amount: number;
  currency: string;
  status: "requires_confirmation" | "succeeded";
  chargeId?: string;
}

export interface StripeRefund {
  id: string;
  object: "refund";
  payment_intent?: string;
  amount?: number;
  status: "succeeded";
}

export interface StripeBackendSnapshot {
  paymentIntents: readonly StripePaymentIntent[];
  refunds: readonly StripeRefund[];
  successfulCharges: number;
  requests: number;
  idempotencyKeys: readonly string[];
}

/**
 * A deliberately small stateful Stripe backend for CloudFault tests. It is not
 * a replacement for stripe-mock/emulate; it implements only the operations
 * needed to prove outcome ambiguity and idempotency behavior in deterministic
 * CI tests.
 */
export class StripeMemoryBackend {
  readonly #paymentIntents = new Map<string, StripePaymentIntent>();
  readonly #refunds = new Map<string, StripeRefund>();
  readonly #idempotency = new Map<string, { status: number; body: string }>();
  #piSequence = 0;
  #chargeSequence = 0;
  #refundSequence = 0;
  #requests = 0;

  async fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init);
    this.#requests++;
    const url = new URL(request.url);
    const idempotencyKey = requestIdempotency(request);

    if (request.method === "POST" && idempotencyKey) {
      const cached = this.#idempotency.get(`${request.method}:${url.pathname}:${idempotencyKey}`);
      if (cached) return new Response(cached.body, { status: cached.status, headers: { "content-type": "application/json" } });
    }

    let response: Response;
    if (request.method === "POST" && url.pathname === "/v1/payment_intents") {
      const form = await request.clone().formData();
      const amount = Number(form.get("amount") ?? 0);
      const currency = String(form.get("currency") ?? "usd");
      const shouldConfirm = formBoolean(form.get("confirm"));
      const id = `pi_cf_${++this.#piSequence}`;
      const intent: StripePaymentIntent = {
        id,
        object: "payment_intent",
        amount,
        currency,
        status: shouldConfirm ? "succeeded" : "requires_confirmation",
      };
      if (shouldConfirm) intent.chargeId = `ch_cf_${++this.#chargeSequence}`;
      this.#paymentIntents.set(id, intent);
      response = Response.json(intent);
    } else {
      const confirm = paymentIntentConfirm.exec(url.pathname);
      const retrieve = paymentIntent.exec(url.pathname);
      if (request.method === "POST" && confirm) {
        const intent = this.#paymentIntents.get(confirm[1]!);
        if (!intent) response = Response.json({ error: { message: "No such payment_intent" } }, { status: 404 });
        else {
          // Re-confirming the same successful PI does not create a second charge in
          // this model; duplicate-charge scenarios require creating a new PI or a
          // genuinely non-idempotent payment operation.
          if (intent.status !== "succeeded") {
            intent.status = "succeeded";
            intent.chargeId = `ch_cf_${++this.#chargeSequence}`;
          }
          response = Response.json(intent);
        }
      } else if (request.method === "GET" && retrieve) {
        const intent = this.#paymentIntents.get(retrieve[1]!);
        response = intent
          ? Response.json(intent)
          : Response.json({ error: { message: "No such payment_intent" } }, { status: 404 });
      } else if (request.method === "POST" && url.pathname === "/v1/refunds") {
        const form = await request.clone().formData();
        const value: StripeRefund = {
          id: `re_cf_${++this.#refundSequence}`,
          object: "refund",
          payment_intent: form.get("payment_intent")?.toString(),
          amount: form.get("amount") ? Number(form.get("amount")) : undefined,
          status: "succeeded",
        };
        this.#refunds.set(value.id, value);
        response = Response.json(value);
      } else {
        response = Response.json({ error: { message: `Unsupported StripeMemoryBackend route ${request.method} ${url.pathname}` } }, { status: 404 });
      }
    }

    if (request.method === "POST" && idempotencyKey) {
      const body = await response.clone().text();
      this.#idempotency.set(`${request.method}:${url.pathname}:${idempotencyKey}`, { status: response.status, body });
    }
    return response;
  }

  snapshot(): StripeBackendSnapshot {
    return {
      paymentIntents: [...this.#paymentIntents.values()].map((value) => ({ ...value })),
      refunds: [...this.#refunds.values()].map((value) => ({ ...value })),
      successfulCharges: this.#chargeSequence,
      requests: this.#requests,
      idempotencyKeys: [...this.#idempotency.keys()],
    };
  }

  reset(): void {
    this.#paymentIntents.clear();
    this.#refunds.clear();
    this.#idempotency.clear();
    this.#piSequence = 0;
    this.#chargeSequence = 0;
    this.#refundSequence = 0;
    this.#requests = 0;
  }
}

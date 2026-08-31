import {
  commitThenDisconnect,
  commitThenTimeout,
  defineAdapter,
  mutation,
  rateLimited,
  rejectBeforeCommit,
  type ClassifiedOperation,
  type SemanticFaultTemplate,
} from "@cloudfault/adapter-sdk";

export const stripeAdapter = defineAdapter({
  manifest: {
    name: "stripe",
    provider: "Stripe",
    unofficial: true,
    hosts: ["api.stripe.com"],
    capabilities: ["payments", "idempotency", "webhooks", "outcome-ambiguity", "rate-limits"],
  },
  operations: [
    mutation("payment_intent.confirm", {
      match: {
        method: "POST",
        path: /^\/v1\/payment_intents\/[^/]+\/confirm$/,
      },
      semantics: {
        sideEffect: true,
        externallyVisible: true,
        idempotency: "key-supported",
        ambiguityRisk: "high",
      },
    }),
    mutation("payment_intent.create", {
      match: {
        method: "POST",
        path: /^\/v1\/payment_intents$/,
      },
      semantics: {
        sideEffect: true,
        externallyVisible: true,
        idempotency: "key-supported",
        ambiguityRisk: "high",
      },
    }),
    mutation("refund.create", {
      match: {
        method: "POST",
        path: /^\/v1\/refunds$/,
      },
      semantics: {
        sideEffect: true,
        externallyVisible: true,
        idempotency: "key-supported",
        ambiguityRisk: "high",
      },
    }),
  ],
  faults(operation: ClassifiedOperation): SemanticFaultTemplate[] {
    if (!operation.operation.semantics.sideEffect) return [rateLimited()];
    return [
      rejectBeforeCommit(),
      commitThenTimeout(),
      commitThenDisconnect(),
      rateLimited(1_000),
    ];
  },
});

export const stripeCommitThenTimeout = {
  id: "stripe:payment:commit-then-timeout",
  label: "Stripe commits payment but caller times out",
  target: "stripe",
  category: "external" as const,
  metadata: {
    semanticOperation: "payment.confirm",
    actualOutcome: "committed",
    observedOutcome: "indeterminate",
  },
};

export function classifyStripePaymentConfirmation(paymentIntentId: string, idempotencyKey?: string) {
  return stripeAdapter.classify({
    url: `https://api.stripe.com/v1/payment_intents/${paymentIntentId}/confirm`,
    method: "POST",
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
  });
}

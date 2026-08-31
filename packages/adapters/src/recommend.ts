import type { AdapterEvidence } from "./detect.js";

export interface BindingEvidence {
  type: string;
  binding: string;
}

export type RecommendationKind = "scenario" | "invariant" | "safety" | "adapter";

export interface CloudFaultRecommendation {
  id: string;
  kind: RecommendationKind;
  priority: "high" | "medium" | "low";
  title: string;
  reason: string;
  target?: string;
  perturbations?: readonly string[];
  invariantTemplate?: string;
  evidence?: readonly string[];
}

const PAYMENT_ADAPTERS = new Set(["stripe", "paypal"]);
const MESSAGE_ADAPTERS = new Set(["slack", "twilio", "sendgrid", "resend", "discord"]);
const WEBHOOK_HEAVY = new Set(["stripe", "github", "slack", "shopify", "clerk", "workos", "linear", "twilio", "resend"]);
const STREAMING = new Set(["openai", "anthropic"]);
const AUTH = new Set(["google", "microsoft-graph", "auth0", "workos", "okta", "clerk"]);

function unique(recommendations: readonly CloudFaultRecommendation[]): readonly CloudFaultRecommendation[] {
  return [...new Map(recommendations.map((item) => [item.id, item])).values()];
}

/**
 * Deterministic recommendations grounded in detected binding/provider
 * semantics. An LLM/agent can layer code-specific reasoning on top of these
 * structured facts instead of inventing generic chaos cases from scratch.
 */
export function recommendCloudFaultCoverage(
  bindings: readonly BindingEvidence[],
  adapters: readonly AdapterEvidence[],
): readonly CloudFaultRecommendation[] {
  const recommendations: CloudFaultRecommendation[] = [];

  for (const binding of bindings) {
    const target = binding.binding;
    if (binding.type === "kv") {
      recommendations.push(
        { id: `binding:${target}:kv-stale`, kind: "scenario", priority: "high", target, title: `Exercise stale ${target} reads`, reason: "KV is eventually consistent across observers; application logic should tolerate an older positive or negative view.", perturbations: ["stale-read", "stale-negative-read"] },
        { id: `binding:${target}:kv-invariant`, kind: "invariant", priority: "high", target, title: `Define a convergence invariant for ${target}`, reason: "A stale view is legal, so correctness should be expressed as a business invariant rather than read-after-write equality.", invariantTemplate: "eventually(authoritativeStateAgreesWithObservedBusinessState)" },
      );
    } else if (binding.type === "queue-producer" || binding.type === "queue-consumer") {
      recommendations.push(
        { id: `binding:${target}:queue-duplicate`, kind: "scenario", priority: "high", target, title: `Duplicate and retry ${target} deliveries`, reason: "At-least-once delivery makes consumer idempotency a correctness requirement.", perturbations: ["duplicate-delivery", "consumer-failure", "rebatch"] },
        { id: `binding:${target}:queue-idempotency`, kind: "invariant", priority: "high", target, title: `Assert idempotent ${target} side effects`, reason: "A retried message must not duplicate irreversible work.", invariantTemplate: "atMostOnce(externalSideEffect, logicalMessageId)" },
      );
    } else if (binding.type === "d1") {
      recommendations.push(
        { id: `binding:${target}:d1-write-ambiguity`, kind: "scenario", priority: "high", target, title: `Inject ambiguous ${target} writes`, reason: "A transient failure around a mutation can make blind application retries unsafe.", perturbations: ["operation-timeout", "commit-then-timeout", "replica-lag"] },
        { id: `binding:${target}:d1-relational`, kind: "invariant", priority: "high", target, title: `Assert relational invariants after ${target} retries`, reason: "HTTP success alone cannot prove multi-step local state remained coherent.", invariantTemplate: "invariant(relatedRowsRemainConsistent)" },
      );
    } else if (binding.type === "r2") {
      recommendations.push({ id: `binding:${target}:r2-ambiguity`, kind: "scenario", priority: "medium", target, title: `Exercise ${target} object-write ambiguity`, reason: "Object upload/deletion can race metadata persistence or lose the caller-visible result.", perturbations: ["capacity-5xx", "commit-then-timeout"] });
    } else if (binding.type === "durable-object") {
      recommendations.push({ id: `binding:${target}:do-retry`, kind: "scenario", priority: "high", target, title: `Retry/reset ${target} around alarms`, reason: "Durable Object alarms may retry after unsuccessful execution; handlers should make durable progress idempotently.", perturbations: ["alarm-retry", "durable-object-reset"] });
    } else if (binding.type === "workflow") {
      recommendations.push({ id: `binding:${target}:workflow-retry`, kind: "scenario", priority: "high", target, title: `Repeat ${target} steps`, reason: "Workflow steps are retryable units, so externally visible calls inside them need idempotency.", perturbations: ["workflow-step-retry", "workflow-retry-delay"] });
    } else if (binding.type === "service") {
      recommendations.push({ id: `binding:${target}:service-degraded`, kind: "scenario", priority: "medium", target, title: `Degrade service binding ${target}`, reason: "Partial service failure should preserve deadlines, retry bounds, and application invariants.", perturbations: ["service-timeout", "service-unavailable", "latency"] });
    }
  }

  for (const detected of adapters) {
    const target = detected.adapter;
    const evidence = detected.evidence;
    recommendations.push({
      id: `adapter:${target}:baseline`, kind: "adapter", priority: "medium", target,
      title: `Enable ${detected.provider} semantic faults`, reason: `Source analysis detected ${detected.provider}; use the semantic adapter instead of generic HTTP status mocking.`, evidence,
    });
    if (PAYMENT_ADAPTERS.has(target)) {
      recommendations.push(
        { id: `adapter:${target}:ambiguous-payment`, kind: "scenario", priority: "high", target, title: `Test ambiguous ${detected.provider} commits`, reason: "Payment mutations may complete while the caller observes a timeout/disconnect.", perturbations: ["commit-then-timeout", "commit-then-disconnect", "rate-limit"] },
        { id: `adapter:${target}:one-charge`, kind: "invariant", priority: "high", target, title: "Assert one financial effect per logical order", reason: "Retries after an indeterminate payment outcome must not create a second charge/refund.", invariantTemplate: "atMostOnce(financialEffect, businessIdempotencyKey)" },
      );
    }
    if (WEBHOOK_HEAVY.has(target)) recommendations.push({ id: `adapter:${target}:webhooks`, kind: "scenario", priority: "high", target, title: `Delay, duplicate, and reorder ${detected.provider} webhooks`, reason: "Webhook delivery is asynchronous and generally must be treated as retryable/out-of-order.", perturbations: ["webhook-delay", "webhook-duplicate", "webhook-reorder"] });
    if (STREAMING.has(target)) recommendations.push({ id: `adapter:${target}:stream`, kind: "scenario", priority: "medium", target, title: `Interrupt ${detected.provider} streams`, reason: "A response can fail after partial tokens/events have already been consumed.", perturbations: ["stream-interrupt", "rate-limit"] });
    if (AUTH.has(target)) recommendations.push({ id: `adapter:${target}:oauth`, kind: "scenario", priority: "medium", target, title: `Expire and revoke ${detected.provider} credentials`, reason: "Long-running Workers/workflows should recover correctly from token expiry and failed refresh.", perturbations: ["token-expired", "token-revoked"] });
    if (MESSAGE_ADAPTERS.has(target)) recommendations.push({ id: `adapter:${target}:message-at-most-once`, kind: "invariant", priority: "medium", target, title: `Prevent duplicate ${detected.provider} sends`, reason: "Timeout-after-send ambiguity can duplicate messages or notifications.", invariantTemplate: "atMostOnce(messageSend, logicalNotificationId)" });
  }

  return unique(recommendations).sort((a, b) => {
    const rank = { high: 0, medium: 1, low: 2 } as const;
    return rank[a.priority] - rank[b.priority] || a.id.localeCompare(b.id);
  });
}

export function recommendationMarkdown(items: readonly CloudFaultRecommendation[]): string {
  if (!items.length) return "No CloudFault recommendations were generated.\n";
  return items.map((item) => {
    const details = [
      `- **${item.priority.toUpperCase()} — ${item.title}**`,
      `  ${item.reason}`,
      item.perturbations?.length ? `  Perturbations: ${item.perturbations.map((p) => `\`${p}\``).join(", ")}` : undefined,
      item.invariantTemplate ? `  Invariant: \`${item.invariantTemplate}\`` : undefined,
    ].filter(Boolean);
    return details.join("\n");
  }).join("\n");
}

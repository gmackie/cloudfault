import type { Fault, SemanticVariation } from "@cloudfault/core";

export function duplicateQueueDelivery(target: string): SemanticVariation {
  return {
    id: `${target}:duplicate-delivery`,
    target,
    kind: "duplicate-delivery",
    description: `${target} delivers a message more than once (at-least-once semantics)`,
    selector: { target },
  };
}

export function rebatchQueueDelivery(target: string): SemanticVariation {
  return {
    id: `${target}:rebatch`,
    target,
    kind: "rebatch",
    description: `${target} changes batch boundaries without changing logical messages`,
    selector: { target },
  };
}

export function queueProducerFailure(target: string): Fault {
  return {
    id: `${target}:producer-failure`,
    target,
    kind: "producer-failure",
    phase: "before-commit",
    category: "cloudflare",
    description: `${target} producer send fails before CloudFault can establish enqueue success`,
    actualOutcome: "unknown",
    observedOutcome: "definite-failure",
    selector: { target },
  };
}

export function queueConsumerFailure(target: string): Fault {
  return {
    id: `${target}:consumer-failure`,
    target,
    kind: "consumer-failure",
    phase: "delivery",
    category: "cloudflare",
    description: `${target} consumer fails during delivery and may be retried`,
    actualOutcome: "unknown",
    observedOutcome: "definite-failure",
    selector: { target },
  };
}

export interface QueueMessageLike<T = unknown> { id: string; body: T; }

export function applyQueueDeliverySemantics<T extends QueueMessageLike>(
  messages: readonly T[],
  options: { duplicateIds?: readonly string[]; batchSizes?: readonly number[] } = {},
): readonly (readonly T[])[] {
  const expanded: T[] = [];
  const duplicates = new Set(options.duplicateIds ?? []);
  for (const message of messages) {
    expanded.push(message);
    if (duplicates.has(message.id)) expanded.push({ ...message } as T);
  }
  if (!options.batchSizes?.length) return expanded.map((message) => [message]);
  const output: T[][] = [];
  let offset = 0;
  let batchIndex = 0;
  while (offset < expanded.length) {
    const size = Math.max(1, options.batchSizes[batchIndex % options.batchSizes.length] ?? 1);
    output.push(expanded.slice(offset, offset + size));
    offset += size;
    batchIndex++;
  }
  return output;
}

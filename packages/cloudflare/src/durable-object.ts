import type { Fault, SemanticVariation } from "@cloudfault/core";

export function duplicateAlarmDelivery(target: string): SemanticVariation {
  return {
    id: `${target}:alarm-retry`,
    target,
    kind: "alarm-retry",
    description: `${target} alarm handler executes again after an unsuccessful attempt`,
    selector: { target },
  };
}

export function durableObjectReset(target: string): Fault {
  return {
    id: `${target}:reset`,
    target,
    kind: "durable-object-reset",
    phase: "after-commit-before-response",
    category: "cloudflare",
    description: `${target} isolate/object resets around an operation boundary`,
    actualOutcome: "unknown",
    observedOutcome: "indeterminate",
    selector: { target },
  };
}

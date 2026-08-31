import type { SemanticVariation } from "@cloudfault/core";

export function duplicateScheduledExecution(target = "scheduled"): SemanticVariation {
  return {
    id: `${target}:duplicate-execution`,
    target,
    kind: "duplicate-scheduled-execution",
    description: `${target} logical scheduled work executes more than once`,
    selector: { target },
  };
}

export function delayedScheduledExecution(target = "scheduled", delayMs: number): SemanticVariation {
  return {
    id: `${target}:delayed:${delayMs}`,
    target,
    kind: "delayed-scheduled-execution",
    description: `${target} fires ${delayMs}ms later than nominal application time`,
    selector: { target },
    metadata: { delayMs },
  };
}

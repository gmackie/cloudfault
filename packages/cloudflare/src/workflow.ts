import type { SemanticVariation } from "@cloudfault/core";

export function workflowStepRetry(target: string, step?: string): SemanticVariation {
  return {
    id: `${target}:step-retry:${step ?? "*"}`,
    target,
    operation: step,
    kind: "workflow-step-retry",
    description: `${target}${step ? ` step ${step}` : ""} executes again under retry semantics`,
    selector: { target, operation: step },
  };
}

export function workflowRetryDelay(target: string, delayMs: number, step?: string): SemanticVariation {
  return {
    id: `${target}:retry-delay:${step ?? "*"}:${delayMs}`,
    target,
    operation: step,
    kind: "workflow-retry-delay",
    description: `${target}${step ? ` step ${step}` : ""} retries after ${delayMs}ms`,
    selector: { target, operation: step },
    metadata: { delayMs },
  };
}

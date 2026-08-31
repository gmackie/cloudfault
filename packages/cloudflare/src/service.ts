import type { Fault } from "@cloudfault/core";

export function serviceTimeout(target: string, operation?: string): Fault {
  return {
    id: `${target}:${operation ?? "*"}:timeout`,
    target,
    operation,
    kind: "service-timeout",
    phase: "during-response",
    category: "cloudflare",
    description: `${target}${operation ? ` ${operation}` : ""} becomes indeterminate due to a service timeout`,
    actualOutcome: "unknown",
    observedOutcome: "indeterminate",
    selector: { target, operation },
  };
}

export function serviceUnavailable(target: string, operation?: string, status = 503): Fault {
  return {
    id: `${target}:${operation ?? "*"}:${status}`,
    target,
    operation,
    kind: "service-unavailable",
    phase: "before-commit",
    category: "cloudflare",
    description: `${target}${operation ? ` ${operation}` : ""} returns ${status}`,
    actualOutcome: "not-committed",
    observedOutcome: "definite-failure",
    selector: { target, operation },
    metadata: { status },
  };
}

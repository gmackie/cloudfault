import type { Fault } from "@cloudfault/core";

export function r2CapacityError(target = "R2", status = 503): Fault {
  return {
    id: `${target}:capacity:${status}`,
    target,
    kind: "capacity-5xx",
    phase: "before-commit",
    category: "cloudflare",
    description: `${target} returns a transient ${status} under capacity/degradation pressure`,
    actualOutcome: "not-committed",
    observedOutcome: "definite-failure",
    selector: { target },
    metadata: { status },
  };
}

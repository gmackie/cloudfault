import type { Fault } from "@cloudfault/core";

export function r2CapacityFault(binding: string): Fault {
  return {
    id: `r2:${binding}:capacity-5xx`,
    label: `${binding} returns transient capacity/backend 5xx`,
    target: `r2:${binding}`,
    category: "degradation",
    metadata: {
      binding,
      retryability: "backoff-recommended",
    },
  };
}

import type { Fault } from "@cloudfault/core";

export function serviceBindingTimeout(binding: string, latencyMs?: number): Fault {
  return {
    id: `service:${binding}:timeout`,
    label: `${binding} service binding times out`,
    target: `service:${binding}`,
    category: "degradation",
    metadata: latencyMs === undefined ? undefined : { latencyMs },
  };
}

export function serviceBindingUnavailable(binding: string, status = 503): Fault {
  return {
    id: `service:${binding}:status:${status}`,
    label: `${binding} service binding returns ${status}`,
    target: `service:${binding}`,
    category: "degradation",
    metadata: { status },
  };
}

export function serviceBindingLatency(binding: string, latencyMs: number): Fault {
  return {
    id: `service:${binding}:latency:${latencyMs}`,
    label: `${binding} service binding adds ${latencyMs}ms latency`,
    target: `service:${binding}`,
    category: "degradation",
    metadata: { latencyMs },
  };
}

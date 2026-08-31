import type { Fault } from "@cloudfault/core";

export type D1DegradationKind =
  | "network-lost"
  | "storage-reset"
  | "replica-unavailable"
  | "operation-timeout";

export function d1TransientFault(binding: string, kind: D1DegradationKind): Fault {
  const labels: Record<D1DegradationKind, string> = {
    "network-lost": "D1 transient network loss",
    "storage-reset": "D1 storage reset",
    "replica-unavailable": "D1 replica unavailable",
    "operation-timeout": "D1 storage operation timeout",
  };

  return {
    id: `d1:${binding}:${kind}`,
    label: labels[kind],
    target: `d1:${binding}`,
    category: "degradation",
    metadata: { binding, kind, retryability: "operation-dependent" },
  };
}

export function d1DefaultDegradationFaults(binding: string): Fault[] {
  return [
    d1TransientFault(binding, "network-lost"),
    d1TransientFault(binding, "storage-reset"),
    d1TransientFault(binding, "replica-unavailable"),
    d1TransientFault(binding, "operation-timeout"),
  ];
}

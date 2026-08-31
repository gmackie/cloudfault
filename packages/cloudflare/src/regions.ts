import type { Fault, Perturbation } from "@cloudfault/core";
import { d1ReplicaLag } from "./d1.js";
import { staleKvRead, staleNegativeKvRead, type EventuallyConsistentKvStore } from "./kv.js";

/**
 * Logical observer profile. These are deliberately not claims about specific
 * Cloudflare POPs or replication timings; they model distinct observers that
 * may see different legal views of eventually-consistent state.
 */
export interface ObserverRegionProfile {
  id: string;
  description: string;
  networkLatencyMs?: number;
  kvVersionsBehind?: number;
  staleNegativeLookups?: boolean;
  d1ReplicaVersionsBehind?: number;
  metadata?: Record<string, unknown>;
}

export function defineObserverRegion(profile: ObserverRegionProfile): ObserverRegionProfile {
  return profile;
}

export const observerRegionProfiles = {
  local: defineObserverRegion({
    id: "local",
    description: "Low-latency observer with converged local views",
    networkLatencyMs: 5,
    kvVersionsBehind: 0,
    d1ReplicaVersionsBehind: 0,
  }),
  remote: defineObserverRegion({
    id: "remote",
    description: "Remote observer permitted to lag eventually-consistent state",
    networkLatencyMs: 100,
    kvVersionsBehind: 1,
    staleNegativeLookups: true,
    d1ReplicaVersionsBehind: 1,
  }),
  degraded: defineObserverRegion({
    id: "degraded",
    description: "High-latency observer with intentionally exaggerated but bounded stale views",
    networkLatencyMs: 400,
    kvVersionsBehind: 2,
    staleNegativeLookups: true,
    d1ReplicaVersionsBehind: 2,
    metadata: { purpose: "hostile-model" },
  }),
} as const;

export interface RegionBindingTargets {
  kv?: readonly { target: string; keys?: readonly string[] }[];
  d1?: readonly { target: string; replica?: string }[];
  services?: readonly { target: string; operation?: string }[];
}

export function observerRegionPerturbations(
  profile: ObserverRegionProfile,
  bindings: RegionBindingTargets,
): readonly Perturbation[] {
  const result: Perturbation[] = [];
  for (const binding of bindings.kv ?? []) {
    const keys = binding.keys?.length ? binding.keys : [undefined];
    for (const key of keys) {
      if ((profile.kvVersionsBehind ?? 0) > 0) {
        result.push(staleKvRead(binding.target, {
          region: profile.id,
          key,
          versionsBehind: profile.kvVersionsBehind,
        }));
      }
      if (profile.staleNegativeLookups) result.push(staleNegativeKvRead(binding.target, profile.id, key));
    }
  }
  for (const binding of bindings.d1 ?? []) {
    if ((profile.d1ReplicaVersionsBehind ?? 0) > 0) {
      result.push(d1ReplicaLag(
        binding.target,
        binding.replica ?? profile.id,
        profile.d1ReplicaVersionsBehind,
      ));
    }
  }
  for (const binding of bindings.services ?? []) {
    if ((profile.networkLatencyMs ?? 0) <= 0) continue;
    result.push({
      id: `${binding.target}:${binding.operation ?? "*"}:region-latency:${profile.id}`,
      target: binding.target,
      operation: binding.operation,
      kind: "latency",
      phase: "before-send",
      category: "transport",
      description: `${binding.target} observes ${profile.networkLatencyMs}ms logical region latency in ${profile.id}`,
      actualOutcome: "unknown",
      observedOutcome: "indeterminate",
      selector: { target: binding.target, operation: binding.operation },
      metadata: { delayMs: profile.networkLatencyMs, observerRegion: profile.id },
    } satisfies Fault);
  }
  return result;
}

/** Apply a logical profile directly to an in-memory KV observer model. */
export function applyObserverRegionToKv<T>(
  store: EventuallyConsistentKvStore<T>,
  profile: ObserverRegionProfile,
  keys: readonly string[],
): void {
  for (const key of keys) store.setObserverLag(profile.id, key, profile.kvVersionsBehind ?? 0);
}

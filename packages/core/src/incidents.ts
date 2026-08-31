import type { Fault, Perturbation, Scenario } from "./types.js";

export interface IncidentProfile {
  id: string;
  description: string;
  perturbations: readonly Perturbation[];
  /** Optional logical duration for reporters/schedulers; the core does not sleep. */
  durationMs?: number;
  tags?: Record<string, string | number | boolean>;
}

export function defineIncident(profile: IncidentProfile): IncidentProfile {
  return profile;
}

export function incidentScenario(
  incident: IncidentProfile,
  options: { seed?: number; metadata?: Record<string, unknown> } = {},
): Scenario {
  return {
    id: `incident:${incident.id}`,
    seed: options.seed,
    perturbations: incident.perturbations,
    metadata: {
      incident: incident.id,
      incidentDescription: incident.description,
      durationMs: incident.durationMs,
      tags: incident.tags,
      ...options.metadata,
    },
  };
}

export function combineIncidents(
  id: string,
  incidents: readonly IncidentProfile[],
  description = incidents.map((item) => item.description).join(" + "),
): IncidentProfile {
  const perturbations = new Map<string, Perturbation>();
  for (const incident of incidents) {
    for (const item of incident.perturbations) perturbations.set(item.id, item);
  }
  return {
    id,
    description,
    perturbations: [...perturbations.values()],
    durationMs: Math.max(0, ...incidents.map((item) => item.durationMs ?? 0)),
    tags: { composed: true, incidentCount: incidents.length },
  };
}

export interface RetryStormOptions {
  target: string;
  operation?: string;
  latencyMs?: number;
  retryAfterSeconds?: number;
  attempts?: number;
  concurrency?: number;
}

/**
 * A provider slowdown + throttling profile that is designed to exercise
 * application retry amplification. The workload runner still controls actual
 * concurrency; metadata tells workload-aware runners how aggressively to fan
 * out retries.
 */
export function retryStormIncident(options: RetryStormOptions): IncidentProfile {
  const target = options.target;
  const operation = options.operation;
  const latency: Fault = {
    id: `${target}:${operation ?? "*"}:incident-latency`,
    target,
    operation,
    kind: "latency",
    phase: "before-send",
    description: `${target} becomes slow during a retry-storm incident`,
    category: "provider",
    actualOutcome: "unknown",
    observedOutcome: "indeterminate",
    metadata: { delayMs: options.latencyMs ?? 1_500, incident: "retry-storm" },
  };
  const throttled: Fault = {
    id: `${target}:${operation ?? "*"}:incident-rate-limit`,
    target,
    operation,
    kind: "rate-limit",
    phase: "before-commit",
    description: `${target} rate-limits callers during a retry-storm incident`,
    category: "provider",
    actualOutcome: "not-committed",
    observedOutcome: "definite-failure",
    metadata: {
      status: 429,
      retryAfterSeconds: options.retryAfterSeconds ?? 1,
      incident: "retry-storm",
    },
  };

  return {
    id: `retry-storm:${target}:${operation ?? "all"}`,
    description: `Correlated latency and throttling on ${target} to expose retry amplification`,
    perturbations: [latency, throttled],
    tags: {
      family: "retry-storm",
      attempts: options.attempts ?? 5,
      concurrency: options.concurrency ?? 16,
    },
  };
}

export interface BrownoutTarget {
  target: string;
  operation?: string;
  status?: number;
  latencyMs?: number;
}

export function providerBrownoutIncident(
  id: string,
  targets: readonly BrownoutTarget[],
): IncidentProfile {
  const perturbations: Fault[] = [];
  for (const target of targets) {
    if ((target.latencyMs ?? 0) > 0) {
      perturbations.push({
        id: `${id}:${target.target}:${target.operation ?? "*"}:latency`,
        target: target.target,
        operation: target.operation,
        kind: "latency",
        phase: "before-send",
        description: `${target.target} latency spike during ${id}`,
        category: "provider",
        actualOutcome: "unknown",
        observedOutcome: "indeterminate",
        metadata: { delayMs: target.latencyMs, incident: id },
      });
    }
    perturbations.push({
      id: `${id}:${target.target}:${target.operation ?? "*"}:unavailable`,
      target: target.target,
      operation: target.operation,
      kind: "http-error",
      phase: "before-commit",
      description: `${target.target} returns transient failures during ${id}`,
      category: "provider",
      actualOutcome: "not-committed",
      observedOutcome: "definite-failure",
      metadata: { status: target.status ?? 503, incident: id },
    });
  }
  return {
    id,
    description: `Correlated provider brownout affecting ${targets.map((item) => item.target).join(", ")}`,
    perturbations,
    tags: { family: "brownout", targetCount: targets.length },
  };
}

export function cloudBackendBrownout(
  id: string,
  targets: readonly string[],
): IncidentProfile {
  const perturbations: Fault[] = targets.map((target) => ({
    id: `${id}:${target}:backend-timeout`,
    target,
    kind: "backend-timeout",
    phase: "before-commit",
    description: `${target} backend becomes intermittently unavailable during ${id}`,
    category: "cloudflare",
    actualOutcome: "unknown",
    observedOutcome: "indeterminate",
    metadata: { incident: id, correlated: true },
  }));
  return {
    id,
    description: `Correlated cloud backend brownout across ${targets.join(", ")}`,
    perturbations,
    tags: { family: "cloud-backend-brownout", targetCount: targets.length },
  };
}

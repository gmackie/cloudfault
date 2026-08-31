import type { Perturbation, Scenario } from "@cloudfault/core";
import type { CloudFaultHarness } from "./harness.js";

export type NemesisBindingKind = "kv" | "queue" | "service";

export interface NemesisBinding {
  /** Binding/semantic target used by perturbations, e.g. ORDER_STATE or PAYMENTS. */
  target: string;
  /** Name of the auxiliary test Worker in createTestHarness(). */
  worker: string;
  kind: NemesisBindingKind;
  /** Optional mapping from semantic operation names to service HTTP routes. */
  operations?: Record<string, { method?: string; path?: string }>;
}

interface RpcExport {
  reset?(): Promise<void> | void;
  setObserver?(region: string): Promise<void> | void;
  setLag?(key: string, versionsBehind?: number, reads?: number, region?: string): Promise<void> | void;
  setNegative?(key: string, reads?: number): Promise<void> | void;
  setMode?(mode: string): Promise<void> | void;
  setPlan?(rules: readonly Record<string, unknown>[]): Promise<void> | void;
}

function matchesTarget(perturbation: Perturbation, target: string): boolean {
  return perturbation.target === target || perturbation.selector?.target === target;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

async function configureKv(rpc: RpcExport, perturbations: readonly Perturbation[]): Promise<void> {
  for (const perturbation of perturbations) {
    if (perturbation.kind === "stale-read") {
      const key = typeof perturbation.metadata?.key === "string" ? perturbation.metadata.key : undefined;
      if (!key) throw new Error(`${perturbation.id} requires metadata.key for the KV nemesis Worker`);
      const region = typeof perturbation.metadata?.region === "string" ? perturbation.metadata.region : "cloudfault";
      const versionsBehind = positiveInt(perturbation.metadata?.versionsBehind, 1);
      const reads = positiveInt(perturbation.selector?.maxActivations, 1);
      await rpc.setObserver?.(region);
      if (!rpc.setLag) throw new Error("Configured KV nemesis Worker does not expose setLag()");
      await rpc.setLag(key, versionsBehind, reads, region);
    } else if (perturbation.kind === "stale-negative-read") {
      const key = typeof perturbation.metadata?.key === "string" ? perturbation.metadata.key : undefined;
      if (!key) throw new Error(`${perturbation.id} requires metadata.key for stale negative reads`);
      const region = typeof perturbation.metadata?.region === "string" ? perturbation.metadata.region : "cloudfault";
      const reads = positiveInt(perturbation.selector?.maxActivations, 1);
      await rpc.setObserver?.(region);
      if (!rpc.setNegative) throw new Error("Configured KV nemesis Worker does not expose setNegative()");
      await rpc.setNegative(key, reads);
    }
  }
}

async function configureQueue(rpc: RpcExport, perturbations: readonly Perturbation[]): Promise<void> {
  // The lightweight Queue binding shim models producer-visible failure and a
  // duplicated logical delivery record. Full consumer retry/rebatch execution
  // is modeled by queue delivery helpers and dedicated consumer fixtures.
  const mode = perturbations.some((item) => item.kind === "duplicate-delivery")
    ? "duplicate"
    : perturbations.some((item) => item.kind === "producer-failure")
      ? "fail"
      : "pass";
  await rpc.setMode?.(mode);
}

function serviceRule(perturbation: Perturbation, binding: NemesisBinding): Record<string, unknown> {
  const mapped = perturbation.operation ? binding.operations?.[perturbation.operation] : undefined;
  const metadata = perturbation.metadata ?? {};
  const method = typeof metadata.method === "string" ? metadata.method : mapped?.method;
  const path = typeof metadata.path === "string" ? metadata.path : mapped?.path;
  const occurrence = perturbation.selector?.occurrence;
  const base: Record<string, unknown> = { method, path, occurrence };

  switch (perturbation.kind) {
    case "commit-then-timeout":
    case "commit-then-disconnect":
    case "commit-then-error":
      return { ...base, kind: perturbation.kind };
    case "service-timeout":
      // One concrete realization of an indeterminate service timeout: the
      // upstream completed, but its response was lost before the caller saw it.
      return { ...base, kind: "commit-then-timeout" };
    case "service-unavailable":
      return { ...base, kind: "http-error", status: metadata.status ?? 503, body: metadata.body };
    case "latency":
      return { ...base, kind: "latency", delayMs: metadata.delayMs ?? 1000 };
    case "rate-limit":
      return { ...base, kind: "http-error", status: 429, body: metadata.body ?? "CloudFault injected rate limit" };
    case "http-error":
    case "reject-before-commit":
      return { ...base, kind: "http-error", status: metadata.status ?? 503, body: metadata.body };
    case "timeout-before-send":
      // A service binding shim cannot literally prevent the call from being
      // sent by the Worker; reject before forwarding is the closest observable
      // application behavior at this interception layer.
      return { ...base, kind: "reject", status: 503, body: "CloudFault injected timeout before upstream send" };
    default:
      return { ...base, kind: perturbation.kind };
  }
}

async function configureService(rpc: RpcExport, perturbations: readonly Perturbation[], binding: NemesisBinding): Promise<void> {
  if (!rpc.setPlan) throw new Error("Configured service nemesis Worker does not expose setPlan()");
  await rpc.setPlan(perturbations.map((item) => serviceRule(item, binding)));
}

/** Reset all auxiliary nemesis Workers before seeding a scenario. */
export async function resetNemesisBindings(harness: CloudFaultHarness, bindings: readonly NemesisBinding[]): Promise<void> {
  for (const binding of bindings) {
    const rpc = await harness.getWorker<Record<string, unknown>, RpcExport>(binding.worker).getExport();
    await rpc.reset?.();
  }
}

/**
 * Translate CloudFault semantic/fault objects into the RPC control plane used
 * by auxiliary Workers supplied via `bindingOverrides`.
 */
export async function applyScenarioToNemesisBindings(
  harness: CloudFaultHarness,
  scenario: Pick<Scenario, "perturbations">,
  bindings: readonly NemesisBinding[],
): Promise<void> {
  for (const binding of bindings) {
    const active = scenario.perturbations.filter((item) => matchesTarget(item, binding.target));
    const rpc = await harness.getWorker<Record<string, unknown>, RpcExport>(binding.worker).getExport();
    if (binding.kind === "kv") await configureKv(rpc, active);
    else if (binding.kind === "queue") await configureQueue(rpc, active);
    else await configureService(rpc, active, binding);
  }
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  History,
  invariant,
  runCheckers,
  type FaultPoint,
  type OperationRef,
  type Perturbation,
  type RunResult,
  type Scenario,
} from "@cloudfault/core";
import { createCloudFaultHarness, type CloudFaultHarness, type CloudFaultHarnessConfig } from "./harness.js";
import { kvNemesisProject, queueNemesisProject } from "./nemesis-templates.js";
import { applyScenarioToNemesisBindings, resetNemesisBindings, type NemesisBinding } from "./scenario.js";
import type { CloudflareBindingDescriptor } from "./topology.js";

/**
 * A runnable, application-agnostic `execute()`: start the Worker from its
 * Wrangler config, send a smoke workload, and check that nothing failed.
 *
 * It can only inject what is reachable from outside the Worker. KV namespaces
 * and Queue producers are rerouted through nemesis Workers, so their
 * perturbations really happen. D1, R2, Hyperdrive, Images, Durable Object and
 * Workflow faults need CloudFault's proxies *inside* the Worker, which a
 * generated config cannot add without changing application code, so
 * `supports()` reports them unsupported instead of pretending to run them.
 */

export interface SmokeRequest {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  /** Acceptable statuses. Default: anything below 500. */
  expectStatus?: number | readonly number[];
}

export interface SmokeExecuteOptions {
  /** The Worker's Wrangler config (path or file URL). */
  config: string | URL;
  /** Worker name from the config; used to address it in the harness. */
  name?: string;
  /** Bindings from the config (as `discoverWranglerTopology` reports them). */
  bindings?: readonly Pick<CloudflareBindingDescriptor, "type" | "binding">[];
  requests?: readonly SmokeRequest[];
  /** Cron expressions to fire through the scheduled handler. */
  crons?: readonly string[];
  /** Wrangler environment to run. */
  env?: string;
  /** Where the nemesis Workers are written. Default: `.cloudfault/nemesis` beside the config. */
  nemesisDirectory?: string;
  /** Per-request deadline. Default 15s. */
  requestTimeoutMs?: number;
  /** Test seam: build the harness. Default: Wrangler's createTestHarness(). */
  createHarness?: (config: CloudFaultHarnessConfig) => Promise<CloudFaultHarness>;
}

export interface SmokeState {
  responses: readonly { request: string; status: number; durationMs: number }[];
  scheduled: readonly { cron: string; outcome: string }[];
  appliedPerturbations: readonly string[];
}

export interface SmokeExecute {
  (scenario: Scenario): Promise<RunResult<SmokeState>>;
  supports(perturbation: Perturbation): boolean;
  /** The fault points with only their supported choices; points left empty are dropped. */
  applicableFaultPoints(points: readonly FaultPoint[]): FaultPoint[];
}

/** The Worker could not be started (missing build output, unresolved imports, bad config). */
export class SmokeHarnessError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SmokeHarnessError";
  }
}

const KV_KINDS = new Set(["stale-read", "stale-negative-read"]);
const QUEUE_KINDS = new Set(["duplicate-delivery", "producer-failure"]);

function workerSlug(binding: string): string {
  return binding.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "binding";
}

function writeProject(directory: string, files: readonly { path: string; content: string }[]): string {
  for (const file of files) {
    const target = path.join(directory, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== file.content) fs.writeFileSync(target, file.content);
  }
  return path.join(directory, "wrangler.jsonc");
}

function expected(request: SmokeRequest, status: number): boolean {
  if (request.expectStatus === undefined) return status < 500;
  return [request.expectStatus].flat().includes(status);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

export function createSmokeExecute(options: SmokeExecuteOptions): SmokeExecute {
  const config = options.config instanceof URL ? fileURLToPath(options.config) : path.resolve(options.config);
  const bindings = options.bindings ?? [];
  const requests = options.requests ?? [{ path: "/" }];
  const crons = options.crons ?? [];
  const timeout = options.requestTimeoutMs ?? 15_000;
  const nemesisDirectory = options.nemesisDirectory ?? path.join(path.dirname(config), ".cloudfault", "nemesis");
  const createHarness = options.createHarness ?? createCloudFaultHarness;

  const nemesis: NemesisBinding[] = [];
  const overrides: Record<string, string> = {};
  const nemesisConfigs: string[] = [];
  let prepared = false;
  const prepare = () => {
    if (prepared) return;
    for (const binding of bindings) {
      const project = binding.type === "kv" ? kvNemesisProject : binding.type === "queue-producer" ? queueNemesisProject : undefined;
      if (!project) continue;
      const kind = binding.type === "kv" ? "kv" : "queue";
      const name = `cloudfault-${kind}-nemesis-${workerSlug(binding.binding)}`;
      nemesisConfigs.push(writeProject(path.join(nemesisDirectory, name), project({ name })));
      nemesis.push({ target: binding.binding, worker: name, kind });
      overrides[binding.binding] = name;
    }
    prepared = true;
  };

  const types = new Map(bindings.map((binding) => [binding.binding, binding.type]));
  const supports = (perturbation: Perturbation): boolean => {
    const type = types.get(perturbation.selector?.target ?? perturbation.target);
    if (type === "kv") return KV_KINDS.has(perturbation.kind);
    if (type === "queue-producer") return QUEUE_KINDS.has(perturbation.kind);
    return false;
  };

  const execute = (async (scenario: Scenario): Promise<RunResult<SmokeState>> => {
    prepare();
    const unsupported = scenario.perturbations.filter((item) => !supports(item));
    if (unsupported.length) throw new Error(`Smoke execute cannot apply ${unsupported.map((item) => item.id).join(", ")} from outside the Worker`);

    const started = performance.now();
    const history = new History();
    const workload: OperationRef = { id: `${scenario.id}:workload`, name: "smoke", process: "client", target: "app" };
    history.invoke(workload);

    let harness: CloudFaultHarness;
    try {
      harness = await createHarness({
        workers: [
          { configPath: config, env: options.env, bindingOverrides: Object.keys(overrides).length ? overrides : undefined },
          ...nemesisConfigs.map((configPath) => ({ configPath })),
        ],
      });
      await harness.listen();
    } catch (error) {
      throw new SmokeHarnessError(`Could not start ${config}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }

    try {
      const app = harness.getWorker(options.name);
      await resetNemesisBindings(harness, nemesis);
      await applyScenarioToNemesisBindings(harness, scenario, nemesis);
      for (const binding of bindings.filter((item) => item.type === "d1")) {
        // Migrations are best-effort: a Worker without a migrations directory still runs.
        try { await app.applyD1Migrations?.(binding.binding); } catch { /* no migrations */ }
      }

      const responses: { request: string; status: number; durationMs: number }[] = [];
      const failures: string[] = [];
      for (const request of requests) {
        const label = `${request.method ?? "GET"} ${request.path}`;
        const operation: OperationRef = { id: `${scenario.id}:${label}:${responses.length}`, name: "fetch", process: "client", target: "app", resource: label, parentId: workload.id };
        history.invoke(operation);
        const requestStarted = performance.now();
        try {
          const response = await withTimeout(app.fetch(new URL(request.path, "https://cloudfault.local"), { method: request.method, headers: request.headers, body: request.body }), timeout, label);
          await response.arrayBuffer().catch(() => undefined);
          responses.push({ request: label, status: response.status, durationMs: performance.now() - requestStarted });
          const ok = expected(request, response.status);
          if (!ok) failures.push(`${label} -> ${response.status}`);
          history.complete(operation, ok ? "ok" : "fail", { status: response.status }, { observed: ok ? "success" : "definite-failure", actual: "unknown", actualSource: "unknown" });
        } catch (error) {
          responses.push({ request: label, status: 0, durationMs: performance.now() - requestStarted });
          failures.push(`${label} -> ${String(error)}`);
          history.complete(operation, "info", undefined, { observed: "indeterminate", actual: "unknown", actualSource: "unknown", detail: String(error) });
        }
      }

      const scheduled: { cron: string; outcome: string }[] = [];
      for (const cron of crons) {
        const operation: OperationRef = { id: `${scenario.id}:scheduled:${cron}`, name: "scheduled", process: "cron", target: "app", resource: cron, parentId: workload.id };
        history.invoke(operation);
        const result = app.scheduled ? await withTimeout(app.scheduled({ cron }), timeout, `scheduled ${cron}`).catch((error) => ({ outcome: `error: ${String(error)}`, noRetry: false })) : { outcome: "unsupported", noRetry: false };
        scheduled.push({ cron, outcome: result.outcome });
        history.complete(operation, result.outcome === "ok" ? "ok" : "fail", result, { observed: result.outcome === "ok" ? "success" : "definite-failure", actual: "unknown", actualSource: "unknown" });
      }

      // A perturbation counts as applied when its nemesis saw the traffic it alters.
      const applied: string[] = [];
      for (const binding of nemesis) {
        const active = scenario.perturbations.filter((item) => (item.selector?.target ?? item.target) === binding.target);
        if (!active.length) continue;
        const snapshot = await (await harness.getWorker<Record<string, unknown>, { snapshot(): Promise<{ events: { type: string; mode?: string }[] }> }>(binding.worker).getExport()).snapshot();
        const touched = binding.kind === "kv"
          ? snapshot.events.some((event) => event.type === "semantic")
          : snapshot.events.some((event) => event.type === "send" && event.mode !== "pass");
        if (!touched) continue;
        for (const perturbation of active) {
          history.perturb(perturbation, workload);
          applied.push(perturbation.id);
        }
      }

      history.complete(workload, failures.length ? "fail" : "ok", { failures }, { observed: failures.length ? "definite-failure" : "success", actual: "unknown", actualSource: "unknown" });
      const state: SmokeState = { responses, scheduled, appliedPerturbations: applied };
      const checks = await runCheckers<SmokeState>([
        invariant("no-unexpected-responses", ({ state }) => state.responses.every((item, index) => item.status !== 0 && expected(requests[index]!, item.status)), () => `Unexpected responses: ${failures.join("; ")}`),
        invariant("scheduled-handlers-succeed", ({ state }) => state.scheduled.every((item) => item.outcome === "ok"), ({ state }) => `Scheduled outcomes: ${state.scheduled.map((item) => `${item.cron}=${item.outcome}`).join(", ")}`),
      ], { history: history.snapshot(), state });
      return { scenario, history: history.snapshot(), checks, state, durationMs: performance.now() - started };
    } finally {
      await harness.close();
    }
  }) as SmokeExecute;

  execute.supports = supports;
  execute.applicableFaultPoints = (points) => points
    .map((point) => ({ ...point, choices: point.choices.filter(supports) }))
    .filter((point) => point.choices.length > 0);
  return execute;
}

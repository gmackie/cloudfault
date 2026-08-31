import type { ScenarioController } from "./controller.js";
import type { OperationRef } from "./types.js";

export interface WorkloadContext<State> {
  controller: ScenarioController;
  state: State;
  client: number;
  step: number;
  signal?: AbortSignal;
}

export interface WorkloadCommand<State = unknown, Result = unknown> {
  /** Stable logical name, e.g. checkout or cancel. */
  name: string;
  target?: string;
  resource?: string;
  callsite?: string;
  attempt?: number;
  value?: unknown;
  run(context: WorkloadContext<State>): Promise<Result> | Result;
}

export interface WorkloadOptions<State> {
  controller: ScenarioController;
  state: State;
  clients: number;
  stepsPerClient: number;
  next(client: number, step: number, state: State): WorkloadCommand<State> | undefined | Promise<WorkloadCommand<State> | undefined>;
  signal?: AbortSignal;
  /** Optional hook used by tests to introduce controlled yield points. */
  beforeStep?: (client: number, step: number) => void | Promise<void>;
  afterStep?: (client: number, step: number) => void | Promise<void>;
}

export interface WorkloadOperationResult {
  client: number;
  step: number;
  operation: OperationRef;
  status: "ok" | "fail";
  value?: unknown;
  error?: unknown;
}

/**
 * Runs each logical client as its own async sequence. This intentionally does
 * not claim deterministic scheduling: it records the schedule that happened,
 * while seeded/model-based generators control the workload and fault choices.
 */
export async function runConcurrentWorkload<State>(options: WorkloadOptions<State>): Promise<readonly WorkloadOperationResult[]> {
  if (!Number.isInteger(options.clients) || options.clients < 1) throw new RangeError("clients must be >= 1");
  if (!Number.isInteger(options.stepsPerClient) || options.stepsPerClient < 0) throw new RangeError("stepsPerClient must be >= 0");
  const results: WorkloadOperationResult[] = [];

  const runClient = async (client: number) => {
    let parentId: string | undefined;
    for (let step = 0; step < options.stepsPerClient; step++) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("workload aborted");
      await options.beforeStep?.(client, step);
      const command = await options.next(client, step, options.state);
      if (!command) continue;

      const op = options.controller.begin({
        id: `client-${client}:step-${step}:${command.name}`,
        name: command.name,
        process: client,
        target: command.target ?? "app",
        resource: command.resource,
        callsite: command.callsite,
        attempt: command.attempt,
        parentId,
      }, command.value);
      parentId = op.id;

      try {
        const value = await command.run({
          controller: options.controller,
          state: options.state,
          client,
          step,
          signal: options.signal,
        });
        options.controller.complete(op, "ok", value, { actual: "unknown", observed: "success" });
        results.push({ client, step, operation: op, status: "ok", value });
      } catch (error) {
        options.controller.complete(op, "fail", { error: error instanceof Error ? error.message : String(error) }, {
          actual: "unknown",
          observed: "definite-failure",
        });
        results.push({ client, step, operation: op, status: "fail", error });
      }
      await options.afterStep?.(client, step);
    }
  };

  await Promise.all(Array.from({ length: options.clients }, (_, client) => runClient(client)));
  return results.sort((a, b) => a.operation.id.localeCompare(b.operation.id));
}

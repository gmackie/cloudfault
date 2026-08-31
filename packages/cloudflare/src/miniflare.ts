import type { Perturbation, Scenario } from "@cloudfault/core";
import { applyQueueDeliverySemantics, type QueueMessageLike } from "./queue.js";

export interface MiniflareQueueMessage<T = unknown> extends QueueMessageLike<T> {
  timestamp?: Date;
  attempts?: number;
}

export interface MiniflareQueueResult {
  outcome: string;
  retryAll?: boolean;
  ackAll?: boolean;
  explicitRetries?: readonly string[];
  explicitAcks?: readonly string[];
  [key: string]: unknown;
}

export interface MiniflareScheduledResult {
  outcome: string;
  noRetry?: boolean;
  [key: string]: unknown;
}

export interface CloudFaultMiniflareWorker {
  fetch?(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  queue?(queue: string, messages: readonly Record<string, unknown>[]): Promise<MiniflareQueueResult>;
  scheduled?(options?: { scheduledTime?: Date | number; cron?: string }): Promise<MiniflareScheduledResult>;
}

export interface CloudFaultMiniflare {
  getWorker(name?: string): Promise<CloudFaultMiniflareWorker>;
  dispose(): Promise<void>;
  setOptions?(options: unknown): Promise<void>;
}

async function optionalImport(specifier: string): Promise<unknown> {
  return Function("specifier", "return import(specifier)")(specifier) as Promise<unknown>;
}

/**
 * Low-level Miniflare escape hatch. CloudFault prefers createTestHarness() for
 * integration tests, but direct Miniflare is useful when dispatching Queue or
 * Scheduled events that the higher-level harness does not expose directly.
 */
export async function createCloudFaultMiniflare(options: Record<string, unknown>): Promise<CloudFaultMiniflare> {
  let mod: unknown;
  try {
    mod = await optionalImport("miniflare");
  } catch (error) {
    throw new Error("createCloudFaultMiniflare() requires miniflare >= 3", { cause: error });
  }
  const Miniflare = (mod as { Miniflare?: new (options: unknown) => unknown }).Miniflare;
  if (typeof Miniflare !== "function") throw new Error("Installed miniflare package does not export Miniflare");
  return new Miniflare(options) as CloudFaultMiniflare;
}

function activeForTarget(scenario: Pick<Scenario, "perturbations">, target: string): readonly Perturbation[] {
  return scenario.perturbations.filter((item) => item.target === target || item.selector?.target === target);
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function numberArray(value: unknown): readonly number[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item))
    ? value.map((item) => Math.max(1, Math.floor(item)))
    : undefined;
}

export interface QueueScenarioDispatchOptions<T = unknown> {
  worker?: string;
  queue: string;
  target?: string;
  messages: readonly MiniflareQueueMessage<T>[];
  scenario: Pick<Scenario, "perturbations">;
}

/**
 * Dispatch a Queue consumer workload under legal at-least-once/rebatch
 * semantics. Duplicate delivery is represented by repeated logical message IDs
 * across one or more actual queue() dispatches.
 */
export async function dispatchQueueScenario<T>(
  miniflare: CloudFaultMiniflare,
  options: QueueScenarioDispatchOptions<T>,
): Promise<readonly MiniflareQueueResult[]> {
  const worker = await miniflare.getWorker(options.worker);
  if (!worker.queue) throw new Error("Selected Miniflare Worker does not expose queue() dispatch");

  const target = options.target ?? options.queue;
  const active = activeForTarget(options.scenario, target);
  const duplicate = active.find((item) => item.kind === "duplicate-delivery");
  const rebatch = active.find((item) => item.kind === "rebatch");

  const explicitDuplicateIds = stringArray(duplicate?.metadata?.messageIds);
  const duplicateIds = duplicate
    ? explicitDuplicateIds ?? options.messages.map((message) => message.id)
    : [];
  const batchSizes = rebatch ? numberArray(rebatch.metadata?.batchSizes) ?? [1, 2, 1] : undefined;
  const batches = applyQueueDeliverySemantics(options.messages, { duplicateIds, batchSizes });
  const now = Date.now();
  const results: MiniflareQueueResult[] = [];

  for (const batch of batches) {
    const payload = batch.map((message, index) => ({
      id: message.id,
      timestamp: message.timestamp ?? new Date(now + index),
      body: message.body,
      attempts: message.attempts ?? 1,
    }));
    results.push(await worker.queue(options.queue, payload));
  }
  return results;
}

export interface QueueDeliveryAttempt<T = unknown> {
  round: number;
  queue: string;
  messages: readonly MiniflareQueueMessage<T>[];
  result: MiniflareQueueResult;
}

export interface QueueLifecycleResult<T = unknown> {
  attempts: readonly QueueDeliveryAttempt<T>[];
  acknowledged: readonly MiniflareQueueMessage<T>[];
  deadLettered: readonly MiniflareQueueMessage<T>[];
  remaining: readonly MiniflareQueueMessage<T>[];
  dlqDispatch?: MiniflareQueueResult;
}

export interface QueueLifecycleOptions<T = unknown> {
  worker?: string;
  queue: string;
  messages: readonly MiniflareQueueMessage<T>[];
  maxRetries?: number;
  deadLetterQueue?: string;
  /** Safety valve for custom consumers returning contradictory retry metadata. */
  maxRounds?: number;
}

function retryIds(result: MiniflareQueueResult, messages: readonly MiniflareQueueMessage[]): Set<string> {
  if (result.retryAll) return new Set(messages.map((message) => message.id));
  return new Set(result.explicitRetries ?? []);
}

/**
 * Drive a real Miniflare Queue consumer until each message is acked or exceeds
 * its retry budget. The next dispatch receives incremented `attempts`, and
 * exhausted messages can be dispatched to a configured DLQ consumer.
 */
export async function dispatchQueueUntilSettled<T>(
  miniflare: CloudFaultMiniflare,
  options: QueueLifecycleOptions<T>,
): Promise<QueueLifecycleResult<T>> {
  const worker = await miniflare.getWorker(options.worker);
  if (!worker.queue) throw new Error("Selected Miniflare Worker does not expose queue() dispatch");
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 3));
  const maxRounds = Math.max(1, Math.floor(options.maxRounds ?? maxRetries + 3));
  let pending = options.messages.map((message) => ({ ...message, attempts: message.attempts ?? 1 }));
  const attempts: QueueDeliveryAttempt<T>[] = [];
  const acknowledged: MiniflareQueueMessage<T>[] = [];
  const deadLettered: MiniflareQueueMessage<T>[] = [];

  for (let round = 1; pending.length && round <= maxRounds; round++) {
    const current = pending;
    const payload = current.map((message) => ({
      id: message.id,
      timestamp: message.timestamp ?? new Date(),
      body: message.body,
      attempts: message.attempts ?? 1,
    }));
    const result = await worker.queue(options.queue, payload);
    attempts.push({ round, queue: options.queue, messages: current.map((message) => ({ ...message })), result });
    const retry = retryIds(result, current);
    const explicitAcks = new Set(result.explicitAcks ?? []);
    const next: MiniflareQueueMessage<T>[] = [];

    for (const message of current) {
      // Explicit retry always wins. Otherwise an explicit ack, ackAll, or a
      // successful result with no retry request means the message is settled.
      if (!retry.has(message.id)) {
        acknowledged.push({ ...message });
        continue;
      }
      const retriesSoFar = Math.max(0, (message.attempts ?? 1) - 1);
      if (retriesSoFar >= maxRetries) {
        deadLettered.push({ ...message });
        continue;
      }
      if (explicitAcks.has(message.id) && !result.retryAll) {
        acknowledged.push({ ...message });
        continue;
      }
      next.push({ ...message, attempts: (message.attempts ?? 1) + 1 });
    }
    pending = next;
  }

  let dlqDispatch: MiniflareQueueResult | undefined;
  if (deadLettered.length && options.deadLetterQueue) {
    dlqDispatch = await worker.queue(options.deadLetterQueue, deadLettered.map((message) => ({
      id: message.id,
      timestamp: message.timestamp ?? new Date(),
      body: message.body,
      attempts: message.attempts ?? maxRetries + 1,
    })));
  }

  return { attempts, acknowledged, deadLettered, remaining: pending, dlqDispatch };
}

export interface ScheduledScenarioDispatchOptions {
  worker?: string;
  target?: string;
  scenario: Pick<Scenario, "perturbations">;
  scheduledTime?: Date | number;
  cron?: string;
}

/** Dispatch scheduled work, including legal duplicate/delayed execution models. */
export async function dispatchScheduledScenario(
  miniflare: CloudFaultMiniflare,
  options: ScheduledScenarioDispatchOptions,
): Promise<readonly MiniflareScheduledResult[]> {
  const worker = await miniflare.getWorker(options.worker);
  if (!worker.scheduled) throw new Error("Selected Miniflare Worker does not expose scheduled() dispatch");

  const target = options.target ?? "scheduled";
  const active = activeForTarget(options.scenario, target);
  const duplicate = active.some((item) => item.kind === "duplicate-scheduled-execution");
  const delayed = active.find((item) => item.kind === "delayed-scheduled-execution");
  const delayMs = typeof delayed?.metadata?.delayMs === "number" ? delayed.metadata.delayMs : 0;
  const base = options.scheduledTime instanceof Date
    ? options.scheduledTime.getTime()
    : typeof options.scheduledTime === "number"
      ? options.scheduledTime
      : Date.now();
  const dispatch = { scheduledTime: new Date(base + delayMs), cron: options.cron };
  const results = [await worker.scheduled(dispatch)];
  if (duplicate) results.push(await worker.scheduled(dispatch));
  return results;
}

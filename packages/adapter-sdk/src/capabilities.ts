import type { Fault, Perturbation } from "@cloudfault/core";

export interface WebhookEvent<T = unknown> {
  id: string;
  type: string;
  payload: T;
  createdAt: number;
  attempt?: number;
}

export interface WebhookDelivery<T = unknown> {
  event: WebhookEvent<T>;
  deliverAt: number;
  deliveryId: string;
}

export interface WebhookDeliveryOptions {
  duplicates?: number;
  delayMs?: number;
  reorder?: boolean;
  now?: number;
}

/**
 * Deterministically expand logical webhook events into delivery attempts.
 *
 * The pure primitive. For a workload that is driven by a scenario's
 * perturbations and recorded in a history, use `runEventWorkload()` from the
 * core package, which activates delivery faults through the controller and
 * derives arrival order from delay rather than taking it as a flag.
 */
export function planWebhookDeliveries<T>(
  events: readonly WebhookEvent<T>[],
  options: WebhookDeliveryOptions = {},
): readonly WebhookDelivery<T>[] {
  const now = options.now ?? Date.now();
  const duplicates = Math.max(0, Math.floor(options.duplicates ?? 0));
  const deliveries: WebhookDelivery<T>[] = [];
  for (const event of events) {
    for (let copy = 0; copy <= duplicates; copy++) {
      deliveries.push({
        event: { ...event, attempt: (event.attempt ?? 0) + copy + 1 },
        deliverAt: now + Math.max(0, options.delayMs ?? 0),
        deliveryId: `${event.id}:delivery:${copy + 1}`,
      });
    }
  }
  if (options.reorder) deliveries.reverse();
  return deliveries;
}

export interface WebhookSigner {
  headers(body: string, timestamp?: number): Record<string, string> | Promise<Record<string, string>>;
}

export async function signedWebhookRequest(
  url: string,
  event: WebhookEvent,
  signer?: WebhookSigner,
  timestamp = Math.floor(Date.now() / 1000),
): Promise<Request> {
  const body = JSON.stringify(event.payload);
  const headers = new Headers({ "content-type": "application/json" });
  if (signer) {
    for (const [key, value] of Object.entries(await signer.headers(body, timestamp))) headers.set(key, value);
  }
  return new Request(url, { method: "POST", headers, body });
}

export interface StreamChunk<T = Uint8Array> {
  index: number;
  value: T;
}

export interface StreamInterruptionOptions {
  afterChunks: number;
  mode?: "truncate" | "error";
  message?: string;
}

/** Pure async-iterable stream interrupter usable by SSE/JSONL/provider models. */
export async function* interruptStream<T>(
  source: AsyncIterable<T> | Iterable<T>,
  options: StreamInterruptionOptions,
): AsyncGenerator<StreamChunk<T>> {
  let index = 0;
  for await (const value of source) {
    if (index >= options.afterChunks) {
      if ((options.mode ?? "error") === "error") {
        throw new Error(options.message ?? `CloudFault interrupted stream after ${options.afterChunks} chunks`);
      }
      return;
    }
    yield { index, value };
    index++;
  }
}

export interface OAuthToken {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  revoked?: boolean;
  generation?: number;
}

export class OAuthTokenLifecycle {
  #token: OAuthToken;
  readonly #refresh: (current: OAuthToken) => OAuthToken | Promise<OAuthToken>;

  constructor(
    token: OAuthToken,
    refresh: (current: OAuthToken) => OAuthToken | Promise<OAuthToken> = (current) => ({
      ...current,
      accessToken: `${current.accessToken}:refresh:${(current.generation ?? 0) + 1}`,
      generation: (current.generation ?? 0) + 1,
      revoked: false,
    }),
  ) {
    this.#token = { ...token };
    this.#refresh = refresh;
  }

  snapshot(): OAuthToken {
    return { ...this.#token };
  }

  valid(at = Date.now()): boolean {
    return !this.#token.revoked && this.#token.expiresAt > at;
  }

  expire(at = Date.now()): void {
    this.#token.expiresAt = Math.min(this.#token.expiresAt, at);
  }

  revoke(): void {
    this.#token.revoked = true;
  }

  async refresh(): Promise<OAuthToken> {
    this.#token = { ...(await this.#refresh(this.#token)) };
    return this.snapshot();
  }
}

export type AsyncJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AsyncJob<T = unknown> {
  id: string;
  status: AsyncJobStatus;
  result?: T;
  error?: string;
  attempts: number;
}

export class AsyncJobLifecycle<T = unknown> {
  #job: AsyncJob<T>;

  constructor(id: string) {
    this.#job = { id, status: "queued", attempts: 0 };
  }

  snapshot(): AsyncJob<T> { return { ...this.#job }; }

  start(): AsyncJob<T> {
    if (!["queued", "failed"].includes(this.#job.status)) throw new Error(`Cannot start job from ${this.#job.status}`);
    this.#job = { ...this.#job, status: "running", attempts: this.#job.attempts + 1, error: undefined };
    return this.snapshot();
  }

  succeed(result: T): AsyncJob<T> {
    if (this.#job.status !== "running") throw new Error(`Cannot succeed job from ${this.#job.status}`);
    this.#job = { ...this.#job, status: "succeeded", result, error: undefined };
    return this.snapshot();
  }

  fail(error: string): AsyncJob<T> {
    if (this.#job.status !== "running") throw new Error(`Cannot fail job from ${this.#job.status}`);
    this.#job = { ...this.#job, status: "failed", error };
    return this.snapshot();
  }

  cancel(): AsyncJob<T> {
    if (["succeeded", "cancelled"].includes(this.#job.status)) throw new Error(`Cannot cancel job from ${this.#job.status}`);
    this.#job = { ...this.#job, status: "cancelled" };
    return this.snapshot();
  }
}

export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
  now?: number;
}

export class TokenBucket {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  #tokens: number;
  #last: number;

  constructor(options: TokenBucketOptions) {
    if (options.capacity <= 0 || options.refillPerSecond < 0) throw new RangeError("Invalid token bucket configuration");
    this.#capacity = options.capacity;
    this.#tokens = options.capacity;
    this.#refillPerMs = options.refillPerSecond / 1000;
    this.#last = options.now ?? Date.now();
  }

  #refill(at: number): void {
    const elapsed = Math.max(0, at - this.#last);
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#refillPerMs);
    this.#last = at;
  }

  take(count = 1, at = Date.now()): boolean {
    this.#refill(at);
    if (this.#tokens < count) return false;
    this.#tokens -= count;
    return true;
  }

  retryAfterMs(count = 1, at = Date.now()): number {
    this.#refill(at);
    if (this.#tokens >= count) return 0;
    if (this.#refillPerMs === 0) return Number.POSITIVE_INFINITY;
    return Math.ceil((count - this.#tokens) / this.#refillPerMs);
  }

  available(at = Date.now()): number {
    this.#refill(at);
    return this.#tokens;
  }
}

export function webhookFaults(target: string, operation = "webhook.delivery"): readonly Perturbation[] {
  const base = (kind: string, description: string, metadata?: Record<string, unknown>): Fault => ({
    id: `${target}:${operation}:${kind}`,
    target,
    operation,
    kind,
    phase: "delivery",
    description,
    category: "provider",
    actualOutcome: "committed",
    observedOutcome: "success",
    metadata,
  });
  return [
    base("webhook-delay", "Webhook delivery is delayed", { delayMs: 30_000 }),
    base("webhook-duplicate", "Webhook is delivered more than once", { duplicates: 1 }),
    base("webhook-reorder", "Webhook delivery order differs from event creation order", { reorder: true }),
  ];
}

/**
 * Delivery faults addressed to ONE event of a multi-event workload.
 *
 * `webhookFaults()` above is workload-wide, which is all a single-event
 * workload can express -- and against a single event `webhook-reorder` and
 * `webhook-delay` mean nothing at all, since there is nothing to be reordered
 * against and nothing for a delay to arrive after. These are scoped by
 * `selector.resource` (the event id) so a scenario can delay exactly one event
 * of several, which is both what makes the fault meaningful and what lets
 * minimization attribute the failure to a specific event.
 *
 * Consumed by `runEventWorkload()` in the core package.
 */
export function eventDeliveryFaults(target: string, eventId: string): readonly Perturbation[] {
  const base = (kind: string, description: string, metadata: Record<string, unknown>): Fault => ({
    id: `${target}:${eventId}:${kind}`,
    target,
    kind,
    phase: "delivery",
    description,
    category: "provider",
    // At-least-once delivery and unordered delivery are contract behaviour, not
    // provider failure: the provider committed and told the truth. What is
    // being tested is whether the application survives the contract it chose.
    actualOutcome: "committed",
    observedOutcome: "success",
    selector: { target, resource: eventId },
    metadata,
  });
  return [
    base("webhook-delay", `Delivery of ${eventId} is delayed behind later events`, { delayMs: 1_000 }),
    base("webhook-duplicate", `${eventId} is delivered more than once`, { duplicates: 1 }),
    base("webhook-reorder", `${eventId} arrives after the event that followed it`, { positions: 1 }),
  ];
}

export function eventDelay(target: string, eventId: string, delayMs = 1_000): Perturbation {
  return { ...(eventDeliveryFaults(target, eventId)[0] as Fault), metadata: { delayMs } };
}

export function eventDuplicate(target: string, eventId: string, duplicates = 1): Perturbation {
  return { ...(eventDeliveryFaults(target, eventId)[1] as Fault), metadata: { duplicates } };
}

export function eventReorder(target: string, eventId: string, positions = 1): Perturbation {
  return { ...(eventDeliveryFaults(target, eventId)[2] as Fault), metadata: { positions } };
}

export function streamFaults(target: string, operation = "stream"): readonly Perturbation[] {
  return [{
    id: `${target}:${operation}:stream-interrupt`,
    target,
    operation,
    kind: "stream-interrupt",
    phase: "during-response",
    description: "Streaming response is interrupted after partial data",
    category: "transport",
    actualOutcome: "unknown",
    observedOutcome: "indeterminate",
    metadata: { afterChunks: 2 },
  } satisfies Fault];
}

export function oauthFaults(target: string, operation = "oauth.token"): readonly Perturbation[] {
  return [
    {
      id: `${target}:${operation}:expired`, target, operation, kind: "token-expired", phase: "before-send",
      description: "OAuth access token expires before the request", category: "provider",
      actualOutcome: "not-committed", observedOutcome: "definite-failure",
    },
    {
      id: `${target}:${operation}:revoked`, target, operation, kind: "token-revoked", phase: "before-send",
      description: "OAuth token is revoked", category: "provider",
      actualOutcome: "not-committed", observedOutcome: "definite-failure",
    },
  ] satisfies readonly Fault[];
}

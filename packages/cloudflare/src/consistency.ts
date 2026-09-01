import type { CheckResult, HistoryEvent } from "@cloudfault/core";

export interface VersionedWrite<T = unknown> {
  key: string;
  version: number;
  value?: T;
  writer?: string;
  at: number;
}

export interface VersionedRead<T = unknown> {
  key: string;
  observer: string;
  version: number;
  value?: T;
  authoritativeVersion?: number;
  sessionVersion?: number;
  at: number;
}

export interface ObserverTrace<T = unknown> {
  writes: readonly VersionedWrite<T>[];
  reads: readonly VersionedRead<T>[];
}

function ok(checker: string, details?: unknown): CheckResult { return { valid: true, checker, details }; }
function fail(checker: string, message: string, details?: unknown): CheckResult { return { valid: false, checker, message, details }; }

export function checkEventuallyConsistentReads<T>(trace: ObserverTrace<T>): CheckResult {
  const checker = "eventual-consistency-legality";
  for (const read of trace.reads) {
    if (read.version < 0) return fail(checker, `observer ${read.observer} read an impossible negative version`, read);
    if (read.authoritativeVersion !== undefined && read.version > read.authoritativeVersion) return fail(checker, `observer ${read.observer} observed future version ${read.version} > ${read.authoritativeVersion}`, read);
  }
  return ok(checker, { reads: trace.reads.length });
}

export function checkMonotonicObserverReads<T>(trace: ObserverTrace<T>): CheckResult {
  const checker = "monotonic-observer-reads";
  const last = new Map<string, VersionedRead<T>>();
  for (const read of [...trace.reads].sort((a, b) => a.at - b.at)) {
    const key = `${read.observer}|${read.key}`;
    const previous = last.get(key);
    if (previous && read.version < previous.version) return fail(checker, `${read.observer} regressed ${read.key} from v${previous.version} to v${read.version}`, { previous, read });
    last.set(key, read);
  }
  return ok(checker, { observerKeys: last.size });
}

export function checkReadYourWrites<T>(trace: ObserverTrace<T>): CheckResult {
  const checker = "read-your-writes";
  const writes = [...trace.writes].sort((a, b) => a.at - b.at);
  for (const read of trace.reads) {
    const prior = writes.filter((write) => write.key === read.key && write.writer === read.observer && write.at <= read.at).at(-1);
    if (prior && read.version < prior.version) return fail(checker, `${read.observer} failed read-your-writes for ${read.key}: wrote v${prior.version}, read v${read.version}`, { write: prior, read });
  }
  return ok(checker);
}

export function checkSequentialSession<T>(trace: ObserverTrace<T>): CheckResult {
  const checker = "sequential-session";
  for (const read of trace.reads) {
    if (read.sessionVersion !== undefined && read.version < read.sessionVersion) return fail(checker, `${read.observer} read v${read.version} below session bookmark v${read.sessionVersion}`, read);
  }
  return ok(checker);
}

export interface ObserverDivergence {
  key: string;
  minVersion: number;
  maxVersion: number;
  spread: number;
  observers: Readonly<Record<string, number>>;
}

export function observerDivergence<T>(trace: ObserverTrace<T>): readonly ObserverDivergence[] {
  const latest = new Map<string, VersionedRead<T>>();
  for (const read of [...trace.reads].sort((a, b) => a.at - b.at)) latest.set(`${read.key}|${read.observer}`, read);
  const byKey = new Map<string, Record<string, number>>();
  for (const read of latest.values()) {
    const observers = byKey.get(read.key) ?? {};
    observers[read.observer] = read.version;
    byKey.set(read.key, observers);
  }
  return [...byKey.entries()].map(([key, observers]) => {
    const versions = Object.values(observers);
    const minVersion = Math.min(...versions);
    const maxVersion = Math.max(...versions);
    return { key, minVersion, maxVersion, spread: maxVersion - minVersion, observers };
  }).sort((a, b) => b.spread - a.spread || a.key.localeCompare(b.key));
}

export class ObserverConsistencyTracker<T = unknown> {
  readonly #writes: VersionedWrite<T>[] = [];
  readonly #reads: VersionedRead<T>[] = [];
  write(value: VersionedWrite<T>): void { this.#writes.push({ ...value }); }
  read(value: VersionedRead<T>): void { this.#reads.push({ ...value }); }
  snapshot(): ObserverTrace<T> { return { writes: this.#writes.map((item) => ({ ...item })), reads: this.#reads.map((item) => ({ ...item })) }; }
  checks(): readonly CheckResult[] {
    const trace = this.snapshot();
    return [checkEventuallyConsistentReads(trace), checkMonotonicObserverReads(trace), checkReadYourWrites(trace), checkSequentialSession(trace)];
  }
  divergence(): readonly ObserverDivergence[] { return observerDivergence(this.snapshot()); }
}

export interface ObserverHistoryInput {
  observer: string;
  history: readonly HistoryEvent[];
}

function namespacedOperation(observer: string, operation: HistoryEvent["operation"]): HistoryEvent["operation"] {
  if (!operation) return undefined;
  return {
    ...operation,
    id: `${observer}/${operation.id}`,
    parentId: operation.parentId ? `${observer}/${operation.parentId}` : undefined,
    process: `${observer}:${String(operation.process)}`,
  };
}

/**
 * Merge independent observer histories into one collision-safe causal timeline.
 * Timestamps are preserved, local sequence numbers become `observerSeq` tags,
 * and operation IDs/parents/processes are namespaced by observer.
 */
export function mergeObserverHistories(inputs: readonly ObserverHistoryInput[]): readonly HistoryEvent[] {
  const flattened = inputs.flatMap(({ observer, history }) => history.map((event) => ({
    ...event,
    process: `${observer}:${String(event.process)}`,
    operation: namespacedOperation(observer, event.operation),
    tags: { ...event.tags, observer, observerSeq: event.seq },
  })));
  return flattened
    .sort((left, right) => left.at - right.at || String(left.tags?.observer).localeCompare(String(right.tags?.observer)) || Number(left.tags?.observerSeq ?? 0) - Number(right.tags?.observerSeq ?? 0))
    .map((event, seq) => ({ ...event, seq }));
}

export interface MultiObserverResult<T> {
  observers: Readonly<Record<string, T>>;
  history: readonly HistoryEvent[];
}

/** Run the same observer-aware operation set concurrently and merge histories. */
export async function runMultiObserver<T extends { history: readonly HistoryEvent[] }>(
  observers: readonly string[],
  run: (observer: string) => Promise<T>,
): Promise<MultiObserverResult<T>> {
  const pairs = await Promise.all(observers.map(async (observer) => [observer, await run(observer)] as const));
  const results = Object.fromEntries(pairs) as Record<string, T>;
  return {
    observers: results,
    history: mergeObserverHistories(pairs.map(([observer, result]) => ({ observer, history: result.history }))),
  };
}

/** Project observer/version tags from a merged history into the consistency checker model. */
export function observerTraceFromHistory(history: readonly HistoryEvent[]): ObserverTrace {
  const writes: VersionedWrite[] = [];
  const reads: VersionedRead[] = [];
  for (const event of history) {
    const observer = typeof event.tags?.observer === "string" ? event.tags.observer : undefined;
    const key = typeof event.tags?.consistencyKey === "string" ? event.tags.consistencyKey : undefined;
    const version = typeof event.tags?.version === "number" ? event.tags.version : undefined;
    if (!observer || !key || version === undefined) continue;
    if (event.tags?.consistencyOperation === "write") {
      writes.push({ key, version, writer: observer, at: event.at, value: event.value });
    } else if (event.tags?.consistencyOperation === "read") {
      reads.push({
        key,
        version,
        observer,
        at: event.at,
        value: event.value,
        authoritativeVersion: typeof event.tags?.authoritativeVersion === "number" ? event.tags.authoritativeVersion : undefined,
        sessionVersion: typeof event.tags?.sessionVersion === "number" ? event.tags.sessionVersion : undefined,
      });
    }
  }
  return { writes, reads };
}

import type { CheckResult, HistoryEvent } from "./types.js";

export interface PollOptions { timeoutMs?: number; intervalMs?: number; name?: string; }

export async function eventually<T>(sample: () => Promise<T> | T, predicate: (value: T) => boolean | Promise<boolean>, options: PollOptions = {}): Promise<CheckResult> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 5_000);
  const intervalMs = Math.max(0, options.intervalMs ?? 25);
  const checker = options.name ?? "eventually";
  const started = Date.now();
  let last: T | undefined;
  let attempts = 0;
  while (true) {
    attempts += 1;
    last = await sample();
    if (await predicate(last)) return { valid: true, checker, details: { attempts, elapsedMs: Date.now() - started, value: last } };
    if (Date.now() - started >= timeoutMs) return { valid: false, checker, message: `condition did not converge within ${timeoutMs}ms`, details: { attempts, elapsedMs: Date.now() - started, last } };
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export interface StateMachineTransition<State extends string, Event = unknown> { from: State | readonly State[]; to: State; when: (event: Event) => boolean; label?: string; }
export interface StateMachineOptions<State extends string, Event = unknown> { name?: string; initial: State; transitions: readonly StateMachineTransition<State, Event>[]; terminal?: readonly State[]; }

export function checkStateMachine<State extends string, Event = unknown>(events: readonly Event[], options: StateMachineOptions<State, Event>): CheckResult {
  const checker = options.name ?? "state-machine";
  let state = options.initial;
  const trace: Array<{ index: number; from: State; to: State; label?: string }> = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    const candidates = options.transitions.filter((transition) => transition.when(event));
    if (!candidates.length) continue;
    const transition = candidates.find((candidate) => (Array.isArray(candidate.from) ? candidate.from : [candidate.from]).includes(state));
    if (!transition) return { valid: false, checker, message: `illegal transition from '${state}' at event ${index}`, details: { state, event, index, candidates: candidates.map((candidate) => candidate.label ?? candidate.to), trace } };
    const previous = state;
    state = transition.to;
    trace.push({ index, from: previous, to: state, label: transition.label });
  }
  if (options.terminal?.length && !options.terminal.includes(state)) return { valid: false, checker, message: `state machine ended in non-terminal state '${state}'`, details: { state, terminal: options.terminal, trace } };
  return { valid: true, checker, details: { state, trace } };
}

export interface CardinalityOptions<T> { name?: string; key: (value: T) => string; max?: number; min?: number; describe?: (value: T) => unknown; }
export function checkCardinality<T>(values: readonly T[], options: CardinalityOptions<T>): CheckResult {
  const checker = options.name ?? "cardinality";
  const max = options.max ?? Number.POSITIVE_INFINITY;
  const min = options.min ?? 0;
  const grouped = new Map<string, T[]>();
  for (const value of values) { const key = options.key(value); const group = grouped.get(key) ?? []; group.push(value); grouped.set(key, group); }
  for (const [key, group] of grouped) {
    if (group.length < min || group.length > max) return { valid: false, checker, message: `cardinality for '${key}' was ${group.length}; expected ${min}..${max}`, details: { key, count: group.length, values: group.map((value) => options.describe?.(value) ?? value) } };
  }
  return { valid: true, checker, details: { keys: grouped.size } };
}
export function checkIdempotent<T>(values: readonly T[], key: (value: T) => string, options: Omit<CardinalityOptions<T>, "key" | "max"> = {}): CheckResult {
  return checkCardinality(values, { ...options, key, max: 1, name: options.name ?? "idempotent" });
}

export function successfulOperations(history: readonly HistoryEvent[], operation?: string): HistoryEvent[] { return history.filter((event) => event.type === "ok" && (!operation || event.operation?.name === operation)); }
export function indeterminateOperations(history: readonly HistoryEvent[], operation?: string): HistoryEvent[] { return history.filter((event) => event.type === "info" && (!operation || event.operation?.name === operation)); }
export function projectHistory<T>(history: readonly HistoryEvent[], predicate: (event: HistoryEvent) => boolean, map: (event: HistoryEvent) => T): T[] { return history.filter(predicate).map(map); }

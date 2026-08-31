import type { CheckResult, HistoryEvent } from "./types.js";

export interface CheckContext<State = unknown> {
  history: readonly HistoryEvent[];
  state: State;
}

export interface Checker<State = unknown> {
  readonly name: string;
  check(context: CheckContext<State>): CheckResult | Promise<CheckResult>;
}

export function invariant<State>(
  name: string,
  predicate: (context: CheckContext<State>) => boolean | Promise<boolean>,
  explain?: (context: CheckContext<State>) => string,
): Checker<State> {
  return {
    name,
    async check(context) {
      const valid = await predicate(context);
      return {
        valid,
        checker: name,
        message: valid ? undefined : explain?.(context) ?? `Invariant '${name}' was violated`,
      };
    },
  };
}

export function historyInvariant<State>(
  name: string,
  predicate: (history: readonly HistoryEvent[], state: State) => boolean | Promise<boolean>,
  explain?: (history: readonly HistoryEvent[], state: State) => string,
): Checker<State> {
  return invariant(
    name,
    ({ history, state }) => predicate(history, state),
    ({ history, state }) => explain?.(history, state) ?? `History invariant '${name}' was violated`,
  );
}

/** Ensure a selected logical effect occurs no more than once per key. */
export function atMostOnce<State>(
  name: string,
  select: (event: HistoryEvent, state: State) => string | undefined,
): Checker<State> {
  return historyInvariant(name, (history, state) => {
    const seen = new Set<string>();
    for (const event of history) {
      const key = select(event, state);
      if (!key) continue;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  });
}

export async function runCheckers<State>(
  checkers: readonly Checker<State>[],
  context: CheckContext<State>,
): Promise<readonly CheckResult[]> {
  const results: CheckResult[] = [];
  for (const checker of checkers) results.push(await checker.check(context));
  return results;
}

export function checksFailed(checks: readonly CheckResult[]): boolean {
  return checks.some((check) => !check.valid);
}

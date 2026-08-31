import type { CheckResult, Invariant, ScenarioResult } from "./types.js";

export function invariant<TState>(
  name: string,
  predicate: (state: TState) => boolean,
  message?: (state: TState) => string,
): Invariant<TState> {
  return {
    name,
    check(state) {
      const valid = predicate(state);
      return valid
        ? { valid: true }
        : {
            valid: false,
            invariant: name,
            message: message?.(state) ?? `Invariant '${name}' was violated`,
            witness: state,
          };
    },
  };
}

export function checkAll<TState>(state: TState, invariants: readonly Invariant<TState>[]): CheckResult {
  for (const candidate of invariants) {
    const result = candidate.check(state);
    if (!result.valid) return result;
  }
  return { valid: true };
}

export function assertScenarioValid(result: ScenarioResult): void {
  if (result.check.valid) return;
  throw new Error(
    `${result.check.invariant ?? "CloudFault invariant"}: ${result.check.message ?? "invalid history"}`,
  );
}

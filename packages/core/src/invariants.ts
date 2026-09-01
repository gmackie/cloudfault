import type { CheckResult } from "./types.js";

export interface NamedStateInvariant<State> {
  name: string;
  check(state: State): CheckResult | Promise<CheckResult>;
}

export function stateInvariant<State>(name: string, predicate: (state: State) => boolean | Promise<boolean>, message?: string | ((state: State) => string)): NamedStateInvariant<State> {
  return {
    name,
    async check(state) {
      const valid = await predicate(state);
      return valid ? { valid: true, checker: name } : { valid: false, checker: name, message: typeof message === "function" ? message(state) : message ?? `invariant '${name}' was violated`, details: state };
    },
  };
}

export function implies<State>(name: string, antecedent: (state: State) => boolean, consequent: (state: State) => boolean): NamedStateInvariant<State> {
  return stateInvariant(name, (state) => !antecedent(state) || consequent(state));
}

export function noOrphans<Parent, Child>(options: {
  name?: string;
  parents: (state: unknown) => readonly Parent[];
  children: (state: unknown) => readonly Child[];
  parentKey: (parent: Parent) => string;
  childParentKey: (child: Child) => string;
}): NamedStateInvariant<unknown> {
  const name = options.name ?? "no-orphans";
  return stateInvariant(name, (state) => {
    const parents = new Set(options.parents(state).map(options.parentKey));
    return options.children(state).every((child) => parents.has(options.childParentKey(child)));
  });
}

export function conserved<State>(name: string, measure: (state: State) => number, expected: number, tolerance = 0): NamedStateInvariant<State> {
  return stateInvariant(name, (state) => Math.abs(measure(state) - expected) <= tolerance, (state) => `expected conserved value ${expected}±${tolerance}, observed ${measure(state)}`);
}

export function monotonic<State>(name: string, values: (state: State) => readonly number[]): NamedStateInvariant<State> {
  return stateInvariant(name, (state) => {
    const sequence = values(state);
    for (let index = 1; index < sequence.length; index += 1) if (sequence[index]! < sequence[index - 1]!) return false;
    return true;
  });
}

export function uniqueBy<State, Item>(name: string, values: (state: State) => readonly Item[], key: (item: Item) => string): NamedStateInvariant<State> {
  return stateInvariant(name, (state) => {
    const seen = new Set<string>();
    for (const item of values(state)) {
      const id = key(item);
      if (seen.has(id)) return false;
      seen.add(id);
    }
    return true;
  });
}

export async function runStateInvariants<State>(state: State, invariants: readonly NamedStateInvariant<State>[]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const candidate of invariants) results.push(await candidate.check(state));
  return results;
}

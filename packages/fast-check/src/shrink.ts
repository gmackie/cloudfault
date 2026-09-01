import { minimizeFailureSet, type Perturbation } from "@cloudfault/core";

export interface SequenceShrinkResult<T> {
  original: readonly T[];
  minimal: readonly T[];
  attempts: number;
}

/** Delta-debug a sequence independently from fault-set minimization. */
export async function shrinkSequence<T>(
  original: readonly T[],
  reproduces: (candidate: readonly T[]) => boolean | Promise<boolean>,
): Promise<SequenceShrinkResult<T>> {
  let candidate = [...original];
  let attempts = 1;
  if (!(await reproduces(candidate))) throw new Error("Cannot shrink a sequence that does not reproduce the failure");
  let granularity = 2;
  while (candidate.length >= 2) {
    const chunkSize = Math.ceil(candidate.length / granularity);
    let reduced = false;
    for (let start = 0; start < candidate.length; start += chunkSize) {
      const attempt = [...candidate.slice(0, start), ...candidate.slice(start + chunkSize)];
      attempts++;
      if (await reproduces(attempt)) {
        candidate = attempt;
        granularity = Math.max(2, granularity - 1);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    if (granularity >= candidate.length) break;
    granularity = Math.min(candidate.length, granularity * 2);
  }
  return { original: [...original], minimal: candidate, attempts };
}

export interface CounterexampleShrinkResult<T> {
  perturbations: readonly Perturbation[];
  workload: readonly T[];
  faultAttempts: number;
  workloadAttempts: number;
  rounds: number;
}

/**
 * Alternate fault-set and workload reduction until neither changes. This keeps
 * the two witnesses conceptually separate: MFS explains which failures matter;
 * workload reduction explains the smallest client/event sequence that exposes them.
 */
export async function shrinkCounterexample<T>(
  perturbations: readonly Perturbation[],
  workload: readonly T[],
  reproduces: (candidate: { perturbations: readonly Perturbation[]; workload: readonly T[] }) => boolean | Promise<boolean>,
  options: { maxRounds?: number } = {},
): Promise<CounterexampleShrinkResult<T>> {
  let currentFaults = [...perturbations];
  let currentWorkload = [...workload];
  let faultAttempts = 0;
  let workloadAttempts = 0;
  let rounds = 0;
  const maxRounds = Math.max(1, options.maxRounds ?? 4);
  if (!(await reproduces({ perturbations: currentFaults, workload: currentWorkload }))) throw new Error("Counterexample does not reproduce before shrinking");

  while (rounds < maxRounds) {
    rounds++;
    const beforeFaults = currentFaults.length;
    const beforeWorkload = currentWorkload.length;
    const faults = await minimizeFailureSet(currentFaults, (candidate) => reproduces({ perturbations: candidate, workload: currentWorkload }));
    currentFaults = [...faults.minimal];
    faultAttempts += faults.attempts;
    const sequence = await shrinkSequence(currentWorkload, (candidate) => reproduces({ perturbations: currentFaults, workload: candidate }));
    currentWorkload = [...sequence.minimal];
    workloadAttempts += sequence.attempts;
    if (currentFaults.length === beforeFaults && currentWorkload.length === beforeWorkload) break;
  }
  return { perturbations: currentFaults, workload: currentWorkload, faultAttempts, workloadAttempts, rounds };
}

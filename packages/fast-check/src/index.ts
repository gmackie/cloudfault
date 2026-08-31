import type { FaultPoint, Perturbation } from "@cloudfault/core";

interface ArbitraryLike<T> {
  map<U>(mapper: (value: T) => U): ArbitraryLike<U>;
}

export interface FastCheckLike {
  constant<T>(value: T): ArbitraryLike<T>;
  constantFrom<T>(...values: T[]): ArbitraryLike<T>;
  array<T>(arb: ArbitraryLike<T>, constraints?: { minLength?: number; maxLength?: number }): ArbitraryLike<T[]>;
}

/**
 * Build a fast-check arbitrary without making fast-check a hard dependency of
 * the rest of CloudFault. Systematic bounded search remains the default mode;
 * this bridge is intended for workload/data generation and fuzz/soak modes.
 */
export function perturbationSequenceArbitrary(
  fc: FastCheckLike,
  points: readonly FaultPoint[],
  maxLength = 8,
): ArbitraryLike<readonly Perturbation[]> {
  const all = points.flatMap((point) => point.choices);
  if (all.length === 0) {
    return fc.constant([] as readonly Perturbation[]);
  }
  return fc.array(fc.constantFrom(...all), { minLength: 0, maxLength });
}

export async function loadFastCheck(): Promise<FastCheckLike> {
  try {
    return (await Function("return import('fast-check')")()) as FastCheckLike;
  } catch (error) {
    throw new Error("@cloudfault/fast-check requires fast-check >= 4", { cause: error });
  }
}

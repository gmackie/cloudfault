import type { Fault } from "@cloudfault/core";

export interface FastCheckRunOptions {
  seed?: number;
  numRuns?: number;
}

/**
 * Optional bridge. CloudFault's systematic correctness search does not require
 * fast-check, but generated workloads and shrinking can delegate to it.
 */
export async function assertGeneratedFaultSets(
  faults: readonly Fault[],
  property: (faults: readonly Fault[]) => boolean | Promise<boolean>,
  options: FastCheckRunOptions = {},
): Promise<void> {
  let fc: Record<string, unknown>;
  try {
    fc = await import("fast-check") as Record<string, unknown>;
  } catch {
    throw new Error("Install fast-check >= 4 to use @cloudfault/fast-check");
  }

  const subarray = fc.subarray as (items: readonly Fault[]) => unknown;
  const asyncProperty = fc.asyncProperty as (arb: unknown, fn: (value: readonly Fault[]) => Promise<void>) => unknown;
  const assert = fc.assert as (property: unknown, params?: Record<string, unknown>) => Promise<void>;

  const generated = subarray(faults);
  const p = asyncProperty(generated, async (active) => {
    if (!(await property(active))) throw new Error("CloudFault generated scenario violated property");
  });
  await assert(p, {
    seed: options.seed,
    numRuns: options.numRuns ?? 100,
  });
}

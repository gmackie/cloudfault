/** Tiny deterministic PRNG used for scenario choices that are not delegated to fast-check. */
export class SeededRandom {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0 || 0x6d2b79f5;
  }

  next(): number {
    let value = (this.#state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  integer(min: number, max: number): number {
    if (max < min) throw new RangeError("max must be >= min");
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(values: readonly T[]): T {
    if (!values.length) throw new RangeError("cannot pick from an empty collection");
    return values[this.integer(0, values.length - 1)]!;
  }
}

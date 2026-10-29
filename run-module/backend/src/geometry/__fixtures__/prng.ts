/**
 * src/geometry/__fixtures__/prng.ts
 *
 * Seeded pseudo-random number generator (mulberry32 algorithm).
 *
 * Mulberry32 is a 32-bit PRNG with excellent statistical properties,
 * a tiny implementation, and a well-understood period (~2^32).
 * It is fully reproducible: the same seed always produces the same sequence.
 *
 * Math.random() is FORBIDDEN here — it is non-deterministic across environments.
 *
 * Reference: https://gist.github.com/tommyettinger/46a874533244883189143505d203312c
 */

export interface Prng {
  /** Returns the next value in the sequence, uniformly in [0, 1). */
  next(): number;
}

/**
 * Create a seeded PRNG using the mulberry32 algorithm.
 *
 * @param seed - A 32-bit unsigned integer seed. The same seed always
 *               yields the same sequence regardless of environment or run order.
 * @returns A stateful PRNG object with a single `next()` method.
 */
export function createPrng(seed: number): Prng {
  // Ensure the seed is treated as a 32-bit unsigned integer.
  let s = seed >>> 0;

  return {
    next(): number {
      // mulberry32 step
      s = (s + 0x6d2b79f5) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 15), z | 1) >>> 0;
      z = (z ^ (z + Math.imul(z ^ (z >>> 7), z | 61))) >>> 0;
      z = (z ^ (z >>> 14)) >>> 0;
      // Map to [0, 1) using full 32-bit range
      return z / 0x1_0000_0000;
    },
  };
}

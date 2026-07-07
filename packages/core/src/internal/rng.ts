/**
 * RNG seam. Signature `(min, max) => int` inclusive — mirrors the plugin's
 * injectable `$random_fn`. The engine short-circuits `min === max` (see
 * `randomInt` in render.ts), so this is only invoked when a real choice exists.
 */
export type Rng = (min: number, max: number) => number;

/**
 * Build an RNG from a `seed` (deterministic PRNG — reproducible within THIS
 * engine; cross-engine sequence parity is a non-goal §3.2) or, when omitted,
 * from `Math.random` (universal on Workers / Node / browser).
 */
export function makeRng(seed: number | string | undefined): Rng {
  const next =
    seed === undefined
      ? Math.random
      : mulberry32(typeof seed === 'number' ? seed >>> 0 : hashString(seed));
  return (min, max) => min + Math.floor(next() * (max - min + 1));
}

/** mulberry32 — tiny, fast, well-distributed 32-bit PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string seed → 32-bit uint. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

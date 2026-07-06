/**
 * Shared golden-corpus harness: loads the language-neutral fixtures from
 * `@spintax/conformance` and provides the pieces the corpus tests need
 * (case types, the injected-RNG builder, an engines filter). See spec §7.1.
 *
 * The TS engine's RNG seam mirrors the plugin's `Parser($random_fn)`: an
 * injected `(min, max) => int`. `rngFromStrategy` turns a fixture's `rng`
 * field into that function. The engine is responsible for the short-circuit
 * (min === max ⇒ do not call the RNG), exactly like PHP `random_int`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export type Op = 'render' | 'validate' | 'extract' | 'neutralize';
export type Kind = 'deterministic' | 'rng';
export type Engine = 'ts' | 'php';
export type RngStrategy = 'first' | 'last' | { sequence: number[] };

export interface ExpectValidate {
  verdict: 'valid' | 'invalid';
  diagnostics?: Array<{ code: string; severity?: 'error' | 'warning'; line?: number; column?: number }>;
}
export interface ExpectExtract {
  refs?: string[];
  sets?: string[];
  includes?: string[];
}
export interface ExpectRng {
  reproducible: true;
  oneOf?: string[];
  subsetOf?: string[];
  sizeRange?: [number, number];
  separator?: string;
  lastSeparator?: string;
}
export type Expect = { output: string } | ExpectValidate | ExpectExtract | ExpectRng;

export interface Case {
  id: string;
  note?: string;
  kind: Kind;
  op: Op;
  template: string;
  context?: Record<string, string>;
  locale?: string;
  knownIncludes?: string[];
  neutralizeContext?: string[];
  seed?: number | string;
  postProcess?: boolean;
  rng?: RngStrategy;
  engines?: Engine[];
  expect: Expect;
}

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'conformance',
  'fixtures',
);

/** Load every corpus file as [filename, cases]. */
export function loadCorpus(): Array<[string, Case[]]> {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => [f, JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf8')) as Case[]]);
}

/** True if this case asserts against the TS engine (absent engines ⇒ both). */
export function runsInTs(c: Case): boolean {
  return !c.engines || c.engines.includes('ts');
}

/**
 * Build the injected RNG `(min, max) => number` for a fixture's `rng` strategy.
 * Matches the plugin's make_first / make_last / make_sequence
 * (ParserTest.php:17-47): raw returns clamped to [min, max], last value reused
 * after the sequence is exhausted.
 */
export function rngFromStrategy(strategy: RngStrategy): (min: number, max: number) => number {
  if (strategy === 'first') return (min) => min;
  if (strategy === 'last') return (_min, max) => max;

  const seq = strategy.sequence;
  let i = 0;
  return (min, max) => {
    const raw = seq[Math.min(i, seq.length - 1)] ?? min;
    i += 1;
    return Math.max(min, Math.min(max, raw));
  };
}

/**
 * Corpus-driven parity tests. Every fixture becomes a test. Ops without a
 * registered runner yet are emitted as `test.todo` so CI stays green while the
 * engine is built — M1 lights up validate/extract, M2 render/neutralize by
 * adding entries to RUNNERS (and the per-op assertion logic). analyze() is
 * validate+extract and has no dedicated corpus op.
 */
import { describe, test, expect } from 'vitest';
import { extract, neutralize, validate, type ValidateOptions } from '../src/index';
import { renderWith, type PipelineOptions } from '../src/internal/pipeline';
import { makeRng } from '../src/internal/rng';
import {
  loadCorpus,
  rngFromStrategy,
  runsInTs,
  type Case,
  type ExpectExtract,
  type ExpectRng,
  type ExpectValidate,
  type Op,
} from './corpus-harness';

/**
 * Per-op runners. Ops without an entry are pending `test.todo`. Wiring one op
 * here turns its whole corpus category live.
 */
const RUNNERS: Partial<Record<Op, (c: Case) => void>> = {
  validate: runValidate,
  extract: runExtract,
  render: (c) => (c.kind === 'rng' ? runRenderRng(c) : runRenderDeterministic(c)),
  neutralize: runNeutralize,
};

/** Build the pipeline options for a render case (neutralizing the marked context keys). */
function pipelineOpts(c: Case): PipelineOptions {
  const opts: PipelineOptions = {};
  let context = c.context;
  if (context && c.neutralizeContext) {
    context = { ...context };
    for (const key of c.neutralizeContext) {
      const v = context[key];
      if (v !== undefined) context[key] = neutralize(v);
    }
  }
  if (context !== undefined) opts.context = context;
  if (c.locale !== undefined) opts.locale = c.locale;
  if (c.postProcess !== undefined) opts.postProcess = c.postProcess;
  return opts;
}

/** deterministic: exact output with the fixture's `rng` strategy. An omitted `rng`
 *  defaults to 'first' — valid only because such fixtures don't SELECT (single
 *  option / non-selecting plural·conditional·variable / shielded round-trip). */
function runRenderDeterministic(c: Case): void {
  const out = renderWith(c.template, rngFromStrategy(c.rng ?? 'first'), pipelineOpts(c));
  expect(out, c.id).toBe((c.expect as { output: string }).output);
}

/** rng: seeded PRNG — reproducibility + §7.2 structural invariants (no exact output). */
function runRenderRng(c: Case): void {
  const opts = pipelineOpts(c);
  const out = renderWith(c.template, makeRng(c.seed), opts);
  const e = c.expect as ExpectRng;
  if (e.reproducible) {
    expect(renderWith(c.template, makeRng(c.seed), opts), `${c.id} reproducible`).toBe(out);
  }
  if (e.oneOf) expect(e.oneOf, `${c.id} oneOf`).toContain(out);
  if (e.subsetOf || e.sizeRange) {
    const tokens = out === '' ? [] : out.split(e.separator ?? ' ');
    if (e.subsetOf) {
      for (const t of tokens) expect(e.subsetOf, `${c.id} subsetOf`).toContain(t);
      // A permutation draws WITHOUT replacement ⇒ tokens are distinct. This (with
      // subsetOf + sizeRange) is what makes an exhaustive [n,n] case assert the full
      // set, and rejects a broken shuffle that repeats/drops an element ("a a a").
      expect(new Set(tokens).size, `${c.id} distinct tokens`).toBe(tokens.length);
    }
    if (e.sizeRange) {
      expect(tokens.length, `${c.id} sizeRange min`).toBeGreaterThanOrEqual(e.sizeRange[0]);
      expect(tokens.length, `${c.id} sizeRange max`).toBeLessThanOrEqual(e.sizeRange[1]);
    }
  }
}

/** neutralize: exact text-safe output. */
function runNeutralize(c: Case): void {
  expect(neutralize(c.template), c.id).toBe((c.expect as { output: string }).output);
}

/** Each present array in `expect` is compared exactly, order-normalized. */
function runExtract(c: Case): void {
  const result = extract(c.template);
  const expected = c.expect as ExpectExtract;
  const sorted = (a: readonly string[] | undefined): string[] => [...(a ?? [])].sort();
  if (expected.refs !== undefined) expect(sorted(result.refs), `${c.id} refs`).toEqual(sorted(expected.refs));
  if (expected.sets !== undefined) expect(sorted(result.sets), `${c.id} sets`).toEqual(sorted(expected.sets));
  if (expected.defs !== undefined) expect(sorted(result.defs), `${c.id} defs`).toEqual(sorted(expected.defs));
  if (expected.includes !== undefined) {
    expect(sorted(result.includes), `${c.id} includes`).toEqual(sorted(expected.includes));
  }
}

/** verdict is asserted exactly; diagnostics is a SUBSET assertion by {code[,severity]}. */
function runValidate(c: Case): void {
  const opts: ValidateOptions = {};
  if (c.locale !== undefined) opts.locale = c.locale;
  if (c.knownIncludes !== undefined) opts.knownIncludes = c.knownIncludes;

  const diags = validate(c.template, opts);
  const expected = c.expect as ExpectValidate;

  const verdict = diags.some((d) => d.severity === 'error') ? 'invalid' : 'valid';
  expect(verdict, `verdict for ${c.id}`).toBe(expected.verdict);

  for (const ed of expected.diagnostics ?? []) {
    const found = diags.some(
      (d) => d.code === ed.code && (ed.severity === undefined || d.severity === ed.severity),
    );
    expect(found, `${c.id}: expected diagnostic '${ed.code}' not produced`).toBe(true);
  }
}

for (const [file, cases] of loadCorpus()) {
  describe(file, () => {
    for (const c of cases) {
      const runner = RUNNERS[c.op];
      if (runner && runsInTs(c)) {
        test(c.id, () => runner(c));
      } else {
        const why = runner ? `${c.op} not asserted in TS` : `pending ${c.op} implementation`;
        test.todo(`${c.id} — ${why}`);
      }
    }
  });
}

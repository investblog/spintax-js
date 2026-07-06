/**
 * Corpus-driven parity tests. Every fixture becomes a test. Ops without a
 * registered runner yet are emitted as `test.todo` so CI stays green while the
 * engine is built — M1 lights up validate/extract, M2 render/neutralize by
 * adding entries to RUNNERS (and the per-op assertion logic). analyze() is
 * validate+extract and has no dedicated corpus op.
 */
import { describe, test, expect } from 'vitest';
import { validate, type ValidateOptions } from '../src/index';
import { loadCorpus, runsInTs, type Case, type ExpectValidate, type Op } from './corpus-harness';

/**
 * Per-op runners. Ops without an entry are pending `test.todo`. Wiring one op
 * here turns its whole corpus category live.
 */
const RUNNERS: Partial<Record<Op, (c: Case) => void>> = {
  validate: runValidate,
  // M1: extract
  // M2: render (branch on kind: deterministic⇒exact output via rngFromStrategy;
  //     rng⇒seeded PRNG + §7.2 invariants), neutralize
};

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

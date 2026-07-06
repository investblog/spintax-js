/**
 * Corpus-driven parity tests. Every fixture becomes a test. Ops without a
 * registered runner yet are emitted as `test.todo` so CI stays green while the
 * engine is built — M1 lights up validate/extract, M2 render/neutralize by
 * adding entries to RUNNERS (and the per-op assertion logic). analyze() is
 * validate+extract and has no dedicated corpus op.
 */
import { describe, test } from 'vitest';
import { loadCorpus, runsInTs, type Case, type Op } from './corpus-harness';

/**
 * Per-op runners. Empty at M0.5 (engine is stubs), so every corpus case is a
 * pending `test.todo`. Wiring one op here turns its whole category live.
 */
const RUNNERS: Partial<Record<Op, (c: Case) => void>> = {
  // M1: validate, extract
  // M2: render (branch on kind: deterministic⇒exact output via rngFromStrategy;
  //     rng⇒seeded PRNG + §7.2 invariants), neutralize
};

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

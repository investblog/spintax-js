import { describe, test, expect } from 'vitest';
import { analyze, parse } from '../src/index';

describe('analyze', () => {
  test('composes extract (refs/sets/includes) + validate diagnostics + construct counts', () => {
    const src = '#set %greeting% = hi\n%greeting% {a|b} [c|d] {?flag?yes} {plural %n%: one|many}\n#include "hero"';
    const a = analyze(src);

    expect(a.sets).toEqual(['greeting']);
    expect(a.includes).toEqual(['hero']);
    expect(a.refs.sort()).toEqual(['flag', 'greeting', 'n'].sort());

    expect(a.constructs).toMatchObject({
      enumeration: 1,
      permutation: 1,
      conditional: 1,
      plural: 1,
      set: 1,
      include: 1,
    });
    // constructs.variable counts VariableNodes in the tree (%greeting% ⇒ 1). Vars
    // that live in raw slots (%n% in the plural count) surface in refs, NOT the census.
    expect(a.constructs.variable).toBe(1);
    expect(a.refs).toContain('n');
    expect(Array.isArray(a.diagnostics)).toBe(true);
  });

  test('census recurses into nested constructs (not just top level)', () => {
    // Outer enumeration with a permutation and a conditional as its options.
    const a = analyze('{a|[x|y]|{?f?z}}');
    expect(a.constructs).toMatchObject({ enumeration: 1, permutation: 1, conditional: 1 });
  });

  test('surfaces validation diagnostics (unbalanced ⇒ error verdict)', () => {
    const a = analyze('{a|b');
    expect(a.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  test('honors ValidateOptions (knownVariables suppresses the undefined warning)', () => {
    const withWarn = analyze('%x%');
    const suppressed = analyze('%x%', { knownVariables: ['x'] });
    expect(withWarn.diagnostics.some((d) => d.code === 'variable.undefined')).toBe(true);
    expect(suppressed.diagnostics.some((d) => d.code === 'variable.undefined')).toBe(false);
  });

  test('accepts a pre-parsed Ast (no re-parse divergence)', () => {
    const ast = parse('{a|b|c}');
    expect(analyze(ast).constructs.enumeration).toBe(1);
  });

  test('empty template ⇒ all-zero construct census, no diagnostics', () => {
    const a = analyze('');
    expect(a.constructs).toEqual({
      enumeration: 0,
      permutation: 0,
      variable: 0,
      conditional: 0,
      plural: 0,
      set: 0,
      include: 0,
    });
    expect(a.diagnostics).toEqual([]);
  });
});

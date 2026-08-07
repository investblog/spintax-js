import { describe, test, expect } from 'vitest';
import { parse, validate } from '../src/index';

const codes = (src: string, opts?: Parameters<typeof validate>[1]): string[] =>
  validate(src, opts).map((d) => d.code);
const isValid = (src: string, opts?: Parameters<typeof validate>[1]): boolean =>
  !validate(src, opts).some((d) => d.severity === 'error');

describe('validator — regression guards (beyond the corpus)', () => {
  test('plural nested inside a permutation is still checked (raw scan, not AST walk)', () => {
    // A 3-form plural is an arity error for en (2-form), even inside [ … ].
    expect(codes('[{plural 1: a|b|c}]', { locale: 'en' })).toContain('plural.arity');
    expect(isValid('[{plural 1: a|b|c}]', { locale: 'en' })).toBe(false);
  });

  test('#include nested inside a permutation is still target-checked', () => {
    const src = '[a|\n#include "nope"\n|b]';
    expect(codes(src, { knownIncludes: ['ok'] })).toContain('include.unknown-target');
  });

  test('arity guard keys off the NORMALIZED base — "_en" normalizes to "" ⇒ arity skipped', () => {
    expect(isValid('{plural 1: a|b|c}', { locale: '_en' })).toBe(true);
    // sanity: real "en" does flag the 3-form arity mismatch
    expect(isValid('{plural 1: a|b|c}', { locale: 'en' })).toBe(false);
  });

  test('comma inside a quoted sep is not a false unknown-key', () => {
    expect(isValid('[<sep=", ">a|b]')).toBe(true);
  });

  test('minsize=0 does NOT flag (ctype_digit parity), minsize=x does', () => {
    expect(codes('[<minsize=0>a|b]')).not.toContain('permutation.minsize-not-integer');
    expect(codes('[<minsize=x>a|b]')).toContain('permutation.minsize-not-integer');
  });

  test('undefined %var% is a warning, not an error (stays valid)', () => {
    const d = validate('Hello %runtime%!');
    expect(d.some((x) => x.code === 'variable.undefined' && x.severity === 'warning')).toBe(true);
    expect(d.some((x) => x.severity === 'error')).toBe(false);
  });

  test('knownVariables suppresses the undefined-var warning (verdict unaffected)', () => {
    expect(validate('%brand%').some((d) => d.code === 'variable.undefined')).toBe(true);
    const d = validate('%Brand%', { knownVariables: ['brand'] }); // case-insensitive
    expect(d.some((x) => x.code === 'variable.undefined')).toBe(false);
    expect(d.some((x) => x.severity === 'error')).toBe(false);
  });

  test('validate accepts a parsed Ast (string|Ast)', () => {
    const ast = parse('{a|b');
    expect(validate(ast).some((d) => d.code === 'bracket.unclosed')).toBe(true);
  });
});

describe('validator — diagnostic positions (line/column/end + data)', () => {
  const only = (src: string, code: string, opts?: Parameters<typeof validate>[1]) =>
    validate(src, opts).find((d) => d.code === code)!;

  test('undefined %var% spans the whole %name% token and carries data.name', () => {
    const d = only('Hello %missing% here', 'variable.undefined');
    expect(d).toMatchObject({ line: 1, column: 7, endLine: 1, endColumn: 16, data: { name: 'missing' } });
    // column 7..15 is exactly "%missing%"
    expect('Hello %missing% here'.slice(d.column - 1, (d.endColumn ?? 0) - 1)).toBe('%missing%');
  });

  test('undefined ref reports its FIRST occurrence, once per unique name', () => {
    const diags = validate('%x% then %x% again').filter((d) => d.code === 'variable.undefined');
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ column: 1, data: { name: 'x' } });
  });

  test('bracket.unclosed points at the offending bracket (real line + column)', () => {
    const d = only('ok\nPick {a|b', 'bracket.unclosed');
    expect(d).toMatchObject({ line: 2, column: 6, endLine: 2, endColumn: 7, data: { bracket: '{' } });
  });

  test('plural.arity spans the block and carries expected/got', () => {
    const d = only('x {plural %n%: a|b|c} y', 'plural.arity', { locale: 'en' });
    expect(d).toMatchObject({ line: 1, column: 3, endColumn: 22, data: { expected: 2, got: 3 } });
    expect('x {plural %n%: a|b|c} y'.slice(d.column - 1, (d.endColumn ?? 0) - 1)).toBe('{plural %n%: a|b|c}');
  });

  test('permutation.minsize-not-integer points at the config token with data.value', () => {
    const d = only('[<minsize=x>a|b]', 'permutation.minsize-not-integer');
    expect(d).toMatchObject({ line: 1, column: 3, data: { value: 'x' } });
  });

  test('positions are 1-based on later lines too (multi-line offset mapping)', () => {
    const d = only('line one\nline two %gone%', 'variable.undefined');
    expect(d).toMatchObject({ line: 2, column: 10, data: { name: 'gone' } });
  });
});

describe('validator — the circular-reference walk (emission shape + the prune must stay silent)', () => {
  const circular = (src: string) => validate(src).filter((d) => d.code === 'variable.circular-reference');

  test('a 3-cycle reports once per root, message carrying the path from that root', () => {
    const diags = circular('#set %c0% = %c1%\n#set %c1% = %c2%\n#set %c2% = %c0%');
    expect(diags.map((d) => d.message)).toEqual([
      'Circular variable reference: c0 → c1 → c2 → c0.',
      'Circular variable reference: c1 → c2 → c0 → c1.',
      'Circular variable reference: c2 → c0 → c1 → c2.',
    ]);
  });

  test('a duplicated edge is walked per occurrence — %b% %b% in a 2-cycle reports three times', () => {
    // The reference semantics spintax-win aligned to on 2026-08-07: references are not
    // deduplicated, and a report abandons only the frame that made it.
    const diags = circular('#set %a% = %b% %b%\n#set %b% = %a%');
    expect(diags.map((d) => d.message)).toEqual([
      'Circular variable reference: a → b → a.',
      'Circular variable reference: a → b → a.',
      'Circular variable reference: b → a → b.',
    ]);
  });

  test('a converging diamond feeding a cycle keeps the per-path emission count', () => {
    // depth 2 → 2^2 + 2^1 reports from the a-roots, one each from a2, p, q.
    const src = '#set %a2% = %p%\n#set %a1% = %a2% %a2%\n#set %a0% = %a1% %a1%\n#set %p% = %q%\n#set %q% = %p%';
    expect(circular(src)).toHaveLength(9);
  });

  test('an acyclic chain is silent and fast — the prune must not invent or lose a report', () => {
    // Pre-rewrite this shape was O(n³)-ish: 2000 definitions took tens of seconds and
    // would trip the suite timeout; the walk now skips subtrees that reach no cycle.
    const lines = ['#set %v0% = x'];
    for (let i = 1; i < 2000; i += 1) lines.push(`#set %v${i}% = %v${i - 1}%`);
    expect(validate(lines.join('\n'))).toEqual([]);
  });

  test('a converging diamond with a literal leaf is silent — pre-rewrite it never returned', () => {
    const n = 30; // 2^30 paths if actually walked
    const lines = [`#set %a${n}% = leaf`];
    for (let i = n - 1; i >= 0; i -= 1) lines.push(`#set %a${i}% = %a${i + 1}% %a${i + 1}%`);
    expect(validate(lines.join('\n'))).toEqual([]);
  });

  test('duplicate-name messages still name the FIRST line (the resuming line counter)', () => {
    const diags = validate('one\n#set %d% = a\ntwo\n#set %d% = b\n#set %d% = c')
      .filter((d) => d.code === 'definition.duplicate-name');
    expect(diags).toHaveLength(2);
    for (const d of diags) expect(d.message).toContain('first on line 2');
    expect(diags.map((d) => d.line)).toEqual([4, 5]);
  });
});

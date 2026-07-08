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

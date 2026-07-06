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

  test('validate accepts a parsed Ast (string|Ast)', () => {
    const ast = parse('{a|b');
    expect(validate(ast).some((d) => d.code === 'bracket.unclosed')).toBe(true);
  });
});

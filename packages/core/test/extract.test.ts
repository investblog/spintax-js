import { describe, test, expect } from 'vitest';
import { extract } from '../src/index';

const sort = (a: string[]): string[] => [...a].sort();

describe('extract — refs / sets / includes', () => {
  test('corpus shape: usages are refs, #set targets are sets', () => {
    const r = extract('#set %greeting% = Hello\n%greeting% %name%!\n#include "hero"');
    expect(sort(r.refs)).toEqual(['greeting', 'name']);
    expect(r.sets).toEqual(['greeting']);
    expect(r.includes).toEqual(['hero']);
  });

  test('an unused #set target is a set but not a ref', () => {
    const r = extract('#set %x% = hi');
    expect(r.sets).toEqual(['x']);
    expect(r.refs).toEqual([]);
  });

  test('a %var% inside a #set value is a ref', () => {
    const r = extract('#set %g% = %x%\n%g%');
    expect(sort(r.refs)).toEqual(['g', 'x']);
    expect(r.sets).toEqual(['g']);
  });

  test('completeness: %var% inside a plural count and a permutation body are refs', () => {
    expect(extract('{plural %n%: a|b}').refs).toEqual(['n']);
    expect(extract('[%x%|b]').refs).toEqual(['x']);
  });

  test('conditional variable names are refs', () => {
    expect(sort(extract('{?flag?yes|no} {?!other?x}').refs)).toEqual(['flag', 'other']);
  });

  test('refs are de-duplicated', () => {
    expect(extract('%a% %a% %a%').refs).toEqual(['a']);
  });

  test('variable names are lower-cased (engine identity); include slugs are not', () => {
    const r = extract('#set %Greeting% = hi\n%GREETING%\n#include "Hero"');
    expect(r.sets).toEqual(['greeting']);
    expect(r.refs).toEqual(['greeting']); // %Greeting% LHS stripped, %GREETING% folded ⇒ one
    expect(r.includes).toEqual(['Hero']); // slug kept as authored
  });

  test('a malformed multi-line #set is NOT a definition ([ \\t], not \\s)', () => {
    // "#set %a%" has no "=" on its line ⇒ not a set; %a% and %b% are refs.
    const r = extract('#set %a%\n= x\n%b%');
    expect(r.sets).toEqual([]);
    expect(r.refs).toEqual(['a', 'b']);
  });

  test('the two directives are reported separately — they have opposite semantics', () => {
    const r = extract('#set %macro% = {a|b}\n#def %frozen% = {c|d}\n%macro% %frozen%');
    expect(r.sets).toEqual(['macro']);
    expect(r.defs).toEqual(['frozen']);
  });

  test('a #def target is a definition, not a phantom reference', () => {
    // Missing the #def half of the LHS strip would report every definition name as a ref.
    const r = extract('#def %x% = hello\nplain text');
    expect(r.defs).toEqual(['x']);
    expect(r.refs).toEqual([]);
  });

  test('a %var% inside a #def value is still a ref', () => {
    const r = extract('#def %greeting% = Hello %name%');
    expect(r.defs).toEqual(['greeting']);
    expect(r.refs).toEqual(['name']);
  });
});

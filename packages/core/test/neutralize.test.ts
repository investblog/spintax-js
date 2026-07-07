import { describe, test, expect } from 'vitest';
import { neutralize, render } from '../src/index';

/** Host feeds a neutralized data value through the engine (the T2 boundary). */
const roundtrip = (value: string, postProcess = false): string =>
  render('%t%', { context: { t: neutralize(value) }, postProcess });

describe('neutralize', () => {
  test('a value with no structural chars is unchanged', () => {
    expect(neutralize('plain text, no markup')).toBe('plain text, no markup');
  });

  test('structural chars are shielded (not present verbatim in the output)', () => {
    const n = neutralize('A {x|y} [z] 50% #h');
    for (const ch of ['{', '}', '[', ']', '%', '#']) expect(n).not.toContain(ch);
  });
});

describe('neutralize → render round-trip (mechanism-independent: final literal glyphs)', () => {
  test('enumeration braces stay literal (not resolved)', () => {
    expect(roundtrip('a {x|y}')).toBe('a {x|y}');
  });
  test('permutation brackets stay literal', () => {
    expect(roundtrip('[a|b]')).toBe('[a|b]');
  });
  test('a shielded % stops %other% from being expanded', () => {
    expect(roundtrip('%other%')).toBe('%other%');
  });
  test('percent literal', () => {
    expect(roundtrip('50% off')).toBe('50% off');
  });
  test('shielded # is not read as an #include directive', () => {
    expect(roundtrip('#include "hero"')).toBe('#include "hero"');
  });

  test('the safety-restore survives postProcess:true (cosmetic still caps the real first letter)', () => {
    expect(roundtrip('a {x|y}', true)).toBe('A {x|y}');
  });
  test('leading shielded brace: restore-before-cosmetic ordering', () => {
    // First real char is "{", no letter to capitalize ⇒ "{x|y}".
    expect(roundtrip('{x|y}', true)).toBe('{x|y}');
  });

  test('a stray reserved sentinel in template markup is stripped (not rewritten)', () => {
    const sentinel = String.fromCharCode(0xe001); // the "}" sentinel
    expect(render(`x${sentinel}y`, { postProcess: false })).toBe('xy');
  });
});

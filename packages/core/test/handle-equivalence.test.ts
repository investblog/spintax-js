import { describe, test, expect } from 'vitest';
import { analyze, neutralize, parse, render, type RenderOptions } from '../src/index';

/**
 * The parse-once-reuse contract (§4): a handle must behave exactly like its source.
 *
 * The ABSENCE of this check is why #51 shipped. The sanitation that keeps author-typed
 * engine sentinels out of a tree lived at the render entry points, so `parse()` and
 * `analyze(str)` — two of the three doors — skipped it and `render(parse(src))` returned
 * "a{b" where `render(src)` returned "ab". A per-construct test in either path would have
 * stayed green; only source-vs-handle equivalence catches a divergence between doors.
 */

/** The "{" sentinel. Author-typed here — the reserved-range edge, not host data. */
const SENTINEL = String.fromCharCode(0xe000);

const OPTS: RenderOptions = {
  seed: 1234,
  context: { name: 'World', flag: '1' },
  postProcess: false,
};

const CASES: Readonly<Record<string, string>> = {
  plain: 'hello world',
  enumeration: '{a|b|c}',
  'nested enumeration': '{a|{b|c}}',
  permutation: '[<, > a|b|c]',
  variable: 'Hi %name%',
  '#set is a macro (re-rolls per reference)': '#set %x% = {a|b}\n%x% %x%',
  '#def is roll-once (frozen after the first draw)': '#def %x% = {a|b}\n%x% %x%',
  conditional: '{?flag?yes|no}',
  plural: '{plural 2: item|items}',
  comment: 'a /#ignored#/ b',
  'author-typed sentinel (#51)': `a${SENTINEL}b`,
};

describe('render(parse(src)) === render(src)', () => {
  for (const [name, src] of Object.entries(CASES)) {
    test(name, () => {
      // Same seed both sides ⇒ the rng sequences match, so any difference is the door.
      expect(render(parse(src), OPTS)).toBe(render(src, OPTS));
    });
  }
});

describe('analyze(parse(src)) === analyze(src)', () => {
  for (const [name, src] of Object.entries(CASES)) {
    test(name, () => {
      expect(analyze(parse(src)).constructs).toEqual(analyze(src).constructs);
    });
  }
});

describe('the sentinel edge, pinned to its value (#51)', () => {
  const src = `a${SENTINEL}b`;

  test('an author-typed sentinel is stripped, not restored into a brace', () => {
    expect(render(src, { postProcess: false })).toBe('ab');
    expect(render(parse(src), { postProcess: false })).toBe('ab');
    // The pre-fix output, spelled out: safetyRestore rewrote the author's character
    // into a structural glyph they never wrote.
    expect(render(parse(src), { postProcess: false })).not.toBe('a{b');
  });

  test('#include results are sanitised too (they are author markup as well)', () => {
    const out = render('#include "child"', {
      postProcess: false,
      includeResolver: () => `x${SENTINEL}y`,
    });
    expect(out).toBe('xy');
  });

  test('the AST keeps the ORIGINAL source, so diagnostics point at what was typed', () => {
    expect(parse(src).source).toBe(src);
  });
});

describe('the strip belongs to author markup ONLY (guards the other direction)', () => {
  /**
   * `parseSequence` re-parses a variable's VALUE, where sentinels are legitimate — they
   * are what `neutralize()` put into a host's T2 data and they must survive to reach the
   * safety-restore. Moving the strip in there would silently un-shield host data, so this
   * fails if anyone ever "completes" the fix by sanitising that door too.
   */
  test('a neutralized host value still renders as literal glyphs', () => {
    const out = render('%t%', { context: { t: neutralize('a {x|y} [z] 50% #h') }, postProcess: false });
    expect(out).toBe('a {x|y} [z] 50% #h');
  });

  test('and stays literal when reached through a #set macro', () => {
    const out = render('#set %s% = %t%\n%s%', {
      context: { t: neutralize('{a|b}') },
      postProcess: false,
    });
    // The directive line is extracted, its line break is not — and postProcess:false
    // leaves it alone. The point of the assertion is the braces, which stay literal.
    expect(out).toBe('\n{a|b}');
  });
});

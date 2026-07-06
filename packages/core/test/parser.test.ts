import { describe, test, expect } from 'vitest';
import { parseTemplate, splitTopLevel, stripComments } from '../src/internal/parser';
import { AST_VERSION, type Node } from '../src/internal/ast';

function nodes(src: string): Node[] {
  return parseTemplate(src).nodes as Node[];
}

const lit = (value: string): Node => ({ type: 'literal', value });
const v = (name: string): Node => ({ type: 'variable', name });

describe('parseTemplate — core constructs', () => {
  test('literal only', () => {
    expect(parseTemplate('hello').astVersion).toBe(AST_VERSION);
    expect(nodes('hello')).toEqual([lit('hello')]);
  });

  test('variable reference', () => {
    expect(nodes('hi %name%')).toEqual([lit('hi '), v('name')]);
  });

  test('variable name may start with a digit (\\w+)', () => {
    expect(nodes('%1x%')).toEqual([v('1x')]);
  });

  test('bare percent stays literal', () => {
    expect(nodes('50% off')).toEqual([lit('50% off')]);
  });

  test('enumeration', () => {
    expect(nodes('{a|b|c}')).toEqual([
      { type: 'enumeration', options: [[lit('a')], [lit('b')], [lit('c')]] },
    ]);
  });

  test('nested enumeration', () => {
    expect(nodes('{a|{b|c}}')).toEqual([
      {
        type: 'enumeration',
        options: [[lit('a')], [{ type: 'enumeration', options: [[lit('b')], [lit('c')]] }]],
      },
    ]);
  });

  test('empty option', () => {
    expect(nodes('{|a}')).toEqual([{ type: 'enumeration', options: [[], [lit('a')]] }]);
  });

  test('permutation captures raw inner (split deferred to PR-11)', () => {
    expect(nodes('[a|b]')).toEqual([{ type: 'permutation', rawInner: 'a|b' }]);
  });

  test('permutation raw inner preserves a pipe inside a quoted config', () => {
    // PR-11 extracts <config> before splitting; PR-10 must not corrupt it.
    expect(nodes('[<sep="|">a|b]')).toEqual([{ type: 'permutation', rawInner: '<sep="|">a|b' }]);
  });

  test('mixed nesting: permutation inside enumeration', () => {
    expect(nodes('{a|[b|c]}')).toEqual([
      {
        type: 'enumeration',
        options: [[lit('a')], [{ type: 'permutation', rawInner: 'b|c' }]],
      },
    ]);
  });
});

describe('parseTemplate — conditionals', () => {
  test('then|else', () => {
    expect(nodes('{?flag?yes|no}')).toEqual([
      { type: 'conditional', name: 'flag', inverted: false, then: [lit('yes')], else: [lit('no')] },
    ]);
  });

  test('inverted, then-only (empty else)', () => {
    expect(nodes('{?!flag?yes}')).toEqual([
      { type: 'conditional', name: 'flag', inverted: true, then: [lit('yes')], else: [] },
    ]);
  });

  test('branch split ignores pipes nested in the then-branch', () => {
    expect(nodes('{?a?{x|y}|z}')).toEqual([
      {
        type: 'conditional',
        name: 'a',
        inverted: false,
        then: [{ type: 'enumeration', options: [[lit('x')], [lit('y')]] }],
        else: [lit('z')],
      },
    ]);
  });

  test('malformed conditional (name starts with digit) falls back to enumeration', () => {
    expect(nodes('{?1bad?x}')).toEqual([
      { type: 'enumeration', options: [[lit('?1bad?x')]] },
    ]);
  });
});

describe('parseTemplate — plurals', () => {
  test('count + forms (formsRaw kept verbatim for the lenient path)', () => {
    expect(nodes('{plural 2: one|two}')).toEqual([
      { type: 'plural', countRaw: '2', formsRaw: ' one|two', forms: [[lit('one')], [lit('two')]] },
    ]);
  });

  test('count may be a %var%', () => {
    expect(nodes('{plural %n%: a|b}')).toEqual([
      { type: 'plural', countRaw: '%n%', formsRaw: ' a|b', forms: [[lit('a')], [lit('b')]] },
    ]);
  });

  test('forms are trimmed', () => {
    expect(nodes('{plural 1: товар | товара | товаров}')).toEqual([
      {
        type: 'plural',
        countRaw: '1',
        formsRaw: ' товар | товара | товаров',
        forms: [[lit('товар')], [lit('товара')], [lit('товаров')]],
      },
    ]);
  });

  test('no colon ⇒ not a plural, treated as enumeration', () => {
    expect(nodes('{plural noun}')).toEqual([
      { type: 'enumeration', options: [[lit('plural noun')]] },
    ]);
  });
});

describe('parseTemplate — #set / #include (line-anchored)', () => {
  test('#set directive', () => {
    expect(nodes('#set %greeting% = Hello')).toEqual([
      { type: 'set', name: 'greeting', value: [lit('Hello')] },
    ]);
  });

  test('#set leaves the trailing newline as literal, then the reference', () => {
    expect(nodes('#set %g% = hi\n%g%')).toEqual([
      { type: 'set', name: 'g', value: [lit('hi')] },
      lit('\n'),
      v('g'),
    ]);
  });

  test('#include directive', () => {
    expect(nodes('#include "hero"')).toEqual([{ type: 'include', ref: 'hero' }]);
  });

  test('malformed #set (no =) is not a directive — stays literal + var', () => {
    expect(nodes('#set %v% hello')).toEqual([lit('#set '), v('v'), lit(' hello')]);
  });

  test('CRLF: directive line with a trailing \\r is still recognized', () => {
    expect(nodes('#set %g% = hi\r\n%g%')).toEqual([
      { type: 'set', name: 'g', value: [lit('hi')] },
      lit('\n'),
      v('g'),
    ]);
    expect(nodes('#include "hero"\r\nx')).toEqual([{ type: 'include', ref: 'hero' }, lit('\nx')]);
  });

  test('#set is NOT detected inside an enumeration option', () => {
    expect(nodes('{a|#set %x% = b}')).toEqual([
      { type: 'enumeration', options: [[lit('a')], [lit('#set '), v('x'), lit(' = b')]] },
    ]);
  });
});

describe('parseTemplate — lenient on malformed markup', () => {
  test('unmatched opener is literal', () => {
    expect(nodes('{a|b')).toEqual([lit('{a|b')]);
  });

  test('stray closer is literal', () => {
    expect(nodes('a}')).toEqual([lit('a}')]);
  });
});

describe('stripComments', () => {
  test('removes /# ... #/ across the run', () => {
    expect(stripComments('a/# note #/b')).toBe('ab');
    expect(stripComments('x/# multi\nline #/y')).toBe('xy');
  });
});

describe('splitTopLevel', () => {
  test('splits on top-level pipes only', () => {
    expect(splitTopLevel('a|b|c')).toEqual(['a', 'b', 'c']);
    expect(splitTopLevel('a|{b|c}|d')).toEqual(['a', '{b|c}', 'd']);
    expect(splitTopLevel('a|[b|c]')).toEqual(['a', '[b|c]']);
    expect(splitTopLevel('')).toEqual(['']);
  });

  test('unmatched closer suppresses the split (signed dual-depth, like PHP)', () => {
    // `]` drives bracket depth to -1, so the following `|` is not both-zero.
    expect(splitTopLevel('a]|b')).toEqual(['a]|b']);
    expect(splitTopLevel('a}|b')).toEqual(['a}|b']);
  });
});

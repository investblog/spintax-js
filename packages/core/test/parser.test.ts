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

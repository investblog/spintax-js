import { describe, test, expect } from 'vitest';
import { parseTemplate } from '../src/internal/parser';
import { renderNodes } from '../src/internal/render';
import { rngFromStrategy, type RngStrategy } from './corpus-harness';

/** White-box render with an injected RNG strategy (like the corpus harness). */
function render(src: string, rng: RngStrategy = 'first', context: Record<string, string> = {}): string {
  const ast = parseTemplate(src);
  const lowered: Record<string, string> = {};
  for (const [k, v] of Object.entries(context)) lowered[k.toLowerCase()] = v;
  return renderNodes(ast.nodes, { context: lowered, setDefs: ast.setDefs, rng: rngFromStrategy(rng) });
}

describe('render — literals & variables', () => {
  test('literal passthrough', () => {
    expect(render('hello world')).toBe('hello world');
  });
  test('variable lookup (case-insensitive)', () => {
    expect(render('Hi %name%!', 'first', { name: 'World' })).toBe('Hi World!');
    expect(render('Hi %NAME%!', 'first', { name: 'World' })).toBe('Hi World!');
  });
  test('unresolved variable stays verbatim', () => {
    expect(render('Hi %missing%')).toBe('Hi %missing%');
  });
});

describe('render — enumeration', () => {
  test('first / last / sequence pick', () => {
    expect(render('{a|b|c}', 'first')).toBe('a');
    expect(render('{a|b|c}', 'last')).toBe('c');
    expect(render('{a|b|c}', { sequence: [1] })).toBe('b');
  });
  test('empty option', () => {
    expect(render('{|a|b}', 'first')).toBe('');
  });
  test('single option (no RNG)', () => {
    expect(render('{a}')).toBe('a');
  });
  test('nested (innermost result flows out)', () => {
    expect(render('{a|{b|c}}', { sequence: [1, 1] })).toBe('c');
  });
});

describe('render — permutation', () => {
  test('default config picks all, Fisher-Yates order', () => {
    expect(render('[a|b]', 'first')).toBe('b a');
    expect(render('[a|b]', 'last')).toBe('a b');
    expect(render('[a|b|c]', 'first')).toBe('b c a');
    expect(render('[a|b|c]', 'last')).toBe('a b c');
  });
  test('single element (no RNG, no shuffle)', () => {
    expect(render('[a]')).toBe('a');
  });
  test('minsize=maxsize picks a fixed count', () => {
    expect(render('[<minsize=2;maxsize=2> a|b|c]', 'first')).toBe('b c');
  });
  test('custom sep + lastsep with alphabetic padding', () => {
    expect(render('[<sep=", ";lastsep=" and "> a|b|c]', 'last')).toBe('a, b and c');
    expect(render('[<sep="and"> a|b|c]', 'last')).toBe('a and b and c');
  });
  test('per-element separator', () => {
    expect(render('[a < or > | b]', 'last')).toBe('a or b');
  });
});

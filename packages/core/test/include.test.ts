import { describe, test, expect } from 'vitest';
import { render as publicRender, IncludeResolverError, type RenderOptions } from '../src/index';

/** A resolver from a slug→template map (null for unknown). */
const from =
  (map: Record<string, string>): ((ref: string) => string | null) =>
  (ref) =>
    map[ref] ?? null;

/** render with postProcess OFF so these tests isolate #include behavior (no cosmetic trim/cap). */
const render = (src: string, opts: RenderOptions = {}): string =>
  publicRender(src, { postProcess: false, ...opts });

describe('render — #include resolution', () => {
  test('resolves to the rendered child template', () => {
    expect(render('#include "hero"', { includeResolver: from({ hero: 'HELLO' }) })).toBe('HELLO');
  });

  test('the child template is itself rendered (its own spintax resolves)', () => {
    expect(render('#include "hero"', { includeResolver: from({ hero: '{a|a}' }) })).toBe('a');
  });

  test('unknown target ⇒ empty (lenient)', () => {
    expect(render('#include "missing"', { includeResolver: () => null })).toBe('');
  });

  test('no resolver ⇒ #include stays literal', () => {
    expect(render('#include "hero"')).toBe('#include "hero"');
  });
});

describe('render — #include scope isolation', () => {
  test("child does NOT inherit the parent's #set locals", () => {
    // Parent defines %x%; the child uses %x% but must not see it.
    expect(render('#set %x% = parent\n#include "c"', { includeResolver: from({ c: '%x%' }) })).toBe('\n%x%');
  });

  test('child DOES inherit the runtime context', () => {
    expect(render('#include "c"', { context: { y: 'Z' }, includeResolver: from({ c: '%y%' }) })).toBe('Z');
  });

  test('child has its own #set scope', () => {
    expect(render('#include "c"', { includeResolver: from({ c: '#set %z% = W\n%z%' }) })).toBe('\nW');
  });
});

describe('render — #include guards', () => {
  test('circular include resolves to empty (no infinite loop)', () => {
    expect(render('#include "a"', { includeResolver: from({ a: '#include "a"' }) })).toBe('');
  });

  test('mutual circular (a→b→a) is bounded', () => {
    // #include must be its own line; a→"A\n"+incl b, b→"B\n"+incl a, a(cycle)→'' ⇒ "A\nB\n"
    const map = { a: 'A\n#include "b"', b: 'B\n#include "a"' };
    expect(render('#include "a"', { includeResolver: from(map) })).toBe('A\nB\n');
  });

  test('runaway depth is capped by maxDepth', () => {
    let n = 0;
    // each include points to a fresh ref, so no cycle — only depth stops it.
    const resolver: RenderOptions['includeResolver'] = () => `#include "r${(n += 1)}"`;
    expect(render('#include "r0"', { includeResolver: resolver, maxDepth: 3 })).toBe('');
  });

  test('a resolver that throws surfaces as IncludeResolverError', () => {
    expect(() =>
      render('#include "x"', {
        includeResolver: () => {
          throw new Error('boom');
        },
      }),
    ).toThrow(IncludeResolverError);
  });
});

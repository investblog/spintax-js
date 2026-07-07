import { describe, test, expect } from 'vitest';
import * as api from '../src/index';
import { DEFAULT_MAX_DEPTH, NotImplementedError } from '../src/index';
import { rngFromStrategy } from './corpus-harness';

describe('package smoke', () => {
  test('exports the §9.2 public surface', () => {
    for (const name of ['parse', 'render', 'validate', 'extract', 'analyze', 'neutralize'] as const) {
      expect(typeof api[name]).toBe('function');
    }
    expect(DEFAULT_MAX_DEPTH).toBe(20);
  });

  test('neutralize still throws NotImplementedError (M2e)', () => {
    expect(() => api.neutralize('x')).toThrow(NotImplementedError);
  });

  test('implemented ops do not throw', () => {
    expect(() => api.parse('{a|b}')).not.toThrow();
    expect(() => api.validate('{a|b}')).not.toThrow();
    expect(api.render('hello')).toBe('hello');
    expect(api.render('Hi %name%', { context: { name: 'World' } })).toBe('Hi World');
    expect(api.render('{?f?a|b}', { context: { f: '1' } })).toBe('a');
    expect(api.render('{plural 2: item|items}', { locale: 'en' })).toBe('items');
  });
});

describe('rngFromStrategy (corpus RNG seam)', () => {
  test('first ⇒ min, last ⇒ max', () => {
    expect(rngFromStrategy('first')(0, 5)).toBe(0);
    expect(rngFromStrategy('last')(0, 5)).toBe(5);
  });

  test('sequence: raw returns clamped to [min,max], last reused after exhaustion', () => {
    const rng = rngFromStrategy({ sequence: [1, 9] });
    expect(rng(0, 2)).toBe(1); // 1 in range
    expect(rng(0, 2)).toBe(2); // 9 clamped to max 2
    expect(rng(0, 2)).toBe(2); // exhausted ⇒ reuse last (9 ⇒ clamp 2)
  });
});

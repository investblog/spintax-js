import { describe, test, expect } from 'vitest';
import { parseTemplate } from '../src/internal/parser';
import { buildVars, renderNodes } from '../src/internal/render';
import { rngFromStrategy, type RngStrategy } from './corpus-harness';

/** White-box render with an injected RNG strategy (like the corpus harness). */
function render(
  src: string,
  rng: RngStrategy = 'first',
  context: Record<string, string> = {},
  locale = '',
): string {
  const ast = parseTemplate(src);
  const rngFn = rngFromStrategy(rng);
  const vars = buildVars(ast.setDefs, context, rngFn);
  return renderNodes(ast.nodes, { vars, rng: rngFn, locale, depth: 0 });
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
  test('recursive expansion (a value that is itself a %ref%)', () => {
    expect(render('Hi %a%', 'first', { a: '%b%', b: 'World' })).toBe('Hi World');
  });
});

describe('render — enumeration', () => {
  test('first / last / sequence pick', () => {
    expect(render('{a|b|c}', 'first')).toBe('a');
    expect(render('{a|b|c}', 'last')).toBe('c');
    expect(render('{a|b|c}', { sequence: [1] })).toBe('b');
  });
  test('empty / single / nested', () => {
    expect(render('{|a|b}', 'first')).toBe('');
    expect(render('{a}')).toBe('a');
    expect(render('{a|{b|c}}', { sequence: [1, 1] })).toBe('c');
  });
});

describe('render — permutation', () => {
  test('default config, Fisher-Yates order', () => {
    expect(render('[a|b]', 'first')).toBe('b a');
    expect(render('[a|b|c]', 'first')).toBe('b c a');
    expect(render('[a|b|c]', 'last')).toBe('a b c');
  });
  test('single / minsize=maxsize / custom sep / per-element', () => {
    expect(render('[a]')).toBe('a');
    expect(render('[<minsize=2;maxsize=2> a|b|c]', 'first')).toBe('b c');
    expect(render('[<sep=", ";lastsep=" and "> a|b|c]', 'last')).toBe('a, b and c');
    expect(render('[a < or > | b]', 'last')).toBe('a or b');
  });
});

describe('render — conditionals', () => {
  test('truthiness (set / unset / whitespace / "0")', () => {
    expect(render('{?flag?yes|no}', 'first', { flag: '1' })).toBe('yes');
    expect(render('{?flag?yes|no}')).toBe('no');
    expect(render('{?flag?yes|no}', 'first', { flag: '   ' })).toBe('no');
    expect(render('{?flag?yes|no}', 'first', { flag: '0' })).toBe('yes'); // "0" is non-whitespace
  });
  test('inverted / then-only', () => {
    expect(render('{?!flag?yes|no}')).toBe('yes');
    expect(render('{?!flag?yes|no}', 'first', { flag: '1' })).toBe('no');
    expect(render('{?flag?yes}')).toBe('');
    expect(render('{?flag?yes}', 'first', { flag: 'x' })).toBe('yes');
  });
});

describe('render — plurals', () => {
  test('ru buckets (one/few/many + exceptions + negative)', () => {
    const t = '{plural %n%: товар|товара|товаров}';
    const ru = (n: string): string => render(t, 'first', { n }, 'ru');
    expect(ru('1')).toBe('товар');
    expect(ru('2')).toBe('товара');
    expect(ru('5')).toBe('товаров');
    expect(ru('11')).toBe('товаров');
    expect(ru('12')).toBe('товаров');
    expect(ru('0')).toBe('товаров');
    expect(ru('-1')).toBe('товар');
  });
  test('en 2-form', () => {
    expect(render('{plural 1: item|items}', 'first', {}, 'en')).toBe('item');
    expect(render('{plural 2: item|items}', 'first', {}, 'en')).toBe('items');
  });
  test('empty / non-numeric count erases the block', () => {
    expect(render('{plural : item|items}', 'first', {}, 'en')).toBe('');
    expect(render('{plural %missing%: item|items}', 'first', {}, 'en')).toBe('');
  });
  test('lenient fullwidth on nested brackets / arity mismatch', () => {
    expect(render('{plural 2: {a|b}|c}', 'first', {}, 'en')).toBe('｛plural 2: ｛a|b｝|c｝');
    expect(render('{plural 2: one|two}', 'first', {}, 'ru')).toBe('｛plural 2: one|two｝'); // 2 forms ≠ ru arity 3
  });
});

// The stage-order group the reviewer asked for: where parity snaps if a pass is off by one.
describe('render — staged-semantics parity', () => {
  test('Stage 4b: #set enum value collapses ONCE, then the plural sees a number', () => {
    // #set %n% = {1|4|9} → collapse (last ⇒ 9) → {plural 9: …} ru ⇒ many.
    expect(render('#set %n% = {1|4|9}\n{plural %n%: товар|товара|товаров}', 'last', {}, 'ru')).toBe('\nтоваров');
  });

  test('Stage 4b: a #set value carrying {?…} is NOT pre-collapsed — resolved later as a conditional', () => {
    expect(render('#set %bonus% = 1\n#set %cta% = {?bonus?Claim|Deposit}\n%cta%')).toBe('\n\nClaim');
  });

  test('conditional introduced by a variable value (post-expand pass)', () => {
    expect(render('%cta%', 'first', { cta: '{?bonus?Claim|Deposit}', bonus: '1' })).toBe('Claim');
    expect(render('%cta%', 'first', { cta: '{?bonus?Claim|Deposit}' })).toBe('Deposit'); // bonus unset ⇒ falsy
  });

  test('plural count comes from a variable (plural-after-var)', () => {
    expect(render('{plural %n%: item|items}', 'first', { n: '2' }, 'en')).toBe('items');
  });

  test('plural sees VARIABLE-expanded (not fully-resolved) count/forms', () => {
    // A var expanding to a construct is still literal at the plural boundary:
    // count {1|2} is non-numeric ⇒ erase (NOT re-resolved to a number).
    expect(render('{plural %n%: item|items}', 'first', { n: '{1|2}' }, 'en')).toBe('');
    // a form var carrying brackets trips the nested-bracket guard ⇒ fullwidth verbatim.
    expect(render('{plural 2: item|%v%}', 'first', { v: '{a|b}' }, 'en')).toBe('｛plural 2: item|｛a|b｝｝');
    // a form var carrying a pipe changes the arity ⇒ fullwidth verbatim.
    expect(render('{plural 2: item|%v%}', 'first', { v: 'a|b' }, 'en')).toBe('｛plural 2: item|a|b｝');
  });

  test('#set enum collapse-once is stable across repeated references', () => {
    // %v% used twice must be the SAME collapsed value (not two independent picks).
    expect(render('#set %v% = {a|b|c}\n%v%-%v%', { sequence: [1] })).toBe('\nb-b');
  });
});

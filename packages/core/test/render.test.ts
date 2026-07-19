import { describe, test, expect } from 'vitest';
import { parseTemplate } from '../src/internal/parser';
import { buildVars, renderNodes, rollDefinitions, type PluralIssue } from '../src/internal/render';
import { rngFromStrategy, type RngStrategy } from './corpus-harness';

/** White-box render with an injected RNG strategy (like the corpus harness). */
function render(
  src: string,
  rng: RngStrategy = 'first',
  context: Record<string, string> = {},
  locale = '',
  onPluralError?: (issue: PluralIssue) => void,
): string {
  const ast = parseTemplate(src);
  const rngFn = rngFromStrategy(rng);
  const base = buildVars(ast.setDefs, context);
  const walkOpts = { rng: rngFn, locale, depth: 0, onPluralError };
  const vars = { ...base, ...rollDefinitions(ast.defDefs, base, context, walkOpts) };
  return renderNodes(ast.nodes, { ...walkOpts, vars });
}

/** Render while collecting plural reports — the observer seam, not a render mode. */
function renderCollecting(
  src: string,
  locale = '',
  context: Record<string, string> = {},
): { output: string; issues: PluralIssue[] } {
  const issues: PluralIssue[] = [];
  const output = render(src, 'first', context, locale, (i) => issues.push(i));
  return { output, issues };
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
  test('a #def count is frozen before the plural runs, so the plural sees a number', () => {
    // #def %n% = {1|4|9} → rolled (last ⇒ 9) → {plural 9: …} ru ⇒ many.
    expect(render('#def %n% = {1|4|9}\n{plural %n%: товар|товара|товаров}', 'last', {}, 'ru')).toBe('\nтоваров');
  });

  test('a #set count is still spintax when the plural runs, so the block is erased', () => {
    // The accepted counterpart: a macro is substituted verbatim, the count slot is non-numeric at
    // the plural boundary, and the construct resolves to nothing. Pinned as a decision on record,
    // and the reason `plural.count-macro` exists.
    expect(render('#set %n% = {1|4|9}\n{plural %n%: товар|товара|товаров}', 'last', {}, 'ru')).toBe('\n');
  });

  test('a #set value carrying {?…} resolves later, as a conditional', () => {
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

  test('a #def is rolled once and holds across repeated references', () => {
    // One draw, reused. The sequence has a second value the roll never reaches.
    expect(render('#def %v% = {a|b|c}\n%v%-%v%', { sequence: [1, 2] })).toBe('\nb-b');
  });

  test('a #set re-rolls at every reference', () => {
    // Same sequence, two draws consumed. That difference in draw count IS the semantic difference,
    // which is why a first-option RNG cannot tell the two directives apart.
    expect(render('#set %v% = {a|b|c}\n%v%-%v%', { sequence: [1, 2] })).toBe('\nb-c');
  });

  test('a #def resolves against runtime context, not a bare map', () => {
    // The roll runs after the context is merged; rolling earlier would freeze the literal `%who%`.
    expect(render('#def %g% = Hello %who%\n%g% / %g%', 'first', { who: 'Bob' })).toBe('\nHello Bob / Hello Bob');
  });

  test('a runtime variable outranks a #def of the same name', () => {
    expect(render('#def %x% = {a|b}\n%x%', 'first', { x: 'RUNTIME' })).toBe('\nRUNTIME');
  });

  test('a #def dependency hidden behind a #set alias is still ordered', () => {
    // %b% never mentions %a%: it reaches it through the macro %s%, which is expanded at reference
    // time. Ordering on direct references alone froze %b% with %a% unexpanded and the plural block
    // vanished for want of a numeric count.
    expect(
      render('#def %b% = %s% {plural %s%: item|items}\n#set %s% = %a%\n#def %a% = {1|4}\n%b%', 'first', {}, 'en'),
      // Three stripped directive lines leave `\n\n` — the extractor collapses `\n{3,}`.
    ).toBe('\n\n1 item');
  });
});

describe('render — onPluralError observer', () => {
  test('silent by default: no observer, no behaviour change', () => {
    // The three failure paths still degrade exactly as before.
    expect(render('{plural 5: a|b|c}', 'first', {}, 'en')).toBe('｛plural 5: a|b|c｝');
    expect(render('{plural %n%: a|b}', 'first', {}, 'en')).toBe('');
    expect(render('{plural 5: {a|b}|c}', 'first', {}, 'en')).toBe('｛plural 5: ｛a|b｝|c｝');
  });

  test('observing does not change the output', () => {
    const plain = render('X {plural 5: a|b|c} Y', 'first', {}, 'en');
    expect(renderCollecting('X {plural 5: a|b|c} Y', 'en').output).toBe(plain);
  });

  test('arity mismatch reports expected/got against the locale', () => {
    const { issues } = renderCollecting('{plural 5: a|b}', 'ru');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'plural.arity',
      locale: 'ru',
      expected: 3,
      got: 2,
      construct: '{plural 5: a|b}',
    });
  });

  test('sr/hr/bs report against the 3-form arity', () => {
    for (const locale of ['sr', 'sr-Latn', 'hr', 'bs']) {
      const { issues } = renderCollecting('{plural 5: sat|sati}', locale);
      expect(issues[0]).toMatchObject({ code: 'plural.arity', expected: 3, got: 2 });
      // The report carries the BASE language, not the tag it was given.
      expect(issues[0]?.locale).toBe(locale === 'sr-Latn' ? 'sr' : locale);
    }
  });

  test('unresolved count is reported — the erase leaves no other trace', () => {
    // This is the whole point of the seam: output is '' either way, so a host
    // persisting the render cannot otherwise tell this from intentional silence.
    const { output, issues } = renderCollecting('{plural %n%: item|items}', 'en');
    expect(output).toBe('');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: 'plural.count', construct: '{plural %n%: item|items}' });
  });

  test('nested brackets in a form slot are reported', () => {
    const { issues } = renderCollecting('{plural 2: {a|b}|c}', 'en');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('plural.nested-brackets');
  });

  test('a healthy template reports nothing', () => {
    const { output, issues } = renderCollecting('{plural 2: sat|sata|sati}', 'sr');
    expect(output).toBe('sata');
    expect(issues).toEqual([]);
  });

  test('every failing block reports, not just the first', () => {
    const { issues } = renderCollecting('{plural 5: a|b} and {plural %n%: c|d} and {plural 1: e|f}', 'ru');
    expect(issues.map((i) => i.code)).toEqual(['plural.arity', 'plural.count', 'plural.arity']);
  });

  test('the construct is reported AFTER variable expansion', () => {
    // What the renderer judged, not what the author typed — otherwise a report
    // cannot be matched against the value that actually broke it.
    const { issues } = renderCollecting('{plural 2: item|%v%}', 'en', { v: 'a|b' });
    expect(issues[0]?.construct).toBe('{plural 2: item|a|b}');
  });
});

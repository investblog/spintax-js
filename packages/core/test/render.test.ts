import { describe, test, expect } from 'vitest';
import { parseTemplate } from '../src/internal/parser';
import { buildVars, renderNodes, rollDefinitions, type PluralIssue } from '../src/internal/render';
import { rngFromStrategy, type RngStrategy } from './corpus-harness';
// The public API, next to the white-box helper below: the count-slot cases are
// about what a caller gets, not about an injected RNG.
import { analyze, neutralize, render as publicRender, validate } from '../src/index';

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
  // A budget large enough to be invisible here; #69's bound is exercised through the
  // public API, where the real one is installed.
  const walkOpts = { rng: rngFn, locale, depth: 0, onPluralError, budget: { left: 1024 * 1024 } };
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

describe('plural count slot: conditionals (spintax-js#67)', () => {
  const COUNT_FROM_A_CONDITIONAL = '#set %flag% =\n#set %n% = {?flag?1|2}\nstart {plural %n%: one|two} end';

  test('a conditional in the count slot resolves before the numeric test', () => {
    // It used to survive into the test, fail it, and ERASE the block — while
    // validate() reported nothing at all. Both PHP engines always rendered it.
    expect(publicRender(COUNT_FROM_A_CONDITIONAL, { locale: 'en' })).toBe('Start two end');
    expect(validate(COUNT_FROM_A_CONDITIONAL, { locale: 'en' })).toEqual([]);
  });

  test('an enumeration in the count slot still erases the block', () => {
    // The negative half. Enumerations resolve AFTER plurals, so the branch is
    // substituted and never rendered; resolving it would invent a count.
    expect(publicRender('#set %n% = {1|2}\n{plural %n%: one|two}', { locale: 'en', postProcess: false })).toBe('\n');
  });

  test('deep nesting does not throw — render is lenient on content (§9.2)', () => {
    // Recursion into the taken branch raised RangeError at ~9000 levels, a 72 KB
    // template. The parsers were made iterative for this same reason.
    const depth = 12_000; // comfortably past the ~9000 where the recursive pass died
    const deep = `#set %V% = y\n{plural ${'{?V?'.repeat(depth)}1${'}'.repeat(depth)}: one|two}`;
    expect(publicRender(deep, { locale: 'en' })).toBe('One');
  });

  test('deep nesting renders and analyzes instead of throwing (#68)', () => {
    // Making the parser iterative moved this wall rather than removing it: `render`
    // and `analyze` walk the tree the parser produced, and both threw `RangeError` at
    // ~5000 levels while `parse` was already fine. All three are frame stacks now.
    // §9.2: the engine never throws on content, whatever the content is.
    const deep = '{'.repeat(3000) + 'x' + '}'.repeat(3000);
    expect(publicRender(deep, { locale: 'en', seed: 1 })).toBe('X');
    expect(analyze(deep).constructs.enumeration).toBe(3000);
  });
  test('an expansion bomb renders instead of ending the process (#69)', () => {
    // 62 characters. Each pass replaces one reference with two, so depth 50 is 2^50 —
    // an out-of-memory abort here, a memory fatal in the PHP engines, HTTP 503 on the
    // public Worker. Acyclic doubling does the same, so the cycle guard never sees it.
    // What is asserted is the contract: it terminates, it does not throw, the output is
    // bounded, and the references it could not afford stay literal. The exact text is
    // deliberately NOT pinned — the engines expand by different mechanisms and stop in
    // different places, which is why no corpus fixture covers it.
    const bomb = '#set %a% = %b% %b%\n#set %b% = %a% %a%\n%a%';
    const out = publicRender(bomb, { locale: 'en' });
    expect(out.length).toBeLessThan(4 * 1024 * 1024);
    expect(out).toContain('%b%');
  });

  test('the expansion budget covers the whole call, includes and all', () => {
    // The budget used to be created per rendered AST, and an include renders one — so
    // every `#include` handed the bomb a fresh megabyte. Fifty lines over one 62-byte
    // body made 57 MB out of 690 bytes: the bound held per subtree and bounded nothing.
    const bomb = '#set %a% = %b% %b%\n#set %b% = %a% %a%\n%a%';
    const many = Array.from({ length: 50 }, () => '#include "a"').join('\n');
    const one = publicRender('#include "a"', { locale: 'en', includeResolver: () => bomb });
    const fifty = publicRender(many, { locale: 'en', includeResolver: () => bomb });
    expect(fifty.length).toBeLessThanOrEqual(one.length + 1024);
  });

  test('an ordinary template is nowhere near the expansion budget', () => {
    // The bound must be invisible to real work: this is the shape a host actually sends.
    const ordinary = '#set %greeting% = {Hi|Hello}\n#def %n% = 2\n%greeting%, {plural %n%: guest|guests}!';
    expect(publicRender(ordinary, { locale: 'en', seed: 1 })).toMatch(/^(Hi|Hello), guests!$/);
  });

  test('an unbalanced count slot stays linear', () => {
    // Legal input: only the whole {plural …} block has to balance, and the slot is
    // cut at the first `:`. Matching braces per `{?` rescanned to the end every
    // time and made this quadratic — 78 KB cost 3 seconds. The ceiling is loose on
    // purpose; it is there to catch a return to quadratic, not to time the machine.
    const n = 100_000;
    const unbalanced = `{plural ${'{?a?'.repeat(n)}: one|two${'}'.repeat(n + 1)}`;
    const started = Date.now();
    expect(publicRender(unbalanced, { locale: 'en' })).toContain('｛plural');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

// #68 kept deep nesting super-linear because depth cost source. The 0.7.0 re-read took that away: macros
// spliced into a construct spell tens of thousands of levels from a few hundred bytes. Every per-level
// cost is gone now — the parser reads spans of one indexed text, the walk hands fragments up instead of
// copying each level's output, a marked construct asks the index before re-reading, and a variable's
// truthiness is tested once per map. Output identity is proven by a differential kept outside the repo;
// these pin that depth is not paid for again at every level. The bounds are loose on purpose.
describe('render — depth is not paid for again at every level, however it is reached', () => {
  const within = (fn: () => void): void => {
    const started = Date.now();
    fn();
    expect(Date.now() - started).toBeLessThan(3_000);
  };
  const doubling = (name: string, unit: string, levels: number): string => {
    let out = `#set %${name}0% = ${unit}\n`;
    for (let i = 1; i <= levels; i += 1) out += `#set %${name}${i}% = %${name}${i - 1}%%${name}${i - 1}%\n`;
    return out;
  };

  test('705 bytes of macros spliced into a construct: 32 768 levels, 31–40 s until this change', () => {
    const template = `${doubling('o', '{', 15)}${doubling('c', '}', 15)}{%o15%x%c15%|y}`;
    within(() => expect(['X', 'Y']).toContain(publicRender(template, { seed: 1 })));
  });

  test('a tree whose every level adds text is not copied once per level', () => {
    const n = 100_000;
    within(() => expect(publicRender('{a'.repeat(n) + 'x' + 'b}'.repeat(n), { postProcess: false })).toHaveLength(2 * n + 1));
    within(() => expect(publicRender('[a'.repeat(n) + 'x' + 'b]'.repeat(n), { postProcess: false })).toHaveLength(2 * n + 1));
    within(() => publicRender('[ a |'.repeat(n) + 'x' + ']'.repeat(n), { seed: 1, postProcess: false }));
  });

  test('levels marked for the re-read that it cannot change are not re-read', () => {
    // An undefined reference marks every level; the index says the splice would change nothing.
    within(() => publicRender('{a%u%'.repeat(50_000) + 'x' + '}'.repeat(50_000), { postProcess: false }));
  });

  test('a re-read is skipped only where the expansion would skip it — a budget made NaN still expands', () => {
    // `%__proto__%` resolves through Object.prototype and charges an undefined length, so the budget is
    // NaN; `left <= 0` is false and the expansion runs, so the check must not read the budget as spent
    // (Codex gate). The prototype lookup is a defect of its own; this pins only that the splice happens.
    const out = publicRender('%__proto__%{%x%}', { context: { x: 'a|b' }, seed: 1, postProcess: false });
    expect(out).not.toContain('|');
    expect(['a', 'b']).toContain(out.slice(-1));
  });

  test('a nest spelled by a #def roll, and conditionals over a megabyte-long whitespace value', () => {
    const def = `${doubling('o', '{', 15)}${doubling('c', '}', 15)}#def %d% = %o15%x%c15%\n%d%`;
    within(() => expect(publicRender(def, { postProcess: false })).toContain('x'));
    // 2^17 form feeds, all whitespace to PHP's \s: every nested conditional used to scan them again.
    const blank = `${doubling('w', '\f', 17)}#def %s% = %w17%\n${'{?s?a|'.repeat(20_000)}x${'}'.repeat(20_000)}`;
    within(() => publicRender(blank, { postProcess: false }));
  });
});

describe('render — a direct %var% is spliced as TEXT before the construct is split (0.7.0)', () => {
  const list = '3 Oaks|Amigo|Amusnet|Apollo|Apparat|Barbara Bang|Belatra|BTG';

  test('the reported shape: a pipe-joined runtime list inside a permutation is N elements, not one', () => {
    // first: pick = random_int(3,3) short-circuits; j = 0 at every step rotates left by one; take 3.
    expect(render('[<minsize=3;maxsize=3;sep=", ">%L%]', 'first', { L: 'a|b|c|d' })).toBe('b, c, d');
    expect(render('[<minsize=3;maxsize=3;sep=", ">%L%]', 'last', { L: 'a|b|c|d' })).toBe('a, b, c');
  });

  test('the production preset: a size range, sep and lastsep, over eight names, seeded', () => {
    const template = '[<minsize=5;maxsize=7;sep=", ";lastsep=" and ">%L%]';
    const out = publicRender(template, { context: { L: list }, seed: 7, postProcess: false });
    const names = out.split(/, | and /u);
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(names.length).toBeLessThanOrEqual(7);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(list.split('|')).toContain(name);
    expect(out).toMatch(/ and [^,]+$/u);
    expect(publicRender(template, { context: { L: list }, seed: 7, postProcess: false })).toBe(out);
  });

  test('a #set macro wrapping the permutation splices the list at its reference', () => {
    expect(render('#set %TP% = [<minsize=2;maxsize=2;sep=", ">%L%]\n%TP%', 'first', { L: 'a|b|c' })).toBe('\nb, c');
  });

  test('enumerations too, and literals around the variable stay their own elements', () => {
    expect(render('{%L%}', 'last', { L: 'x|y|z' })).toBe('z');
    expect(render('{a|%L%}', { sequence: [1] }, { L: 'x|y' })).toBe('x');
    expect(render('[a|%L%|b]', 'last', { L: 'x|y' })).toBe('a x y b');
  });

  test('a reference inside a conditional branch is direct too — plugin Stage 6a runs before expansion', () => {
    expect(render('#set %flag% = 1\n[{?flag?%L%|none}|c]', 'last', { L: 'x|y' })).toBe('\nx y c');
    expect(render('[{?flag?%L%|none}|c]', 'last', { L: 'x|y' })).toBe('none c');
  });

  test('the config and a per-element separator are text to the plugin, so a reference there is spliced', () => {
    expect(render('[<sep="%S%">a|b]', 'last', { S: ', ' })).toBe('a, b');
    expect(render('[a <%S%> | b]', 'last', { S: ', ' })).toBe('a, b');
  });

  test('what does NOT split: a top-level reference, an undefined name, a nested construct’s own list', () => {
    expect(render('%L%', 'first', { L: 'x|y' })).toBe('x|y');
    expect(render('[%nope%|b]', 'last')).toBe('%nope% b');
    expect(render('[a|{%L%}]', 'last', { L: 'x|y' })).toBe('a y');
  });

  test('a value without structural characters renders exactly as it did before the splice existed', () => {
    // Same element count, same draws, same order: the re-read tree IS the parsed tree.
    expect(render('[%a%|%b%|c]', 'first', { a: 'x', b: 'y' })).toBe('y c x');
    expect(render('{%a%|%b%}', { sequence: [1] }, { a: 'x', b: 'y' })).toBe('y');
  });

  test('the hop budget is 51 inside a bracket exactly as outside one', () => {
    // The corpus knot pin (render/circular-set-accumulates-then-stops), moved inside braces.
    expect(render('#set %b% = x%b%y\n{%b%}')).toBe(`\n${'x'.repeat(51)}%b%${'y'.repeat(51)}`);
    expect(render('#set %a% = %b%\n#set %b% = %a%\n{%a%}')).toBe('\n\n%b%');
    // Reached through a macro re-parse, the construct has already spent one hop: the fixpoint
    // gets 50 passes — the 51st hop overall — and what is left is frozen. A flat 51 would
    // leave %a52% here.
    const chain = Array.from({ length: 59 }, (_, i) => `#set %a${i + 1}% = %a${i + 2}%`).join('\n');
    expect(render(`#set %v% = {%a1%|x}\n${chain}\n#set %a60% = END\n%v%`)).toBe('\n\n%a51%');
  });

  test('a bomb inside a construct dies at the budget and never throws (#69)', () => {
    const out = publicRender('#set %a% = %b% %b%\n#set %b% = %a% %a%\n{%a%}', { postProcess: false });
    expect(out.length).toBeLessThan(4 * 1024 * 1024);
    expect(out).toContain('%');
  });

  test('deep nesting with references renders instead of throwing (#68)', () => {
    const deep = '{%x%|'.repeat(5000) + 'z' + '}'.repeat(5000);
    expect(() => publicRender(deep, { context: { x: 'a' }, seed: 1 })).not.toThrow();
  });

  test('neutralize() shields the brackets of a value but not its pipe — inside an author’s construct it still splits', () => {
    const out = publicRender('[<sep=", ">%v%]', { context: { v: neutralize('[a|b]') }, seed: 1, postProcess: false });
    expect(out).toMatch(/^(\[a, b\]|b\], \[a)$/u);
  });
});

describe('render — the re-read covers a whole <config> and every conditional in a construct (#80)', () => {
  test('a size, or an unquoted separator, taken from a variable', () => {
    expect(render('[<minsize=%n%;maxsize=%n%>a|b|c]', 'first', { n: '1' })).toBe('b');
    expect(render('[<sep=%S%>a|b]', 'first', { S: '", "' })).toBe('b, a');
  });

  test('a taken branch that carries a pipe is split with its construct, in [] and in {}', () => {
    expect(render('[{?f?a|b|x}|c]', 'first')).toBe('x c b');
    expect(render('{c|{?f?a|b|x}}', 'last')).toBe('x');
  });

  test('a list item gated by an unset flag leaves no separator behind', () => {
    // The shape of a real template: 'Есть покер, слоты и.' was a possible render until #80.
    const src = 'Есть [<sep=", ";lastsep=" и ">{?HasLive?лайв-казино}|слоты|покер].';
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed += 1) seen.add(publicRender(src, { seed }));
    expect([...seen].sort()).toEqual(['Есть покер и слоты.', 'Есть слоты и покер.']);
  });

  test('an element that renders empty is no element — an optional item written {x|}, as much as a branch', () => {
    // Found by the differential against both PHP engines, after the conditional half was fixed: the
    // plugin splits text in which every nested enumeration is already resolved.
    expect(render('[<sep=", ">slots|{live casino|}|poker]', 'last')).toBe('slots, poker');
    expect(render('[<minsize=3;maxsize=3>a|{b|}|c]', 'last')).toBe('a c');
    expect(render('[{ a |b}|c]', 'first')).toBe('c a');
  });

  test('a few hundred bytes of macros cannot buy a quadratic post-process', () => {
    // 336 bytes doubling one letter took 25 s to post-process; the dotted and tag-shaped units longer.
    for (const unit of ['a', 'a.', '.<', '<p>']) {
      let template = `#set %l0% = ${unit.repeat(8)}\n`;
      for (let i = 1; i <= 16; i += 1) template += `#set %l${i}% = %l${i - 1}%%l${i - 1}%\n`;
      const started = Date.now();
      publicRender(`${template}x %l16%1`, { seed: 1 });
      expect(Date.now() - started).toBeLessThan(3_000);
    }
  });

  test('a few hundred bytes of macros cannot buy a quadratic parse of the construct they are spliced into', () => {
    // The re-read hands the parser the megabyte a doubling macro spells. An unclosed opener per unit
    // sent the parser to the end of the text from each — 5 to 28 s from under 350 bytes — a quoted `>`
    // in a tag-shaped config was quadratic in the config, and a long name there made render() throw.
    const doubled = (unit: string, body: string, levels: number): string => {
      let template = `#set %l0% = ${unit}\n`;
      for (let i = 1; i <= levels; i += 1) template += `#set %l${i}% = %l${i - 1}%%l${i - 1}%\n`;
      return template + body.replace('X', `%l${levels}%`);
    };
    const shapes: [string, string, number][] = [
      ['[<', '{aXb|c}', 16],
      ['{plural 1:', '{aXb|c}', 16],
      ['{?a?', '{aXb|c}', 16],
      ['[<sep="', '{aXb|c}', 16],
      // A form feed, not a space: a directive value loses its edge spaces, and the tag pattern's
      // whitespace class takes \f as well.
      ['\f', '[<a X">"b>x|y]', 18],
      ['a', '[<X>x|y]', 16],
    ];
    for (const [unit, body, levels] of shapes) {
      const started = Date.now();
      expect(() => publicRender(doubled(unit, body, levels), { seed: 1 })).not.toThrow();
      expect(Date.now() - started).toBeLessThan(3_000);
    }
  });

  test('a padded element is trimmed in linear time — whitespace from a value is not seconds (review)', () => {
    // Trimming every assembled element with an end-anchored regex went quadratic on a long run inside
    // the text: 51 000 spaces took 3 s, and the expansion budget allows a megabyte.
    const started = Date.now();
    publicRender('[a%v%y|z]', { context: { v: ' '.repeat(400_000) }, seed: 1 });
    publicRender('[a{%v%}y|z]', { context: { v: ' '.repeat(400_000) }, seed: 1 });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test('a conditional in a separator or in the config is text before the split, like one in an element', () => {
    expect(render('[x|a<{?g?, |; }>|b]', 'last')).toBe('x a; b');
    expect(render('[<lastsep="{?en? and | и }">a|b|c]', 'last')).toBe('a b и c');
  });

  test('a conditional that changes nothing structural draws exactly as the tree did in 0.7.0', () => {
    // Re-read now, a tree walk then: the nested draws and the shuffle must land in the same places,
    // or content a host has already published re-rolls on upgrade.
    expect(render('[{?f?x {p|q}|y}|{r|s}|t]', { sequence: [1, 0, 2, 1] }, { f: '1' })).toBe('x q r t');
  });
});

describe('render — the splice under review (0.7.0, findings from the Codex gate)', () => {
  test('the 51st hop reaches the body as TEXT: a chain into a list is split, not spliced whole', () => {
    // 50 aliases and a terminal list: the plugin's 51 passes end with `{x|y}`, an enumeration.
    // The first cut rendered that last hop at the depth cap as finished text and gave `x|y`.
    const chain = Array.from({ length: 50 }, (_, i) => `#set %a${i + 1}% = %a${i + 2}%`).join('\n');
    expect(render(`${chain}\n#set %a51% = x|y\n{%a1%}`, 'last')).toBe('\n\ny');
    // One deeper, the reference is what is left — frozen, not spliced a 52nd time.
    const longer = Array.from({ length: 51 }, (_, i) => `#set %a${i + 1}% = %a${i + 2}%`).join('\n');
    expect(render(`${longer}\n#set %a52% = x|y\n{%a1%}`, 'last')).toBe('\n\n%a52%');
  });

  test('a reference the budget cut off stays literal in the re-read subtree — no free splice', () => {
    // 2^12 references to a 1 KiB plain value, reached through a doubling chain: the fixpoint
    // charges the first ~1 MiB and leaves the rest literal; the first cut then handed those
    // leftovers to resolveVariable, whose plain-value shortcut spliced them for nothing — 4 MiB
    // out of a 1 MiB allowance, and the same door with 2^20 references is an OOM.
    const chain = Array.from({ length: 12 }, (_, i) => `#set %d${i}% = ${i === 0 ? '%x% %x%' : `%d${i - 1}% %d${i - 1}%`}`).join('\n');
    const out = publicRender(`${chain}\n{%d11%}`, { context: { x: 'a'.repeat(1024) }, postProcess: false });
    expect(out.length).toBeLessThan(1024 * 1024 + 64 * 1024);
    expect(out).toContain('%x%');
  });

  test('every substitution is charged, so a plain value is not a free leaf at top level either', () => {
    // The same 2^12 references outside any construct: the old shortcut never charged a plain
    // value, so nothing bounded this; PHP charges every substitution.
    const chain = Array.from({ length: 12 }, (_, i) => `#set %d${i}% = ${i === 0 ? '%x% %x%' : `%d${i - 1}% %d${i - 1}%`}`).join('\n');
    const out = publicRender(`${chain}\n%d11%`, { context: { x: 'a'.repeat(1024) }, postProcess: false });
    expect(out.length).toBeLessThan(1024 * 1024 + 64 * 1024);
  });
});

describe('render — plural slots share the 51-hop arithmetic and the freeze (0.7.0, review)', () => {
  test('a 51-deep alias chain in the count slot reaches its number, as it does in the plugin', () => {
    // The slots used to run a flat 50 passes: the count stopped at %a51%, non-numeric, erased.
    const chain = Array.from({ length: 50 }, (_, i) => `#set %a${i + 1}% = %a${i + 2}%`).join('\n');
    expect(render(`${chain}\n#set %a51% = 1\n{plural %a1%: one|many}`, 'first', {}, 'en')).toBe('\n\none');
  });

  test('a picked form whose passes ran out stays frozen instead of expanding again', () => {
    // 52 deep: the plugin's 51 passes leave %a52% literal in the form; the old path picked the
    // form and rendered it unfrozen, so it went on to END.
    const chain = Array.from({ length: 51 }, (_, i) => `#set %a${i + 1}% = %a${i + 2}%`).join('\n');
    expect(render(`${chain}\n#set %a52% = END\n{plural 1: %a1%|two}`, 'first', {}, 'en')).toBe('\n\n%a52%');
  });
});

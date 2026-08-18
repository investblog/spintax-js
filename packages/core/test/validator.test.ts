import { describe, test, expect } from 'vitest';
import { parse, render, validate } from '../src/index';

const codes = (src: string, opts?: Parameters<typeof validate>[1]): string[] =>
  validate(src, opts).map((d) => d.code);
const isValid = (src: string, opts?: Parameters<typeof validate>[1]): boolean =>
  !validate(src, opts).some((d) => d.severity === 'error');

describe('validator — regression guards (beyond the corpus)', () => {
  test('plural nested inside a permutation is still checked (raw scan, not AST walk)', () => {
    // A 3-form plural is an arity error for en (2-form), even inside [ … ].
    expect(codes('[{plural 1: a|b|c}]', { locale: 'en' })).toContain('plural.arity');
    expect(isValid('[{plural 1: a|b|c}]', { locale: 'en' })).toBe(false);
  });

  test('#include nested inside a permutation is still target-checked', () => {
    const src = '[a|\n#include "nope"\n|b]';
    expect(codes(src, { knownIncludes: ['ok'] })).toContain('include.unknown-target');
  });

  test('arity guard keys off the NORMALIZED base — "_en" normalizes to "" ⇒ arity skipped', () => {
    expect(isValid('{plural 1: a|b|c}', { locale: '_en' })).toBe(true);
    // sanity: real "en" does flag the 3-form arity mismatch
    expect(isValid('{plural 1: a|b|c}', { locale: 'en' })).toBe(false);
  });

  test('comma inside a quoted sep is not a false unknown-key', () => {
    expect(isValid('[<sep=", ">a|b]')).toBe(true);
  });

  test('minsize=0 does NOT flag (ctype_digit parity), minsize=x does', () => {
    expect(codes('[<minsize=0>a|b]')).not.toContain('permutation.minsize-not-integer');
    expect(codes('[<minsize=x>a|b]')).toContain('permutation.minsize-not-integer');
  });

  test('undefined %var% is a warning, not an error (stays valid)', () => {
    const d = validate('Hello %runtime%!');
    expect(d.some((x) => x.code === 'variable.undefined' && x.severity === 'warning')).toBe(true);
    expect(d.some((x) => x.severity === 'error')).toBe(false);
  });

  test('knownVariables suppresses the undefined-var warning (verdict unaffected)', () => {
    expect(validate('%brand%').some((d) => d.code === 'variable.undefined')).toBe(true);
    const d = validate('%Brand%', { knownVariables: ['brand'] }); // case-insensitive
    expect(d.some((x) => x.code === 'variable.undefined')).toBe(false);
    expect(d.some((x) => x.severity === 'error')).toBe(false);
  });

  test('validate accepts a parsed Ast (string|Ast)', () => {
    const ast = parse('{a|b');
    expect(validate(ast).some((d) => d.code === 'bracket.unclosed')).toBe(true);
  });
});

/**
 * Issue #65, reported from a pipeline that shipped `｛plural …｝` to live pages.
 *
 * With no locale the engine files no arity VERDICT — deliberately, because the template
 * may be correct for the locale it will actually be rendered with, and failing a good
 * template for a fact the caller never claimed is worse than silence. But `render` has no
 * such luxury: it defaults to 2 forms, so a 3-form block with no locale lands in finished
 * text as the fullwidth-brace fallback. The warning is the seam between those two truths.
 */
describe('validator — plural.locale-missing (#65)', () => {
  const warnings = (src: string, opts?: Parameters<typeof validate>[1]): string[] =>
    validate(src, opts).filter((d) => d.severity === 'warning').map((d) => d.code);

  test('a non-2-form block with no locale warns, and the template stays VALID', () => {
    expect(warnings('{plural 3: одна|две|много}')).toEqual(['plural.locale-missing']);
    expect(isValid('{plural 3: одна|две|много}')).toBe(true);
  });

  test('a 2-form block with no locale is silent — the default resolves it', () => {
    expect(validate('{plural 3: one|many}')).toEqual([]);
  });

  test('supplying ANY locale replaces the warning with the real verdict', () => {
    // ru: 3 forms are right, so nothing at all.
    expect(validate('{plural 3: одна|две|много}', { locale: 'ru' })).toEqual([]);
    // en: 3 forms are wrong, and that is an error, not this warning.
    expect(codes('{plural 3: одна|две|много}', { locale: 'en' })).toEqual(['plural.arity']);
  });

  test('the warning agrees with what render will actually do', () => {
    const src = '{plural 3: a|b|c}';
    const d = validate(src).find((x) => x.code === 'plural.locale-missing');
    expect(d?.data).toEqual({ got: 3, defaultArity: 2 });
    // The claim in the message, checked against the engine rather than asserted:
    // the block really does fail to resolve at the default.
    expect(render(src, { seed: 1 })).toContain('｛');
    expect(render(src, { locale: 'ru', seed: 1 })).not.toContain('｛');
  });

  test('a structurally broken block reports only that — no second, invented problem', () => {
    // The nested-brackets branch `continue`s, and the new check inherits that guard.
    expect(codes('{plural 3: {a|b}|c|d}')).toEqual(['plural.nested-brackets']);
  });

  test('an unnormalizable locale behaves like no locale at all, warning included', () => {
    expect(warnings('{plural 1: a|b|c}', { locale: '_en' })).toEqual(['plural.locale-missing']);
  });

  test('every block is judged on its own', () => {
    const src = '{plural 1: a|b} and {plural 2: x|y|z}';
    expect(warnings(src)).toEqual(['plural.locale-missing']);
  });
});

/**
 * Issue #66, found adopting #65 in the Pascal port: `render` expands `%variables%` and
 * then counts forms, while this validator counted the raw source — so a reference inside
 * a form list was judged on the wrong number, in both directions.
 *
 * The property these tests hold to is the one that matters and the one that was missing:
 * **the verdict agrees with what render actually does.** Each case asserts both.
 */
describe('validator — plural forms are counted as the RENDERER sees them (#66)', () => {
  const codesOf = (src: string, opts?: Parameters<typeof validate>[1]): string[] =>
    validate(src, opts).map((d) => d.code);
  /** Did the block fail to resolve? The engine says so with fullwidth braces. */
  const rendersBroken = (src: string, opts?: Parameters<typeof render>[1]): boolean =>
    render(src, { seed: 1, ...opts }).includes('｛');

  test('a #def holding extra forms no longer makes a correct template invalid', () => {
    const src = '#def %tail% = few|many\n{plural 2: one|%tail%}';
    // Three forms after expansion: right for ru, and ru renders it.
    expect(codesOf(src, { locale: 'ru' })).toEqual([]);
    expect(rendersBroken(src, { locale: 'ru' })).toBe(false);
    // With no locale it cannot resolve at the 2-form default — and now says so.
    expect(codesOf(src)).toEqual(['plural.locale-missing']);
    expect(rendersBroken(src)).toBe(true);
  });

  test('a #def holding the WHOLE list stops producing a phantom count', () => {
    const src = '#def %forms% = one|many\n{plural 2: %forms%}';
    // One raw pipe, two real forms. Was: error for en, warning for none.
    expect(codesOf(src, { locale: 'en' })).toEqual([]);
    expect(codesOf(src)).toEqual([]);
    expect(rendersBroken(src, { locale: 'en' })).toBe(false);
    expect(rendersBroken(src)).toBe(false);
  });

  test('a #def whose value carries a construct is NOT counted — the roll is not invariant', () => {
    // The first version of this fix counted pipes at bracket depth 0, on the theory that
    // a construct always collapses to one form. Review found two shapes where it does
    // not, and both are now the reason this stays silent instead of guessing.
    const synonym = ['#def %x% = {a|b}', '{plural 1: one|%x%}'].join('\n');
    expect(codesOf(synonym, { locale: 'en' })).toEqual([]);
    expect(codesOf(synonym, { locale: 'ru' })).toEqual([]);

    // A conditional's branches can differ in top-level pipes: `b|c` on the false branch.
    const conditional = ['#set %flag% =', '#def %x% = {?flag?a|b|c}', '{plural 1: one|%x%}'].join(
      '\n',
    );
    expect(codesOf(conditional, { locale: 'ru' })).toEqual([]);
    expect(rendersBroken(conditional, { locale: 'ru' })).toBe(false);
  });

  test('a #def that rolls a #set is not reported as nested brackets', () => {
    // The #def roll consumes the macro's `{a|b}` before the plural is decided, so the
    // block renders normally. Following the reference into the raw macro reported it.
    const src = ['#set %s% = {a|b}', '#def %x% = %s%', '{plural 1: one|%x%}'].join('\n');
    expect(codesOf(src, { locale: 'en' })).toEqual([]);
    expect(rendersBroken(src, { locale: 'en' })).toBe(false);
  });

  test('every reference is expanded per pass, as the renderer does', () => {
    // Replacing one occurrence per iteration spent the whole budget on a list that
    // merely repeats a name, and the completed expansion was then called unresolvable.
    const src = ['#set %x% = a|b', `{plural 1: ${'%x%'.repeat(51)}}`].join('\n');
    expect(codesOf(src, { locale: 'en' })).toEqual(['plural.arity']);
    expect(rendersBroken(src, { locale: 'en' })).toBe(true);
  });

  test('a name the host will supply outranks a local definition, so nothing is counted', () => {
    // Runtime context wins over a same-named definition at render time, so the local
    // value is not what will be counted.
    const src = ['#def %forms% = one|many', '{plural 2: %forms%}'].join('\n');
    expect(codesOf(src, { locale: 'en', knownVariables: ['forms'] })).toEqual([]);
    expect(render(src, { locale: 'en', context: { forms: 'one|few|many' }, seed: 1 })).toContain('｛');
  });

  test('a #set carrying spintax is reported, not silently rendered broken', () => {
    const src = '#set %x% = {a|b}\n{plural 2: one|%x%}';
    // A #set is substituted verbatim and is still spintax when the plural is decided —
    // which is exactly what the nested-brackets message has always said.
    expect(codesOf(src)).toEqual(['plural.nested-brackets']);
    expect(codesOf(src, { locale: 'en' })).toEqual(['plural.nested-brackets']);
    expect(rendersBroken(src)).toBe(true);
  });

  test('a #set of plain text counts its pipes, like the substitution does', () => {
    const src = '#set %x% = a|b\n{plural 1: one|%x%}';
    expect(codesOf(src, { locale: 'ru' })).toEqual([]);
    expect(rendersBroken(src, { locale: 'ru' })).toBe(false);
  });

  test('a reference the template does not define suppresses the count verdicts', () => {
    // A host variable has no static form count, and #65 settled the principle: no
    // verdict on a fact the caller never claimed.
    const src = '{plural 2: one|%host%}';
    expect(codesOf(src, { locale: 'en' })).toEqual(['variable.undefined']);
    expect(codesOf(src, { knownVariables: ['host'], locale: 'ru' })).toEqual([]);
  });

  test('a cyclic reference stops at the budget instead of hanging', () => {
    const src = '#set %a% = %b%\n#set %b% = %a%\n{plural 2: one|%a%}';
    const codes = codesOf(src, { locale: 'ru' });
    expect(codes).not.toContain('plural.arity');
    expect(codes).toContain('variable.circular-reference');
  });

  test('the ordinary case is untouched — no directives, no references', () => {
    expect(codesOf('{plural 2: one|many}', { locale: 'en' })).toEqual([]);
    expect(codesOf('{plural 2: one|many}', { locale: 'ru' })).toEqual(['plural.arity']);
    expect(codesOf('{plural 2: {a|b}|many}')).toEqual(['plural.nested-brackets']);
  });
});

describe('validator — diagnostic positions (line/column/end + data)', () => {
  const only = (src: string, code: string, opts?: Parameters<typeof validate>[1]) =>
    validate(src, opts).find((d) => d.code === code)!;

  test('undefined %var% spans the whole %name% token and carries data.name', () => {
    const d = only('Hello %missing% here', 'variable.undefined');
    expect(d).toMatchObject({ line: 1, column: 7, endLine: 1, endColumn: 16, data: { name: 'missing' } });
    // column 7..15 is exactly "%missing%"
    expect('Hello %missing% here'.slice(d.column - 1, (d.endColumn ?? 0) - 1)).toBe('%missing%');
  });

  test('undefined ref reports its FIRST occurrence, once per unique name', () => {
    const diags = validate('%x% then %x% again').filter((d) => d.code === 'variable.undefined');
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ column: 1, data: { name: 'x' } });
  });

  test('bracket.unclosed points at the offending bracket (real line + column)', () => {
    const d = only('ok\nPick {a|b', 'bracket.unclosed');
    expect(d).toMatchObject({ line: 2, column: 6, endLine: 2, endColumn: 7, data: { bracket: '{' } });
  });

  test('plural.arity spans the block and carries expected/got', () => {
    const d = only('x {plural %n%: a|b|c} y', 'plural.arity', { locale: 'en' });
    expect(d).toMatchObject({ line: 1, column: 3, endColumn: 22, data: { expected: 2, got: 3 } });
    expect('x {plural %n%: a|b|c} y'.slice(d.column - 1, (d.endColumn ?? 0) - 1)).toBe('{plural %n%: a|b|c}');
  });

  test('permutation.minsize-not-integer points at the config token with data.value', () => {
    const d = only('[<minsize=x>a|b]', 'permutation.minsize-not-integer');
    expect(d).toMatchObject({ line: 1, column: 3, data: { value: 'x' } });
  });

  test('positions are 1-based on later lines too (multi-line offset mapping)', () => {
    const d = only('line one\nline two %gone%', 'variable.undefined');
    expect(d).toMatchObject({ line: 2, column: 10, data: { name: 'gone' } });
  });
});

describe('validator — the circular-reference walk (emission shape + the prune must stay silent)', () => {
  const circular = (src: string) => validate(src).filter((d) => d.code === 'variable.circular-reference');

  test('a 3-cycle reports once per root, message carrying the path from that root', () => {
    const diags = circular('#set %c0% = %c1%\n#set %c1% = %c2%\n#set %c2% = %c0%');
    expect(diags.map((d) => d.message)).toEqual([
      'Circular variable reference: c0 → c1 → c2 → c0.',
      'Circular variable reference: c1 → c2 → c0 → c1.',
      'Circular variable reference: c2 → c0 → c1 → c2.',
    ]);
  });

  test('a duplicated edge is walked per occurrence — %b% %b% in a 2-cycle reports three times', () => {
    // The reference semantics spintax-win aligned to on 2026-08-07: references are not
    // deduplicated, and a report abandons only the frame that made it.
    const diags = circular('#set %a% = %b% %b%\n#set %b% = %a%');
    expect(diags.map((d) => d.message)).toEqual([
      'Circular variable reference: a → b → a.',
      'Circular variable reference: a → b → a.',
      'Circular variable reference: b → a → b.',
    ]);
  });

  test('a converging diamond feeding a cycle keeps the per-path emission count', () => {
    // depth 2 → 2^2 + 2^1 reports from the a-roots, one each from a2, p, q.
    const src = '#set %a2% = %p%\n#set %a1% = %a2% %a2%\n#set %a0% = %a1% %a1%\n#set %p% = %q%\n#set %q% = %p%';
    expect(circular(src)).toHaveLength(9);
  });

  test('an acyclic chain is silent and fast — the prune must not invent or lose a report', () => {
    // Pre-rewrite this shape was O(n³)-ish: 2000 definitions took tens of seconds and
    // would trip the suite timeout; the walk now skips subtrees that reach no cycle.
    const lines = ['#set %v0% = x'];
    for (let i = 1; i < 2000; i += 1) lines.push(`#set %v${i}% = %v${i - 1}%`);
    expect(validate(lines.join('\n'))).toEqual([]);
  });

  test('a converging diamond with a literal leaf is silent — pre-rewrite it never returned', () => {
    const n = 30; // 2^30 paths if actually walked
    const lines = [`#set %a${n}% = leaf`];
    for (let i = n - 1; i >= 0; i -= 1) lines.push(`#set %a${i}% = %a${i + 1}% %a${i + 1}%`);
    expect(validate(lines.join('\n'))).toEqual([]);
  });

  test('duplicate-name messages still name the FIRST line (the resuming line counter)', () => {
    const diags = validate('one\n#set %d% = a\ntwo\n#set %d% = b\n#set %d% = c')
      .filter((d) => d.code === 'definition.duplicate-name');
    expect(diags).toHaveLength(2);
    for (const d of diags) expect(d.message).toContain('first on line 2');
    expect(diags.map((d) => d.line)).toEqual([4, 5]);
  });

  // The expansion budget bounds GROWTH, not size. Both halves are cheap to get wrong and
  // neither is in the shared corpus: a 65 KB fixture would be carried by five engines.
  describe('the form-expansion budget', () => {
    test('a long PLAIN form list is still counted', () => {
      // A ceiling on total length made this "unknowable" and flipped invalid → valid.
      // Nothing in the grammar limits how long a form may be; long is not exploding.
      const list = `{plural 2: one|${'x'.repeat(65 * 1024)}}`;
      expect(validate(list, { locale: 'ru' }).map((d) => d.code)).toEqual(['plural.arity']);
    });

    test('one pass cannot allocate past the budget', () => {
      // 15k self-references: the next generation is ~900 MB. Checking the size after
      // building the string is checking it too late — the allocation is the failure.
      const template = `#set %a% = ${'%a% '.repeat(15_000)}\n{plural 2: one|%a%}`;
      expect(validate(template, { locale: 'en' }).map((d) => d.code)).toContain('variable.self-reference');
    });
  });
});

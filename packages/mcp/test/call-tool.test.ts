/**
 * The engine wrappers. Everything here is about the boundary — argument coercion,
 * caps, and the seed derivation a client is told about in the tool description
 * ("variant i uses seed <seed>#<i>"), which makes it a contract and not an
 * implementation detail.
 */

import { describe, expect, it } from 'vitest';
import { render } from '@spintax/core';
import { callTool, type CallToolOptions } from '../src/call-tool';

const CAPPED: CallToolOptions = { maxTemplateChars: 8 * 1024, maxVariants: 20 };
const LOCAL: CallToolOptions = { maxVariants: 50 };

const ok = (name: string, args: Record<string, unknown>, opts: CallToolOptions = CAPPED) => {
  const out = callTool(name, args, opts);
  if (out.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(out)}`);
  return out;
};

describe('the template argument', () => {
  it.each([
    ['missing', {}],
    ['empty', { template: '' }],
    ['a number', { template: 7 }],
    ['null', { template: null }],
  ])('refuses a %s template', (_label, args) => {
    expect(callTool('render_spintax', args, CAPPED)).toEqual({
      kind: 'error',
      message: 'Missing or empty "template" argument (string required).',
    });
  });

  it('refuses an oversize template with the cap in the message', () => {
    const out = callTool('render_spintax', { template: 'x'.repeat(8193) }, CAPPED);
    expect(out).toMatchObject({ kind: 'error' });
    expect(out.kind === 'error' && out.message).toContain('caps templates at 8192');
  });

  it('accepts the same template when there is no cap — the local server has none', () => {
    const oversize = 'x'.repeat(9000);
    expect(callTool('render_spintax', { template: oversize }, CAPPED).kind).toBe('error');
    expect(ok('render_spintax', { template: oversize, count: 1 }, LOCAL).structured).toEqual({
      variants: [`X${oversize.slice(1)}`],
    });
  });

  it('reports an unknown tool separately from a tool failure', () => {
    expect(callTool('nope', { template: 'a' }, CAPPED)).toEqual({ kind: 'unknown-tool', name: 'nope' });
  });
});

describe('render_spintax', () => {
  it.each([
    ['0 clamps up to 1', 0, 1],
    ['a negative count clamps up to 1', -5, 1],
    ['999 clamps down to the maximum', 999, 20],
    ['a fractional count floors', 2.7, 2],
    ['a non-number falls back to 3', 'many', 3],
    ['absent falls back to 3', undefined, 3],
  ])('%s', (_label, count, expected) => {
    const args: Record<string, unknown> = { template: 'a', seed: 1 };
    if (count !== undefined) args.count = count;
    expect((ok('render_spintax', args).structured.variants as string[]).length).toBe(expected);
  });

  it('derives variant i from "<seed>#<i>", exactly as the tool description promises', () => {
    const template = '{alpha|beta|gamma} {one|two|three}';
    const variants = ok('render_spintax', { template, seed: 'pool', count: 5 }).structured
      .variants as string[];
    variants.forEach((v, i) => {
      expect(v).toBe(render(template, { seed: `pool#${i}` }));
    });
  });

  it('is deterministic for seed 0 — a falsy seed is still a seed', () => {
    const a = ok('render_spintax', { template: '{a|b|c}', seed: 0, count: 3 }).structured.variants;
    const b = ok('render_spintax', { template: '{a|b|c}', seed: 0, count: 3 }).structured.variants;
    expect(a).toEqual(b);
  });

  it('joins the variants with the documented separator in the text content', () => {
    const out = ok('render_spintax', { template: 'x', count: 3, seed: 1 });
    expect(out.text).toBe('X\n---\nX\n---\nX');
  });

  it('passes context through, stringifying non-string values', () => {
    const out = ok('render_spintax', {
      template: '%city% %n%',
      context: { city: 'Prague', n: 7 },
      count: 1,
      seed: 1,
    });
    expect(out.structured.variants).toEqual(['Prague 7']);
  });

  it('refuses a context that is not an object', () => {
    for (const context of ['x', 7, ['a'], true]) {
      expect(callTool('render_spintax', { template: 'a', context }, CAPPED)).toEqual({
        kind: 'error',
        message: '"context" must be an object mapping variable names to strings.',
      });
    }
  });

  it('leaves a null context alone (the engine default), since null is not "provided"', () => {
    expect(callTool('render_spintax', { template: 'a', context: null }, CAPPED).kind).toBe('error');
  });
});

describe('validate_spintax', () => {
  it('reports valid with no diagnostics', () => {
    const out = ok('validate_spintax', { template: '{a|b}' });
    expect(out.structured).toEqual({ valid: true, errorCount: 0, warningCount: 0, diagnostics: [] });
    expect(out.text).toBe('Valid: no diagnostics.');
  });

  it('separates errors from warnings and formats one line each', () => {
    const out = ok('validate_spintax', { template: '%missing%' });
    expect(out.structured).toMatchObject({ valid: true, errorCount: 0, warningCount: 1 });
    expect(out.text).toMatch(/^warning \S+ at \d+:\d+ — /);
  });

  it('silences a variable warning when the caller declares the name', () => {
    const out = ok('validate_spintax', { template: '%city%', knownVariables: ['city'] });
    expect(out.structured).toMatchObject({ warningCount: 0 });
  });

  it('ignores a knownVariables array that is not all strings', () => {
    const out = ok('validate_spintax', { template: '%city%', knownVariables: ['city', 7] });
    expect(out.structured).toMatchObject({ warningCount: 1 });
  });

  it('is locale-sensitive about plural arity, and warns rather than staying silent', () => {
    // The trap this used to hide: with NO locale the engine files no arity VERDICT, so a
    // 3-form block "validates" and then renders through the 2-form default — straight into
    // finished text as ｛plural …｝. Since core 0.4.0 (issue #65) that case carries a
    // `plural.locale-missing` WARNING: the verdict still does not move, but an agent
    // reading the diagnostics can see the risk before it ships.
    const threeForm = '{plural 3: one|few|many}';

    const noLocale = ok('validate_spintax', { template: threeForm }).structured as {
      valid: boolean;
      warningCount: number;
      diagnostics: { code: string; severity: string }[];
    };
    expect(noLocale.valid).toBe(true);
    expect(noLocale.warningCount).toBe(1);
    expect(noLocale.diagnostics[0]).toMatchObject({
      code: 'plural.locale-missing',
      severity: 'warning',
    });

    // A 2-form block resolves at the default, so it stays silent.
    expect(ok('validate_spintax', { template: '{plural 3: one|many}' }).structured).toEqual({
      valid: true,
      errorCount: 0,
      warningCount: 0,
      diagnostics: [],
    });

    // Naming the locale replaces the warning with the real verdict, either way.
    expect(ok('validate_spintax', { template: threeForm, locale: 'en' }).structured).toMatchObject({
      valid: false,
    });
    expect(ok('validate_spintax', { template: threeForm, locale: 'ru' }).structured).toEqual({
      valid: true,
      errorCount: 0,
      warningCount: 0,
      diagnostics: [],
    });
  });
});

describe('analyze_spintax', () => {
  it('reports refs, sets, defs, includes and construct counts', () => {
    const out = ok('analyze_spintax', {
      template: '#set %greeting% = {hi|hey}\n#def %city% = {Prague|Brno}\n%greeting% %city% %name%',
    });
    expect(out.structured).toMatchObject({
      sets: ['greeting'],
      defs: ['city'],
      includes: [],
    });
    expect(out.structured.refs).toContain('name');
    expect(out.text).toContain('constructs: {');
  });

  it('does not follow #include — the counts must mean the same thing on both servers', () => {
    const out = ok('analyze_spintax', { template: '#include "partial"\n{a|b}' });
    expect(out.structured.includes).toEqual(['partial']);
  });
});

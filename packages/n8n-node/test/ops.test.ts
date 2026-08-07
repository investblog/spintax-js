import { describe, expect, it } from 'vitest';

import { PROMPT_VERSION } from '@spintax/authoring-prompt';

import { buildContext } from '../src/ops/context';
import { cleanTemplate } from '../src/ops/clean';
import { renderOp } from '../src/ops/render';
import { renderManyOp } from '../src/ops/render-many';
import { validateOp } from '../src/ops/validate';
import { buildAuthoringOp, buildRepairOp } from '../src/ops/prompts';

describe('buildContext', () => {
  it('takes top-level scalars only, coercing numbers and booleans', () => {
    const ctx = buildContext({
      itemJson: { name: 'Ada', age: 36, vip: true, tags: ['a'], meta: { x: 1 }, none: null },
      neutralizeIncoming: false,
    });
    expect(ctx).toEqual({ name: 'Ada', age: '36', vip: 'true' });
  });

  it('shields incoming (T2) values by default — markup stays data', () => {
    const ctx = buildContext({ itemJson: { v: '{x|y}' } });
    expect(renderOp('%v%', { context: ctx, seed: 1, postProcess: false })).toBe('{x|y}');
  });

  it('without the shield, incoming markup executes', () => {
    const ctx = buildContext({ itemJson: { v: '{x|y}' }, neutralizeIncoming: false });
    expect(['x', 'y']).toContain(renderOp('%v%', { context: ctx, seed: 1, postProcess: false }));
  });

  it('fixed pairs are T1: unshielded by default, so intentional spintax works', () => {
    const ctx = buildContext({ fixedPairs: [{ name: 'title', value: '{Mr|Ms}' }] });
    expect(['Mr', 'Ms']).toContain(renderOp('%title%', { context: ctx, seed: 2, postProcess: false }));
  });

  it('a fixed pair can opt into shielding', () => {
    const ctx = buildContext({ fixedPairs: [{ name: 'v', value: '{x|y}', neutralize: true }] });
    expect(renderOp('%v%', { context: ctx, seed: 1, postProcess: false })).toBe('{x|y}');
  });

  it('fixed pairs win on collision; ignoreIncoming drops the item layer', () => {
    expect(
      buildContext({
        itemJson: { name: 'from-item' },
        neutralizeIncoming: false,
        fixedPairs: [{ name: 'name', value: 'fixed' }],
      }),
    ).toEqual({ name: 'fixed' });
    expect(buildContext({ itemJson: { name: 'x' }, ignoreIncoming: true })).toEqual({});
  });
});

describe('cleanTemplate', () => {
  it('strips code fences and reports the change', () => {
    const fenced = '```\n{Hello|Hi} %name%\n```';
    const result = cleanTemplate(fenced);
    expect(result.cleanedTemplate).toBe('{Hello|Hi} %name%');
    expect(result.rawTemplate).toBe(fenced);
    expect(result.changed).toBe(true);
  });

  it('passes clean input through unchanged', () => {
    const result = cleanTemplate('{a|b}');
    expect(result.cleanedTemplate).toBe('{a|b}');
    expect(result.changed).toBe(false);
  });
});

describe('renderManyOp', () => {
  it('is deterministic with a base seed (documented `${baseSeed}:${i}` derivation)', () => {
    const template = '{a|b|c} {d|e|f} {g|h|i}';
    const first = renderManyOp(template, { count: 5, baseSeed: 'seed' });
    const second = renderManyOp(template, { count: 5, baseSeed: 'seed' });
    expect(first.variants).toEqual(second.variants);
    expect(first.produced).toBe(5);
  });

  it('is honest on low-cardinality templates: returns what exists, no spinning', () => {
    const result = renderManyOp('{a|b}', { count: 5, baseSeed: 1 });
    expect(result.requested).toBe(5);
    expect(result.produced).toBeLessThanOrEqual(2);
    expect(result.attempts).toBeLessThanOrEqual(25); // min(500, 5 × count)
    expect(result.variants.map((v) => v.variantIndex)).toEqual(
      Array.from({ length: result.produced }, (_, i) => i),
    );
  });

  it('deduplicates by the final rendered string', () => {
    const result = renderManyOp('{a|b}', { count: 2, baseSeed: 'x', maxAttempts: 50 });
    const rendered = result.variants.map((v) => v.rendered);
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it('clamps count into 1–100', () => {
    expect(renderManyOp('{a|b}', { count: 0 }).requested).toBe(1);
    expect(renderManyOp('{a|b}', { count: 1000 }).requested).toBe(100);
  });
});

describe('validateOp', () => {
  it('valid ⇔ no error diagnostics (warnings ride along)', () => {
    const result = validateOp('%name%');
    expect(result.valid).toBe(true);
    expect(result.warningCount).toBe(1);
    expect(result.diagnostics[0]!.code).toBe('variable.undefined');
  });

  it('routes real errors to invalid', () => {
    const result = validateOp('{a|b');
    expect(result.valid).toBe(false);
    expect(result.diagnostics[0]!.code).toBe('bracket.unclosed');
  });

  it('defaults knownVariables from spintaxMeta, silencing allow-listed warnings', () => {
    const meta = { allowedVariables: [{ name: 'name' }] };
    expect(validateOp('%name%', { meta }).warningCount).toBe(0);
    expect(validateOp('%other%', { meta }).warningCount).toBe(1);
  });

  it('takes locale from spintaxMeta when not given explicitly', () => {
    expect(validateOp('x', { meta: { locale: 'ru' } }).locale).toBe('ru');
    expect(validateOp('x', { locale: 'de', meta: { locale: 'ru' } }).locale).toBe('de');
    expect(validateOp('x').locale).toBe('en');
  });
});

describe('prompt operations', () => {
  it('stamps spintaxMeta with FULL variable specs and the exported PROMPT_VERSION', () => {
    const specs = [{ name: 'name', case: 'genitive' as const }, { name: 'company' }];
    const result = buildAuthoringOp({ brief: 'b', locale: 'ru', allowedVariables: specs });
    expect(result.spintaxMeta).toEqual({
      locale: 'ru',
      allowedVariables: specs,
      promptVersion: PROMPT_VERSION,
    });
    expect(result.systemPrompt.length).toBeGreaterThan(0);
    expect(result.userPrompt).toContain('b');
  });

  it('repair inherits the meta locale and variables', () => {
    const diagnostics = validateOp('{a|b').diagnostics;
    const result = buildRepairOp('{a|b', diagnostics, {
      locale: 'ru',
      allowedVariables: [{ name: 'name' }],
    });
    expect(result.spintaxMeta.locale).toBe('ru');
    expect(result.spintaxMeta.promptVersion).toBe(PROMPT_VERSION);
    expect(result.systemPrompt.length).toBeGreaterThan(0);
  });
});

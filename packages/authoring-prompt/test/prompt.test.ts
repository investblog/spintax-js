import { describe, expect, test } from 'vitest';
import { render, validate } from '@spintax/core';
import {
  PROMPT_VERSION,
  buildAuthoringPrompt,
  buildRepairPrompt,
  cleanModelTemplate,
  pluralArity,
  promptExamples,
} from '../src/index.js';

const errorsIn = (src: string, locale: string) =>
  validate(src, { locale }).filter((d) => d.severity === 'error');

// Every locale the prompt claims to support. `en` stands for the 2-form world, `ru` for the 3-form
// one — and the plural arity the prompt teaches has to follow, or it teaches templates the engine
// rejects at render time.
const LOCALES = ['en', 'ru'] as const;

describe.each(LOCALES)('the prompt must not teach invalid syntax [locale=%s]', (locale) => {
  const examples = Object.entries(promptExamples(locale));

  // The load-bearing test. Every worked example the model is shown goes through the real engine
  // UNDER THE SAME LOCALE the prompt is built for: a prompt that teaches broken markup poisons
  // everything downstream of it. (An earlier version validated locale-lessly, which is exactly
  // how a 3-form English plural slipped into the prompt: validate() skips arity with no locale.)
  test.each(examples)('example %s validates clean', (_name, example) => {
    expect(errorsIn(example, locale)).toEqual([]);
  });

  test.each(examples)('example %s renders without a fullwidth fallback', (_name, example) => {
    const out = render(example, { seed: 1, locale, context: { discount: '20%', n: '3' } });
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain('｛'); // fullwidth braces = the engine rejected the block
  });

  test('the examples shown are the examples tested — no drift', () => {
    const { systemPrompt } = buildAuthoringPrompt({ brief: 'x', locale });
    for (const [, example] of examples) {
      for (const line of example.split('\n')) {
        expect(systemPrompt).toContain(line);
      }
    }
  });

  test('the taught plural arity matches what the engine accepts for this locale', () => {
    const { systemPrompt } = buildAuthoringPrompt({ brief: 'x', locale });
    const forms = pluralArity(locale);
    expect(systemPrompt).toContain(
      forms === 3 ? '{plural %n%: one|few|many}' : '{plural %n%: one|many}',
    );
    // and the counter-shape must NOT be taught
    expect(systemPrompt).not.toContain(
      forms === 3 ? '{plural %n%: one|many}\n' : '{plural %n%: one|few|many}',
    );
  });

  test('#set collapses once, which is the whole reason the prompt teaches it', () => {
    const out = render(promptExamples(locale).set, { seed: 1, locale });
    // Exactly one of the two words, never a mix — that is the collapse-once promise.
    expect(out.includes('course')).not.toBe(out.includes('training'));
  });
});

describe('buildAuthoringPrompt', () => {
  test('teaches every construct — including the two the bot used to omit', () => {
    const { systemPrompt } = buildAuthoringPrompt({ brief: 'welcome email' });
    for (const construct of ['{a|b|c}', '#set', '%name%', '[<sep=', '{?VAR?', '{plural']) {
      expect(systemPrompt).toContain(construct);
    }
  });

  test('warns that a bare permutation joins with a space', () => {
    const { systemPrompt } = buildAuthoringPrompt({ brief: 'x' });
    expect(systemPrompt).toContain('DEFAULT SEPARATOR IS A SINGLE SPACE');
  });

  test('locale selects a grammar block, and ru pushes counts into {plural}', () => {
    const ru = buildAuthoringPrompt({ brief: 'x', locale: 'ru' }).systemPrompt;
    expect(ru).toContain('GENDER, CASE and NUMBER');
    expect(ru).toContain('{plural %n%: товар|товара|товаров}');
    expect(ru).not.toBe(buildAuthoringPrompt({ brief: 'x', locale: 'en' }).systemPrompt);
  });

  test('allowed variables are listed; an empty list forbids variables outright', () => {
    const withVars = buildAuthoringPrompt({ brief: 'x', allowedVariables: ['first_name', 'company'] });
    expect(withVars.userPrompt).toContain('%first_name%, %company%');
    expect(withVars.allowedVariables).toEqual(['first_name', 'company']);

    const none = buildAuthoringPrompt({ brief: 'x' });
    expect(none.userPrompt).toContain('do not use any %variable%');
  });

  test('variation levels differ, and the prompt is versioned', () => {
    const levels = (['conservative', 'balanced', 'aggressive'] as const).map(
      (variationLevel) => buildAuthoringPrompt({ brief: 'x', variationLevel }).systemPrompt,
    );
    expect(new Set(levels).size).toBe(3);
    expect(buildAuthoringPrompt({ brief: 'x' }).promptVersion).toBe(PROMPT_VERSION);
  });

  test('the brief reaches the user prompt', () => {
    const { userPrompt } = buildAuthoringPrompt({ brief: 'a warm welcome for SaaS signups' });
    expect(userPrompt).toContain('a warm welcome for SaaS signups');
  });
});

describe('buildRepairPrompt', () => {
  test('line-numbers the template and cites each error with its exact span', () => {
    const broken = 'Line one is fine.\n{Hi|Hello there';
    const diagnostics = validate(broken, { locale: 'en' });
    expect(errorsIn(broken, 'en').length).toBeGreaterThan(0);

    const { userPrompt } = buildRepairPrompt(broken, diagnostics);
    expect(userPrompt).toContain(' 2 | {Hi|Hello there');
    expect(userPrompt).toMatch(/line 2, column \d+ \[bracket\./u);
  });

  test('tells the model to change as little as possible', () => {
    const { systemPrompt } = buildRepairPrompt('{a|b', validate('{a|b'));
    expect(systemPrompt).toContain('Change as little as possible');
  });

  // A repair that fixes a bracket while inventing a variable, or restating the wrong plural arity,
  // is not a repair — it just moves the error. So the repair prompt carries the same constraints
  // as the draft prompt.
  test('carries the authoring constraints: locale-correct plural arity', () => {
    const bad = 'You have 3 {plural 3: item|few|items} in cart.';
    const { systemPrompt } = buildRepairPrompt(bad, validate(bad, { locale: 'en' }), {
      locale: 'en',
    });
    expect(systemPrompt).toContain('{plural %n%: one|many}');
    expect(systemPrompt).toContain('EXACTLY 2 forms');
  });

  test('carries the authoring constraints: allowed variables', () => {
    const built = buildRepairPrompt('{a|b', validate('{a|b'), {
      allowedVariables: ['first_name'],
    });
    expect(built.userPrompt).toContain('ALLOWED VARIABLES: %first_name%');
    expect(built.allowedVariables).toEqual(['first_name']);
  });

  test('with no allowed variables, forbids them outright', () => {
    const built = buildRepairPrompt('{a|b', validate('{a|b'));
    expect(built.userPrompt).toContain('must not use any %variable%');
  });
});

describe('cleanModelTemplate — the output contract is stated, never trusted', () => {
  test.each([
    ['```\n{Hi|Hello} %name%!\n```', '{Hi|Hello} %name%!'],
    ['```spintax\n{Hi|Hello}\n```', '{Hi|Hello}'],
    ['"{Hi|Hello}"', '{Hi|Hello}'],
    ['“{Hi|Hello}”', '{Hi|Hello}'],
    ['Template: {Hi|Hello}', '{Hi|Hello}'],
    ['  {Hi|Hello}  ', '{Hi|Hello}'],
  ])('strips %j', (raw, expected) => {
    expect(cleanModelTemplate(raw)).toBe(expected);
  });

  test('leaves a clean template untouched', () => {
    const clean = promptExamples('en').permutation;
    expect(cleanModelTemplate(clean)).toBe(clean);
  });
});

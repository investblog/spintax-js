import { describe, expect, test } from 'vitest';
import { render, validate } from '@spintax/core';
import {
  PROMPT_EXAMPLES,
  PROMPT_VERSION,
  buildAuthoringPrompt,
  buildRepairPrompt,
  cleanModelTemplate,
} from '../src/index.js';

const errorsIn = (src: string) => validate(src).filter((d) => d.severity === 'error');

describe('the prompt must not teach invalid syntax', () => {
  // The load-bearing test. Every worked example the model is shown goes through the real engine:
  // a prompt that teaches broken markup poisons every surface downstream of it.
  test.each(Object.entries(PROMPT_EXAMPLES))('example %s validates clean', (_name, example) => {
    expect(errorsIn(example)).toEqual([]);
  });

  test.each(Object.entries(PROMPT_EXAMPLES))('example %s renders', (_name, example) => {
    const out = render(example, { seed: 1, context: { discount: '20%', n: '3' } });
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain('｛'); // fullwidth braces = the engine rejected a block as malformed
  });

  test('the examples shown are the examples tested — no drift', () => {
    const { systemPrompt } = buildAuthoringPrompt({ brief: 'x' });
    for (const example of Object.values(PROMPT_EXAMPLES)) {
      for (const line of example.split('\n')) {
        expect(systemPrompt).toContain(line);
      }
    }
  });

  test('#set collapses once, which is the whole reason the prompt teaches it', () => {
    const out = render(PROMPT_EXAMPLES.set, { seed: 1 });
    const usedCourse = out.includes('course');
    const usedTraining = out.includes('training');
    // Exactly one of the two words, never a mix — that is the collapse-once promise.
    expect(usedCourse).not.toBe(usedTraining);
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
    const diagnostics = validate(broken);
    expect(errorsIn(broken).length).toBeGreaterThan(0);

    const { userPrompt } = buildRepairPrompt(broken, diagnostics);
    expect(userPrompt).toContain(' 2 | {Hi|Hello there');
    expect(userPrompt).toMatch(/line 2, column \d+ \[bracket\./u);
  });

  test('tells the model to change as little as possible', () => {
    const { systemPrompt } = buildRepairPrompt('{a|b', validate('{a|b'));
    expect(systemPrompt).toContain('Change as little as possible');
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
    expect(cleanModelTemplate(PROMPT_EXAMPLES.permutation)).toBe(PROMPT_EXAMPLES.permutation);
  });
});

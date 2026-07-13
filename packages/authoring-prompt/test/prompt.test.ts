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
    for (const construct of ['{a|b|c}', '#set', '%name%', '[<minsize=', 'lastsep=', '{?VAR?', '{plural']) {
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
    expect(withVars.userPrompt).toContain('%first_name%');
    expect(withVars.userPrompt).toContain('%company%');
    expect(withVars.allowedVariables).toEqual(['first_name', 'company']);

    const none = buildAuthoringPrompt({ brief: 'x' });
    expect(none.userPrompt).toContain('do not use any %variable%');
  });

  test('teaches lastsep — a list without it reads like a robot', () => {
    expect(buildAuthoringPrompt({ brief: 'x' }).systemPrompt).toContain('lastsep=" and "');
    expect(buildAuthoringPrompt({ brief: 'x', locale: 'ru' }).systemPrompt).toContain('lastsep=" и "');
  });

  test('teaches the empty branch AND its accidental twin, the stray double pipe', () => {
    const { systemPrompt } = buildAuthoringPrompt({ brief: 'x' });
    expect(systemPrompt).toContain('EMPTY branch makes a word optional');
    expect(systemPrompt).toContain('{a|b||c}');
  });
});

// Drawn from a real Russian template set (casino-platform): the author had to declare one variable
// per grammatical case, because a variable is substituted verbatim and cannot be inflected from the
// outside. A prompt that says only "use these names" invites the model to write "для %Visitors%".
describe('variables carry grammatical case (the ru trap)', () => {
  const CASED = [
    { name: 'Visitors', case: 'nominative' as const },
    { name: 'VisitorsGen', case: 'genitive' as const },
    { name: 'VisitorsDat', case: 'dative' as const },
    { name: 'VisitorsInstr', case: 'instrumental' as const },
    { name: 'CasinoName', note: 'brand name — does not decline' },
  ];

  test('the declared case is shown next to each name, in the per-item user prompt', () => {
    const { userPrompt, systemPrompt } = buildAuthoringPrompt({
      brief: 'x',
      locale: 'ru',
      allowedVariables: CASED,
    });
    expect(userPrompt).toContain('%VisitorsGen% — genitive');
    expect(userPrompt).toContain('%CasinoName% — brand name — does not decline');
    // The list is DATA (it changes per item); the system prompt must stay stable and cacheable.
    expect(systemPrompt).not.toContain('%VisitorsGen% — genitive');
  });

  test('ru: the case rules are taught — suffix gluing, prepositions, brand names', () => {
    const { systemPrompt } = buildAuthoringPrompt({
      brief: 'x',
      locale: 'ru',
      allowedVariables: CASED,
    });
    expect(systemPrompt).toContain('CASE IS PART OF THE VALUE');
    expect(systemPrompt).toContain('для %VisitorsGen%');
    expect(systemPrompt).toContain('NEVER glue an ending onto a variable');
    expect(systemPrompt).toContain('move TOGETHER');
    expect(systemPrompt).toContain('never "%CasinoName%а"');
  });

  test('en: the same principle surfaces as the article trap, not as case', () => {
    const { systemPrompt } = buildAuthoringPrompt({
      brief: 'x',
      locale: 'en',
      allowedVariables: ['product'],
    });
    expect(systemPrompt).toContain('substituted VERBATIM');
    expect(systemPrompt).toContain('"a %product%" is a coin-flip');
    expect(systemPrompt).not.toContain('CASE IS PART OF THE VALUE');
  });

  test('a bare string still works — case is optional, not required', () => {
    const built = buildAuthoringPrompt({ brief: 'x', allowedVariables: ['name'] });
    expect(built.allowedVariables).toEqual(['name']);
    expect(built.userPrompt).toContain('%name%');
  });

  test('the repair prompt restates the variables, cases and all', () => {
    const { systemPrompt, userPrompt } = buildRepairPrompt('{a|b', validate('{a|b'), {
      locale: 'ru',
      allowedVariables: CASED,
    });
    expect(userPrompt).toContain('%VisitorsDat% — dative');
    expect(systemPrompt).toContain('CASE IS PART OF THE VALUE');
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
    expect(built.userPrompt).toContain('%first_name%');
    expect(built.allowedVariables).toEqual(['first_name']);
  });

  test('with no allowed variables, forbids them outright', () => {
    const built = buildRepairPrompt('{a|b', validate('{a|b'));
    expect(built.userPrompt).toContain('do not use any %variable%');
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

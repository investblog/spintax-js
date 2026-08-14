import { describe, expect, it } from 'vitest';

import { guessGenderRu, lintOp, lintSampleOp, sameRoot } from '../src/ops/lint';

/** Codes only — messages are explicitly not a contract. */
const codes = (text: string, opts?: Parameters<typeof lintOp>[1]): string[] =>
  lintOp(text, { locale: 'ru', ...opts }).findings.map((f) => f.code);

describe('lintOp — repetition', () => {
  it('catches two slots landing on the same word', () => {
    const findings = lintOp('<p>футбол, хоккей, теннис, теннис, киберспорт</p>', {
      locale: 'ru',
    }).findings;
    expect(findings[0]!.code).toBe('repeat.word');
    expect(findings[0]!.data).toMatchObject({ first: 'теннис', second: 'теннис', distance: 1 });
  });

  it('catches the same word in two forms — a tautology the template cannot show', () => {
    expect(codes('это вопрос, где больше всего вопросов')).toContain('repeat.word');
  });

  it('the window is tunable: wider reaches further, at the cost of noise', () => {
    const far = 'это вопрос, где у новичков накопилось больше всего вопросов';
    expect(codes(far)).toEqual([]);
    expect(codes(far, { window: 10 })).toContain('repeat.word');
  });

  it('ignores function words repeating, which is ordinary Russian', () => {
    expect(codes('он и она, и снова он')).toEqual([]);
  });

  it('leaves a clean sentence alone and never counts HTML tags as words', () => {
    expect(codes('<p>Разборы разложены по видам спорта: футбол, хоккей и киберспорт.</p>')).toEqual(
      [],
    );
    expect(codes('<p>первый</p><p>второй</p>')).toEqual([]);
  });

  it('sameRoot matches inflections but not merely similar words', () => {
    expect(sameRoot('букмекеры', 'букмекерам')).toBe(true);
    expect(sameRoot('купонов', 'купона')).toBe(true);
    expect(sameRoot('ставка', 'ставки')).toBe(true);
    expect(sameRoot('форум', 'фонбет')).toBe(false);
    expect(sameRoot('игра', 'игла')).toBe(false);
  });

  it('works without a stop-word table for the locale — the length filter still applies', () => {
    // No table for `de`: the repetition is still visible, and nothing was invented
    // about a language we have not looked at.
    expect(lintOp('Angebote, Angebote überall', { locale: 'de' }).findings[0]!.code).toBe(
      'repeat.word',
    );
  });
});

describe('lintOp — gender agreement (locale-scoped)', () => {
  it('catches a noun and a relative pronoun disagreeing', () => {
    // The live defect: `{тема|сюжет|материя}` next to `{где|в которой}` shipped
    // "сюжет, в которой" in 18% of a pool. Each option is correct on its own.
    const finding = lintOp('верификация — сюжет, в которой много вопросов', {
      locale: 'ru',
    }).findings[0]!;
    expect(finding.code).toBe('agreement.relative');
    expect(finding.data).toMatchObject({ noun: 'сюжет', pronoun: 'которой' });

    expect(codes('верификация — тема, в которой много вопросов')).toEqual([]);
    expect(codes('это раздел, в котором всё понятно')).toEqual([]);
    expect(codes('это ветка, в которой всё понятно')).toEqual([]);
  });

  it('skips what it cannot judge instead of guessing', () => {
    expect(guessGenderRu('тема')).toBe('f');
    expect(guessGenderRu('сюжет')).toBe('m');
    expect(guessGenderRu('место')).toBe('n');
    // A soft sign is ambiguous — `путь` masculine, `тень` feminine.
    expect(guessGenderRu('путь')).toBeNull();
    expect(codes('это путь, в которой ошибка')).toEqual([]);
  });

  it('does not run the Russian table on another locale', () => {
    // The same string under `en`: the Slavic rule set is not applied to a language
    // whose rules we have not written down.
    const findings = lintOp('верификация — сюжет, в которой много вопросов', { locale: 'en' })
      .findings;
    expect(findings.map((f) => f.code)).not.toContain('agreement.relative');
  });
});

describe('lintOp — punctuation debris', () => {
  it('catches what an unlucky join leaves behind', () => {
    expect(codes('текст  с двойным пробелом')).toContain('punctuation.double-space');
    expect(codes('текст , с пробелом перед запятой')).toContain('punctuation.space-before');
    expect(codes('текст,, с дублем')).toContain('punctuation.duplicated');
    expect(codes('пустые «» кавычки')).toContain('punctuation.empty-pair');
  });

  it('leaves an intentional ellipsis alone but reports a broken run of dots', () => {
    expect(codes('он подумал… и замолчал')).toEqual([]);
    expect(codes('он подумал... и замолчал')).toEqual([]);
    expect(codes('конец предложения.. начало другого')).toContain('punctuation.duplicated');
  });

  it('does not complain about French spacing before ; : ! ?, which is correct there', () => {
    expect(lintOp('le prix : très bas', { locale: 'fr' }).clean).toBe(true);
    // …while the same spacing before a comma is still debris.
    expect(lintOp('le prix , très bas', { locale: 'fr' }).findings.map((f) => f.code)).toContain(
      'punctuation.space-before',
    );
    // Under a locale without that convention it is reported as usual.
    expect(codes('цена : очень низкая')).toContain('punctuation.space-before');
  });

  it('reports the offending fragment, not just the code', () => {
    const finding = lintOp('цена , очень низкая', { locale: 'ru' }).findings[0]!;
    expect(finding.fragment).toContain('цена ,');
  });
});

describe('lintSampleOp', () => {
  it('renders a sample, tallies the defects and reports the worst first', () => {
    // Half the draws pick the same word twice — the defect exists in the combination,
    // never in the template, which is the whole point of the operation.
    const template = '{разборы|прогнозы} по {дисциплинам|видам спорта}, всё по дисциплинам';
    const report = lintSampleOp(template, { count: 20, baseSeed: 'lint', locale: 'ru' });

    expect(report.checked).toBe(20);
    expect(report.cleanCount).toBeGreaterThan(0);
    expect(report.cleanCount).toBeLessThan(20);
    expect(report.cleanRatio).toBeCloseTo(report.cleanCount / 20, 4);
    expect(report.issues[0]!.code).toBe('repeat.word');
    expect(report.issues[0]!.count).toBe(20 - report.cleanCount);
  });

  it('is reproducible from the base seed — the same report twice', () => {
    const template = '{разборы|прогнозы} по {дисциплинам|видам}, всё по дисциплинам';
    const once = lintSampleOp(template, { count: 15, baseSeed: 'x', locale: 'ru' });
    const twice = lintSampleOp(template, { count: 15, baseSeed: 'x', locale: 'ru' });
    expect(twice).toEqual(once);
  });

  it('reports a clean template as clean', () => {
    const report = lintSampleOp('{Привет|Здравствуйте}, {друзья|коллеги}!', {
      count: 10,
      baseSeed: 'ok',
      locale: 'ru',
    });
    expect(report.cleanCount).toBe(10);
    expect(report.cleanRatio).toBe(1);
    expect(report.issues).toEqual([]);
  });

  it('clamps the sample size into 1–500', () => {
    expect(lintSampleOp('a', { count: 0 }).checked).toBe(1);
    expect(lintSampleOp('a', { count: 5000 }).checked).toBe(500);
  });
});

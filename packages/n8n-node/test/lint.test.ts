import { describe, expect, it } from 'vitest';

import { guessGenderRu, lintOp, lintSampleOp, lintWords, sameRoot } from '../src/ops/lint';

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

  it('does not blame the author for a value the render substituted twice', () => {
    // Found on a live run: 8 of 12 documents were flagged, and the hits were the brand
    // and the product name. A brand appearing twice in a paragraph is data the author
    // did not write and often cannot avoid.
    const text = 'Our Trail Runner 3, designed by Brightline Gear. The team at Brightline Gear built it.';
    expect(lintOp(text, { locale: 'en' }).findings.map((f) => f.code)).toContain('repeat.word');
    expect(lintOp(text, { locale: 'en', ignore: ['Brightline Gear', 'Trail Runner 3'] }).clean).toBe(
      true,
    );
  });

  it('keeps the distance an ignored value occupied — the live false positive', () => {
    // "built" twice, ten words apart in the real document: outside the window, and a
    // deliberate `#def` word at that. Erasing the values between them pulled the pair
    // three words apart and failed the whole pool.
    const text =
      'Trail Runner 3 by Brightline Gear, built for weekend hikers. Meet Trail Runner 3, ' +
      'built by Brightline Gear with weekend hikers in mind.';
    const ignore = ['Trail Runner 3', 'Brightline Gear', 'weekend hikers'];
    expect(lintOp(text, { locale: 'en', ignore }).clean).toBe(true);

    // …while a real repeat at a real distance is still caught with the same values ignored.
    expect(
      lintOp('Trail Runner 3 is sturdy and sturdy enough', { locale: 'en', ignore }).findings.map(
        (f) => f.code,
      ),
    ).toContain('repeat.word');
  });

  it('does not glue the words an ignored value sat between', () => {
    expect(lintOp('the Gear boots and the Gear again', { locale: 'en', ignore: ['Gear'] }).clean)
      .toBe(true);
  });

  it('reads punctuation on the ORIGINAL text, not the blanked copy', () => {
    // Otherwise the gap left by a removed value reads as debris the render never made.
    expect(lintOp('Our Trail Runner 3, designed today', {
      locale: 'en',
      ignore: ['Trail Runner 3'],
    }).clean).toBe(true);
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

// ── #77: a locale with no stop-word table ────────────────────────────────────
//
// `repeat.word` used to run everywhere with `STOP_WORDS[language] ?? []`, so on any locale but
// ru/en every function word was eligible content. The reporting pipeline measured the cost: one
// Spanish `para` produced 2303 findings across a 1000-article pool. The examples below are theirs.

describe('#77 — repeat.word only runs where the function words are known', () => {
  it('no longer reports a Spanish function word as a repetition', () => {
    const text = 'Herramientas para webmasters, pensadas para equipos que trabajan para clientes.';
    const result = lintOp(text, { locale: 'es' });
    expect(result.findings.filter((f) => f.code === 'repeat.word')).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('still catches a real Spanish repetition, so the table did not blunt the rule', () => {
    const result = lintOp('La herramienta es una herramienta para todos.', { locale: 'es' });
    expect(result.findings.some((f) => f.code === 'repeat.word')).toBe(true);
  });

  it('no longer reports the German function words the pipeline named', () => {
    const text = 'Eine Sammlung, die sich an alle wendet und die keine Grenzen kennt.';
    expect(lintOp(text, { locale: 'de' }).findings.filter((f) => f.code === 'repeat.word')).toEqual(
      [],
    );
  });

  it('still catches a real German repetition', () => {
    const result = lintOp('Die Sammlung ist eine Sammlung für alle.', { locale: 'de' });
    expect(result.findings.some((f) => f.code === 'repeat.word')).toBe(true);
  });

  it('reports the Portuguese function words as clean and a real repeat as a finding', () => {
    expect(
      lintOp('Isso não é nada, isso não muda nada aqui.', { locale: 'pt' }).findings.filter(
        (f) => f.code === 'repeat.word',
      ),
    ).toEqual([]);
    expect(
      lintOp('A ferramenta é uma ferramenta para todos.', { locale: 'pt' }).findings.some(
        (f) => f.code === 'repeat.word',
      ),
    ).toBe(true);
  });

  it('drops the region, so pt-BR uses the pt table', () => {
    expect(lintOp('Isso não é nada, isso não muda nada.', { locale: 'pt-BR' }).skipped).toEqual([]);
  });

  it('SKIPS repeat.word on a locale it has no table for, and says so', () => {
    // Turkish: no table. Silence here would be the defect — a rule that never ran reporting clean.
    const result = lintOp('Bu araç bu araç için değil.', { locale: 'tr' });
    expect(result.skipped).toEqual(['repeat.word']);
    expect(result.findings.filter((f) => f.code === 'repeat.word')).toEqual([]);
  });

  it('runs again once the caller supplies the words, and then reports nothing skipped', () => {
    const result = lintOp('Bu araç bu araç için değil.', {
      locale: 'tr',
      stopWords: ['bu', 'için', 'değil'],
    });
    expect(result.skipped).toEqual([]);
    expect(result.findings.some((f) => f.code === 'repeat.word')).toBe(true);
  });

  it('merges a supplied list with the built-in table rather than replacing it', () => {
    // `para` comes from the table, `webmasters` from the caller — both must be silenced.
    const text = 'Webmasters para webmasters, para todos.';
    expect(
      lintOp(text, { locale: 'es', stopWords: ['webmasters'] }).findings.filter(
        (f) => f.code === 'repeat.word',
      ),
    ).toEqual([]);
  });

  it('keeps the language-neutral rules running on an untabled locale', () => {
    // Only repetition needs the vocabulary; punctuation debris does not.
    const result = lintOp('Bir  metin , burada.', { locale: 'tr' });
    expect(result.skipped).toEqual(['repeat.word']);
    expect(result.findings.map((f) => f.code)).toContain('punctuation.double-space');
    expect(result.findings.map((f) => f.code)).toContain('punctuation.space-before');
  });

  it('carries the skip through the sampler, where a clean ratio would otherwise mislead', () => {
    const report = lintSampleOp('{Bu|Şu} araç {bu|şu} araç.', {
      count: 5,
      baseSeed: 'x',
      locale: 'tr',
    });
    expect(report.skipped).toEqual(['repeat.word']);
  });
});

// ── HTML entities are not words ──────────────────────────────────────────────
//
// Found by measurement, not by reading: run repeat.word over 120 KB of our own French long-form
// and `nbsp` is the most reported "repetition" on the page, ahead of every real word, with
// `mdash` and `rarr` behind it. Stripping & and ; as punctuation left the entity NAME standing.

describe('lintWords drops HTML entities before they can look like words', () => {
  it('does not turn a named entity into a token', () => {
    expect(lintWords('a&nbsp;b &mdash; c&nbsp;d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('no longer reports two non-breaking spaces as a repetition', () => {
    const result = lintOp('Le texte&nbsp;ici et le mot&nbsp;suivant.', {
      locale: 'fr',
      stopWords: ['le', 'et'],
    });
    expect(result.findings.filter((f) => f.code === 'repeat.word')).toEqual([]);
  });

  it('decodes a numeric entity to the character it stands for', () => {
    // &#160; is a non-breaking space, so it separates words rather than joining them.
    expect(lintWords('one&#160;two')).toEqual(['one', 'two']);
    // &#x2014; is an em dash: punctuation, dropped like any other.
    expect(lintWords('alpha&#x2014;beta')).toEqual(['alpha', 'beta']);
  });

  it('survives an out-of-range code point instead of throwing inside the pass', () => {
    // Reachable values only: the decimal form caps at 7 digits and the hex form at 6, and both
    // of those still exceed U+10FFFF — `String.fromCodePoint` throws RangeError on either.
    // (An earlier version of this test used 8 digits, which the regex never matches, so it
    // proved nothing; a control mutation removing the guard kept it green.)
    expect(() => lintWords('x&#9999999;y')).not.toThrow();
    expect(() => lintWords('x&#xFFFFFF;y')).not.toThrow();
    expect(lintWords('x&#9999999;y')).toEqual(['x', 'y']);
  });

  it('still finds a real repetition in text that also carries entities', () => {
    const result = lintOp('The tool&nbsp;here is a tool for everyone.', { locale: 'en' });
    expect(result.findings.some((f) => f.code === 'repeat.word')).toBe(true);
  });

  it('cuts a letter entity short rather than inventing a word from its name', () => {
    // `caf&eacute;` becomes `caf`, which can only hide a repetition — never invent one.
    expect(lintWords('caf&eacute; noir')).toEqual(['caf', 'noir']);
  });
});

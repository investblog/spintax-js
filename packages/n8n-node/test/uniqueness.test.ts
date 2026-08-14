import { describe, expect, it } from 'vitest';

import {
  UNIQUENESS_DEFAULTS,
  footprintShare,
  jaccard,
  nearDupes,
  normalizeText,
  shingleSet,
  uniquenessOp,
} from '../src/ops/uniqueness';

/** Eight unrelated articles sharing one macro — the reproducibility fixture. */
function fixture(): string[] {
  return [
    'приветственный пакет новичкам начисляется первым депозитом мгновенно',
    'кэшбэк возвращается еженедельно по понедельникам утром без заявки',
    'турниры проходят каждый вечер призовой фонд делится между лидерами',
    'служба поддержки отвечает круглосуточно в чате и почтой быстро',
    'мобильная версия открывается браузером телефона установка вообще не нужна',
    'вывод средств занимает считанные часы карты кошельки криптовалюта доступны',
    'программа лояльности повышает уровень игрока начисляя баллы каждой ставкой',
    'фриспины выдаются новым слотам недели условия отыгрыша описаны правилами',
  ].map((t) => `${t}\n\n#file_links#\n`);
}

describe('normalizeText — the ordered algorithm', () => {
  it('step 1: exact macro strings are removed, not matched by pattern', () => {
    const macros = ['#file_links#', "[URL='%url%']%anchor_text%[/URL]"];
    expect(normalizeText("Текст #file_links# и [URL='%url%']%anchor_text%[/URL] конец", { macros }))
      .toEqual(['текст', 'и', 'конец']);
  });

  it('step 1: a macro shared by every document cannot manufacture similarity', () => {
    const macros = ['#file_links#'];
    const a = normalizeText('Первый уникальный текст #file_links#', { macros });
    const b = normalizeText('Второй непохожий документ #file_links#', { macros });
    expect(jaccard(shingleSet(a, 2), shingleSet(b, 2))).toBe(0);
  });

  it('step 1: the longest macro wins, so a nested one cannot eat it', () => {
    const macros = ['%url%', "[URL='%url%']"];
    expect(normalizeText("до [URL='%url%'] после", { macros })).toEqual(['до', 'после']);
  });

  it('step 2: tags go with their attributes, the inner text stays', () => {
    expect(normalizeText('<a href="x">якорь</a> текст', { bodyFormat: 'html' })).toEqual([
      'якорь',
      'текст',
    ]);
    expect(normalizeText('[B]жирный[/B] текст', { bodyFormat: 'bbcode' })).toEqual([
      'жирный',
      'текст',
    ]);
    // plain: brackets are just punctuation, so their content survives as words.
    expect(normalizeText('[B]жирный[/B]', { bodyFormat: 'plain' })).toEqual(['b', 'жирный', 'b']);
  });

  it('step 3: NFC first, then the locale-aware lowercase', () => {
    const decomposed = 'é';
    expect(normalizeText(decomposed)).toEqual(['é'.normalize('NFC')]);
    expect(normalizeText('ПРИВЕТ Мир', { locale: 'ru' })).toEqual(['привет', 'мир']);
    // The Turkish trap the step exists for: a locale-blind lowercase gives "i".
    expect(normalizeText('IŞIK', { locale: 'tr' })).toEqual(['ışık']);
  });

  it('step 4: punctuation becomes a SPACE, so a hyphen splits rather than joins', () => {
    // Deleting it would give "интернетказино" — a different shingle, a different number.
    expect(normalizeText('интернет-казино')).toEqual(['интернет', 'казино']);
    expect(normalizeText('«ёлки» — да!')).toEqual(['ёлки', 'да']);
    expect(normalizeText('100% + 50€')).toEqual(['100', '50']);
  });

  it('step 5: NBSP and runs of whitespace collapse to one space', () => {
    expect(normalizeText('a b   c\n\nd')).toEqual(['a', 'b', 'c', 'd']);
    expect(normalizeText('a b')).toEqual(['a', 'b']);
    expect(normalizeText('   ')).toEqual([]);
  });
});

describe('shingleSet and jaccard', () => {
  it('step 7: a SET of w-word tuples', () => {
    expect([...shingleSet(['a', 'b', 'c', 'd', 'e', 'f'], 5)]).toEqual(['a b c d e', 'b c d e f']);
  });

  it('step 7: a document shorter than w yields one shingle of all its words', () => {
    expect([...shingleSet(['a', 'b'], 5)]).toEqual(['a b']);
    expect(shingleSet([], 5).size).toBe(0);
  });

  it('step 7: repeated phrases collapse — a set, not a multiset', () => {
    const set = shingleSet('a b c d e a b c d e'.split(' '), 5);
    expect(set.has('a b c d e')).toBe(true);
    expect([...set].filter((x) => x === 'a b c d e')).toHaveLength(1);
  });

  it('identical = 1, disjoint = 0, symmetric', () => {
    const a = new Set(['x', 'y']);
    const b = new Set(['x', 'y']);
    const c = new Set(['z']);
    expect(jaccard(a, b)).toBe(1);
    expect(jaccard(a, c)).toBe(0);
    expect(jaccard(a, c)).toBe(jaccard(c, a));
    expect(jaccard(new Set(['x', 'y']), new Set(['y', 'z']))).toBeCloseTo(1 / 3, 10);
  });
});

describe('nearDupes', () => {
  const mk = (t: string): Set<string> => shingleSet(normalizeText(t), 3);

  it('finds pairs above the threshold and reports the score', () => {
    const docs = [
      mk('обзор казино бонусы для новичков сегодня'),
      mk('обзор казино бонусы для новичков сегодня'),
      mk('совсем другой текст про погоду и природу'),
    ];
    const hits = nearDupes(docs, 0.6);
    expect(hits).toHaveLength(1);
    expect([hits[0]!.a, hits[0]!.b]).toEqual([0, 1]);
    expect(hits[0]!.jaccard).toBe(1);
  });

  it('falls back to the full scan where the index cannot propose candidates', () => {
    // Two empty documents score 1 by definition but share no shingle to be indexed by,
    // and at threshold 0 every pair qualifies while only shingle-sharing pairs are
    // indexed. Both cases would silently lose pairs the docstring promises are kept.
    const empty = [new Set<string>(), new Set<string>(), mk('совсем другой текст здесь')];
    expect(nearDupes(empty, 0.6).map((p) => [p.a, p.b])).toEqual([[0, 1]]);

    const disjoint = [mk('первый текст про одно'), mk('второй документ про другое')];
    expect(nearDupes(disjoint, 0)).toHaveLength(1);
  });

  it('the inverted index does not lose a pair the full scan would find', () => {
    const docs = [
      'один два три четыре пять шесть',
      'один два три четыре пять семь',
      'восемь девять десять одиннадцать двенадцать',
    ].map(mk);
    const viaIndex = nearDupes(docs, 0.3)
      .map((p) => `${p.a}:${p.b}`)
      .sort();

    const brute: string[] = [];
    for (let i = 0; i < docs.length; i++) {
      for (let k = i + 1; k < docs.length; k++) {
        if (jaccard(docs[i]!, docs[k]!) >= 0.3) brute.push(`${i}:${k}`);
      }
    }
    expect(viaIndex).toEqual(brute.sort());
  });
});

describe('footprintShare', () => {
  it('a pool of clones is almost entirely shared shingles', () => {
    const doc = shingleSet(normalizeText('обзор казино бонусы для новичков и всех прочих'));
    expect(footprintShare(Array.from({ length: 10 }, () => new Set(doc))).value).toBe(1);
  });

  it('a pool of genuinely unrelated documents shares nothing', () => {
    // Note for the future: the first version of this fixture built documents as
    // "unique document number N with its own content and words" — they differed ONLY by
    // the number, and the metric rightly found a shared tail shingle. Texts must diverge
    // in WORDS, not in an index, or the test checks something other than it claims.
    const docs = fixture().map((t) => shingleSet(normalizeText(t, { macros: ['#file_links#'] })));
    expect(footprintShare(docs).value).toBe(0);
  });

  it('a shared skeleton across a diverse pool shows up as a partial share', () => {
    const shared = 'зарегистрируйтесь получите бонус и начните играть сегодня';
    const docs = Array.from({ length: 10 }, (_, i) =>
      shingleSet(normalizeText(`тема номер ${i} с разными словами ${i} ${i} ${i} ${shared}`)),
    );
    const result = footprintShare(docs);
    expect(result.value).toBeGreaterThan(0);
    expect(result.value).toBeLessThan(1);
    expect(result.sharedShingles).toBeGreaterThan(0);
    expect(result.sharedShingles).toBeLessThan(result.totalShingles);
  });

  it('refuses to report a number on a pool too small to mean anything', () => {
    const docs = Array.from({ length: 3 }, (_, i) => shingleSet(normalizeText(`текст ${i}`)));
    const result = footprintShare(docs);
    expect(result.value).toBeNull();
    expect(result.reason).toMatch(/below minPool/);
  });
});

describe('uniquenessOp', () => {
  it('is reproducible: the same fixture gives the same numbers', () => {
    const texts = fixture();
    const opts = { macros: ['#file_links#'], locale: 'ru' };
    expect(uniquenessOp(texts, opts)).toEqual(uniquenessOp(texts, opts));
  });

  it('drops the LATER document of a near-dup pair, deterministically', () => {
    const texts = [
      'обзор казино бонусы для новичков и ветеранов сегодня вечером',
      'совсем другая статья про рыбалку в северных реках летом',
      'обзор казино бонусы для новичков и ветеранов сегодня вечером',
    ];
    expect(uniquenessOp(texts, { locale: 'ru' }).drop).toEqual([2]);
  });

  it('keeps a document whose only duplicate was itself dropped (A≈B, B≈C, A≉C)', () => {
    // Pairwise "drop the later one" discards both B and C — but once B is gone, C
    // duplicates nothing that remains, and its reported nearDupOf would point at a
    // document that is no longer in the pool.
    const a = 'обзор площадки бонусы для новичков и ветеранов сегодня вечером в чате';
    const b = 'обзор площадки бонусы для новичков и ветеранов сегодня утром на форуме';
    const c = 'разбор выплат бонусы для новичков и ветеранов сегодня утром на форуме';
    const result = uniquenessOp([a, b, c], { locale: 'ru', dedupJaccard: 0.3 });

    // The chain really exists: B is close to both, A and C are not close to each other.
    const pair = (x: number, y: number): number =>
      result.nearDup.find((p) => p.a === Math.min(x, y) && p.b === Math.max(x, y))?.jaccard ?? 0;
    expect(pair(0, 1)).toBeGreaterThanOrEqual(0.3);
    expect(pair(1, 2)).toBeGreaterThanOrEqual(0.3);
    expect(pair(0, 2)).toBeLessThan(0.3);

    expect(result.drop).toEqual([1]);
    expect(result.duplicateOf[1]!.of).toBe(0);
    expect(result.duplicateOf[2]).toBeUndefined();
  });

  it('every dropped document points at one that is still in the pool', () => {
    const texts = Array.from({ length: 6 }, (_, i) =>
      `обзор площадки бонусы для новичков сегодня вечером вариант ${i % 2}`,
    );
    const result = uniquenessOp(texts, { locale: 'ru' });
    const kept = new Set(texts.map((_, i) => i).filter((i) => !result.drop.includes(i)));
    for (const index of result.drop) {
      expect(kept.has(result.duplicateOf[index]!.of)).toBe(true);
    }
  });

  it('says outright that more variants of the same template will not help', () => {
    const shared = 'зарегистрируйтесь получите бонус и начните играть прямо сейчас без депозита';
    const texts = Array.from({ length: 8 }, (_, i) => `вступление ${i}. ${shared}`);
    const result = uniquenessOp(texts, { locale: 'ru', footprintMax: 0.15 });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/footprint .* exceeds/);
    expect(result.problems.join(' ')).toMatch(/NOT with more variants/);
  });

  it('passes a genuinely diverse pool', () => {
    const result = uniquenessOp(fixture(), { macros: ['#file_links#'], locale: 'ru' });
    expect(result.ok).toBe(true);
    expect(result.drop).toEqual([]);
  });

  it('a pool with zero exact duplicates can still share one skeleton', () => {
    // The finding the whole operation exists for. Exact-string dedupe is happy here —
    // every document differs — and the pool is still one skeleton wearing ten hats.
    const skeleton =
      'ставки на спорт принимаются круглосуточно на любой матч регулярного сезона ' +
      'а вывод выигрыша занимает считанные часы и не требует дополнительных заявок ' +
      'от игрока прошедшего проверку документов при первой регистрации на площадке';
    const texts = Array.from({ length: 10 }, (_, i) => `Вариант${i} ${skeleton}`);

    expect(new Set(texts).size).toBe(texts.length);
    const result = uniquenessOp(texts, { locale: 'ru' });
    expect(result.footprint.value).toBeGreaterThan(0.7);
    expect(result.nearDup.length).toBeGreaterThan(0);
    expect(result.ok).toBe(false);
  });

  it('the metric tracks variation DENSITY, not template count', () => {
    // Both pools below come from ONE template and have the same size. The dense one
    // varies every word: no unchanged five-word window survives, so it scores 0 — not
    // from some deep diversity, purely from density. Add a fixed bridge to the very
    // same documents and the number climbs, with the template count unchanged.
    const slots = [
      ['обзор', 'разбор', 'гид', 'справка', 'путеводитель', 'заметка'],
      ['площадки', 'конторы', 'сайта', 'сервиса', 'портала', 'ресурса'],
      ['помогает', 'позволяет', 'даёт', 'учит', 'предлагает', 'советует'],
      ['новичкам', 'игрокам', 'читателям', 'подписчикам', 'зрителям', 'гостям'],
      ['выбрать', 'подобрать', 'найти', 'оценить', 'сравнить', 'проверить'],
      ['бонус', 'подарок', 'приз', 'купон', 'промокод', 'кэшбэк'],
      ['быстро', 'сразу', 'мгновенно', 'моментально', 'заранее', 'легко'],
    ];
    const dense = Array.from({ length: 6 }, (_, i) => slots.map((slot) => slot[i]!).join(' '));
    expect(uniquenessOp(dense, { locale: 'ru' }).footprint.value).toBe(0);

    const bridge = 'и в этом материале мы разберём каждый пункт по порядку без спешки';
    const sparse = dense.map((t) => `${t} ${bridge}`);
    // Thirteen unchanged words are enough to move it off zero; the real pool went the
    // other way — 0.287 → 0.055 on one template, once no more than four unchanged words
    // were left in a row.
    expect(uniquenessOp(sparse, { locale: 'ru' }).footprint.value).toBeGreaterThan(0.1);
  });

  it('defaults match the measured campaign configuration', () => {
    expect(UNIQUENESS_DEFAULTS.shingleWidth).toBe(5);
    expect(UNIQUENESS_DEFAULTS.dedupJaccard).toBe(0.6);
    expect(UNIQUENESS_DEFAULTS.footprintShare).toBe(0.2);
    expect(UNIQUENESS_DEFAULTS.footprintMax).toBe(0.15);
    expect(UNIQUENESS_DEFAULTS.minPoolForFootprint).toBe(5);
  });
});

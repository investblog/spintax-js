import { describe, test, expect } from 'vitest';
import { postProcess } from '../src/internal/postprocess';
import { render } from '../src/index';

const NUL = '\x00';

describe('postProcess — capitalization', () => {
  test('first letter / after period / after ellipsis / after linebreak', () => {
    expect(postProcess('hello world')).toBe('Hello world');
    expect(postProcess('hello. world')).toBe('Hello. World');
    expect(postProcess('wait… really')).toBe('Wait… Really');
    expect(postProcess('line one\nline two')).toBe('Line one\nLine two');
  });
});

describe('postProcess — whitespace & punctuation', () => {
  test('collapse spaces / space before & after punctuation / digit-lookahead', () => {
    expect(postProcess('Word  with   spaces')).toBe('Word with spaces');
    expect(postProcess('Word , next')).toBe('Word, next');
    expect(postProcess('Hello ! World')).toBe('Hello! World');
    expect(postProcess('one,two')).toBe('One, two');
    expect(postProcess('Price 3,14 eur')).toBe('Price 3,14 eur'); // (?!\d) protects the number
    expect(postProcess('a.b')).toBe('A. B');
  });
  test('trim + collapse', () => {
    expect(postProcess('  hello  ')).toBe('Hello');
  });
});

describe('postProcess — shielding', () => {
  test('decimal / url (+ trailing punct) / email / domain', () => {
    expect(postProcess('Version 2.5 released')).toBe('Version 2.5 released');
    expect(postProcess('visit https://example.com now')).toBe('Visit https://example.com now');
    expect(postProcess('see https://example.com.')).toBe('See https://example.com.');
    expect(postProcess('mail me@example.com please')).toBe('Mail me@example.com please');
    expect(postProcess('visit example.com. next')).toBe('Visit example.com. Next');
    expect(postProcess('open xn--e1afmapc.xn--p1ai today')).toBe('Open xn--e1afmapc.xn--p1ai today');
  });
  test('mailto: / tel: URIs (spintax-js#41)', () => {
    // Shielded before the EMAIL pass so the whole URI survives — otherwise the
    // email is carved out and the bare 'mailto:' gets a space after its colon.
    expect(postProcess('email mailto:contact@example.com now')).toBe('Email mailto:contact@example.com now');
    expect(postProcess('<a href="mailto:contact@example.com">write us</a>')).toBe(
      '<a href="mailto:contact@example.com">Write us</a>',
    );
    // Trailing '.' splits off like a URL: sentence ends, address intact, next cap.
    expect(postProcess('see mailto:contact@example.com. next')).toBe('See mailto:contact@example.com. Next');
    expect(postProcess('reach us at tel:+1-800-555-0000 today')).toBe('Reach us at tel:+1-800-555-0000 today');
  });
  test('abbreviations (ru whitelist / en whitelist / multi-dot)', () => {
    // Single-token whitelist uses a \p{L} lookbehind (Unicode-aware), so Cyrillic works.
    expect(postProcess('Текст соц. сети тут')).toBe('Текст соц. сети тут');
    expect(postProcess('call Mr. smith now')).toBe('Call Mr. smith now');
    // Multi-dot: PHP's leading \b is UCP (/u), so a Cyrillic abbreviation is shielded like an ASCII
    // one. This test used to lock the opposite — 'т.д.' mangled "in both engines" — on the belief
    // that PHP's \b is ASCII; both PHP engines had rendered it intact all along. (The old assertion
    // was also vacuous: `.not.toBe('и т.д. далее')` passes on the capital 'И' alone.)
    expect(postProcess('See e.g. this')).toBe('See e.g. this');
    expect(postProcess('и т.д. далее')).toBe('И т.д. далее');
    expect(postProcess('то есть т. е. так')).toBe('То есть т. е. так');
  });
});

// Each shape below took seconds to minutes when the pass was a global regex replace retried from every
// start inside a long run, and each is a few hundred bytes of macros away from any renderer of untrusted
// templates. The scanners that replaced those passes are proven output-identical to the regexes by an
// exhaustive differential; these only pin that they stay linear. The bound is loose on purpose.
describe('postProcess — no pass rescans a long run from every start', () => {
  const N = 400_000;
  const within = (fn: () => void): void => {
    const started = Date.now();
    fn();
    expect(Date.now() - started).toBeLessThan(2_000);
  };

  test('the email and domain shields: a long word, dotted chains in any script, a hyphen run', () => {
    within(() => postProcess('a'.repeat(N)));
    within(() => postProcess(`x ${'a.'.repeat(N / 2)}`));
    within(() => postProcess(`x ${'а.'.repeat(N / 2)}`));
    within(() => postProcess(`x ${'1.'.repeat(N / 2)}`));
    within(() => postProcess('a-'.repeat(N / 2)));
  });

  test('a URL whose body is a run of trailing-punctuation characters', () => {
    within(() => postProcess(`see https://x${'.'.repeat(N)}a`));
  });

  test('a run of sentence marks followed by a digit or a space', () => {
    within(() => postProcess(`x${'.'.repeat(N)}1`));
    within(() => postProcess(`x${'?!'.repeat(N / 2)} y`));
  });

  test('capitalization across unclosed tags and runs of block tags', () => {
    within(() => postProcess('.<'.repeat(N / 2)));
    within(() => postProcess(`${'<p>'.repeat(N / 3)}1`));
    within(() => postProcess('\n<'.repeat(N / 2)));
  });

  test('the restore of a text carrying U+0000, which takes the reference loop’s reading (#54)', () => {
    // One split/join per placeholder: 100 000 decimals after a NUL would be 100 000 scans of the text.
    within(() => postProcess(`\x00${'1.1,'.repeat(N / 4)}`));
    within(() => postProcess(`\x00${'NUM_0\x00a.io '.repeat(N / 12)}`));
  });
});

// Every pattern of the cosmetic stage carries /u in PHP — the decimal shield alone does not — and /u
// is PCRE2_UCP. The expectations are the PHP engines' output (docker, both engines), not this one's.
describe('postProcess — character classes are PHP’s /u classes (UCP)', () => {
  const NBSP = String.fromCodePoint(0xa0);
  const THIN = String.fromCodePoint(0x2009);
  const NEL = String.fromCodePoint(0x85);
  const BOM = String.fromCodePoint(0xfeff);
  const ZWSP = String.fromCodePoint(0x200b);

  test('an IDN domain and an IDN email are shielded', () => {
    expect(postProcess('открой пример.рф сегодня')).toBe('Открой пример.рф сегодня');
    expect(postProcess('пишите на info@сайт.рф сегодня')).toBe('Пишите на info@сайт.рф сегодня');
    expect(postProcess('visit example.рф now')).toBe('Visit example.рф now');
  });

  test('NBSP, a thin space and NEL are whitespace; U+FEFF and U+200B are not', () => {
    expect(postProcess(`word${NBSP}, next`)).toBe('Word, next');
    expect(postProcess(`a,${NBSP}b`)).toBe(`A,${NBSP}b`);
    expect(postProcess(`end.${NBSP}next`)).toBe(`End.${NBSP}Next`);
    expect(postProcess(`end.${THIN}next`)).toBe(`End.${THIN}Next`);
    expect(postProcess(`end.${NEL}next`)).toBe(`End.${NEL}Next`);
    expect(postProcess(`end.${BOM}next`)).toBe(`End. ${BOM}next`);
    expect(postProcess(`end.${ZWSP}next`)).toBe(`End. ${ZWSP}next`);
    expect(postProcess(`в 5${NBSP}тыс.${NBSP}руб. всего`)).toBe(`В 5${NBSP}тыс.${NBSP}руб. всего`);
    expect(postProcess(`go to https://x.io/a${NBSP},next`)).toBe('Go to https://x.io/a, next');
  });

  test('the digit in the spacing lookahead is any decimal digit', () => {
    const ARABIC_INDIC_THREE = String.fromCodePoint(0x663);
    expect(postProcess(`a,${ARABIC_INDIC_THREE} b`)).toBe(`A,${ARABIC_INDIC_THREE} b`);
  });

  // Found in review of the class change: with more characters counting as whitespace, two old
  // quadratics got new triggers — and they were live in 0.7.0 already, for form feeds and `\n `.
  test('a long whitespace run is scanned once, not once per character', () => {
    const within = (fn: () => void): void => {
      const started = Date.now();
      fn();
      expect(Date.now() - started).toBeLessThan(2_000);
    };
    within(() => postProcess(`x${NBSP.repeat(200_000)}y`)); // no punctuation after the run: 10 s at half this
    within(() => postProcess(`x${'\f'.repeat(200_000)}y`));
    within(() => postProcess(`x${`\n${NBSP}`.repeat(100_000)}1`)); // breaks, no letter: 4 s at a fifth of this
  });

  test('a TLD is a label in one case, so a capital after the dot starts a sentence (#79)', () => {
    expect(postProcess('конец.Начало')).toBe('Конец. Начало');
    expect(postProcess('end.Начало')).toBe('End. Начало');
    expect(postProcess('built on ASP.NET and example.com')).toBe('Built on ASP.NET and example.com');
    // The domain patterns carry no `i`: under it a `\p{Ll}` matches capitals, and `Com` would be a TLD again.
    expect(postProcess('write to info@Example.COM, not info@example.Com')).toBe('Write to info@Example.COM, not info@example. Com');
    // The punycode form keeps the plugin's caseless reading.
    expect(postProcess('see a.XN--P1ai and b.xn--p1AI')).toBe('See a.XN--P1ai and b.xn--p1AI');
    // A letter without case opens the lower-case branch as well as the upper-case one.
    expect(postProcess('see a.中a here')).toBe('See a.中a here');
    // '_' and 'т' are both word characters: no boundary, so the multi-dot shield does not fire.
    expect(postProcess('x _т.д. y')).toBe('X _т. Д. Y');
  });
});

// The restore step (12) has two readings behind one guard: a single left-to-right token pass when
// the input carries no \x00, and the result of the per-key split/join loop when it does. Run as a
// loop that is O(text × placeholders) — 39 s on a 950 KB render (spintax-js#52) — so the \x00 path
// computes the loop's result in one pass instead; the token pass only agrees with the loop when no
// \x00 came in from the caller. Nothing pinned the \x00 behaviour before, which is why dropping the
// guard would land unnoticed.
describe('postProcess — placeholder restore (spintax-js#52)', () => {
  test('shield-heavy text round-trips through the fast path', () => {
    expect(
      postProcess('visit https://example.com/a?b=1 or mail me@example.co.uk before 3.14, e.g. now'),
    ).toBe('Visit https://example.com/a?b=1 or mail me@example.co.uk before 3.14, e.g. now');
    // Many placeholders in one text: each restores to its own value, none to a neighbour's.
    const many = Array.from({ length: 40 }, (_, i) => `see https://example.com/p${i} and 1.${i} now.`).join(' ');
    expect(postProcess(many)).toBe(
      Array.from({ length: 40 }, (_, i) => `See https://example.com/p${i} and 1.${i} now.`).join(' '),
    );
  });

  test('a literal \\x00 in the input keeps the per-key loop’s result, quirks and all', () => {
    // split(key).join(value) replaces EVERY occurrence of a key — including one the caller's
    // own text happened to spell. A single pass would leave the caller's copy alone.
    expect(postProcess(`see ${NUL}URL_0${NUL} and https://example.com now`)).toBe(
      'See https://example.com and https://example.com now',
    );
    // An unpaired \x00 from the input pairs with a real placeholder's opening delimiter into a
    // key that was never minted. The loop never sees it; a single pass would consume it and so
    // lose the genuine key that follows.
    expect(postProcess(`hello world${NUL}DOM_2http://x.io/p?q=1`)).toBe(
      `Hello world${NUL}DOM_2http://x.io/p?q=1`,
    );
    // The report's own case, all three effects at once.
    expect(postProcess(`</p>${NUL}NUM_9${NUL}http://x.io/p?q=1${NUL}URI_1${NUL}. ${NUL}tel:+1-555-0100`)).toBe(
      `</p>${NUL}NUM_9${NUL}http://x.io/p?q=1tel:+1-555-0100. ${NUL}tel:+1-555-0100`,
    );
  });

  // The guard is NOT exact, and the comment above restore() used to claim it was (spintax-js#54).
  // A placeholder's delimiters are not owned by the token that placed them, so two adjacent
  // placeholders can sandwich author text that spells a key and forge a third occurrence of a
  // real one — with no \x00 in the input, and so on the fast path. The loop substitutes the
  // forgery, destroys both real tokens and returns raw \x00 from \x00-free input; the single pass
  // tokenises left to right and never sees it. That divergence is the reason this is a corpus
  // fixture too: the engines did not agree on it.
  test('adjacent placeholders around an author-written key name (spintax-js#54)', () => {
    const src = 'https://a.io e.g. URL_0mailto:x@y.io';
    expect(src).not.toContain(NUL);
    expect(postProcess(src)).toBe(src);
    expect(postProcess(src)).not.toContain(NUL);
    // The same shape reached through the abbreviation shield rather than the URL one. The space
    // before 'т' is load-bearing: under UCP a letter glued to it is no boundary, and the shield
    // would not fire at all (this input read 'worldт.д.' while the boundary was ASCII).
    expect(postProcess('hello world т.д.URL_0http://x.io/p?q=1')).toBe(
      'Hello world т.д.URL_0http://x.io/p?q=1',
    );
  });
});

// URIs shield in ONE pass. Two passes let the second run into a placeholder the first had
// minted, and the swallowed key then never restored — postProcess emitted a raw U+0000 on input
// that carried none: illegal in XML, U+FFFD to an HTML parser, rejected by Postgres `text`, and
// a live key again once an edit detaches it from the prefix that was shielding it.
describe('postProcess — overlapping URIs shield as one token (spintax-js#53)', () => {
  test('a URL inside a mailto:/tel: URI', () => {
    expect(postProcess('mailto:sales@example.com?body=see%20https://shop.example.com/cart')).toBe(
      'mailto:sales@example.com?body=see%20https://shop.example.com/cart',
    );
    expect(postProcess('write to mailto:a@b.com?subject=Re:%20https://x.io/p please')).toBe(
      'Write to mailto:a@b.com?subject=Re:%20https://x.io/p please',
    );
    expect(postProcess('contact mailto:https://shop.example.com/cart now')).toBe(
      'Contact mailto:https://shop.example.com/cart now',
    );
    // A tel: and a URL joined by a comma — the comma is inside the URI body class, so the whole
    // run is one token and the "space after ," rule must not reach into it.
    expect(postProcess('call tel:+1-555-0100,https://x.io/p now')).toBe(
      'Call tel:+1-555-0100,https://x.io/p now',
    );
  });

  test('the mirror case — a mailto:/tel: inside a URL', () => {
    // What an ordering fix would have broken instead: shielding mailto: first splits this URL,
    // and the leading half loses its trailing dot to the punctuation pass. One pass has no
    // second pass to do that with.
    expect(postProcess('https://x.io/?to=mailto:a@b.com')).toBe('https://x.io/?to=mailto:a@b.com');
    expect(postProcess('see https://x.io/a.mailto:contact@example.com now')).toBe(
      'See https://x.io/a.mailto:contact@example.com now',
    );
    expect(postProcess('https://x.io/p?q=tel:+1-555-0100 now')).toBe('https://x.io/p?q=tel:+1-555-0100 now');
  });

  test('no U+0000 reaches the caller from input that has none', () => {
    for (const src of [
      'mailto:sales@example.com?body=see%20https://shop.example.com/cart',
      'contact mailto:https://shop.example.com/cart now',
      'call tel:+1-555-0100,https://x.io/p now',
      'https://x.io/?to=mailto:a@b.com',
    ]) {
      expect(postProcess(src)).not.toContain(NUL);
    }
  });

  test('a plain mailto:/tel: is untouched — the #41 shield still holds', () => {
    expect(postProcess('mailto:plain@example.com')).toBe('mailto:plain@example.com');
    expect(postProcess('write mailto:contact@example.com now')).toBe('Write mailto:contact@example.com now');
    expect(postProcess('reach us at tel:+1-800-555-0000 today')).toBe('Reach us at tel:+1-800-555-0000 today');
  });
});

// Spanish is the only European language whose punctuation OPENS a sentence. The spacing and
// capitalization passes were written as if a sentence always begins with a letter, so every
// Spanish question silently lost its capital: the capitalizer upper-cased '¿', which has no
// uppercase form, and left the real first letter alone.
describe('sentence openers — ¿ and ¡ (Spanish)', () => {
  test('capitalizes the letter after an opener at the start of the text', () => {
    expect(postProcess('¿cómo estás?')).toBe('¿Cómo estás?');
    expect(postProcess('¡genial!')).toBe('¡Genial!');
  });

  test('capitalizes after sentence-ending punctuation, through the opener', () => {
    expect(postProcess('hola. ¿cómo estás? ¡genial!')).toBe('Hola. ¿Cómo estás? ¡Genial!');
  });

  test('the opener binds to the word it opens', () => {
    expect(postProcess('Hola. ¿ qué tal ?')).toBe('Hola. ¿Qué tal?');
    expect(postProcess('¡ genial !')).toBe('¡Genial!');
  });

  test('a space BEFORE the opener is kept — that one is correct Spanish', () => {
    expect(postProcess('Hola, ¿qué tal?')).toBe('Hola, ¿qué tal?');
  });

  test('works after a block tag (the plugin renders HTML paragraphs) and after a newline', () => {
    expect(postProcess('<p>¿cómo estás?</p><p>¡genial!</p>')).toBe(
      '<p>¿Cómo estás?</p><p>¡Genial!</p>',
    );
    expect(postProcess('Hola.\n¿cómo estás?')).toBe('Hola.\n¿Cómo estás?');
  });

  // The opener set is deliberately NARROW. Quotes and brackets both open AND close, so treating
  // them as openers would capitalize list markers. Lock that out.
  test('quotes and brackets are NOT openers', () => {
    expect(postProcess('Elige una. (a) primero')).toBe('Elige una. (a) primero');
    expect(postProcess('Он сказал. "привет"')).toBe('Он сказал. "привет"');
  });

  // `¡¿Qué haces?!` is RAE's form for a sentence that is both question and exclamation, so a lead
  // that allows exactly ONE opener leaves the most Spanish construction there is uncapitalized.
  test('a sentence can open with TWO marks', () => {
    expect(postProcess('¡¿qué haces?!')).toBe('¡¿Qué haces?!');
    expect(postProcess('¿¡qué haces!?')).toBe('¿¡Qué haces!?');
    expect(postProcess('hola. ¡¿qué haces?! adiós')).toBe('Hola. ¡¿Qué haces?! Adiós');
  });

  // The opened word is routinely wrapped in markup, which puts a tag AFTER the opener — the lead
  // has to allow tags on both sides of it, not just before.
  test('capitalizes through an opener followed by an inline tag', () => {
    expect(postProcess('¿<strong>cómo</strong> estás?')).toBe('¿<strong>Cómo</strong> estás?');
    expect(postProcess('Hola. ¿<em>qué</em> tal?')).toBe('Hola. ¿<em>Qué</em> tal?');
    expect(postProcess('<p>¿<a href="/ayuda">necesitas ayuda</a>?</p>')).toBe(
      '<p>¿<a href="/ayuda">Necesitas ayuda</a>?</p>',
    );
  });
});

// A run of sentence punctuation is ONE sentence end, not several. The "space after .!?" rule fired
// between the marks and shredded the copy — in every language, not just Spanish: "Wow! ! !",
// "Wait. . . what", "Really? !". The ASCII ellipsis is the common casualty; the Unicode "…" was
// never in the class and so was never affected.
describe('sentence punctuation runs', () => {
  test('a run is never split from the inside', () => {
    expect(postProcess('wait... what?')).toBe('Wait... What?');
    expect(postProcess('wow!!!')).toBe('Wow!!!');
    expect(postProcess('really?! yes.')).toBe('Really?! Yes.');
    expect(postProcess('Что?! Не может быть!!')).toBe('Что?! Не может быть!!');
  });

  test('the space goes after the whole run when the next word touches it', () => {
    expect(postProcess('wait...what?')).toBe('Wait... What?');
    expect(postProcess('hola.¡genial!')).toBe('Hola. ¡Genial!');
  });

  test('a single mark still gets its space', () => {
    expect(postProcess('a.b')).toBe('A. B');
  });

  // The closer rule itself is corpus contract (postprocess/closing-* and the guards after them); this
  // pins only its cost. The lookahead reads the run of quotes after a mark once per mark run.
  test('a long run of quotes after the marks is read once', () => {
    const within = (fn: () => void): void => {
      const started = Date.now();
      fn();
      expect(Date.now() - started).toBeLessThan(2_000);
    };
    within(() => postProcess(`${'?'.repeat(200_000)}${'"'.repeat(200_000)}a`));
    within(() => postProcess(`${','.repeat(200_000)}${'"'.repeat(200_000)}a`));
    within(() => postProcess(',""a'.repeat(100_000)));
  });
});

describe('render — postProcess is on by default, off with postProcess:false', () => {
  test('default capitalizes; false leaves the raw pick', () => {
    expect(render('{a|b|c}', { seed: 1 })).toMatch(/^[ABC]$/); // capitalized
    expect(render('hello world')).toBe('Hello world');
    expect(render('hello world', { postProcess: false })).toBe('hello world');
  });
});

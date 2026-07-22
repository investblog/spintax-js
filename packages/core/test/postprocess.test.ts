import { describe, test, expect } from 'vitest';
import { postProcess } from '../src/internal/postprocess';
import { render } from '../src/index';

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
    // Multi-dot uses \b which — like PHP PCRE without UCP — is ASCII, so it shields
    // ASCII abbreviations (e.g.) but NOT a Cyrillic one (т.д.). Parity holds either way.
    expect(postProcess('See e.g. this')).toBe('See e.g. this');
    // Lock the divergence: a Cyrillic multi-dot is NOT shielded ⇒ mangled (both engines).
    expect(postProcess('и т.д. далее')).not.toBe('и т.д. далее');
  });
});

// The restore step (12) has two implementations behind one guard: a single left-to-right pass
// when the input carries no \x00, and the original per-key split/join loop when it does. The
// loop is O(text × placeholders) and cost 39 s on a 950 KB render (spintax-js#52); the single
// pass is ~100× faster but only agrees with the loop when no \x00 came in from the caller.
// Nothing pinned the \x00 behaviour before, which is why dropping the guard would land unnoticed.
describe('postProcess — placeholder restore (spintax-js#52)', () => {
  const NUL = '\x00';

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

  test('a literal \\x00 in the input keeps the per-key loop, quirks and all', () => {
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

  test('a nested placeholder stays literal on both paths', () => {
    // \x00 is not excluded from the URI body class, so a `mailto:` glued to an already-shielded
    // URL stores a value that itself contains URL_0's key. The loop is past URL_0 by the time
    // that value lands in the text, and String.replace does not rescan a callback's output —
    // so both paths leave it literal. Pinned as the shared behaviour, not as a desirable one.
    expect(postProcess('mailto:http://x.io/p')).toBe(`mailto:${NUL}URL_0${NUL}`);
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
});

describe('render — postProcess is on by default, off with postProcess:false', () => {
  test('default capitalizes; false leaves the raw pick', () => {
    expect(render('{a|b|c}', { seed: 1 })).toMatch(/^[ABC]$/); // capitalized
    expect(render('hello world')).toBe('Hello world');
    expect(render('hello world', { postProcess: false })).toBe('hello world');
  });
});

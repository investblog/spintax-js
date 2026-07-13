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
});

describe('render — postProcess is on by default, off with postProcess:false', () => {
  test('default capitalizes; false leaves the raw pick', () => {
    expect(render('{a|b|c}', { seed: 1 })).toMatch(/^[ABC]$/); // capitalized
    expect(render('hello world')).toBe('Hello world');
    expect(render('hello world', { postProcess: false })).toBe('hello world');
  });
});

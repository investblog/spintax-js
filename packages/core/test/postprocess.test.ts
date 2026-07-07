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

describe('render — postProcess is on by default, off with postProcess:false', () => {
  test('default capitalizes; false leaves the raw pick', () => {
    expect(render('{a|b|c}', { seed: 1 })).toMatch(/^[ABC]$/); // capitalized
    expect(render('hello world')).toBe('Hello world');
    expect(render('hello world', { postProcess: false })).toBe('hello world');
  });
});

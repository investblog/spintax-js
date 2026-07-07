/**
 * Cosmetic post-process — faithful port of the plugin's `Parser::post_process`
 * (parity-target §5). Order matters: URLs / emails / domains / decimals /
 * abbreviations are shielded to `\x00…\x00` placeholders FIRST so the
 * spacing/capitalization passes don't corrupt them, then restored + trimmed.
 *
 * This is the COSMETIC stage (gated by `postProcess`). The mandatory neutralize
 * safety-restore (§6) is separate (M2e) and always runs.
 */

// Single-token abbreviations (case-insensitive) that would otherwise look like a
// sentence end. Multi-dot forms (т.д.) are handled by the 5a regex.
const SINGLE_ABBREVS = [
  // Russian editorial / address / unit shorthands.
  'соц', 'эл', 'см', 'ср', 'ст', 'ул', 'пр', 'пер', 'г', 'р', 'руб', 'коп',
  'тыс', 'млн', 'млрд', 'трлн', 'доп', 'напр', 'прим', 'изд', 'обл', 'респ',
  'стр', 'табл', 'рис', 'мин', 'макс', 'тел', 'факс',
  // English titles / business suffixes / editorial.
  'etc', 'vs', 'Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Sr', 'Jr', 'Inc', 'Ltd', 'Co',
  'Corp', 'No', 'St', 'Ave', 'Blvd',
];

// ASCII whitespace only — PHP `\s`/`\b` under /u (no PCRE_UCP) are ASCII, while
// JS `\s` is Unicode. Using `\s` would diverge around NBSP / thin spaces, so every
// whitespace class below is the explicit ASCII set. (`\b` in JS is already ASCII.)
const WS = ' \\t\\r\\n\\f\\x0B';
const S = `[${WS}]`;

const DOMAIN_PART =
  '(?:(?:(?:xn--)?[\\p{L}\\p{N}]+(?:-[\\p{L}\\p{N}]+)*)\\.)+(?:xn--[a-z0-9\\-]{2,59}|[\\p{L}][\\p{L}\\p{N}-]{1,62})';
const URL_RE = new RegExp(`(?:https?|ftp):\\/\\/[^${WS}<>"')\\]]+`, 'giu');
const EMAIL_RE = new RegExp(`[a-z0-9._%+\\-]+@${DOMAIN_PART}\\b`, 'giu');
const DOMAIN_RE = new RegExp(`\\b${DOMAIN_PART}\\b`, 'giu');
const DECIMAL_RE = /\b\d+\.\d+\b/gu;
const MULTI_ABBR_RE = new RegExp(`\\b(?:\\p{L}{1,2}\\.${S}*){2,}`, 'gu');
const SINGLE_ABBR_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${SINGLE_ABBREVS.join('|')})\\.(?=${S}|$|<)`, 'giu');
const TRAILING_PUNCT_RE = /([.,;:!]+)$/u;

// Spacing + capitalization (all ASCII-whitespace).
const SPACE_BEFORE_PUNCT_RE = new RegExp(`${S}+([,;:!?.])`, 'gu');
const SPACE_AFTER_COMMA_RE = new RegExp(`([,;:])(?!\\d)(?!${S}|$|<)`, 'gu');
const SPACE_AFTER_SENTENCE_RE = new RegExp(`([.!?])(?!\\d)(?!${S}|$|<)`, 'gu');
const CAP_FIRST_RE = new RegExp(`^(${S}*(?:<[^>]+>${S}*)*)(\\p{Ll})`, 'u');
const CAP_AFTER_SENTENCE_RE = new RegExp(`([.!?…])(${S}*(?:<\\/?[^>]+>${S}*)*)(\\p{Ll})`, 'gu');
const CAP_AFTER_BLOCK_RE = new RegExp(`(<\\/?(?:p|h[1-6]|li|blockquote|div|td|th)[^>]*>${S}*)(\\p{Ll})`, 'giu');
const CAP_AFTER_BREAK_RE = new RegExp(`(\\n${S}*)(\\p{Ll})`, 'gu');

const up = (ch: string): string => ch.toUpperCase();

export function postProcess(input: string): string {
  const placeholders = new Map<string, string>();
  let counter = 0;

  const store = (value: string, prefix: string): string => {
    const key = `\x00${prefix}_${counter}\x00`;
    placeholders.set(key, value);
    counter += 1;
    return key;
  };
  const storeWithTrailingPunct = (value: string, prefix: string): string => {
    const m = TRAILING_PUNCT_RE.exec(value);
    if (m) {
      const suffix = m[1] ?? '';
      const body = value.slice(0, value.length - suffix.length);
      return body === '' ? suffix : store(body, prefix) + suffix;
    }
    return store(value, prefix);
  };

  let text = input;

  // 1-5: shield.
  text = text.replace(URL_RE, (m) => storeWithTrailingPunct(m, 'URL'));
  text = text.replace(EMAIL_RE, (m) => store(m, 'EMAIL'));
  text = text.replace(DOMAIN_RE, (m) => store(m, 'DOM'));
  text = text.replace(DECIMAL_RE, (m) => store(m, 'NUM'));
  text = text.replace(MULTI_ABBR_RE, (m) => store(m, 'ABBR'));
  text = text.replace(SINGLE_ABBR_RE, (m) => store(m, 'ABBR'));

  // 6: collapse duplicate spaces/tabs.
  text = text.replace(/[ \t]{2,}/gu, ' ');

  // 7: punctuation spacing. Remove whitespace before punctuation, then add a
  // space after ,;: and .!? unless followed by a digit / space / end / tag.
  text = text.replace(SPACE_BEFORE_PUNCT_RE, '$1');
  text = text.replace(SPACE_AFTER_COMMA_RE, '$1 ');
  text = text.replace(SPACE_AFTER_SENTENCE_RE, '$1 ');

  // 8: capitalize the first letter (skipping leading HTML tags).
  text = text.replace(CAP_FIRST_RE, (_m, lead: string, ch: string) => lead + up(ch));
  // 9: capitalize after sentence punctuation (through HTML tags).
  text = text.replace(CAP_AFTER_SENTENCE_RE, (_m, p: string, gap: string, ch: string) => p + gap + up(ch));
  // 10: capitalize after block-level HTML tags.
  text = text.replace(CAP_AFTER_BLOCK_RE, (_m, tag: string, ch: string) => tag + up(ch));
  // 11: capitalize after line breaks.
  text = text.replace(CAP_AFTER_BREAK_RE, (_m, br: string, ch: string) => br + up(ch));

  // 12: restore placeholders, then trim.
  for (const [key, value] of placeholders) {
    text = text.split(key).join(value);
  }
  return text.trim();
}

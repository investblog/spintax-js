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
// `mailto:`/`tel:` URIs have no `//` authority, so URL_RE misses them. Without
// this shield the EMAIL/DOMAIN passes swallow the address, the bare `mailto:` /
// `tel:` prefix is left behind, and the "space after :" rule splits it into a
// malformed `mailto: contact@…` href (spintax-js#41).
const MAILTEL_RE = new RegExp(`(?:mailto|tel):[^${WS}<>"')\\]]+`, 'giu');
const EMAIL_RE = new RegExp(`[a-z0-9._%+\\-]+@${DOMAIN_PART}\\b`, 'giu');
const DOMAIN_RE = new RegExp(`\\b${DOMAIN_PART}\\b`, 'giu');
const DECIMAL_RE = /\b\d+\.\d+\b/gu;
const MULTI_ABBR_RE = new RegExp(`\\b(?:\\p{L}{1,2}\\.${S}*){2,}`, 'gu');
const SINGLE_ABBR_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${SINGLE_ABBREVS.join('|')})\\.(?=${S}|$|<)`, 'giu');
const TRAILING_PUNCT_RE = /([.,;:!]+)$/u;

/**
 * SENTENCE OPENERS — the inverted marks that OPEN a Spanish question/exclamation.
 *
 * Every other European language only ever *closes* with punctuation, which is why the spacing and
 * capitalization passes below were written as if a sentence always begins with a letter. In Spanish
 * it does not: `¿cómo estás?` begins with `¿`, and the capitalizer — which upper-cases the first
 * *character* after a boundary — hits a mark that has no uppercase form and silently leaves the
 * real first letter lowercase.
 *
 * Named explicitly, and deliberately NOT widened to quotes/brackets/«»: those both open and close,
 * and capitalizing after them would mangle list markers ("Elige. (a) primero" → "(A) primero").
 * This constant encodes the language semantics of Spanish punctuation, not a general "skip anything
 * that isn't a letter" rule.
 */
const SENTENCE_OPENERS = '¿¡';
/**
 * The LEAD — everything that can sit between a sentence boundary and the first letter: HTML tags,
 * sentence openers and whitespace, in any order and any number.
 *
 * A single optional opener is not enough. `¡¿Qué haces?!` — RAE's form for a sentence that is both
 * a question and an exclamation — opens with TWO marks, and the opened word is routinely wrapped in
 * markup (`<p>¿<a href="/ayuda">Necesitas ayuda</a>?</p>`), which puts a tag AFTER the opener.
 * Whatever the lead fails to cover silently keeps a lowercase first letter.
 */
const LEAD = `(?:<[^>]+>|[${SENTENCE_OPENERS}]|${S})*`;

// Spacing + capitalization (all ASCII-whitespace).
const SPACE_BEFORE_PUNCT_RE = new RegExp(`${S}+([,;:!?.])`, 'gu');
const SPACE_AFTER_COMMA_RE = new RegExp(`([,;:])(?!\\d)(?!${S}|$|<)`, 'gu');
// A run of sentence punctuation is ONE sentence end, not several: "..." and "?!" have to survive
// intact, so the space goes after the whole run. `(?![.!?])` is what completes the run — a greedy
// `+` on its own still backtracks INTO it to satisfy the lookaheads, turning "Wow!!!" into
// "Wow!! !". (JS has no possessive quantifiers, and PHP must match this shape exactly.)
const SPACE_AFTER_SENTENCE_RE = new RegExp(`([.!?]+)(?![.!?])(?!\\d)(?!${S}|$|<)`, 'gu');
// An opener binds to the word it opens: "¿ qué tal ?" → "¿qué tal?". MUST run before the
// capitalization passes, so they see the real first letter instead of a space.
const SPACE_AFTER_OPENER_RE = new RegExp(`([${SENTENCE_OPENERS}])${S}+`, 'gu');
const CAP_FIRST_RE = new RegExp(`^(${LEAD})(\\p{Ll})`, 'u');
const CAP_AFTER_SENTENCE_RE = new RegExp(`([.!?…])(${LEAD})(\\p{Ll})`, 'gu');
const CAP_AFTER_BLOCK_RE = new RegExp(
  `(<\\/?(?:p|h[1-6]|li|blockquote|div|td|th)[^>]*>${LEAD})(\\p{Ll})`,
  'giu',
);
const CAP_AFTER_BREAK_RE = new RegExp(`(\\n${LEAD})(\\p{Ll})`, 'gu');

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

  // 1-5: shield. mailto:/tel: shielded before EMAIL/DOMAIN so the whole URI
  // survives instead of the address being carved out from under its prefix.
  text = text.replace(URL_RE, (m) => storeWithTrailingPunct(m, 'URL'));
  text = text.replace(MAILTEL_RE, (m) => storeWithTrailingPunct(m, 'URI'));
  text = text.replace(EMAIL_RE, (m) => store(m, 'EMAIL'));
  text = text.replace(DOMAIN_RE, (m) => store(m, 'DOM'));
  text = text.replace(DECIMAL_RE, (m) => store(m, 'NUM'));
  text = text.replace(MULTI_ABBR_RE, (m) => store(m, 'ABBR'));
  text = text.replace(SINGLE_ABBR_RE, (m) => store(m, 'ABBR'));

  // 6: collapse duplicate spaces/tabs.
  text = text.replace(/[ \t]{2,}/gu, ' ');

  // 7: punctuation spacing. Remove whitespace before punctuation, then add a
  // space after ,;: and after a RUN of .!? unless followed by a digit / space / end / tag.
  text = text.replace(SPACE_BEFORE_PUNCT_RE, '$1');
  text = text.replace(SPACE_AFTER_COMMA_RE, '$1 ');
  text = text.replace(SPACE_AFTER_SENTENCE_RE, '$1 ');
  // 7a: a Spanish opener binds to the word it opens. Before capitalization, deliberately.
  text = text.replace(SPACE_AFTER_OPENER_RE, '$1');

  // 8: capitalize the first letter (skipping leading HTML tags and sentence openers).
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

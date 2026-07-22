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
/**
 * URIs — `https?`/`ftp` (with a `//` authority) and `mailto:`/`tel:` (without one) — shielded
 * in ONE pass, deliberately.
 *
 * They used to be two passes, URLs then `mailto:`/`tel:`. A URI body runs to the first
 * delimiter, so the two match sets overlap whenever one URI contains the other's scheme, and
 * with two passes the second one runs into a placeholder the first already minted:
 * `mailto:sales@x.com?body=see%20https://shop.x.com/cart` shielded the URL first, then stored
 * a `mailto:` value with URL_0's key inside it. Restore was past that key by the time the value
 * landed, so the engine emitted a raw U+0000 — illegal in XML, U+FFFD to an HTML parser,
 * rejected by Postgres `text`, and a live key again as soon as an edit detaches it from the
 * prefix that was shielding it (spintax-js#53).
 *
 * Neither pass order fixes that, because whichever runs second is the one that gets split:
 * ordering `mailto:` first instead only moves the damage onto a URL whose path carries a
 * `mailto:`, where the leading half then loses its trailing dot to the punctuation pass
 * (`https://x.io/a.mailto:…` → `https://x.io/a. mailto:…`). A single alternation has no second
 * pass to damage: the leftmost match wins and takes the whole token, whichever scheme it is.
 *
 * `\x00` stays out of the body class regardless. Nothing is shielded yet when this pass runs,
 * so on ordinary input it never bites; it is there for a caller-supplied U+0000, which would
 * otherwise let a URI match run through the delimiters of a placeholder minted after it.
 */
const URI_BODY = `[^\\x00${WS}<>"')\\]]`;
const URI_RE = new RegExp(`(?:(?:https?|ftp):\\/\\/|(?:mailto|tel):)${URI_BODY}+`, 'giu');
// Which placeholder prefix a match gets. Kept distinct (URL vs URI) even though one pass mints
// both: the prefixes are what the other engines' fixtures and #52's restore regex speak.
const MAILTEL_PREFIX_RE = /^(?:mailto|tel):/iu;
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

// The shield's placeholder prefixes, in one place: RESTORE_RE below is built from this
// list, so a new shield pass cannot mint a key shape the single-pass restore fails to
// recognise. Keep the two in step by construction, not by memory.
const SHIELD_PREFIXES = ['URL', 'URI', 'EMAIL', 'DOM', 'NUM', 'ABBR'] as const;
type ShieldPrefix = (typeof SHIELD_PREFIXES)[number];
const RESTORE_RE = new RegExp(`\\x00(?:${SHIELD_PREFIXES.join('|')})_\\d+\\x00`, 'gu');

/**
 * Restore the shielded values (step 12).
 *
 * The reference form is one `split(key).join(value)` per key — a full scan of the text
 * per placeholder, so O(text × placeholders). Every URL, URI, email, domain, decimal and
 * abbreviation is shielded, so on shield-heavy output the placeholder count grows with
 * the text and this stage comes to dominate the render: 39 s on a 950 KB render, against
 * 0.07 s with `postProcess: false` (spintax-js#52).
 *
 * A single left-to-right pass is NOT the same function, because the loop is a repeated
 * SUBSTRING substitution and the pass is a token substitution. `split/join` rewrites every
 * occurrence of a key, not only the one the shield placed. Three shapes make them differ:
 * the caller's own text spells a key the shield goes on to mint; an unpaired `\x00` from
 * the input pairs with a real placeholder's delimiter; and — needing no `\x00` from the
 * caller at all — two adjacent placeholders sandwich caller text that spells a key, so one
 * token's CLOSING delimiter, that text, and the next token's OPENING delimiter form a
 * third occurrence of a key that really was minted. Delimiters are not owned by the token
 * that placed them.
 *
 * The guard therefore removes the `\x00`-borne disagreements; it does not make the two
 * functions equal, and an earlier version of this comment claimed a proof that does not
 * hold (spintax-js#54). Measured over a 456 976-input differential sweep whose fragments
 * include bare key names: 13 266 inputs distinguish the two restores, 12 of them carrying
 * no `\x00`. On every one of those 12 it is the LOOP that is wrong — it emits a raw U+0000
 * from `\x00`-free input, wrecking two real tokens to serve a forged one — and the single
 * pass returns the text intact. So the fast path is not merely faster on the shape that
 * survives the guard; it is the answer we want there, and the guard's whole remaining
 * effect is the 13 254 `\x00`-carrying inputs where the loop's reading is the defensible
 * one. Real text carries no `\x00`, so the fast path is what actually runs.
 *
 * Neither path rescans a value it inserted, which is what makes them agree even if a stored
 * value ever came to contain another key. On `\x00`-free input none can: URI_BODY excludes
 * `\x00` and every other shield class is letters/digits/dots, so no match can span a
 * placeholder (spintax-js#53). The property is worth stating because it is the one an
 * ordering change could quietly take away.
 */
function restore(text: string, input: string, placeholders: Map<string, string>): string {
  if (!input.includes('\x00')) {
    return text.replace(RESTORE_RE, (key) => placeholders.get(key) ?? key);
  }
  let out = text;
  for (const [key, value] of placeholders) {
    out = out.split(key).join(value);
  }
  return out;
}

export function postProcess(input: string): string {
  const placeholders = new Map<string, string>();
  let counter = 0;

  const store = (value: string, prefix: ShieldPrefix): string => {
    const key = `\x00${prefix}_${counter}\x00`;
    placeholders.set(key, value);
    counter += 1;
    return key;
  };
  const storeWithTrailingPunct = (value: string, prefix: ShieldPrefix): string => {
    const m = TRAILING_PUNCT_RE.exec(value);
    if (m) {
      const suffix = m[1] ?? '';
      const body = value.slice(0, value.length - suffix.length);
      return body === '' ? suffix : store(body, prefix) + suffix;
    }
    return store(value, prefix);
  };

  let text = input;

  // 1-5: shield. URIs go first and in one pass, so an overlapping pair is never split
  // (spintax-js#53), and always before EMAIL/DOMAIN, so the whole `mailto:` survives
  // instead of the address being carved out from under its prefix (spintax-js#41).
  text = text.replace(URI_RE, (m) =>
    storeWithTrailingPunct(m, MAILTEL_PREFIX_RE.test(m) ? 'URI' : 'URL'),
  );
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
  return restore(text, input, placeholders).trim();
}

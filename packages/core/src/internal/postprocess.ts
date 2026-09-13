/**
 * Cosmetic post-process — faithful port of the plugin's `Parser::post_process`
 * (parity-target §5). Order matters: URLs / emails / domains / decimals /
 * abbreviations are shielded to `\x00…\x00` placeholders FIRST so the
 * spacing/capitalization passes don't corrupt them, then restored + trimmed.
 *
 * This is the COSMETIC stage (gated by `postProcess`). The mandatory neutralize
 * safety-restore (§6) is separate (M2e) and always runs.
 */
import { isUcpSpace, UCP_SPACE, UCP_WORD } from './charclass';

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

// Every pattern of this stage carries /u in PHP — the decimal shield alone does not — and /u is
// PCRE2_UCP: `\s` takes NBSP and the rest of \p{Z}, `\b` and `\d` see every script. So the
// classes are UCP, spelled out (./charclass); this block once said the opposite, and Cyrillic
// abbreviations, IDN domains and NBSP were mangled here while PHP rendered them intact.
const WS = UCP_SPACE;
const S = `[${WS}]`;
/**
 * `\b` in front of a pattern that begins with a word character: the character before is not one.
 * Equivalent to PHP's leading `\b` there, and a single lookbehind instead of two alternatives.
 */
const AFTER_NON_WORD = `(?<![${UCP_WORD}])`;
/** `\b` in general — a TLD can end in `-`, so the boundary after a domain can go either way. */
const WORD_BOUNDARY = `(?:(?<=[${UCP_WORD}])(?![${UCP_WORD}])|(?<![${UCP_WORD}])(?=[${UCP_WORD}]))`;

const LABEL = '(?:xn--)?[\\p{L}\\p{N}]+(?:-[\\p{L}\\p{N}]+)*';
const DOMAIN_PART = `(?:${LABEL}\\.)+(?:xn--[a-z0-9\\-]{2,59}|[\\p{L}][\\p{L}\\p{N}-]{1,62})`;
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
/**
 * The email and bare-domain shields are the plugin's patterns — `[a-z0-9._%+\-]+@DOMAIN\b` and
 * `\bDOMAIN\b` — run by a scanner instead of a global replace, because the replace retried from every
 * start inside a long run and went quadratic on untrusted text: one 131 000-letter word took 25 s, a
 * dotted run `a.a.a.…` longer still, and a 336-byte macro template expands to either. The scanner tries
 * the same regex at the same starts, in the same order, and skips only starts that provably fail.
 *
 * Email: every start inside one run of local-part characters reaches the same end — the class holds no
 * `@` — so the run's first start matches or none does, and a failed run is skipped whole. That makes the
 * `@` the thing to look for: the only run that can match is the one ending at it.
 */
const DOMAIN_AT_RE = new RegExp(`${DOMAIN_PART}${WORD_BOUNDARY}`, 'iuy');
/**
 * Domain: an attempt that fails at the start of a chain of labels (`a.b-c.d…`) fails at every later
 * start in that chain too — prefix the chain's own labels to a match further in and it is a match here.
 * So a failed attempt skips to where the chain of labels ends. One global regex does all of it: it
 * matches at exactly the starts the shield tries (a word character not preceded by one — every label
 * begins with one), group 1 is a domain, and when there is none the whole match is the chain to skip.
 */
const DOMAIN_SCAN_RE = new RegExp(`${AFTER_NON_WORD}(?:(${DOMAIN_PART}${WORD_BOUNDARY})|(?:${LABEL}\\.)*${LABEL})`, 'giu');
// PHP's decimal shield is the one pattern here without /u: byte mode, so its `\b` and `\d` are
// ASCII — as JS's are. Deliberately not widened with the rest.
const DECIMAL_RE = /\b\d+\.\d+\b/gu;
const MULTI_ABBR_RE = new RegExp(`${AFTER_NON_WORD}(?:\\p{L}{1,2}\\.${S}*){2,}`, 'gu');
const SINGLE_ABBR_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${SINGLE_ABBREVS.join('|')})\\.(?=${S}|$|<)`, 'giu');

/**
 * `[a-z0-9._%+-]` as the plugin's pattern reads it under `iu`: both cases, and the two non-ASCII letters that
 * fold into the class — U+017F LONG S and U+212A KELVIN SIGN.
 */
function isEmailLocalChar(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2e ||
    code === 0x5f ||
    code === 0x25 ||
    code === 0x2b ||
    code === 0x2d ||
    code === 0x17f ||
    code === 0x212a
  );
}

function shieldEmails(text: string, shield: (value: string) => string): string {
  let out = '';
  let emitted = 0;
  // Where the run search would resume: after the last shield, and past every `@` already tried.
  let pos = 0;
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', Math.max(at + 1, pos))) {
    // The run of local-part characters that ends at this `@`, begun no earlier than the scan could begin it.
    let start = at;
    while (start > pos && isEmailLocalChar(text.charCodeAt(start - 1))) start -= 1;
    if (start === at) continue; // no run ends here, so no attempt is made at it
    DOMAIN_AT_RE.lastIndex = at + 1;
    if (DOMAIN_AT_RE.exec(text) !== null) {
      out += text.slice(emitted, start) + shield(text.slice(start, DOMAIN_AT_RE.lastIndex));
      emitted = pos = DOMAIN_AT_RE.lastIndex;
    }
  }
  return emitted === 0 ? text : out + text.slice(emitted);
}

/** Every domain holds a dot followed by the first character of a label; most prose holds none. */
const DOMAIN_DOT_RE = /\.[\p{L}\p{N}]/u;

function shieldDomains(text: string, shield: (value: string) => string): string {
  if (!DOMAIN_DOT_RE.test(text)) return text;
  let out = '';
  let emitted = 0;
  DOMAIN_SCAN_RE.lastIndex = 0;
  for (let m = DOMAIN_SCAN_RE.exec(text); m !== null; m = DOMAIN_SCAN_RE.exec(text)) {
    if (m[1] !== undefined) {
      out += text.slice(emitted, m.index) + shield(m[1]);
      emitted = m.index + m[1].length;
    }
  }
  return emitted === 0 ? text : out + text.slice(emitted);
}

/** Where the run of `.,;:!` that ends `value` starts — a loop: `/([.,;:!]+)$/` retried from every dot inside a URL. */
function trailingPunctuationStart(value: string): number {
  let cut = value.length;
  while (cut > 0 && '.,;:!'.includes(value.charAt(cut - 1))) cut -= 1;
  return cut;
}

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

// Spacing + capitalization. PHP's `\s` and `\d` here are UCP: `\d` is any decimal digit (\p{Nd}).
//
// A match may start only where a whitespace run starts (`(?<!${S})`). Same matches — every start
// inside a run reaches the same end, so the run's first character is the leftmost match or there is
// none — but a run NOT followed by punctuation is scanned once instead of once per character: 100 000
// form feeds took 10 s without the guard, and the UCP class made NBSP and U+3000 runs do the same.
const SPACE_BEFORE_PUNCT_RE = new RegExp(`(?<!${S})${S}+([,;:!?.])`, 'gu');
const SPACE_AFTER_COMMA_RE = new RegExp(`([,;:])(?!\\p{Nd})(?!${S}|$|<)`, 'gu');
// A run of sentence punctuation is ONE sentence end, not several: "..." and "?!" have to survive
// intact, so the space goes after the whole run. `(?![.!?])` is what completes the run — a greedy
// `+` on its own still backtracks INTO it to satisfy the lookaheads, turning "Wow!!!" into
// "Wow!! !". (JS has no possessive quantifiers, and PHP must match this shape exactly.)
// And a match starts only where the run starts (`(?<![.!?])`): every start inside a run reaches the
// same end and the same lookaheads, so a run followed by a digit or a space was otherwise rejected once
// per mark — 32 000 dots before a digit took 5 s.
const SPACE_AFTER_SENTENCE_RE = new RegExp(`(?<![.!?])([.!?]+)(?![.!?])(?!\\p{Nd})(?!${S}|$|<)`, 'gu');
// An opener binds to the word it opens: "¿ qué tal ?" → "¿qué tal?". MUST run before the
// capitalization passes, so they see the real first letter instead of a space.
const SPACE_AFTER_OPENER_RE = new RegExp(`([${SENTENCE_OPENERS}])${S}+`, 'gu');
const CAP_FIRST_RE = new RegExp(`^(${LEAD})(\\p{Ll})`, 'u');

const up = (ch: string): string => ch.toUpperCase();

/**
 * The capitalizers after a sentence end, a block tag and a line break — the plugin's
 * `([.!?…])(LEAD)(\p{Ll})`, `(<\/?(?:p|h[1-6]|li|blockquote|div|td|th)[^>]*>LEAD)(\p{Ll})` (caseless)
 * and `(\nLEAD)(\p{Ll})` — run by a scanner, because the regexes rescanned the lead from every start:
 * `.<` repeated with no `>` to close a tag, or `<p>` repeated with no letter after, went quadratic.
 *
 * What makes a scanner exact is that the lead has one reading. An opener or a whitespace character is a
 * token of one character; a tag is `<`, at least one character that is not `>`, then the FIRST `>` —
 * `[^>]+` cannot cross a `>`, so a tag ends where the next `>` is, and a `<` followed at once by `>`, or
 * by no `>` at all, is no tag. Every shorter run of tokens ends before a `<`, an opener or a space,
 * none of which is `\p{Ll}`, so a start matches exactly when the character after its LONGEST lead is a
 * lowercase letter. Where each lead ends is indexed from the right, when a lead first needs it.
 */
interface LeadIndex {
  /** `leadEnd[i]`: where the lead that starts at `i` ends. */
  readonly leadEnd: Int32Array;
}

function indexLeads(text: string): LeadIndex {
  const n = text.length;
  const leadEnd = new Int32Array(n + 1);
  leadEnd[n] = n;
  let gt = -1; // the first `>` after the position being indexed
  for (let i = n - 1; i >= 0; i -= 1) {
    const code = text.charCodeAt(i);
    let tokenEnd = -1;
    if (code === 0xbf || code === 0xa1 || isUcpSpace(code)) {
      tokenEnd = i + 1;
    } else if (code === 0x3c && gt > i + 1) {
      tokenEnd = gt + 1;
    }
    leadEnd[i] = tokenEnd === -1 ? i : (leadEnd[tokenEnd] as number);
    if (code === 0x3e) gt = i;
  }
  return { leadEnd };
}

const LOWER_RE = /^\p{Ll}/u;
/** The block-tag capitalizer is caseless in both engines, and caseless `\p{Ll}` takes every cased letter. */
const LOWER_CASELESS_RE = /^\p{Ll}/iu;
const BLOCK_TAG_NAME_RE = /<\/?(?:p|h[1-6]|li|blockquote|div|td|th)/iuy;
/** `.`, `!`, `?` and `…` — the boundaries of the sentence capitalizer. */
const SENTENCE_END_SCAN_RE = new RegExp(`[.!?${String.fromCharCode(0x2026)}]`, 'g');

/** Lead steps walked one character at a time before the lead index is built — see {@link leadEndFrom}. */
const LEAD_WALK = 32;

/**
 * Where the lead starting at `i` ends. Openers and whitespace are one character each, so a short lead is
 * walked; a tag, or a lead longer than {@link LEAD_WALK}, is answered by the index, built once per text
 * when first needed. Walking every lead in full would read a run of line breaks once per break — each
 * one starts a lead that holds the rest.
 */
function leadEndFrom(text: string, i: number, leads: () => LeadIndex): number {
  let j = i;
  for (let steps = 0; steps < LEAD_WALK && j < text.length; steps += 1) {
    const code = text.charCodeAt(j);
    if (code === 0x3c) return leads().leadEnd[j] as number;
    if (code !== 0xbf && code !== 0xa1 && !isUcpSpace(code)) return j;
    j += 1;
  }
  return j < text.length ? (leads().leadEnd[j] as number) : j;
}

/**
 * One capitalizer pass: for each boundary the `next` search finds, upper-case the `\p{Ll}` at the end of the
 * lead after it. After a match the search resumes behind the letter, as a global replace does. `next(from)`
 * returns where the lead starts for the first boundary at or after `from`, and where to search from after
 * it; the passes find their boundaries natively instead of testing every character.
 */
function capitalizeAfter(
  text: string,
  lower: RegExp,
  next: (text: string, from: number) => { leadStart: number; resume: number } | null,
  context: { leads: LeadIndex | null },
): string {
  // The passes only change the case of letters, and no upper-case mapping is shorter than its letter, so a
  // text of the same length has every `<`, `>`, opener and space where the index saw them: one index serves
  // all three passes unless a letter grew (`ß` → `SS`).
  const leads = (): LeadIndex => {
    if (context.leads === null || context.leads.leadEnd.length !== text.length + 1) context.leads = indexLeads(text);
    return context.leads;
  };
  let out = '';
  let emitted = 0;
  let from = 0;
  for (let boundary = next(text, from); boundary !== null; boundary = next(text, from)) {
    from = boundary.resume;
    const at = leadEndFrom(text, boundary.leadStart, leads);
    const cp = text.codePointAt(at);
    if (cp === undefined) continue;
    const ch = String.fromCodePoint(cp);
    if (!lower.test(ch)) continue;
    out += text.slice(emitted, at) + up(ch);
    emitted = at + ch.length;
    from = emitted;
  }
  return emitted === 0 ? text : out + text.slice(emitted);
}

const afterSentenceEnd = (text: string, from: number): { leadStart: number; resume: number } | null => {
  SENTENCE_END_SCAN_RE.lastIndex = from;
  const m = SENTENCE_END_SCAN_RE.exec(text);
  return m === null ? null : { leadStart: m.index + 1, resume: m.index + 1 };
};

/** The block-tag pass asks for the first `>` after each tag name, at positions that only grow: one scan. */
function afterBlockTag(): (text: string, from: number) => { leadStart: number; resume: number } | null {
  let gtFrom = -1;
  let gt = -1;
  return (text, from) => {
    for (let lt = text.indexOf('<', from); lt !== -1; lt = text.indexOf('<', lt + 1)) {
      BLOCK_TAG_NAME_RE.lastIndex = lt;
      if (!BLOCK_TAG_NAME_RE.test(text)) continue;
      const nameEnd = BLOCK_TAG_NAME_RE.lastIndex;
      if (gtFrom === -1 || nameEnd < gtFrom || (gt !== -1 && nameEnd > gt)) {
        gtFrom = nameEnd;
        gt = text.indexOf('>', nameEnd);
      }
      if (gt === -1) continue;
      return { leadStart: gt + 1, resume: lt + 1 };
    }
    return null;
  };
}

const afterLineBreak = (text: string, from: number): { leadStart: number; resume: number } | null => {
  const at = text.indexOf('\n', from);
  return at === -1 ? null : { leadStart: at + 1, resume: at + 1 };
};

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
 *
 * The loop is not run as a loop, though: one scan of the text per placeholder is quadratic, and
 * one `\x00` in a template buys it — a few hundred bytes of macros doubling `\x00` and a decimal
 * took 2 s at 16 000 decimals, four times that per doubling. {@link restoreAsTheLoopDoes} computes
 * the loop's result in one pass.
 */
function restore(text: string, input: string, placeholders: Map<string, string>): string {
  if (!input.includes('\x00')) {
    return text.replace(RESTORE_RE, (key) => placeholders.get(key) ?? key);
  }
  return restoreAsTheLoopDoes(text, placeholders);
}

/**
 * What `for (const [key, value] of placeholders) text = text.split(key).join(value)` returns, in
 * linear time.
 *
 * Every key is `\x00NAME\x00`, so an occurrence of one is a stretch between two `\x00`s whose content
 * is that NAME — a "gap". Replacing it removes both delimiters and puts a value there, and that can
 * never form a new occurrence: no value holds a `\x00` (see {@link restore}), and no whole value fits
 * inside a key name either — a URL keeps its `://`, an email its `@`, a domain, decimal or abbreviation
 * its `.`, and a URI cut back to its scheme (`tel:.` stores `tel`) is no substring of `URL_7` or
 * `EMAIL_7`. So the only occurrences the loop can ever meet are gaps of the original text, and the
 * only effect one replacement has on another is taking a shared delimiter from a neighbour. The loop
 * takes the keys in insertion order and each `split` scans left to right, so visiting candidate gaps
 * in that order — each replaced only while both its delimiters survive — is the loop.
 */
function restoreAsTheLoopDoes(text: string, placeholders: Map<string, string>): string {
  const gaps = text.split('\x00'); // gaps[j] lies between delimiter j - 1 and delimiter j
  const rank = new Map<string, number>();
  for (const key of placeholders.keys()) rank.set(key, rank.size);

  const byRank: number[][] = [];
  for (let j = 1; j < gaps.length - 1; j += 1) {
    const r = rank.get(`\x00${gaps[j]}\x00`);
    if (r !== undefined) (byRank[r] ??= []).push(j);
  }

  const taken = new Uint8Array(gaps.length); // delimiter j, between gaps[j] and gaps[j + 1]
  const replaced = new Uint8Array(gaps.length);
  for (const candidates of byRank) {
    for (const j of candidates ?? []) {
      if (taken[j - 1] === 1 || taken[j] === 1) continue;
      taken[j - 1] = 1;
      taken[j] = 1;
      replaced[j] = 1;
    }
  }

  let out = gaps[0] as string;
  for (let j = 1; j < gaps.length; j += 1) {
    if (taken[j - 1] !== 1) out += '\x00';
    const gap = gaps[j] as string;
    out += replaced[j] === 1 ? (placeholders.get(`\x00${gap}\x00`) as string) : gap;
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
    const cut = trailingPunctuationStart(value);
    if (cut === value.length) return store(value, prefix);
    return cut === 0 ? value : store(value.slice(0, cut), prefix) + value.slice(cut);
  };

  let text = input;

  // 1-5: shield. URIs go first and in one pass, so an overlapping pair is never split
  // (spintax-js#53), and always before EMAIL/DOMAIN, so the whole `mailto:` survives
  // instead of the address being carved out from under its prefix (spintax-js#41).
  text = text.replace(URI_RE, (m) =>
    storeWithTrailingPunct(m, MAILTEL_PREFIX_RE.test(m) ? 'URI' : 'URL'),
  );
  text = shieldEmails(text, (m) => store(m, 'EMAIL'));
  text = shieldDomains(text, (m) => store(m, 'DOM'));
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
  const leadContext: { leads: LeadIndex | null } = { leads: null };
  text = capitalizeAfter(text, LOWER_RE, afterSentenceEnd, leadContext);
  // 10: capitalize after block-level HTML tags.
  text = capitalizeAfter(text, LOWER_CASELESS_RE, afterBlockTag(), leadContext);
  // 11: capitalize after line breaks.
  text = capitalizeAfter(text, LOWER_RE, afterLineBreak, leadContext);

  // 12: restore placeholders, then trim.
  return restore(text, input, placeholders).trim();
}

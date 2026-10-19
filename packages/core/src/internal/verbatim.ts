/**
 * Block constructs of author source — `/# … #/` comments and `/! … !/` verbatim spans (#92,
 * ADR 0001) — and the span token codec.
 *
 * {@link projectSource} is the one scan of author source, before anything else reads it: comments
 * are removed, each span is replaced where it stands by a self-contained TOKEN that carries its
 * content, and the reserved ranges are stripped from everything outside spans. Every later pass —
 * directives, the tree, the validator, `extract()` — reads that projection, so none of them can see
 * into a span, and the token rides along wherever text goes (a `#set` value, an `#include` body, the
 * #78 splice, a reused `parse()`).
 *
 * The token: U+F0000, then one pair of digits U+F1000+n per code point of the content
 * (`c >> 12`, `c & 0xFFF`), then U+F0001 — all in Supplementary Private Use Area-A, which no pass
 * reads as a letter, a digit, whitespace, punctuation or markup. {@link decodeVerbatim} turns tokens
 * back into their content as the very last step of a render, after the post-process and the
 * neutralize safety-restore.
 */

const OPEN = 0xf0000;
const CLOSE = 0xf0001;
const DIGIT = 0xf1000;

/**
 * Reserved code points stripped from author text outside spans: the neutralize sentinels
 * (U+E000–U+E005; only `neutralize()` may introduce one) and the span range, so an author cannot
 * type a ready-made token. Inside a span they are content.
 */
const RESERVED_RE = /[-\u{F0000}-\u{F1FFF}]/gu;
/** The span range alone — what a runtime context value is stripped of (ADR 0001 rule 4). */
const SPAN_RANGE_RE = /[\u{F0000}-\u{F1FFF}]/gu;
/** A well-formed token. One left-to-right pass; what it emits is never rescanned. */
const TOKEN_RE = /\u{F0000}((?:[\u{F1000}-\u{F1FFF}]{2})*)\u{F0001}/gu;
/**
 * High surrogates of the span range (U+F0000–U+F1FFF): a text without them holds no token. No `u`
 * flag on purpose — with it, a pair is one code point and a class of lone surrogates never matches.
 */
const SPAN_HIGH_RE = /[\uDB80-\uDB87]/;

/** Encode a span's content as a token. */
export function encodeVerbatim(content: string): string {
  let out = String.fromCodePoint(OPEN);
  for (const ch of content) {
    const c = ch.codePointAt(0)!;
    out += String.fromCodePoint(DIGIT + (c >> 12), DIGIT + (c & 0xfff));
  }
  return out + String.fromCodePoint(CLOSE);
}

/** Replace every well-formed token by its content — once, never re-reading what it emitted. */
export function decodeVerbatim(text: string): string {
  if (!SPAN_HIGH_RE.test(text)) return text;
  TOKEN_RE.lastIndex = 0;
  return text.replace(TOKEN_RE, (_m, digits: string): string => {
    let out = '';
    const units = [...digits];
    for (let i = 0; i + 1 < units.length; i += 2) {
      out += String.fromCodePoint(((units[i]!.codePointAt(0)! - DIGIT) << 12) | (units[i + 1]!.codePointAt(0)! - DIGIT));
    }
    return out;
  });
}

/**
 * What a value costs the expansion budget: its length with every token counted as its content
 * (ADR 0001 rule 7a), so the encoding does not move the point where a bounded expansion stops.
 */
export function budgetLength(value: string): number {
  return SPAN_HIGH_RE.test(value) ? decodeVerbatim(value).length : value.length;
}

/** Strip the span range from a runtime value, so data cannot carry a token (ADR 0001 rule 4). */
export function stripSpanRange(value: string): string {
  return SPAN_HIGH_RE.test(value) ? value.replace(SPAN_RANGE_RE, '') : value;
}

/** The scan of author source: the projection every later pass reads, and how to map back. */
export interface Projection {
  /** Comments removed, spans encoded, reserved ranges stripped outside spans. */
  readonly text: string;
  /** Spans found, the empty `/!!/` included. */
  readonly spans: number;
  /** Source offset of the first `/!` with no closer after it, or -1. */
  readonly unclosed: number;
  /** Maps an offset in {@link text} back to an offset in the source. */
  readonly toSource: (offset: number) => number;
  /**
   * Maps an EXCLUSIVE end offset back: biased to the left, so a range that ends just before removed
   * text (a comment, an empty span, a stripped character) does not stretch over it.
   */
  readonly toSourceEnd: (offset: number) => number;
}

/**
 * Scan author source once, left to right: the next `/#` or `/!`, whichever comes first, runs to the
 * first matching closer searched from the END of the opener, so `/!/` does not close itself. A
 * comment is removed; a span is encoded, an empty one removed. An opener with no closer is two
 * characters of text and the scan goes on after it — the reading of
 * `/\/#[\s\S]*?#\/|\/![\s\S]*?!\//g` (no nesting; whichever opener comes first wins).
 *
 * Linear: once a closer is missing from some offset on, it is missing from every later one, so each
 * kind's opener and closer are searched for at most once past any point.
 */
export function projectSource(src: string): Projection {
  // Segments of the projection, in order: [outStart, srcStart, srcEnd, isToken].
  const outStarts: number[] = [];
  const srcStarts: number[] = [];
  const srcEnds: number[] = [];
  const tokens: boolean[] = [];
  let out = '';
  let spans = 0;
  let unclosed = -1;

  const copy = (start: number, end: number): void => {
    if (start >= end) return;
    const chunk = src.slice(start, end);
    let from = 0;
    for (const m of chunk.matchAll(RESERVED_RE)) {
      if (m.index > from) push(start + from, start + m.index, chunk.slice(from, m.index), false);
      from = m.index + m[0].length;
    }
    if (from < chunk.length) push(start + from, end, chunk.slice(from), false);
  };
  const push = (srcStart: number, srcEnd: number, piece: string, token: boolean): void => {
    outStarts.push(out.length);
    srcStarts.push(srcStart);
    srcEnds.push(srcEnd);
    tokens.push(token);
    out += piece;
  };

  let from = 0; // first source offset not yet emitted
  let at = 0; // where the next opener is searched from
  let nextComment = -2;
  let nextSpan = -2;
  let commentCloserGone = false;
  let spanCloserGone = false;
  for (;;) {
    if (nextComment !== -1 && nextComment < at) nextComment = src.indexOf('/#', at);
    if (nextSpan !== -1 && nextSpan < at) nextSpan = src.indexOf('/!', at);
    if (nextComment === -1 && nextSpan === -1) break;
    const isSpan = nextComment === -1 || (nextSpan !== -1 && nextSpan < nextComment);
    const open = isSpan ? nextSpan : nextComment;
    const gone = isSpan ? spanCloserGone : commentCloserGone;
    const close = gone ? -1 : src.indexOf(isSpan ? '!/' : '#/', open + 2);
    if (close === -1) {
      if (isSpan) {
        spanCloserGone = true;
        if (unclosed === -1) unclosed = open;
      } else {
        commentCloserGone = true;
      }
      at = open + 2;
      continue;
    }
    copy(from, open);
    if (isSpan) {
      spans += 1;
      if (close > open + 2) push(open, close + 2, encodeVerbatim(src.slice(open + 2, close)), true);
    }
    from = at = close + 2;
  }
  copy(from, src.length);

  /** The last segment starting at or before `offset`, or -1. */
  const segmentAt = (offset: number): number => {
    let lo = 0;
    let hi = outStarts.length - 1;
    if (hi < 0 || outStarts[0]! > offset) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (outStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const toSource = (offset: number): number => {
    const at = segmentAt(offset);
    if (at === -1) return 0;
    const delta = offset - outStarts[at]!;
    if (delta <= 0) return srcStarts[at]!;
    if (tokens[at]) return srcEnds[at]!;
    return Math.min(srcStarts[at]! + delta, srcEnds[at]!);
  };
  const toSourceEnd = (offset: number): number => {
    if (offset <= 0) return toSource(0);
    // The segment holding the last covered unit; the end follows that unit.
    const at = segmentAt(offset - 1);
    if (at === -1) return 0;
    if (tokens[at]) return srcEnds[at]!;
    return Math.min(srcStarts[at]! + (offset - outStarts[at]!), srcEnds[at]!);
  };
  return { text: out, spans, unclosed, toSource, toSourceEnd };
}

/**
 * One text, indexed once, so that reading a construct costs its own markup and not its subtree.
 *
 * The parser used to hand every construct its content as a new string and scan all of it: to find the
 * closer, to split on top-level pipes, to find a conditional's pipe, a config's end, a closing tag, a
 * trailing separator. Each of those reads the whole subtree again at every level of nesting, and the
 * re-read of a construct lets a few hundred bytes of macros spell tens of thousands of levels — 705 bytes
 * made 32 768 and took 31 s. Here each question is answered from a table built in one pass over the
 * text, for a span of it, and a construct's children are spans of the same text rather than copies.
 *
 * Every table is built on first use, so a text that never asks a question pays nothing for it.
 */
import { BRACE_CLOSE, BRACE_OPEN, BRACKET_CLOSE, BRACKET_OPEN, matchAnyPairs, matchPairs } from './pairs';

const PIPE = 0x7c;
const COLON = 0x3a;
const QUOTE = 0x22;
const LT = 0x3c;
const GT = 0x3e;
const BANG = 0x21;
const QUESTION = 0x3f;
/** The conditional name, as `recognizeConditional` reads it. */
const CONDITIONAL_NAME_RE = /[A-Za-z_]\w*/y;
/** A reference, as the renderer's expansion pass finds them. */
const REFERENCE_SCAN_RE = /%(\w+)%/gu;

/**
 * Every `</name>` in a text, with the name read as the tag-name pattern reads one. Under `iu` the
 * class also takes U+017F and U+212A — they fold to `s` and `k` — which {@link foldTagName} maps back.
 */
const CLOSING_TAG_RE = /<\/([a-z][a-z0-9-]*)[ \t\n\x0B\f\r]*>/giu;

/**
 * A tag name as `iu` compares it. U+212A KELVIN SIGN lower-cases to `k` on its own; U+017F LATIN SMALL
 * LETTER LONG S is lower case already, so it is mapped by hand.
 */
function foldTagName(name: string): string {
  return name.toLowerCase().split(LONG_S).join('s');
}
const LONG_S = String.fromCharCode(0x17f);

/**
 * Where a construct marked for the re-read sits in the text it was parsed from — the renderer asks the
 * index whether re-reading it could change anything before it does the work. Kept beside the node, not
 * on it: the node's shape is what `parse()` returns and what tests compare.
 */
export interface RereadSpan {
  readonly index: TextIndex;
  readonly start: number;
  readonly end: number;
}
export const rereadSpans = new WeakMap<object, RereadSpan>();

/** First index in the ascending `list` whose value is >= `x` (list.length when there is none). */
export function lowerBound(list: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((list[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class TextIndex {
  readonly text: string;
  private braces: Int32Array | null = null;
  private brackets: Int32Array | null = null;
  private any: Int32Array | null = null;
  private pipeBrace: Int32Array | null = null;
  private pipeBracket: Int32Array | null = null;
  private pipesByDepth: Map<number, Map<number, number[]>> | null = null;
  private colons: number[] | null = null;
  private quotes: number[] | null = null;
  private gtByQuoteParity: [number[], number[]] | null = null;
  private closingTags: Map<string, { starts: number[]; ends: number[] }> | null = null;
  private angles: number[] | null = null;
  private heads: number[] | null = null;
  private headCloseMin: Float64Array | null = null;
  private headTreeSize = 0;
  private readonly definedReferences = new WeakMap<object, number[]>();

  constructor(text: string) {
    this.text = text;
  }

  /**
   * The closer matching the `{` or `[` at `i` within a span ending at `end`, or -1.
   *
   * The table pairs the whole text, and a span agrees with it: an opener inside a span is closed there
   * exactly when the closer the whole text pairs it with lies inside too, because every opener pushed
   * after it is pushed after the span begins.
   */
  closerWithin(i: number, end: number): number {
    const table =
      this.text.charCodeAt(i) === BRACE_OPEN
        ? (this.braces ??= matchPairs(this.text, BRACE_OPEN, BRACE_CLOSE))
        : (this.brackets ??= matchPairs(this.text, BRACKET_OPEN, BRACKET_CLOSE));
    const close = table[i] as number;
    return close !== -1 && close < end ? close : -1;
  }

  /** {@link matchAnyPairs} of the text: one stack for both bracket kinds, as a clamped depth counts. */
  anyPairs(): Int32Array {
    return (this.any ??= matchAnyPairs(this.text));
  }

  /**
   * The pipes of `[start, end)` that `splitTopLevel` splits at, in order.
   *
   * Its two counters are signed and start at zero, so a pipe at `p` splits exactly when the text before
   * it holds as many `{` as `}` and as many `[` as `]` counted from `start` — when both running totals
   * over the whole text read the same at `p` as at `start`. The pipes are grouped by those two totals
   * once, and a span takes the group of its start.
   */
  topLevelPipes(start: number, end: number): number[] {
    if (this.pipesByDepth === null) this.indexPipes();
    const braceDepth = this.pipeBrace as Int32Array;
    const bracketDepth = this.pipeBracket as Int32Array;
    const group = (this.pipesByDepth as Map<number, Map<number, number[]>>)
      .get(braceDepth[start] as number)
      ?.get(bracketDepth[start] as number);
    if (group === undefined) return [];
    const out: number[] = [];
    for (let k = lowerBound(group, start); k < group.length && (group[k] as number) < end; k += 1) {
      out.push(group[k] as number);
    }
    return out;
  }

  private indexPipes(): void {
    const n = this.text.length;
    const braceDepth = new Int32Array(n + 1);
    const bracketDepth = new Int32Array(n + 1);
    const groups = new Map<number, Map<number, number[]>>();
    let brace = 0;
    let bracket = 0;
    for (let i = 0; i < n; i += 1) {
      braceDepth[i] = brace;
      bracketDepth[i] = bracket;
      const code = this.text.charCodeAt(i);
      if (code === BRACE_OPEN) brace += 1;
      else if (code === BRACE_CLOSE) brace -= 1;
      else if (code === BRACKET_OPEN) bracket += 1;
      else if (code === BRACKET_CLOSE) bracket -= 1;
      else if (code === PIPE) {
        let byBracket = groups.get(brace);
        if (byBracket === undefined) groups.set(brace, (byBracket = new Map()));
        const list = byBracket.get(bracket);
        if (list === undefined) byBracket.set(bracket, [i]);
        else list.push(i);
      }
    }
    braceDepth[n] = brace;
    bracketDepth[n] = bracket;
    this.pipeBrace = braceDepth;
    this.pipeBracket = bracketDepth;
    this.pipesByDepth = groups;
  }

  /** The first `:` in `[from, end)`, or -1. */
  colonWithin(from: number, end: number): number {
    const colons = (this.colons ??= this.positionsOf(COLON));
    const k = lowerBound(colons, from);
    return k < colons.length && (colons[k] as number) < end ? (colons[k] as number) : -1;
  }

  /**
   * The `>` that ends a `<config>` whose `<` is at `lt`, before `end`, or -1: the first one with an even
   * number of `"` between the `<` and it — the quote toggle `findConfigEnd` keeps, as a parity.
   */
  configEnd(lt: number, end: number): number {
    const quotes = (this.quotes ??= this.positionsOf(QUOTE));
    if (this.gtByQuoteParity === null) {
      const even: number[] = [];
      const odd: number[] = [];
      let seen = 0;
      for (let i = 0; i < this.text.length; i += 1) {
        const code = this.text.charCodeAt(i);
        if (code === QUOTE) seen += 1;
        else if (code === GT) (seen % 2 === 0 ? even : odd).push(i);
      }
      this.gtByQuoteParity = [even, odd];
    }
    const parity = lowerBound(quotes, lt + 1) % 2;
    const candidates = this.gtByQuoteParity[parity] as number[];
    const k = lowerBound(candidates, lt + 1);
    return k < candidates.length && (candidates[k] as number) < end ? (candidates[k] as number) : -1;
  }

  /**
   * Does a closing tag of `tagName` lie wholly inside `[from, end)`? Closing tags cannot overlap — each
   * starts with the only `<` it holds — so one scan of the whole text finds every one a scan of the span
   * would, and the first one starting at or after `from` is the one that ends soonest.
   */
  hasClosingTag(tagName: string, from: number, end: number): boolean {
    if (this.closingTags === null) {
      const tags = new Map<string, { starts: number[]; ends: number[] }>();
      for (const m of this.text.matchAll(CLOSING_TAG_RE)) {
        const name = foldTagName(m[1] ?? '');
        let entry = tags.get(name);
        if (entry === undefined) tags.set(name, (entry = { starts: [], ends: [] }));
        entry.starts.push(m.index ?? 0);
        entry.ends.push((m.index ?? 0) + m[0].length);
      }
      this.closingTags = tags;
    }
    const entry = this.closingTags.get(tagName);
    if (entry === undefined) return false;
    const k = lowerBound(entry.starts, from);
    return k < entry.starts.length && (entry.ends[k] as number) <= end;
  }

  /** The last `<` or `>` in `[floor, at]`, or -1. */
  lastAngleWithin(floor: number, at: number): number {
    if (this.angles === null) {
      const angles: number[] = [];
      for (let i = 0; i < this.text.length; i += 1) {
        const code = this.text.charCodeAt(i);
        if (code === LT || code === GT) angles.push(i);
      }
      this.angles = angles;
    }
    const k = lowerBound(this.angles, at + 1) - 1;
    return k >= 0 && (this.angles[k] as number) >= floor ? (this.angles[k] as number) : -1;
  }

  /**
   * Would the renderer's conditional pass over `[start, end)` resolve anything? Exactly when a `{?` in
   * the span opens a well-formed head and its brace closes inside the span: the pass reaches the first
   * such one in order, because every `{?` before it is one it steps over.
   */
  hasConditionalWithin(start: number, end: number): boolean {
    if (this.heads === null) this.indexHeads();
    const heads = this.heads as number[];
    let lo = lowerBound(heads, start) + this.headTreeSize;
    let hi = lowerBound(heads, end) + this.headTreeSize;
    const tree = this.headCloseMin as Float64Array;
    let min = Infinity;
    while (lo < hi) {
      if (lo & 1) min = Math.min(min, tree[lo++] as number);
      if (hi & 1) min = Math.min(min, tree[--hi] as number);
      lo >>= 1;
      hi >>= 1;
    }
    return min < end;
  }

  private indexHeads(): void {
    const heads: number[] = [];
    const closes: number[] = [];
    const braces = (this.braces ??= matchPairs(this.text, BRACE_OPEN, BRACE_CLOSE));
    for (let at = this.text.indexOf('{?'); at !== -1; at = this.text.indexOf('{?', at + 1)) {
      let p = at + 2;
      if (this.text.charCodeAt(p) === BANG) p += 1;
      CONDITIONAL_NAME_RE.lastIndex = p;
      const name = CONDITIONAL_NAME_RE.exec(this.text);
      if (name === null || this.text.charCodeAt(p + name[0].length) !== QUESTION) continue;
      heads.push(at);
      closes.push(braces[at] as number);
    }
    // A segment tree of the closers (none = infinity), for the smallest closer among a run of heads.
    let size = 1;
    while (size < heads.length) size *= 2;
    const tree = new Float64Array(2 * size).fill(Infinity);
    closes.forEach((close, k) => {
      tree[size + k] = close === -1 ? Infinity : close;
    });
    for (let k = size - 1; k >= 1; k -= 1) tree[k] = Math.min(tree[2 * k] as number, tree[2 * k + 1] as number);
    this.heads = heads;
    this.headCloseMin = tree;
    this.headTreeSize = size;
  }

  /**
   * Would expansion substitute anything in `[start, end)` — is a reference there to a name `vars`
   * defines? A reference cannot straddle a span of a construct's content (a bracket bounds it on both
   * sides), so the references one scan of the whole text finds are the ones a scan of the span would.
   */
  hasDefinedReferenceWithin(start: number, end: number, vars: Readonly<Record<string, string>>): boolean {
    let positions = this.definedReferences.get(vars);
    if (positions === undefined) {
      positions = [];
      for (const m of this.text.matchAll(REFERENCE_SCAN_RE)) {
        if (vars[(m[1] ?? '').toLowerCase()] !== undefined) positions.push(m.index ?? 0);
      }
      this.definedReferences.set(vars, positions);
    }
    const k = lowerBound(positions, start);
    return k < positions.length && (positions[k] as number) < end;
  }

  private positionsOf(code: number): number[] {
    const ch = String.fromCharCode(code);
    const out: number[] = [];
    for (let i = this.text.indexOf(ch); i !== -1; i = this.text.indexOf(ch, i + 1)) out.push(i);
    return out;
  }
}

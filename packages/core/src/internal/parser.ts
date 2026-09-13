/**
 * Recursive-descent parser: template string → {@link ParsedAst}.
 *
 * Lenient by contract (spec §9.2): never throws on malformed markup. Unmatched
 * brackets, malformed `{?…}` / `{plural …}`, and bare `%` degrade gracefully
 * (bad conditional/plural fall back to an enumeration, exactly as the plugin's
 * later passes would consume them). Structural *diagnostics* are the validator's
 * job (PR-12), not the parser's.
 *
 * `#set` is extracted GLOBALLY before the tree is built ({@link extractSetDirectives},
 * line-anchored like the plugin's `extract_set_directives`), so a `#set` on its
 * own line even inside a `{…}`/`[…]` group is a global definition — matching the
 * plugin's brace-oblivious `/m` extraction — not literal text. `#include` stays
 * literal here; the renderer resolves it as a post-tree string pass (like the
 * plugin's post-enum `resolve_includes`).
 */
import { AST_VERSION, type Node, type ParsedAst, type PermConfig } from './ast';
import { stripSentinels } from './neutralize';
import { BRACE_OPEN, BRACKET_OPEN } from './pairs';
import { TextIndex, rereadSpans } from './text-index';

/** A reference at a given offset (sticky), no `u`: the name is ASCII `\w`. */
const VARIABLE_RE = /%(\w+)%/y;
const PERCENT = 0x25;
const QUESTION = 0x3f;
const PIPE = 0x7c;
const LT = 0x3c;
const GT = 0x3e;
// `\r?` before the multiline `$` so a CRLF line strips cleanly (JS `.` excludes \r).
/**
 * The one grammar for `#set` and `#def`. Whitespace is `[ \t]` (not `\s`) so a directive is a
 * single line, and the value group may be empty. `\r?` before the multiline `$` so a CRLF line
 * strips cleanly (JS `.` excludes \r).
 *
 * The value is the rest of the line up to its last character that is not a space, a tab or a line
 * terminator — what a lazy `(.*?)[ \t]*` captured, and the same match. Lazy, every character of a
 * whitespace run inside the value retried `[ \t]*` over the rest of that run: a directive line with
 * 16 KB of spaces in its value cost `parse()` 0.7 s and `validate()` 2.8 s, ×4 per doubling.
 */
export const DIRECTIVE_RE = /^[ \t]*#(set|def)[ \t]+%(\w+)%[ \t]*=[ \t]*((?:.*[^ \t\n\r\u2028\u2029])?)[ \t]*\r?$/gmu;
const CONDITIONAL_NAME_RE = /[A-Za-z_]\w*/y;
const PLURAL_PREFIX = 'plural ';

/**
 * Parse a full template into an AST (sanitised + comments stripped + directives extracted first).
 *
 * **This is the one door from author source into a tree, and it sanitises.** Stray engine
 * sentinels (U+E000–U+E005) come out first, so a reserved-range character an author typed
 * cannot survive to be rewritten into a brace by the mandatory {@link safetyRestore} — the
 * invariant `neutralize` documents ("only `neutralize()` may introduce a sentinel"). It lives
 * here rather than at each caller because there were three callers and two of them (`parse()`
 * and `analyze(str)`) forgot it, so `render(parse(src))` diverged from `render(src)` on that
 * edge and broke the parse-once-reuse contract (#51).
 *
 * {@link parseSequence} is NOT sanitised, and must not be: it re-parses a variable's *value*,
 * where sentinels a host neutralized are legitimate and have to reach the safety-restore.
 *
 * `source` keeps the ORIGINAL, unsanitised text — the validator reads it to place diagnostics,
 * which must point at the bytes the author actually wrote.
 */
export function parseTemplate(src: string): ParsedAst {
  const { body, setDefs, defDefs } = extractDirectives(stripComments(stripSentinels(src)));
  return { astVersion: AST_VERSION, source: src, setDefs, defDefs, nodes: parseSequence(body) };
}

/** One directive occurrence, in source order, with the line it was written on. */
export interface DirectiveOccurrence {
  readonly kind: 'set' | 'def';
  readonly name: string;
  readonly value: string;
  readonly line: number;
}

/**
 * Global directive extraction (parity with `extract_directives`): pull every line-anchored
 * `#set`/`#def` out of the text — regardless of brace nesting — collecting name→value (name
 * lowercased), strip the lines, then collapse `\n{3,}`→`\n\n`.
 *
 * `occurrences` preserves every directive line including duplicates that the two maps flatten
 * away: a validator cannot report a collision it can no longer see.
 */
export function extractDirectives(text: string): {
  body: string;
  setDefs: Record<string, string>;
  defDefs: Record<string, string>;
  occurrences: DirectiveOccurrence[];
} {
  const setDefs: Record<string, string> = {};
  const defDefs: Record<string, string> = {};
  const occurrences: DirectiveOccurrence[] = [];

  // Match offsets ascend (replace scans left to right), so the line number resumes
  // from the previous match instead of recounting from the start of the text — a
  // fresh count per occurrence made a directive-heavy document quadratic.
  let cursorOffset = 0;
  let cursorLine = 1;
  const lineAt = (offset: number): number => {
    for (let i = cursorOffset; i < offset; i += 1) {
      if (text.charCodeAt(i) === 10) cursorLine += 1;
    }
    cursorOffset = offset;
    return cursorLine;
  };

  DIRECTIVE_RE.lastIndex = 0;
  const stripped = text.replace(
    DIRECTIVE_RE,
    (full: string, kind: string, rawName: string, value: string, offset: number): string => {
      const name = rawName.toLowerCase();
      occurrences.push({
        kind: kind as 'set' | 'def',
        name,
        value,
        line: lineAt(offset),
      });
      if (kind === 'def') defDefs[name] = value;
      else setDefs[name] = value;
      return '';
    },
  );

  return { body: stripped.replace(/\n{3,}/gu, '\n\n'), setDefs, defDefs, occurrences };
}

/**
 * Remove `/# … #/` block comments (non-greedy, spans newlines): each `/#` to the first `#/` after it,
 * what `/\/#[\s\S]*?#\//g` removed — without retrying that lazy run from every `/#` once no `#/` is
 * left, which read to the end of the text from each of them.
 */
export function stripComments(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const open = text.indexOf('/#', from);
    if (open === -1) break;
    const close = text.indexOf('#/', open + 2);
    if (close === -1) break;
    out += text.slice(from, open);
    from = close + 2;
  }
  return from === 0 ? text : out + text.slice(from);
}

/**
 * Parse a run of text into a node sequence (construct parsing only — no comment strip / #set
 * extraction; the renderer uses this to re-process variable values).
 *
 * A construct's children are SPANS of the one text, read against one {@link TextIndex}, never copies
 * of it: every step that decides what a construct is — its closer, its top-level pipes, a conditional's
 * pipe, a config's end, a closing tag, a trailing separator — asks the index about the span, and costs
 * what the construct itself holds, plus a binary search. Scanning each construct's content instead read
 * the whole subtree at every level, and the re-read lets a few hundred bytes of macros spell tens of
 * thousands of levels: 705 bytes, 32 768 levels, 31–40 s (#68 had kept that cost when depth still cost
 * source).
 */
export function parseSequence(text: string): Node[] {
  const index = new TextIndex(text);

  interface Frame {
    readonly start: number;
    readonly end: number;
    i: number;
    /** Where the pending literal starts: everything from here to `i` that no node took. */
    literal: number;
    nodes: Node[];
    /** The construct whose children this frame is collecting, if any. */
    plan: ChildPlan | null;
    parts: Node[][];
  }

  const frame = (start: number, end: number): Frame => ({
    start,
    end,
    i: start,
    literal: start,
    nodes: [],
    plan: null,
    parts: [],
  });
  const stack: Frame[] = [frame(0, text.length)];

  while (stack.length > 0) {
    const f = stack[stack.length - 1] as Frame;

    // A construct is mid-flight: descend into its next child, or assemble it.
    if (f.plan !== null) {
      if (f.parts.length < f.plan.spans.length) {
        const span = f.plan.spans[f.parts.length] as Span;
        stack.push(frame(span[0], span[1]));
        continue;
      }
      f.nodes.push(f.plan.build(f.parts));
      f.plan = null;
      f.parts = [];
      continue;
    }

    const flushLiteral = (to: number): void => {
      if (to > f.literal) f.nodes.push({ type: 'literal', value: text.slice(f.literal, to) });
    };

    let planned: Planned | null = null;
    while (f.i < f.end && planned === null) {
      const code = text.charCodeAt(f.i);

      if (code === BRACE_OPEN || code === BRACKET_OPEN) {
        const close = index.closerWithin(f.i, f.end);
        if (close === -1) {
          f.i += 1;
          continue;
        }
        flushLiteral(f.i);
        planned = code === BRACE_OPEN ? planBraceConstruct(index, f.i + 1, close) : planPermutation(index, f.i + 1, close);
        f.i = close + 1;
        f.literal = f.i;
        continue;
      }

      if (code === PERCENT) {
        VARIABLE_RE.lastIndex = f.i;
        const m = VARIABLE_RE.exec(text);
        // A reference ends inside its span or is none: the closing `%` of a longer one belongs elsewhere.
        if (m !== null && VARIABLE_RE.lastIndex <= f.end) {
          flushLiteral(f.i);
          f.nodes.push({ type: 'variable', name: m[1] as string });
          f.i = VARIABLE_RE.lastIndex;
          f.literal = f.i;
          continue;
        }
      }

      f.i += 1;
    }

    if (planned !== null) {
      if ('node' in planned) f.nodes.push(planned.node);
      else f.plan = planned;
      continue;
    }

    // Frame exhausted: finish it and hand its nodes to the parent's pending construct.
    flushLiteral(f.end);
    stack.pop();
    const parent = stack[stack.length - 1];
    if (parent !== undefined) parent.parts.push(f.nodes);
    else return f.nodes;
  }

  return [];
}

/** `[start, end)` of the text a {@link TextIndex} holds. */
type Span = readonly [number, number];

/**
 * A construct whose children still need parsing: their spans, and how to assemble the node once they
 * are parsed.
 *
 * This is what lets the parser be iterative. Each construct used to call
 * `parseSequence` on every child — one stack frame per level of nesting — so
 * `parse()` threw `RangeError` at about 2000 levels, a 3.9 KB template, and `render()`
 * did the same over the tree it produced (#68). §9.2 says the engine never throws on
 * content. The shape mirrors the Python port's `_plan_*` functions, written this way
 * from the start for exactly this reason.
 */
type ChildPlan = { spans: Span[]; build: (parts: Node[][]) => Node };
type Planned = { node: Node } | ChildPlan;

/** The spans between the given pipes of `[start, end)`. */
function spansBetween(start: number, end: number, pipes: readonly number[]): Span[] {
  const spans: Span[] = [];
  let from = start;
  for (const pipe of pipes) {
    spans.push([from, pipe]);
    from = pipe + 1;
  }
  spans.push([from, end]);
  return spans;
}

/**
 * Decide what a `{…}` (content `[start, end)`) is: a conditional (`?…`), a plural (`plural …:` …),
 * or — the default and the fallback for a malformed conditional — an enumeration.
 */
function planBraceConstruct(index: TextIndex, start: number, end: number): Planned {
  const { text } = index;
  if (start < end && text.charCodeAt(start) === QUESTION) {
    const head = recognizeConditional(text, start, end, index.anyPairs());
    if (head !== null) {
      const then: Span = [head.bodyStart, head.sepIndex < 0 ? end : head.sepIndex];
      const otherwise: Span = head.sepIndex < 0 ? [end, end] : [head.sepIndex + 1, end];
      return {
        spans: [then, otherwise],
        build: (children) => ({
          type: 'conditional',
          name: head.name,
          inverted: head.inverted,
          then: children[0] ?? [],
          else: children[1] ?? [],
        }),
      };
    }
    // Malformed conditional ⇒ fall back to enumeration (plugin parity).
  } else if (end - start >= PLURAL_PREFIX.length && text.startsWith(PLURAL_PREFIX, start)) {
    const colon = index.colonWithin(start + PLURAL_PREFIX.length, end);
    if (colon !== -1) {
      // Count + raw forms are kept as strings; the renderer expands variables in them
      // FIRST (Stage 6d runs after var-expansion, before enum/perm), then splits/checks.
      return {
        node: {
          type: 'plural',
          countRaw: text.slice(start + PLURAL_PREFIX.length, colon),
          formsRaw: text.slice(colon + 1, end),
        },
      };
    }
  }
  return {
    spans: spansBetween(start, end, index.topLevelPipes(start, end)),
    build: (children) => {
      if (!needsTextualReread(children)) return { type: 'enumeration', options: children };
      const node: Node = { type: 'enumeration', options: children, raw: text.slice(start, end) };
      rereadSpans.set(node, { index, start, end });
      return node;
    },
  };
}

/**
 * Does a construct body hold something the reference engines see as TEXT before they split it?
 *
 * - A `%var%` at the top level of an option: expansion runs over the whole text before any bracket
 *   is read, so a `|` in the value separates options there (#78).
 * - A `{?…}` conditional at the top level of an option: the plugin resolves it at Stage 6a, so the
 *   taken branch lands in the body ahead of the split — a `|` it carries separates options, and an
 *   empty branch leaves an empty element for the permutation to drop. 0.7.0 marked a conditional
 *   only when a `%var%` sat in its branches, so `[{?f?a|b|x}|c]` rendered a raw `|` and
 *   `[{?f?live}|slots|poker]` kept a blank element (#80).
 *
 * Nested enumerations / permutations / plurals are not entered: a value inside them is spliced when
 * THEY render, and a `|` it carries belongs to them. A conditional marks on sight, so there is no
 * branch left to descend into — the scan is flat.
 */
export function needsTextualReread(lists: readonly (readonly Node[])[]): boolean {
  return lists.some((list) => list.some((node) => node.type === 'variable' || node.type === 'conditional'));
}

/** A `%var%` reference written inside a separator string — config or per-element. */
const REFERENCE_RE = /%\w+%/u;
/**
 * A whole `{?…}` the renderer's conditional pass would resolve, written in the same places — Stage 6a
 * resolves it there too, before any bracket is read. A bare `{?` is not enough: `<{?}>` is a literal
 * separator, and marking it made every level of `[<{?}>a|[<{?}>a|…]]` rescan the nested body for a
 * conditional that is not there (found in review).
 */
function holdsConditional(text: string): boolean {
  if (!text.includes('{?')) return false;
  const opens: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '{') {
      opens.push(i);
    } else if (ch === '}') {
      const open = opens.pop();
      if (open !== undefined && text.charAt(open + 1) === '?' && recognizeConditional(text, open + 1, i) !== null) {
        return true;
      }
    }
  }
  return false;
}
const holdsTextForReread = (text: string): boolean => REFERENCE_RE.test(text) || holdsConditional(text);

/**
 * `[<config>a|b|c]` (content `[start, end)`) — the config and the per-element separators resolve here;
 * the element spans are parsed by the caller's loop.
 */
function planPermutation(index: TextIndex, start: number, end: number): Planned {
  const { text } = index;
  const { config, contentStart } = extractPermutationConfig(index, start, end);
  const { spans, separators } = permutationElements(index, spansBetween(contentStart, end, index.topLevelPipes(contentStart, end)));
  // The reference engines resolve conditionals in and expand the config and the per-element
  // separators too — to them it is all text — so a reference or a `{?…}` ANYWHERE in the `<…>`
  // header or a separator is as direct as one in an element: a size (`minsize=%n%`), an unquoted
  // separator (`sep=%S%`), `lastsep="{?en? and | и }"`. The header is exactly what precedes the
  // content. (0.7.0 tested the PARSED `sep` and `lastsep` for references only, where `%n%` never
  // arrives — a size that is not digits parses to nothing, an unquoted separator to the default — so
  // none of these was ever read as text: #80.)
  const header = text.slice(start, contentStart);
  const textNeedsReread = holdsTextForReread(header) || separators.some((sep) => sep !== null && holdsTextForReread(sep));
  return {
    spans,
    build: (children) => {
      const options = children.map((nodes, i) => ({ nodes, separator: separators[i] ?? null }));
      if (!textNeedsReread && !needsTextualReread(children)) return { type: 'permutation', config, options };
      const node: Node = { type: 'permutation', config, options, raw: text.slice(start, end) };
      rereadSpans.set(node, { index, start, end });
      return node;
    },
  };
}

/**
 * A recognized `{?…}` as OFFSETS into the string it was found in — no branch text
 * copied out. The count-slot pass walks spans instead of substrings; slicing the
 * branch per level of nesting is quadratic on a deeply nested template, and that
 * template arrives from the public Worker.
 */
export interface ConditionalHead {
  readonly name: string;
  readonly inverted: boolean;
  /** Offset of the body (past `?name?`). */
  readonly bodyStart: number;
  /** Offset of the top-level `|`, or -1 when the branch stands alone. */
  readonly sepIndex: number;
}

/**
 * Recognize `?VAR?then|else` / `?!VAR?then` in `text[contentStart, contentEnd)`
 * (the span between the braces), or null if malformed — the ONE place the
 * conditional grammar lives. Reports offsets only.
 *
 * The renderer needs the branches unparsed as well as parsed: the plural count
 * slot resolves conditionals textually, without resolving the enums a branch may
 * carry (spintax-js#67). Two readers, one recognizer — a second copy of these
 * rules would be a syntax-surface divergence waiting to happen (#55–#57).
 *
 * `anyPairs` ({@link matchAnyPairs} of `text`) lets the branch split jump over nested constructs
 * instead of reading them; without it the body is scanned, which a short text can afford.
 */
export function recognizeConditional(
  text: string,
  contentStart: number,
  contentEnd: number,
  anyPairs?: Int32Array,
): ConditionalHead | null {
  let p = contentStart + 1; // past the leading '?'
  let inverted = false;
  if (text.charAt(p) === '!') {
    inverted = true;
    p += 1;
  }

  CONDITIONAL_NAME_RE.lastIndex = p;
  const name = CONDITIONAL_NAME_RE.exec(text)?.[0];
  if (name === undefined || p + name.length > contentEnd) return null;
  p += name.length;

  if (text.charAt(p) !== '?') return null; // required '?' after the name
  p += 1;

  const sepIndex = anyPairs === undefined ? firstTopLevelPipe(text, p, contentEnd) : firstTopLevelPipeByPairs(text, p, contentEnd, anyPairs);
  return { name, inverted, bodyStart: p, sepIndex };
}

// ─── Permutation parsing (config + per-element separators) ────────────────────

// The plugin writes these without /u — byte mode — so its `\s` is ASCII here, and JS's `\s` is
// Unicode whatever the flags: the class is spelled out, or `minsize<NBSP>=2` is a size to this
// parser and a single separator to PHP's (./charclass has the rule for both kinds of pattern).
const CONFIG_KEY_RE = /\b(?:minsize|maxsize|sep|lastsep)[ \t\n\x0B\f\r]*=/i;
const MINSIZE_RE = /minsize[ \t\n\x0B\f\r]*=[ \t\n\x0B\f\r]*(\d+)/i;
const MAXSIZE_RE = /maxsize[ \t\n\x0B\f\r]*=[ \t\n\x0B\f\r]*(\d+)/i;
const SEP_RE = /(?<!last)sep[ \t\n\x0B\f\r]*=[ \t\n\x0B\f\r]*"([^"]*)"/i; // negative lookbehind excludes "lastsep"
const LASTSEP_RE = /lastsep[ \t\n\x0B\f\r]*=[ \t\n\x0B\f\r]*"([^"]*)"/i;
// One whitespace character, not a run: `[^>]*` takes whitespace too, so the same strings match — and
// `[ws]+[^>]*` let the two runs trade characters, every split retried when a quoted `>` in the config
// makes `$` fail. Quadratic in the config, which a macro can make a megabyte long.
const HTML_TAG_RE = /^([a-zA-Z][a-zA-Z0-9-]*)(?:[ \t\n\x0B\f\r][^>]*)?\/?$/;
const PER_ELEM_HTML_RE = /^[a-zA-Z][a-zA-Z0-9]*[ \t\n\x0B\f\r]/;

function defaultPermConfig(): PermConfig {
  return { minsize: null, maxsize: null, sep: ' ', lastsep: null };
}

/**
 * Split a leading `<config>` off the body `[start, end)` (config is extracted BEFORE the top-level
 * split). Without one, the content is the whole body, leading whitespace included.
 */
function extractPermutationConfig(index: TextIndex, start: number, end: number): { config: PermConfig; contentStart: number } {
  const { text } = index;
  let lt = start;
  while (lt < end && isPhpTrimChar(text.charCodeAt(lt))) lt += 1;
  if (lt === end || text.charCodeAt(lt) !== LT) return { config: defaultPermConfig(), contentStart: start };

  const gt = index.configEnd(lt, end);
  if (gt === -1) return { config: defaultPermConfig(), contentStart: start };

  const configStr = text.slice(lt + 1, gt);
  // A leading `<li>…</li>`-style tag is HTML, not config.
  if (looksLikeHtmlStartTag(index, configStr, gt + 1, end)) return { config: defaultPermConfig(), contentStart: start };
  return { config: parseConfigString(configStr), contentStart: gt + 1 };
}

function parseConfigString(str: string): PermConfig {
  if (!CONFIG_KEY_RE.test(str)) {
    // Single-separator form: the whole string is sep (and lastsep).
    return { minsize: null, maxsize: null, sep: str, lastsep: str };
  }
  return {
    minsize: intGroup(MINSIZE_RE.exec(str)),
    maxsize: intGroup(MAXSIZE_RE.exec(str)),
    sep: strGroup(SEP_RE.exec(str)) ?? ' ',
    lastsep: strGroup(LASTSEP_RE.exec(str)),
  };
}

/**
 * Is the config a start tag whose closing tag follows in `[from, end)`? The closing tag is looked up in
 * the index — neither a pattern built from this tag's name (V8 would not compile one past about 7.8 KB,
 * and parse() threw `SyntaxError`, render() too from 333 bytes of macros) nor a scan of the rest of the
 * body at every level.
 */
function looksLikeHtmlStartTag(index: TextIndex, tagText: string, from: number, end: number): boolean {
  const trimmed = phpTrim(tagText);
  if (trimmed === '') return false;
  const m = HTML_TAG_RE.exec(trimmed);
  if (!m) return false;
  if (trimmed.endsWith('/')) return true; // self-closing
  return index.hasClosingTag((m[1] ?? '').toLowerCase(), from, end);
}

/**
 * Turn raw split parts into elements, moving a trailing `<sep>` on part[i] to be
 * the per-element separator of the element from part[i+1]. Each element's span is
 * trimmed; empty elements are dropped (plugin `extract_per_element_separators`).
 */
function permutationElements(index: TextIndex, parts: readonly Span[]): { spans: Span[]; separators: (string | null)[] } {
  const { text } = index;
  const spans: Span[] = [];
  const separators: (string | null)[] = [];
  let pendingSep: string | null = null;

  parts.forEach(([partStart, partEnd], i) => {
    let textEnd = partEnd;
    let trailingSep: string | null = null;
    if (i < parts.length - 1) {
      const extracted = extractTrailingSep(index, partStart, partEnd);
      if (extracted) {
        textEnd = extracted.textEnd;
        trailingSep = extracted.sep;
      }
    }
    let a = partStart;
    let b = textEnd;
    while (a < b && isPhpTrimChar(text.charCodeAt(a))) a += 1;
    while (b > a && isPhpTrimChar(text.charCodeAt(b - 1))) b -= 1;
    if (b > a) {
      spans.push([a, b]);
      separators.push(pendingSep);
    }
    pendingSep = trailingSep;
  });

  return { spans, separators };
}

/** Detect a trailing `< sep >` on the part `[start, end)` (not an HTML tag): where its text ends, and the separator. */
function extractTrailingSep(index: TextIndex, start: number, end: number): { textEnd: number; sep: string } | null {
  const { text } = index;
  let len = end;
  while (len > start && isPhpTrimChar(text.charCodeAt(len - 1))) len -= 1;
  if (len === start || text.charCodeAt(len - 1) !== GT) return null;

  // The nearest `<` or `>` before the final `>`: a `<` opens the separator, a `>` means nested or complex.
  const openPos = index.lastAngleWithin(start, len - 2);
  if (openPos === -1 || text.charCodeAt(openPos) === GT) return null;

  const inner = text.slice(openPos + 1, len - 1);
  const innerTrimmed = phpTrim(inner);
  // HTML tag → not a separator: closing </x>, self-closing <x/>, or tag-with-attrs `<x …>`.
  if (innerTrimmed.startsWith('/') || innerTrimmed.endsWith('/') || PER_ELEM_HTML_RE.test(innerTrimmed)) {
    return null;
  }
  return { textEnd: openPos, sep: inner };
}

function intGroup(m: RegExpExecArray | null): number | null {
  return m && m[1] !== undefined ? Number.parseInt(m[1], 10) : null;
}
function strGroup(m: RegExpExecArray | null): string | null {
  return m && m[1] !== undefined ? m[1] : null;
}

// PHP trim strips only [ \t\n\r\0\x0B] — NOT the full JS Unicode whitespace set —
// so use these for byte-exact parity wherever the plugin trims (permutation
// config / element text / separators, plural forms).
//
// Loops, not `/[…]+$/`: an end-anchored run class is retried from every position of a whitespace
// run INSIDE the text and goes quadratic. 80 000 spaces cost seconds per call, and what gets trimmed
// can be a megabyte of expanded text — the renderer trims every permutation element it assembles.
export function isPhpTrimChar(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x00 || code === 0x0b;
}
export function phpTrim(s: string): string {
  return phpRtrim(phpLtrim(s));
}
function phpLtrim(s: string): string {
  let start = 0;
  while (start < s.length && isPhpTrimChar(s.charCodeAt(start))) start += 1;
  return start === 0 ? s : s.slice(start);
}
function phpRtrim(s: string): string {
  let end = s.length;
  while (end > 0 && isPhpTrimChar(s.charCodeAt(end - 1))) end -= 1;
  return end === s.length ? s : s.slice(0, end);
}

/**
 * Split on top-level `|` — mirrors the plugin's `split_top_level`: brace and
 * bracket depths tracked INDEPENDENTLY and decremented UNCONDITIONALLY (may go
 * negative), split only when BOTH are exactly 0. So `a]|b` stays one option.
 *
 * The parser asks {@link TextIndex.topLevelPipes} for the same pipes of a span; this is that
 * question put to a whole string.
 */
export function splitTopLevel(inner: string): string[] {
  return spansBetween(0, inner.length, new TextIndex(inner).topLevelPipes(0, inner.length)).map(([a, b]) => inner.slice(a, b));
}

/**
 * Index of the first top-level `|` in a conditional body, or -1. Uses a single
 * depth counter CLAMPED at 0 (matching the plugin's `parse_conditional` body
 * split, which differs from `split_top_level`'s signed dual counters).
 */
function firstTopLevelPipe(body: string, from = 0, to = body.length): number {
  let depth = 0;
  for (let j = from; j < to; j += 1) {
    const ch = body.charAt(j);
    if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      if (depth > 0) depth -= 1;
    } else if (ch === '|' && depth === 0) {
      return j;
    }
  }
  return -1;
}

/**
 * {@link firstTopLevelPipe}, jumping. The clamped counter is the size of a stack holding both bracket
 * kinds, so at depth zero an opener's run ends where {@link matchAnyPairs} closes it — the pairing a
 * span makes of its own openers is the whole text's — and nothing between is at the top level. An
 * opener that does not close before `to` keeps the depth above zero to the end.
 */
function firstTopLevelPipeByPairs(body: string, from: number, to: number, anyPairs: Int32Array): number {
  let j = from;
  while (j < to) {
    const code = body.charCodeAt(j);
    if (code === BRACE_OPEN || code === BRACKET_OPEN) {
      const close = anyPairs[j] as number;
      if (close === -1 || close >= to) return -1;
      j = close + 1;
    } else if (code === PIPE) {
      return j;
    } else {
      j += 1;
    }
  }
  return -1;
}

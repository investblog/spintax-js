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

const VARIABLE_RE = /^%(\w+)%/;
// `\r?` before the multiline `$` so a CRLF line strips cleanly (JS `.` excludes \r).
/**
 * The one grammar for `#set` and `#def`. Whitespace is `[ \t]` (not `\s`) so a directive is a
 * single line, and the value group is `(.*?)` so an empty value is legal. `\r?` before the
 * multiline `$` so a CRLF line strips cleanly (JS `.` excludes \r).
 */
export const DIRECTIVE_RE = /^[ \t]*#(set|def)[ \t]+%(\w+)%[ \t]*=[ \t]*(.*?)[ \t]*\r?$/gmu;
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

/** Remove `/# … #/` block comments (non-greedy, spans newlines). */
export function stripComments(text: string): string {
  return text.replace(/\/#[\s\S]*?#\//g, '');
}

/** Parse a run of text into a node sequence (construct parsing only — no comment
 *  strip / #set extraction; the renderer uses this to re-process variable values). */
export function parseSequence(text: string): Node[] {
  interface Frame {
    text: string;
    i: number;
    literal: string;
    nodes: Node[];
    /** The construct whose children this frame is collecting, if any. */
    plan: ChildPlan | null;
    parts: Node[][];
  }

  const frame = (t: string): Frame => ({ text: t, i: 0, literal: '', nodes: [], plan: null, parts: [] });
  const stack: Frame[] = [frame(text)];

  while (stack.length > 0) {
    const f = stack[stack.length - 1] as Frame;

    // A construct is mid-flight: descend into its next child, or assemble it.
    if (f.plan !== null) {
      if (f.parts.length < f.plan.texts.length) {
        stack.push(frame(f.plan.texts[f.parts.length] as string));
        continue;
      }
      f.nodes.push(f.plan.build(f.parts));
      f.plan = null;
      f.parts = [];
      continue;
    }

    const flushLiteral = (): void => {
      if (f.literal !== '') {
        f.nodes.push({ type: 'literal', value: f.literal });
        f.literal = '';
      }
    };

    let planned: Planned | null = null;
    while (f.i < f.text.length && planned === null) {
      const ch = f.text.charAt(f.i);

      if (ch === '{' || ch === '[') {
        const close = ch === '{' ? '}' : ']';
        const end = findMatchingClose(f.text, f.i, ch, close);
        if (end === -1) {
          f.literal += ch;
          f.i += 1;
          continue;
        }
        const inner = f.text.slice(f.i + 1, end);
        flushLiteral();
        planned = ch === '{' ? planBraceConstruct(inner) : planPermutation(inner);
        f.i = end + 1;
        continue;
      }

      if (ch === '%') {
        const name = VARIABLE_RE.exec(f.text.slice(f.i))?.[1];
        if (name !== undefined) {
          flushLiteral();
          f.nodes.push({ type: 'variable', name });
          f.i += name.length + 2; // "%" + name + "%"
          continue;
        }
      }

      f.literal += ch;
      f.i += 1;
    }

    if (planned !== null) {
      if ('node' in planned) f.nodes.push(planned.node);
      else f.plan = planned;
      continue;
    }

    // Frame exhausted: finish it and hand its nodes to the parent's pending construct.
    flushLiteral();
    stack.pop();
    const parent = stack[stack.length - 1];
    if (parent !== undefined) parent.parts.push(f.nodes);
    else return f.nodes;
  }

  return [];
}

/**
 * A construct whose children still need parsing: their raw texts, and how to assemble
 * the node once they are parsed.
 *
 * This is what lets the parser be iterative. Each construct used to call
 * `parseSequence` on every child — one stack frame per level of nesting — so
 * `parse()` threw `RangeError` at about 2000 levels, a 3.9 KB template, and `render()`
 * did the same over the tree it produced (#68). §9.2 says the engine never throws on
 * content. The shape mirrors the Python port's `_plan_*` functions, written this way
 * from the start for exactly this reason.
 */
type ChildPlan = { texts: string[]; build: (parts: Node[][]) => Node };
type Planned = { node: Node } | ChildPlan;

/**
 * Decide what a `{…}` (content between the braces) is: a conditional (`?…`), a
 * plural (`plural …:` …), or — the default and the fallback for a malformed
 * conditional — an enumeration.
 */
function planBraceConstruct(content: string): Planned {
  if (content.charAt(0) === '?') {
    const parts = splitConditional(content);
    if (parts !== null) {
      return {
        texts: [parts.thenRaw, parts.elseRaw],
        build: (children) => ({
          type: 'conditional',
          name: parts.name,
          inverted: parts.inverted,
          then: children[0] ?? [],
          else: children[1] ?? [],
        }),
      };
    }
    // Malformed conditional ⇒ fall back to enumeration (plugin parity).
  } else if (content.startsWith(PLURAL_PREFIX) && content.slice(PLURAL_PREFIX.length).includes(':')) {
    return { node: parsePlural(content.slice(PLURAL_PREFIX.length)) };
  }
  return {
    texts: splitTopLevel(content),
    build: (children) => ({ type: 'enumeration', options: children }),
  };
}

/**
 * `[<config>a|b|c]` — the config and the per-element separators resolve here; the
 * element texts are parsed by the caller's loop.
 */
function planPermutation(rawInner: string): Planned {
  const { config, content } = extractPermutationConfig(rawInner);
  const { texts, separators } = permutationElements(splitTopLevel(content));
  return {
    texts,
    build: (children) => ({
      type: 'permutation',
      config,
      options: children.map((nodes, i) => ({ nodes, separator: separators[i] ?? null })),
    }),
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

/** A recognized `{?…}` with its branches materialized — what the parser needs. */
export interface ConditionalParts {
  readonly name: string;
  readonly inverted: boolean;
  readonly thenRaw: string;
  readonly elseRaw: string;
}

/**
 * Recognize `?VAR?then|else` / `?!VAR?then` in `text[contentStart, contentEnd)`
 * (the span between the braces), or null if malformed — the ONE place the
 * conditional grammar lives. Reports offsets only; {@link splitConditional} is
 * the wrapper that materializes the branches for the parser.
 *
 * The renderer needs the branches unparsed as well as parsed: the plural count
 * slot resolves conditionals textually, without resolving the enums a branch may
 * carry (spintax-js#67). Two readers, one recognizer — a second copy of these
 * rules would be a syntax-surface divergence waiting to happen (#55–#57).
 */
export function recognizeConditional(
  text: string,
  contentStart: number,
  contentEnd: number,
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

  return { name, inverted, bodyStart: p, sepIndex: firstTopLevelPipe(text, p, contentEnd) };
}

export function splitConditional(content: string): ConditionalParts | null {
  const head = recognizeConditional(content, 0, content.length);
  if (head === null) return null;

  const body = content.slice(head.bodyStart);
  const sep = head.sepIndex < 0 ? -1 : head.sepIndex - head.bodyStart;

  return {
    name: head.name,
    inverted: head.inverted,
    thenRaw: sep < 0 ? body : body.slice(0, sep),
    elseRaw: sep < 0 ? '' : body.slice(sep + 1),
  };
}

/** Parse `<count>: forms` (the part after the `plural ` prefix). */
function parsePlural(afterPrefix: string): Node {
  const colon = afterPrefix.indexOf(':');
  // Count + raw forms are kept as strings; the renderer expands variables in them
  // FIRST (Stage 6d runs after var-expansion, before enum/perm), then splits/checks.
  return { type: 'plural', countRaw: afterPrefix.slice(0, colon), formsRaw: afterPrefix.slice(colon + 1) };
}

// ─── Permutation parsing (config + per-element separators) ────────────────────

const CONFIG_KEY_RE = /\b(?:minsize|maxsize|sep|lastsep)\s*=/i;
const MINSIZE_RE = /minsize\s*=\s*(\d+)/i;
const MAXSIZE_RE = /maxsize\s*=\s*(\d+)/i;
const SEP_RE = /(?<!last)sep\s*=\s*"([^"]*)"/i; // negative lookbehind excludes "lastsep"
const LASTSEP_RE = /lastsep\s*=\s*"([^"]*)"/i;
const HTML_TAG_RE = /^([a-zA-Z][a-zA-Z0-9-]*)(?:\s+[^>]*)?\/?$/;
const PER_ELEM_HTML_RE = /^[a-zA-Z][a-zA-Z0-9]*\s/;

function defaultPermConfig(): PermConfig {
  return { minsize: null, maxsize: null, sep: ' ', lastsep: null };
}

/** Split a leading `<config>` off the body (config is extracted BEFORE the top-level split). */
function extractPermutationConfig(content: string): { config: PermConfig; content: string } {
  const trimmed = phpLtrim(content);
  if (trimmed === '' || trimmed.charAt(0) !== '<') {
    return { config: defaultPermConfig(), content };
  }
  const end = findConfigEnd(trimmed);
  if (end === -1) return { config: defaultPermConfig(), content };

  const configStr = trimmed.slice(1, end);
  const remaining = trimmed.slice(end + 1);
  // A leading `<li>…</li>`-style tag is HTML, not config.
  if (looksLikeHtmlStartTag(configStr, remaining)) {
    return { config: defaultPermConfig(), content };
  }
  return { config: parseConfigString(configStr), content: remaining };
}

/** Index of the closing `>` of a `<…>` config, respecting quoted strings; -1 if none. */
function findConfigEnd(text: string): number {
  let inQuote = false;
  for (let i = 1; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '"') inQuote = !inQuote;
    if (ch === '>' && !inQuote) return i;
  }
  return -1;
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

function looksLikeHtmlStartTag(tagText: string, remaining: string): boolean {
  const trimmed = phpTrim(tagText);
  if (trimmed === '') return false;
  const m = HTML_TAG_RE.exec(trimmed);
  if (!m) return false;
  if (trimmed.endsWith('/')) return true; // self-closing
  const tagName = (m[1] ?? '').toLowerCase();
  return new RegExp(`</${escapeRegExp(tagName)}\\s*>`, 'iu').test(remaining);
}

/**
 * Turn raw split parts into elements, moving a trailing `<sep>` on part[i] to be
 * the per-element separator of the element from part[i+1]. Each element's text is
 * trimmed; empty elements are dropped (plugin `extract_per_element_separators`).
 */
function permutationElements(rawParts: string[]): { texts: string[]; separators: (string | null)[] } {
  const texts: string[] = [];
  const separators: (string | null)[] = [];
  let pendingSep: string | null = null;

  rawParts.forEach((part, i) => {
    let text = part;
    let trailingSep: string | null = null;
    if (i < rawParts.length - 1) {
      const extracted = extractTrailingSep(part);
      if (extracted) {
        text = extracted.text;
        trailingSep = extracted.sep;
      }
    }
    const trimmed = phpTrim(text);
    if (trimmed !== '') {
      texts.push(trimmed);
      separators.push(pendingSep);
    }
    pendingSep = trailingSep;
  });

  return { texts, separators };
}

/** Detect a trailing `< sep >` on a part (not an HTML tag). Returns {text, sep} or null. */
function extractTrailingSep(part: string): { text: string; sep: string } | null {
  const trimmed = phpRtrim(part);
  const len = trimmed.length;
  if (len === 0 || trimmed.charAt(len - 1) !== '>') return null;

  let openPos = -1;
  for (let i = len - 2; i >= 0; i -= 1) {
    const ch = trimmed.charAt(i);
    if (ch === '<') {
      openPos = i;
      break;
    }
    if (ch === '>') return null; // nested/complex, bail
  }
  if (openPos === -1) return null;

  const inner = trimmed.slice(openPos + 1, len - 1);
  const innerTrimmed = phpTrim(inner);
  // HTML tag → not a separator: closing </x>, self-closing <x/>, or tag-with-attrs `<x …>`.
  if (innerTrimmed.startsWith('/') || innerTrimmed.endsWith('/') || PER_ELEM_HTML_RE.test(innerTrimmed)) {
    return null;
  }
  return { text: trimmed.slice(0, openPos), sep: inner };
}

function intGroup(m: RegExpExecArray | null): number | null {
  return m && m[1] !== undefined ? Number.parseInt(m[1], 10) : null;
}
function strGroup(m: RegExpExecArray | null): string | null {
  return m && m[1] !== undefined ? m[1] : null;
}
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

// PHP trim strips only [ \t\n\r\0\x0B] — NOT the full JS Unicode whitespace set —
// so use these for byte-exact parity wherever the plugin trims (permutation
// config / element text / separators, plural forms).
const PHP_LTRIM_RE = /^[ \t\n\r\0\x0B]+/u;
const PHP_RTRIM_RE = /[ \t\n\r\0\x0B]+$/u;
function phpTrim(s: string): string {
  return s.replace(PHP_LTRIM_RE, '').replace(PHP_RTRIM_RE, '');
}
function phpLtrim(s: string): string {
  return s.replace(PHP_LTRIM_RE, '');
}
function phpRtrim(s: string): string {
  return s.replace(PHP_RTRIM_RE, '');
}

/**
 * Index of the `close` that matches the `open` at `openPos`, tracking depth of
 * this bracket pair only. Returns -1 if unmatched.
 */
function findMatchingClose(text: string, openPos: number, open: string, close: string): number {
  let depth = 0;
  for (let i = openPos; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split on top-level `|` — mirrors the plugin's `split_top_level`: brace and
 * bracket depths tracked INDEPENDENTLY and decremented UNCONDITIONALLY (may go
 * negative), split only when BOTH are exactly 0. So `a]|b` stays one option.
 */
export function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let brace = 0;
  let bracket = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '{') brace += 1;
    else if (ch === '}') brace -= 1;
    else if (ch === '[') bracket += 1;
    else if (ch === ']') bracket -= 1;

    if (ch === '|' && brace === 0 && bracket === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
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

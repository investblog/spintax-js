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
import { AST_VERSION, type Node, type ParsedAst, type PermConfig, type PermOption } from './ast';

const VARIABLE_RE = /^%(\w+)%/;
// `\r?` before the multiline `$` so a CRLF line strips cleanly (JS `.` excludes \r).
const SET_DIRECTIVE_RE = /^[ \t]*#set[ \t]+%(\w+)%[ \t]*=[ \t]*(.*?)[ \t]*\r?$/gmu;
const CONDITIONAL_NAME_RE = /^[A-Za-z_]\w*/;
const PLURAL_PREFIX = 'plural ';

/** Parse a full template into an AST (comments stripped + `#set` extracted first). */
export function parseTemplate(src: string): ParsedAst {
  const { body, setDefs } = extractSetDirectives(stripComments(src));
  return { astVersion: AST_VERSION, source: src, setDefs, nodes: parseSequence(body) };
}

/**
 * Global `#set` extraction (parity with `extract_set_directives`): pull every
 * line-anchored `#set %name% = value` out of the text — regardless of brace
 * nesting — collecting name→value (name lowercased), strip the lines, then
 * collapse `\n{3,}`→`\n\n`. Whitespace is `[ \t]` (not `\s`) so a directive is a
 * single line.
 */
export function extractSetDirectives(text: string): { body: string; setDefs: Record<string, string> } {
  const setDefs: Record<string, string> = {};
  SET_DIRECTIVE_RE.lastIndex = 0;
  const stripped = text.replace(SET_DIRECTIVE_RE, (_full: string, name: string, value: string): string => {
    setDefs[name.toLowerCase()] = value;
    return '';
  });
  return { body: stripped.replace(/\n{3,}/gu, '\n\n'), setDefs };
}

/** Remove `/# … #/` block comments (non-greedy, spans newlines). */
export function stripComments(text: string): string {
  return text.replace(/\/#[\s\S]*?#\//g, '');
}

/** Parse a run of text into a node sequence. */
function parseSequence(text: string): Node[] {
  const nodes: Node[] = [];
  let literal = '';
  let i = 0;

  const flushLiteral = (): void => {
    if (literal !== '') {
      nodes.push({ type: 'literal', value: literal });
      literal = '';
    }
  };

  while (i < text.length) {
    const ch = text.charAt(i);

    if (ch === '{') {
      const end = findMatchingClose(text, i, '{', '}');
      if (end === -1) {
        literal += ch;
        i += 1;
        continue;
      }
      const content = text.slice(i + 1, end);
      flushLiteral();
      nodes.push(parseBraceConstruct(content));
      i = end + 1;
      continue;
    }

    if (ch === '[') {
      const end = findMatchingClose(text, i, '[', ']');
      if (end === -1) {
        literal += ch;
        i += 1;
        continue;
      }
      flushLiteral();
      nodes.push(parsePermutation(text.slice(i + 1, end)));
      i = end + 1;
      continue;
    }

    if (ch === '%') {
      const name = VARIABLE_RE.exec(text.slice(i))?.[1];
      if (name !== undefined) {
        flushLiteral();
        nodes.push({ type: 'variable', name });
        i += name.length + 2; // "%" + name + "%"
        continue;
      }
    }

    literal += ch;
    i += 1;
  }

  flushLiteral();
  return nodes;
}

/**
 * Decide what a `{…}` (content between the braces) is: a conditional (`?…`), a
 * plural (`plural …:` …), or — the default and the fallback for a malformed
 * conditional — an enumeration.
 */
function parseBraceConstruct(content: string): Node {
  if (content.charAt(0) === '?') {
    const cond = tryParseConditional(content);
    if (cond) return cond;
    // Malformed conditional ⇒ fall back to enumeration (plugin parity).
  } else if (content.startsWith(PLURAL_PREFIX) && content.slice(PLURAL_PREFIX.length).includes(':')) {
    return parsePlural(content.slice(PLURAL_PREFIX.length));
  }
  return { type: 'enumeration', options: splitTopLevel(content).map((o) => parseSequence(o)) };
}

/** Parse `?VAR?then|else` / `?!VAR?then` (content starts with `?`), or null if malformed. */
function tryParseConditional(content: string): Node | null {
  let p = 1; // past the leading '?'
  let inverted = false;
  if (content.charAt(p) === '!') {
    inverted = true;
    p += 1;
  }

  const name = CONDITIONAL_NAME_RE.exec(content.slice(p))?.[0];
  if (name === undefined) return null;
  p += name.length;

  if (content.charAt(p) !== '?') return null; // required '?' after the name
  p += 1;

  const body = content.slice(p);
  const sep = firstTopLevelPipe(body);
  const thenRaw = sep < 0 ? body : body.slice(0, sep);
  const elseRaw = sep < 0 ? '' : body.slice(sep + 1);

  return {
    type: 'conditional',
    name,
    inverted,
    then: parseSequence(thenRaw),
    else: parseSequence(elseRaw),
  };
}

/** Parse `<count>: forms` (the part after the `plural ` prefix). */
function parsePlural(afterPrefix: string): Node {
  const colon = afterPrefix.indexOf(':');
  const countRaw = afterPrefix.slice(0, colon);
  const formsRaw = afterPrefix.slice(colon + 1);
  // Forms split on every pipe (plugin uses explode('|', …)); each form is
  // trimmed. Nested brackets in a form are invalid (validator's job).
  const forms = formsRaw.split('|').map((f) => parseSequence(phpTrim(f)));
  return { type: 'plural', countRaw, formsRaw, forms };
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

/** Parse a permutation body `[<config>a|b|c]` inner → config + options with per-element seps. */
function parsePermutation(rawInner: string): Node {
  const { config, content } = extractPermutationConfig(rawInner);
  const options = extractPerElementSeparators(splitTopLevel(content));
  return { type: 'permutation', config, options };
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
function extractPerElementSeparators(rawParts: string[]): PermOption[] {
  const options: PermOption[] = [];
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
      options.push({ nodes: parseSequence(trimmed), separator: pendingSep });
    }
    pendingSep = trailingSep;
  });

  return options;
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
function firstTopLevelPipe(body: string): number {
  let depth = 0;
  for (let j = 0; j < body.length; j += 1) {
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

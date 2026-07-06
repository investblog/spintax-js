/**
 * Recursive-descent parser: template string → {@link ParsedAst}.
 *
 * Lenient by contract (spec §9.2): never throws on malformed markup. Unmatched
 * brackets, malformed `{?…}` / `{plural …}`, and bare `%` degrade gracefully
 * (bad conditional/plural fall back to an enumeration, exactly as the plugin's
 * later passes would consume them). Structural *diagnostics* are the validator's
 * job (PR-12), not the parser's.
 *
 * `#set` / `#include` are line-anchored and detected only at true top-level line
 * starts (the plugin extracts them with `^…$` multiline regexes over the whole
 * template) — never inside a recursively-parsed option/branch, so
 * `{a|#set %x%=b}` stays an enumeration.
 *
 * Known descent-vs-global-pass gaps (not exercised by the corpus; revisit at M2
 * if needed): a directive on its own line INSIDE a multi-line `{…}` group is not
 * extracted (the plugin's global `/m` regex is brace-oblivious); and the
 * plugin's `\n{3,}`→`\n\n` collapse after stripping `#set` lines is an M2 render
 * concern (the parser leaves every newline as a literal).
 */
import { AST_VERSION, type Node, type ParsedAst } from './ast';

const VARIABLE_RE = /^%(\w+)%/;
const SET_LINE_RE = /^[ \t]*#set[ \t]+%(\w+)%[ \t]*=[ \t]*(.*?)[ \t]*$/;
const INCLUDE_LINE_RE = /^[ \t]*#include[ \t]+"([^"]+)"[ \t]*$/;
const CONDITIONAL_NAME_RE = /^[A-Za-z_]\w*/;
const PLURAL_PREFIX = 'plural ';

/** Parse a full template into an AST (comments stripped first). */
export function parseTemplate(src: string): ParsedAst {
  return { astVersion: AST_VERSION, nodes: parseSequence(stripComments(src), true) };
}

/** Remove `/# … #/` block comments (non-greedy, spans newlines). */
export function stripComments(text: string): string {
  return text.replace(/\/#[\s\S]*?#\//g, '');
}

/**
 * Parse a run of text into a node sequence. `detectDirectives` enables the
 * line-anchored `#set`/`#include` scan — true only for the outermost template
 * scan, false for recursive option/branch/form parses.
 */
function parseSequence(text: string, detectDirectives: boolean): Node[] {
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
    // Line-anchored directives (#set / #include) at a real line start.
    if (detectDirectives && (i === 0 || text.charAt(i - 1) === '\n')) {
      const lineEnd = indexOfOrEnd(text, '\n', i);
      // Drop a trailing CR so CRLF templates match (the plugin uses \s/\m). The
      // \r is inside [i, lineEnd) and is consumed with the directive line.
      const rawLine = text.slice(i, lineEnd);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

      const setM = SET_LINE_RE.exec(line);
      if (setM) {
        const name = setM[1];
        const valueRaw = setM[2];
        if (name !== undefined) {
          flushLiteral();
          nodes.push({ type: 'set', name, value: parseSequence(valueRaw ?? '', false) });
          i = lineEnd; // leave the trailing "\n" as literal (matches the plugin)
          continue;
        }
      }

      const incM = INCLUDE_LINE_RE.exec(line);
      const ref = incM?.[1];
      if (ref !== undefined) {
        flushLiteral();
        nodes.push({ type: 'include', ref });
        i = lineEnd;
        continue;
      }
    }

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
      nodes.push({ type: 'permutation', rawInner: text.slice(i + 1, end) });
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
  return { type: 'enumeration', options: splitTopLevel(content).map((o) => parseSequence(o, false)) };
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
    then: parseSequence(thenRaw, false),
    else: parseSequence(elseRaw, false),
  };
}

/** Parse `<count>: forms` (the part after the `plural ` prefix). */
function parsePlural(afterPrefix: string): Node {
  const colon = afterPrefix.indexOf(':');
  const countRaw = afterPrefix.slice(0, colon);
  const formsRaw = afterPrefix.slice(colon + 1);
  // Forms split on every pipe (plugin uses explode('|', …)); each form is
  // trimmed. Nested brackets in a form are invalid (validator's job).
  const forms = formsRaw.split('|').map((f) => parseSequence(f.trim(), false));
  return { type: 'plural', countRaw, formsRaw, forms };
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

function indexOfOrEnd(text: string, search: string, from: number): number {
  const idx = text.indexOf(search, from);
  return idx === -1 ? text.length : idx;
}

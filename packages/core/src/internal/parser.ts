/**
 * Recursive-descent parser: template string → {@link ParsedAst}.
 *
 * Lenient by contract (spec §9.2): never throws on malformed markup. An
 * unmatched `{`/`[` or a bare `%` is emitted as literal text so a bad block
 * survives; structural *diagnostics* are the validator's job (PR-12), not the
 * parser's.
 *
 * Nesting mirrors the plugin's innermost-out resolution: an option sequence can
 * itself contain enumerations/permutations, and a top-level `|` split ignores
 * pipes nested inside `{}`/`[]`.
 */
import { AST_VERSION, type Node, type ParsedAst } from './ast';

/** `%name%` — name is `\w+` (letters, digits, underscore); case handled at render. */
const VARIABLE_RE = /^%(\w+)%/;

/** Parse a full template into an AST (comments stripped first). */
export function parseTemplate(src: string): ParsedAst {
  return { astVersion: AST_VERSION, nodes: parseSequence(stripComments(src)) };
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

    if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']';
      const end = findMatchingClose(text, i, ch, close);
      if (end === -1) {
        // Unmatched opener ⇒ lenient: treat as literal, keep scanning.
        literal += ch;
        i += 1;
        continue;
      }
      const inner = text.slice(i + 1, end);
      flushLiteral();
      if (ch === '{') {
        // Enumeration has no config: split top-level and parse each option now.
        nodes.push({ type: 'enumeration', options: splitTopLevel(inner).map((o) => parseSequence(o)) });
      } else {
        // Permutation: keep the inner raw — PR-11 extracts <config> BEFORE splitting.
        nodes.push({ type: 'permutation', rawInner: inner });
      }
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
 * Index of the `close` that matches the `open` at `openPos`, tracking depth of
 * this bracket pair only (the other pair is transparent — innermost-out
 * resolution handles genuine nesting). Returns -1 if unmatched.
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
 * Split on top-level `|` — pipes nested inside `{}`/`[]` are not separators.
 * Mirrors the plugin's `split_top_level`: brace and bracket depths are tracked
 * INDEPENDENTLY and decremented UNCONDITIONALLY (may go negative on a stray
 * closer), and a `|` splits only when BOTH depths are exactly 0. This matters
 * for lenient inners with unmatched closers, e.g. `a]|b` stays one option.
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

/**
 * Static validator — ported from the plugin's `Validator` (parity gate §3.1).
 * Produces {@link Diagnostic}[] with the canonical, stable codes documented in
 * `@spintax/conformance`'s README. "Valid" ⇔ no `severity:'error'`.
 *
 * Bracket balance is a raw char scan (the lenient AST doesn't represent
 * imbalance). Plural and #include checks walk the AST. Positions are best-effort
 * — not parity-gated (§3.1): only `code` (+ severity) is.
 *
 * Circular `#include` is NOT a verdict here — it is a render-time maxDepth guard
 * (the plugin's validator never resolves includes).
 */
import type { Diagnostic, ValidateOptions } from '../index';
import { stripComments } from './parser';
import { findPluralBlocks, normalizeBaseLang, pluralArity } from './plurals';

const KNOWN_CONFIG_KEYS = new Set(['minsize', 'maxsize', 'sep', 'lastsep']);
const INCLUDE_RE = /^[ \t]*#include[ \t\n\r\f\x0B]+"([^"]+)"[ \t\n\r\f\x0B]*$/gmu; // ASCII \s (PHP parity)

/**
 * Pure raw-text validation — exactly like the plugin's `Validator` (which does
 * NOT build an AST). Scanning the raw text (not the lenient AST) is what lets
 * bracket imbalance and constructs nested inside `[…]` permutations be seen.
 */
export function validateTemplate(src: string, opts: ValidateOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const text = stripComments(src);

  checkBrackets(text, diagnostics);
  checkSetDirectives(text, diagnostics);
  checkPermutationConfigs(text, diagnostics);
  checkPlurals(text, opts.locale, diagnostics);
  checkVariableReferences(text, opts.knownVariables, diagnostics);
  if (opts.knownIncludes && opts.knownIncludes.length > 0) {
    checkIncludeTargets(text, opts.knownIncludes, diagnostics);
  }

  return diagnostics;
}

/** Position (+ optional end and structured data) attached to a Diagnostic. */
interface Pos { line: number; column: number; endLine?: number; endColumn?: number; data?: Record<string, unknown> }

function err(code: string, message: string, pos: Pos): Diagnostic {
  return { severity: 'error', code, message, ...pos };
}
function warn(code: string, message: string, pos: Pos): Diagnostic {
  return { severity: 'warning', code, message, ...pos };
}

/** 1-based (line, column) of a character offset. */
function offsetToLineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(Math.max(offset, 0), text.length);
  for (let i = 0; i < end; i += 1) {
    if (text.charAt(i) === '\n') { line += 1; lineStart = i + 1; }
  }
  return { line, column: end - lineStart + 1 };
}

/** A full [offset, offset+length) span as start + end positions. */
function span(text: string, offset: number, length: number): Pos {
  const s = offsetToLineCol(text, offset);
  const e = offsetToLineCol(text, offset + length);
  return { line: s.line, column: s.column, endLine: e.line, endColumn: e.column };
}

/** Balanced `{}`/`[]` with proper nesting (raw char scan, real line/col). */
function checkBrackets(text: string, out: Diagnostic[]): void {
  const close: Record<string, string> = { '{': '}', '[': ']' };
  const stack: Array<{ char: string; expect: string; line: number; column: number }> = [];
  let line = 1;
  let column = 1;

  for (const ch of text) {
    if (ch === '\n') {
      line += 1;
      column = 1;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push({ char: ch, expect: close[ch]!, line, column });
    } else if (ch === '}' || ch === ']') {
      const top = stack.pop();
      if (top === undefined) {
        out.push(err('bracket.unexpected-closing', `Unexpected closing '${ch}'.`, { line, column, endLine: line, endColumn: column + 1, data: { bracket: ch } }));
      } else if (top.expect !== ch) {
        out.push(err('bracket.mismatched', `'${top.char}' closed by '${ch}'.`, { line, column, endLine: line, endColumn: column + 1, data: { open: top.char, close: ch } }));
      }
    }
    column += 1;
  }

  for (const unclosed of stack) {
    out.push(err('bracket.unclosed', `Unclosed '${unclosed.char}'.`, { line: unclosed.line, column: unclosed.column, endLine: unclosed.line, endColumn: unclosed.column + 1, data: { bracket: unclosed.char } }));
  }
}

/** `#set` lines must match `#set %name% = value`. */
function checkSetDirectives(text: string, out: Diagnostic[]): void {
  const lines = text.split('\n');
  lines.forEach((lineText, idx) => {
    const trimmed = lineText.replace(/^[ \t]+/, '');
    if (!trimmed.startsWith('#set ') && !trimmed.startsWith('#set\t')) return;
    if (!/^#set\s+%(\w+)%\s*=\s*(.+)$/u.test(trimmed)) {
      const column = lineText.length - trimmed.length + 1; // first non-space char
      const line = idx + 1;
      out.push(err('set.malformed', 'Malformed #set. Expected: #set %name% = value', { line, column, endLine: line, endColumn: lineText.length + 1 }));
    }
  });
}

/** `[<config>]` prefixes: known keys only, minsize/maxsize must be digit runs. */
function checkPermutationConfigs(text: string, out: Diagnostic[]): void {
  for (const m of text.matchAll(/\[<([^>]*?)>/gu)) {
    const configStr = m[1] ?? '';
    if (!/\w+\s*=/.test(configStr)) continue; // not a key=value config
    const configBase = (m.index ?? 0) + 2; // offset of configStr in text (past "[<")

    for (const km of configStr.matchAll(/(\w+)\s*=/gu)) {
      const key = (km[1] ?? '').toLowerCase();
      if (!KNOWN_CONFIG_KEYS.has(key)) {
        out.push(err('permutation.unknown-key', `Unknown permutation config key: '${km[1]}'.`,
          { ...span(text, configBase + (km.index ?? 0), (km[1] ?? '').length), data: { key: km[1] } }));
      }
    }
    const min = /minsize\s*=\s*([^;>\s]+)/i.exec(configStr);
    if (min && !/^\d+$/.test(min[1] ?? '')) {
      out.push(err('permutation.minsize-not-integer', `minsize must be a positive integer, got '${min[1]}'.`,
        { ...span(text, configBase + min.index, min[0].length), data: { value: min[1] } }));
    }
    const max = /maxsize\s*=\s*([^;>\s]+)/i.exec(configStr);
    if (max && !/^\d+$/.test(max[1] ?? '')) {
      out.push(err('permutation.maxsize-not-integer', `maxsize must be a positive integer, got '${max[1]}'.`,
        { ...span(text, configBase + max.index, max[0].length), data: { value: max[1] } }));
    }
  }
}

/** `{plural …}`: no nested brackets in forms; form count matches locale arity. */
function checkPlurals(text: string, locale: string | undefined, out: Diagnostic[]): void {
  // Guard on the NORMALIZED base (like the plugin): a non-empty locale that
  // normalizes to '' (e.g. "_en") skips the arity check.
  const base = locale && locale !== '' ? normalizeBaseLang(locale) : '';
  const arity = base !== '' ? pluralArity(base) : 0;

  for (const block of findPluralBlocks(text)) {
    const at = span(text, block.start, block.end - block.start);
    if (/[{}[\]]/.test(block.formsRaw)) {
      out.push(err('plural.nested-brackets', '{plural ...}: forms must not contain nested spintax brackets.', at));
      continue;
    }
    if (arity > 0) {
      const count = block.formsRaw.split('|').length;
      if (count !== arity) {
        out.push(err('plural.arity', `{plural ...}: expected ${arity} forms, got ${count}.`,
          { ...at, data: { expected: arity, got: count } }));
      }
    }
  }
}

/** Self-reference + circular `#set` (errors) and undefined `%var%`/conditional refs (warnings). */
function checkVariableReferences(text: string, known: readonly string[] | undefined, out: Diagnostic[]): void {
  const knownSet = new Set((known ?? []).map((n) => n.toLowerCase()));
  // `[ \t]` (single-line), uniform with the parser's extract_set_directives and
  // extract.ts — so a malformed cross-line `#set` isn't treated as a definition.
  const defs = new Map<string, string>();
  const defPos = new Map<string, Pos>(); // %name% token span in its #set line
  for (const m of text.matchAll(/^[ \t]*#set[ \t]+%(\w+)%[ \t]*=[ \t]*(.*?)$/gmu)) {
    const name = (m[1] ?? '').toLowerCase();
    defs.set(name, m[2] ?? '');
    const nameOffset = (m.index ?? 0) + m[0].indexOf('%');
    defPos.set(name, span(text, nameOffset, name.length + 2));
  }

  const somewhere: Pos = { line: 1, column: 1 };
  for (const [name, value] of defs) {
    if (value.toLowerCase().includes(`%${name}%`)) {
      out.push(err('variable.self-reference', `Variable '${name}' references itself.`, defPos.get(name) ?? somewhere));
    }
  }
  for (const name of defs.keys()) {
    detectCycle(name, defs, [name], defPos.get(name) ?? somewhere, out);
  }

  // Blank #set lines to same-length whitespace so ref offsets still map to `text`
  // (a bare removal would shift every later column).
  const body = text.replace(/^[ \t]*#set[ \t]+%\w+%[ \t]*=[ \t]*.*?$/gmu, (m) => m.replace(/[^\n]/g, ' '));
  const seen = new Set<string>();
  const undefinedAt = (name: string, offset: number, length: number): void => {
    const key = name.toLowerCase();
    if (defs.has(key) || knownSet.has(key) || seen.has(key)) return;
    seen.add(key);
    out.push(warn('variable.undefined', `Variable '${name}' is not defined — may be a runtime variable.`,
      { ...span(text, offset, length), data: { name } }));
  };
  for (const m of body.matchAll(/%(\w+)%/gu)) undefinedAt(m[1] ?? '', m.index ?? 0, m[0].length);
  for (const m of body.matchAll(/\{\?!?([A-Za-z_]\w*)\?/gu)) {
    undefinedAt(m[1] ?? '', (m.index ?? 0) + m[0].indexOf(m[1] ?? ''), (m[1] ?? '').length);
  }
}

function detectCycle(current: string, defs: Map<string, string>, visited: string[], rootPos: Pos, out: Diagnostic[]): void {
  const value = defs.get(current) ?? '';
  for (const m of value.matchAll(/%(\w+)%/gu)) {
    const ref = (m[1] ?? '').toLowerCase();
    if (ref === current) continue; // self-reference already reported
    if (visited.includes(ref)) {
      out.push(err('variable.circular-reference', `Circular variable reference: ${[...visited, ref].join(' → ')}.`, rootPos));
      return;
    }
    if (defs.has(ref)) detectCycle(ref, defs, [...visited, ref], rootPos, out);
  }
}

/** Unknown `#include` targets — only when a slug list is supplied. Raw `/m` scan. */
function checkIncludeTargets(text: string, known: readonly string[], out: Diagnostic[]): void {
  const set = new Set(known);
  INCLUDE_RE.lastIndex = 0;
  for (const m of text.matchAll(INCLUDE_RE)) {
    const ref = m[1] ?? '';
    if (!set.has(ref)) {
      const refOffset = (m.index ?? 0) + m[0].indexOf('"') + 1; // inside the quotes
      out.push(err('include.unknown-target', `#include target '${ref}' does not match any known template.`,
        { ...span(text, refOffset, ref.length), data: { target: ref } }));
    }
  }
}

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
const INCLUDE_RE = /^[ \t]*#include\s+"([^"]+)"\s*$/gmu;

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
  checkVariableReferences(text, diagnostics);
  if (opts.knownIncludes && opts.knownIncludes.length > 0) {
    checkIncludeTargets(text, opts.knownIncludes, diagnostics);
  }

  return diagnostics;
}

function err(code: string, message: string, line = 1, column = 1): Diagnostic {
  return { severity: 'error', code, message, line, column };
}
function warn(code: string, message: string, line = 1, column = 1): Diagnostic {
  return { severity: 'warning', code, message, line, column };
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
        out.push(err('bracket.unexpected-closing', `Unexpected closing '${ch}'.`, line, column));
      } else if (top.expect !== ch) {
        out.push(err('bracket.mismatched', `'${top.char}' closed by '${ch}'.`, line, column));
      }
    }
    column += 1;
  }

  for (const unclosed of stack) {
    out.push(err('bracket.unclosed', `Unclosed '${unclosed.char}'.`, unclosed.line, unclosed.column));
  }
}

/** `#set` lines must match `#set %name% = value`. */
function checkSetDirectives(text: string, out: Diagnostic[]): void {
  const lines = text.split('\n');
  lines.forEach((lineText, idx) => {
    const trimmed = lineText.replace(/^[ \t]+/, '');
    if (!trimmed.startsWith('#set ') && !trimmed.startsWith('#set\t')) return;
    if (!/^#set\s+%(\w+)%\s*=\s*(.+)$/u.test(trimmed)) {
      out.push(err('set.malformed', 'Malformed #set. Expected: #set %name% = value', idx + 1));
    }
  });
}

/** `[<config>]` prefixes: known keys only, minsize/maxsize must be digit runs. */
function checkPermutationConfigs(text: string, out: Diagnostic[]): void {
  for (const m of text.matchAll(/\[<([^>]*?)>/gu)) {
    const configStr = m[1] ?? '';
    if (!/\w+\s*=/.test(configStr)) continue; // not a key=value config
    const line = countLines(text, m.index ?? 0);

    for (const km of configStr.matchAll(/(\w+)\s*=/gu)) {
      const key = (km[1] ?? '').toLowerCase();
      if (!KNOWN_CONFIG_KEYS.has(key)) {
        out.push(err('permutation.unknown-key', `Unknown permutation config key: '${km[1]}'.`, line));
      }
    }
    const min = /minsize\s*=\s*([^;>\s]+)/i.exec(configStr);
    if (min && !/^\d+$/.test(min[1] ?? '')) {
      out.push(err('permutation.minsize-not-integer', `minsize must be a positive integer, got '${min[1]}'.`, line));
    }
    const max = /maxsize\s*=\s*([^;>\s]+)/i.exec(configStr);
    if (max && !/^\d+$/.test(max[1] ?? '')) {
      out.push(err('permutation.maxsize-not-integer', `maxsize must be a positive integer, got '${max[1]}'.`, line));
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
    const line = countLines(text, block.start);
    if (/[{}[\]]/.test(block.formsRaw)) {
      out.push(err('plural.nested-brackets', '{plural ...}: forms must not contain nested spintax brackets.', line));
      continue;
    }
    if (arity > 0) {
      const count = block.formsRaw.split('|').length;
      if (count !== arity) {
        out.push(err('plural.arity', `{plural ...}: expected ${arity} forms, got ${count}.`, line));
      }
    }
  }
}

/** Self-reference + circular `#set` (errors) and undefined `%var%`/conditional refs (warnings). */
function checkVariableReferences(text: string, out: Diagnostic[]): void {
  // `[ \t]` (single-line), uniform with the parser's extract_set_directives and
  // extract.ts — so a malformed cross-line `#set` isn't treated as a definition.
  const defs = new Map<string, string>();
  for (const m of text.matchAll(/^[ \t]*#set[ \t]+%(\w+)%[ \t]*=[ \t]*(.*?)$/gmu)) {
    defs.set((m[1] ?? '').toLowerCase(), m[2] ?? '');
  }

  for (const [name, value] of defs) {
    if (value.toLowerCase().includes(`%${name}%`)) {
      out.push(err('variable.self-reference', `Variable '${name}' references itself.`));
    }
  }
  for (const name of defs.keys()) {
    detectCycle(name, defs, [name], out);
  }

  const body = text.replace(/^[ \t]*#set[ \t]+%\w+%[ \t]*=[ \t]*.*?$/gmu, '');
  const refs = new Set<string>();
  for (const m of body.matchAll(/%(\w+)%/gu)) refs.add((m[1] ?? '').toLowerCase());
  for (const m of body.matchAll(/\{\?!?([A-Za-z_]\w*)\?/gu)) refs.add((m[1] ?? '').toLowerCase());
  for (const ref of refs) {
    if (!defs.has(ref)) {
      out.push(warn('variable.undefined', `Variable '${ref}' is not defined — may be a runtime variable.`));
    }
  }
}

function detectCycle(current: string, defs: Map<string, string>, visited: string[], out: Diagnostic[]): void {
  const value = defs.get(current) ?? '';
  for (const m of value.matchAll(/%(\w+)%/gu)) {
    const ref = (m[1] ?? '').toLowerCase();
    if (ref === current) continue; // self-reference already reported
    if (visited.includes(ref)) {
      out.push(err('variable.circular-reference', `Circular variable reference: ${[...visited, ref].join(' → ')}.`));
      return;
    }
    if (defs.has(ref)) detectCycle(ref, defs, [...visited, ref], out);
  }
}

/** Unknown `#include` targets — only when a slug list is supplied. Raw `/m` scan. */
function checkIncludeTargets(text: string, known: readonly string[], out: Diagnostic[]): void {
  const set = new Set(known);
  INCLUDE_RE.lastIndex = 0;
  for (const m of text.matchAll(INCLUDE_RE)) {
    const ref = m[1] ?? '';
    if (!set.has(ref)) {
      out.push(
        err('include.unknown-target', `#include target '${ref}' does not match any known template.`, countLines(text, m.index ?? 0)),
      );
    }
  }
}

function countLines(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charAt(i) === '\n') n += 1;
  }
  return n;
}

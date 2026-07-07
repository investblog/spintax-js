/**
 * Variable / #set / #include enumeration for `extract()` (spec §9.2).
 *
 * Raw-text scan (like the validator) rather than an AST walk, so it is complete:
 * it catches `%var%` inside a `{plural <count>: …}` count slot and inside a
 * `[…]` permutation body — both of which the AST leaves as raw strings. The
 * `#set` definition target (`#set %name% =` LHS) is a *definition*, not a
 * reference, so it is stripped before collecting `refs`.
 *
 * Variable names (`refs`, `sets`) are LOWER-CASED — the engine's variable
 * identity is case-insensitive, so cross-referencing sets against refs (the
 * two-phase-include / host-provisioning use) works. `includes` slugs are left
 * as authored (host-resolved, not case-folded). Arrays are de-duplicated;
 * order is insertion (the corpus compares order-normalized).
 *
 * NOTE (best-effort on malformed input): the conditional-name scan keys off the
 * `{?NAME?` prefix without requiring the brace to close, so an unclosed
 * `{?foo?…` yields a phantom `foo` ref. Acceptable for an extraction API.
 */
import { stripComments } from './parser';

export interface ExtractResult {
  refs: string[];
  sets: string[];
  includes: string[];
}

// `#set` uses [ \t] (single-line), matching the parser / extract_set_directives —
// NOT \s, which would let a malformed multi-line `#set` be read as a definition.
const SET_DEF_RE = /^[ \t]*#set[ \t]+%(\w+)%[ \t]*=/gmu;
const SET_LHS_RE = /^[ \t]*#set[ \t]+%\w+%[ \t]*=/gmu;
const INCLUDE_RE = /^[ \t]*#include[ \t\n\r\f\x0B]+"([^"]+)"[ \t\n\r\f\x0B]*$/gmu; // ASCII \s (PHP parity)
const VARIABLE_RE = /%(\w+)%/gu;
const CONDITIONAL_REF_RE = /\{\?!?([A-Za-z_]\w*)\?/gu;

export function extractFromSource(src: string): ExtractResult {
  const text = stripComments(src);

  const sets = collect(text, SET_DEF_RE, true);
  const includes = collect(text, INCLUDE_RE, false);

  // Drop the `#set … =` LHS (keep the value) so a definition target is not a ref.
  const body = text.replace(SET_LHS_RE, '');
  const refs = new Set<string>();
  addAll(refs, body, VARIABLE_RE, true);
  addAll(refs, body, CONDITIONAL_REF_RE, true);

  return { refs: [...refs], sets, includes };
}

function collect(text: string, re: RegExp, fold: boolean): string[] {
  const seen = new Set<string>();
  addAll(seen, text, re, fold);
  return [...seen];
}

function addAll(target: Set<string>, text: string, re: RegExp, fold: boolean): void {
  for (const m of text.matchAll(re)) {
    const value = m[1];
    if (value !== undefined && value !== '') target.add(fold ? value.toLowerCase() : value);
  }
}

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
import { DIRECTIVE_RE, extractDirectives, stripComments } from './parser';
import { DEFAULT_PLURAL_ARITY, findPluralBlocks, normalizeBaseLang, pluralArity } from './plurals';

const KNOWN_CONFIG_KEYS = new Set(['minsize', 'maxsize', 'sep', 'lastsep']);
// The gap class is spelled out because no dialect's `\s` is this set — PHP's under /u is
// UCP-Unicode (measured, #55), not the ASCII this comment once claimed. Corpus-pinned.
const INCLUDE_RE = /^[ \t]*#include[ \t\n\r\f\x0B]+"([^"]+)"[ \t\n\r\f\x0B]*$/gmu;

/**
 * Pure raw-text validation — exactly like the plugin's `Validator` (which does
 * NOT build an AST). Scanning the raw text (not the lenient AST) is what lets
 * bracket imbalance and constructs nested inside `[…]` permutations be seen.
 */
export function validateTemplate(src: string, opts: ValidateOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const text = stripComments(src);
  const idx = buildLineIndex(text);

  checkBrackets(text, diagnostics);
  checkDirectives(text, diagnostics);
  checkPermutationConfigs(text, idx, diagnostics);
  checkPlurals(text, idx, opts.locale, diagnostics);
  checkVariableReferences(text, idx, opts.knownVariables, diagnostics);
  if (opts.knownIncludes && opts.knownIncludes.length > 0) {
    checkIncludeTargets(text, idx, opts.knownIncludes, diagnostics);
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

/**
 * Line-start offsets of `text`, built once per validate() call. Every diagnostic
 * position is then a binary search instead of a scan from offset 0 — the scan made
 * a diagnostic-heavy document quadratic (each of N diagnostics re-walked the text).
 */
interface LineIndex { starts: number[]; length: number }

function buildLineIndex(text: string): LineIndex {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return { starts, length: text.length };
}

/** 1-based (line, column) of a character offset — same clamp and column model as the old scan. */
function offsetToLineCol(idx: LineIndex, offset: number): { line: number; column: number } {
  const end = Math.min(Math.max(offset, 0), idx.length);
  let lo = 0;
  let hi = idx.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((idx.starts[mid] ?? 0) <= end) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: end - (idx.starts[lo] ?? 0) + 1 };
}

/** A full [offset, offset+length) span as start + end positions. */
function span(idx: LineIndex, offset: number, length: number): Pos {
  const s = offsetToLineCol(idx, offset);
  const e = offsetToLineCol(idx, offset + length);
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

/**
 * Directive lines must match the shared grammar, each name may be defined once, and `#include`
 * may not appear in a `#def` value.
 *
 * The shape test uses `DIRECTIVE_RE` rather than a private copy. The old copy differed from the
 * parser's in two ways — `\s` for whitespace and `(.+)` for the value — and the second was a live
 * defect: an empty value is legal and the parser accepts it, but this reported `#set %x% =` as
 * malformed unless a trailing space happened to be present.
 */
function checkDirectives(text: string, out: Diagnostic[]): void {
  const lines = text.split('\n');
  lines.forEach((lineText, idx) => {
    const trimmed = lineText.replace(/^[ \t]+/, '');
    const kind = (['#set', '#def'] as const).find(
      (candidate) => trimmed.startsWith(`${candidate} `) || trimmed.startsWith(`${candidate}\t`),
    );
    if (!kind) return;

    DIRECTIVE_RE.lastIndex = 0;
    if (!DIRECTIVE_RE.test(trimmed)) {
      const column = lineText.length - trimmed.length + 1; // first non-space char
      const line = idx + 1;
      const code = kind === '#def' ? 'def.malformed' : 'set.malformed';
      out.push(err(code, `Malformed ${kind}. Expected: ${kind} %name% = value`, { line, column, endLine: line, endColumn: lineText.length + 1 }));
    }
  });

  const { occurrences } = extractDirectives(text);
  const seen = new Map<string, number>();

  for (const occurrence of occurrences) {
    // A name defined twice is an error whichever directives are involved. The two maps flatten a
    // collision to last-wins before anyone can see it, which is why `occurrences` exists — and a
    // `#set`/`#def` pair sharing a name would be worse still, the two carrying opposite semantics.
    const first = seen.get(occurrence.name);
    if (first !== undefined) {
      out.push(err(
        'definition.duplicate-name',
        `Variable '${occurrence.name}' is defined more than once (first on line ${first}). A name belongs to one directive, once.`,
        { line: occurrence.line, column: 1 },
      ));
    } else {
      seen.set(occurrence.name, occurrence.line);
    }

    // Includes resolve after a definition is frozen, so one cannot be rolled into a value — it
    // would survive as literal text. Inside a `#set` it is fine: the macro is substituted verbatim
    // and its `#include` reaches the include stage in the body.
    if (occurrence.kind === 'def' && /#include\b/u.test(occurrence.value)) {
      out.push(err(
        'def.include-in-value',
        `#include cannot appear in a #def value ('${occurrence.name}'): includes resolve after the value is frozen. Use #set, or put the #include in the body.`,
        { line: occurrence.line, column: 1 },
      ));
    }
  }
}

/** `[<config>]` prefixes: known keys only, minsize/maxsize must be digit runs. */
function checkPermutationConfigs(text: string, idx: LineIndex, out: Diagnostic[]): void {
  for (const m of text.matchAll(/\[<([^>]*?)>/gu)) {
    const configStr = m[1] ?? '';
    if (!/\w+\s*=/.test(configStr)) continue; // not a key=value config
    const configBase = (m.index ?? 0) + 2; // offset of configStr in text (past "[<")

    for (const km of configStr.matchAll(/(\w+)\s*=/gu)) {
      const key = (km[1] ?? '').toLowerCase();
      if (!KNOWN_CONFIG_KEYS.has(key)) {
        out.push(err('permutation.unknown-key', `Unknown permutation config key: '${km[1]}'.`,
          { ...span(idx, configBase + (km.index ?? 0), (km[1] ?? '').length), data: { key: km[1] } }));
      }
    }
    const min = /minsize\s*=\s*([^;>\s]+)/i.exec(configStr);
    if (min && !/^\d+$/.test(min[1] ?? '')) {
      out.push(err('permutation.minsize-not-integer', `minsize must be a positive integer, got '${min[1]}'.`,
        { ...span(idx, configBase + min.index, min[0].length), data: { value: min[1] } }));
    }
    const max = /maxsize\s*=\s*([^;>\s]+)/i.exec(configStr);
    if (max && !/^\d+$/.test(max[1] ?? '')) {
      out.push(err('permutation.maxsize-not-integer', `maxsize must be a positive integer, got '${max[1]}'.`,
        { ...span(idx, configBase + max.index, max[0].length), data: { value: max[1] } }));
    }
  }
}

/** `{plural …}`: no nested brackets in forms; form count matches locale arity. */
function checkPlurals(text: string, idx: LineIndex, locale: string | undefined, out: Diagnostic[]): void {
  // Guard on the NORMALIZED base (like the plugin): a non-empty locale that
  // normalizes to '' (e.g. "_en") skips the arity check.
  const base = locale && locale !== '' ? normalizeBaseLang(locale) : '';
  const arity = base !== '' ? pluralArity(base) : 0;

  const tainted = macroTaintedNames(text);

  for (const block of findPluralBlocks(text)) {
    const at = span(idx, block.start, block.end - block.start);

    // A macro in the count slot: the count is still unresolved spintax when the plural is decided,
    // so the block resolves to nothing. `#def` is the fix — it freezes to a literal before the
    // body is walked — which is why this points at the directive, not at the plural block.
    for (const m of block.countSlot.matchAll(/%(\w+)%/gu)) {
      const name = (m[1] ?? '').toLowerCase();
      if (!tainted.has(name)) continue;
      out.push(err(
        'plural.count-macro',
        `{plural ...}: the count '${m[1]}' is a #set macro, so it is still unresolved spintax when the plural is decided and the block renders empty. Define it with #def instead.`,
        at,
      ));
    }

    if (/[{}[\]]/.test(block.formsRaw)) {
      out.push(err('plural.nested-brackets', '{plural ...}: forms must not contain nested spintax brackets. Extract via #def first — a #set is substituted verbatim and would put the brackets straight back.', at));
      continue;
    }
    const count = block.formsRaw.split('|').length;
    if (arity > 0) {
      if (count !== arity) {
        out.push(err('plural.arity', `{plural ...}: expected ${arity} forms, got ${count}.`,
          { ...at, data: { expected: arity, got: count } }));
      }
    } else if (count !== DEFAULT_PLURAL_ARITY) {
      // No locale ⇒ no arity VERDICT: the template may well be correct for the locale it
      // will be rendered with, and calling it invalid here would fail a good template for
      // a fact the caller never claimed. But `render` has no such luxury — it defaults to
      // 2 forms — so silence sends a 3-form block straight to the fullwidth-brace
      // fallback in finished text (issue #65: a pipeline shipped ｛plural …｝ to live
      // pages because validate stayed quiet). A warning says the one true thing: this
      // resolves only if a matching locale arrives at render time.
      out.push(warn(
        'plural.locale-missing',
        `{plural ...}: ${count} forms, but no locale was supplied. render defaults to ` +
          `${DEFAULT_PLURAL_ARITY} forms and leaves this block unresolved — pass the locale you will render with.`,
        { ...at, data: { got: count, defaultArity: DEFAULT_PLURAL_ARITY } },
      ));
    }
  }
}

/**
 * Spintax still unresolved when plural agreement runs: `[`, or `{` that does not open a
 * conditional.
 *
 * Stage order decides this, not bracket type. Conditionals resolve BEFORE plurals, so a `{?…}` in
 * a count value is already a literal when the count is read — flagging it would be a false
 * positive on a template that renders correctly. Enumerations and permutations resolve AFTER
 * plurals and are the real hazard. A nested `{plural …}` is NOT exempt either: it resolves in the
 * same pass as the outer block, not before it.
 *
 * Only `#set` names can be tainted; a `#def` is frozen to literal text before the walk begins.
 * Taint propagates through `#set` → `#set` references to a fixpoint, because the chain can be
 * arbitrarily long and carry no bracket at its final link.
 */
const UNRESOLVED_AT_PLURAL_TIME = /\[|\{(?!\?)/u;

function macroTaintedNames(text: string): Set<string> {
  const macros = extractDirectives(text).setDefs;
  const tainted = new Set<string>();
  const queue: string[] = [];

  for (const [name, value] of Object.entries(macros)) {
    if (UNRESOLVED_AT_PLURAL_TIME.test(value)) {
      tainted.add(name);
      queue.push(name);
    }
  }

  // Same closure the old fixpoint sweep computed, via reverse edges — the sweep
  // re-parsed every value once per newly tainted name, O(n²) on a macro chain.
  const dependents = new Map<string, string[]>();
  for (const [name, value] of Object.entries(macros)) {
    for (const m of value.matchAll(/%(\w+)%/gu)) {
      const ref = (m[1] ?? '').toLowerCase();
      const list = dependents.get(ref);
      if (list === undefined) dependents.set(ref, [name]);
      else list.push(name);
    }
  }
  while (queue.length > 0) {
    const source = queue.pop()!;
    for (const name of dependents.get(source) ?? []) {
      if (!tainted.has(name)) {
        tainted.add(name);
        queue.push(name);
      }
    }
  }

  return tainted;
}

/** Self-reference + circular definitions (errors) and undefined `%var%`/conditional refs (warnings). */
function checkVariableReferences(text: string, idx: LineIndex, known: readonly string[] | undefined, out: Diagnostic[]): void {
  const knownSet = new Set((known ?? []).map((n) => n.toLowerCase()));
  // `[ \t]` (single-line), uniform with the parser's extract_set_directives and
  // extract.ts — so a malformed cross-line `#set` isn't treated as a definition.
  const defs = new Map<string, string>();
  const defPos = new Map<string, Pos>(); // %name% token span in its #set line
  for (const m of text.matchAll(/^[ \t]*#(?:set|def)[ \t]+%(\w+)%[ \t]*=[ \t]*(.*?)$/gmu)) {
    const name = (m[1] ?? '').toLowerCase();
    defs.set(name, m[2] ?? '');
    const nameOffset = (m.index ?? 0) + m[0].indexOf('%');
    defPos.set(name, span(idx, nameOffset, name.length + 2));
  }

  const somewhere: Pos = { line: 1, column: 1 };
  for (const [name, value] of defs) {
    if (value.toLowerCase().includes(`%${name}%`)) {
      out.push(err('variable.self-reference', `Variable '${name}' references itself.`, defPos.get(name) ?? somewhere));
    }
  }

  // Each value's references, parsed once — the walk used to re-run the regex at
  // every visit of every root.
  const refsOf = new Map<string, string[]>();
  for (const [name, value] of defs) {
    const refs: string[] = [];
    for (const m of value.matchAll(/%(\w+)%/gu)) refs.push((m[1] ?? '').toLowerCase());
    refsOf.set(name, refs);
  }

  const reachesCycle = namesThatReachACycle(defs, refsOf);
  for (const name of defs.keys()) {
    detectCycle(name, defs, refsOf, reachesCycle, defPos.get(name) ?? somewhere, out);
  }

  // Blank #set lines to same-length whitespace so ref offsets still map to `text`
  // (a bare removal would shift every later column).
  const body = text.replace(/^[ \t]*#(?:set|def)[ \t]+%\w+%[ \t]*=[ \t]*.*?$/gmu, (m) => m.replace(/[^\n]/g, ' '));
  const seen = new Set<string>();
  const undefinedAt = (name: string, offset: number, length: number): void => {
    const key = name.toLowerCase();
    if (defs.has(key) || knownSet.has(key) || seen.has(key)) return;
    seen.add(key);
    out.push(warn('variable.undefined', `Variable '${name}' is not defined — may be a runtime variable.`,
      { ...span(idx, offset, length), data: { name } }));
  };
  for (const m of body.matchAll(/%(\w+)%/gu)) undefinedAt(m[1] ?? '', m.index ?? 0, m[0].length);
  for (const m of body.matchAll(/\{\?!?([A-Za-z_]\w*)\?/gu)) {
    undefinedAt(m[1] ?? '', (m.index ?? 0) + m[0].indexOf(m[1] ?? ''), (m[1] ?? '').length);
  }
}

/**
 * Names from which a cycle of length ≥ 2 is reachable, over the graph name → defined
 * refs with self-edges excluded — exactly the edges the reporting walk can traverse
 * (it skips `ref === current`, and a pure self-loop is `variable.self-reference`).
 *
 * This is the prune that makes the walk affordable, and it is output-neutral by
 * construction: a report fires only when the walk meets a name already on its path,
 * which is a cycle the met name lies on — so a subtree in which no name reaches any
 * cycle cannot emit, and skipping it changes nothing. Without the prune every root
 * re-walked its whole subgraph (a 400-definition chain took hundreds of milliseconds,
 * and a converging diamond re-explored shared subtrees exponentially — a one-kilobyte
 * template validate() never returned from). One iterative colour walk, computed once.
 */
function namesThatReachACycle(defs: Map<string, string>, refsOf: Map<string, string[]>): Set<string> {
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const reaches = new Set<string>();

  interface Frame { name: string; refs: string[]; i: number }
  for (const root of defs.keys()) {
    if (color.has(root)) continue;
    const stack: Frame[] = [{ name: root, refs: refsOf.get(root) ?? [], i: 0 }];
    color.set(root, GREY);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (top.i < top.refs.length) {
        const ref = top.refs[top.i]!;
        top.i += 1;
        if (ref === top.name || !defs.has(ref)) continue;
        const c = color.get(ref);
        if (c === GREY) reaches.add(top.name); // back edge — top sits on a cycle
        else if (c === BLACK) { if (reaches.has(ref)) reaches.add(top.name); }
        else {
          stack.push({ name: ref, refs: refsOf.get(ref) ?? [], i: 0 });
          color.set(ref, GREY);
        }
      } else {
        stack.pop();
        color.set(top.name, BLACK);
        if (stack.length > 0 && reaches.has(top.name)) reaches.add(stack[stack.length - 1]!.name);
      }
    }
  }
  return reaches;
}

/**
 * The reporting walk, exactly the recursive one it replaces: depth-first over a
 * value's references in order, one report per frame that meets a name already on
 * the path (the frame then abandons its remaining references; siblings continue
 * from the parent). Iterative so a definition chain as deep as the document cannot
 * overflow the call stack; the shared path array is pushed/popped instead of copied
 * per step, and membership is a Set — the array `includes` plus the per-step copy
 * made one 1600-definition cycle cost tens of seconds.
 */
function detectCycle(
  root: string,
  defs: Map<string, string>,
  refsOf: Map<string, string[]>,
  reachesCycle: Set<string>,
  rootPos: Pos,
  out: Diagnostic[],
): void {
  if (!reachesCycle.has(root)) return; // the root frame could only report ref === root, which it skips

  interface Frame { name: string; refs: string[]; i: number }
  const path: string[] = [root];
  const onPath = new Set<string>([root]);
  const stack: Frame[] = [{ name: root, refs: refsOf.get(root) ?? [], i: 0 }];

  const leave = (frame: Frame): void => {
    stack.pop();
    onPath.delete(frame.name);
    path.pop();
  };

  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    if (top.i >= top.refs.length) {
      leave(top);
      continue;
    }
    const ref = top.refs[top.i]!;
    top.i += 1;
    if (ref === top.name) continue; // self-reference already reported
    if (onPath.has(ref)) {
      out.push(err('variable.circular-reference', `Circular variable reference: ${[...path, ref].join(' → ')}.`, rootPos));
      leave(top); // the recursive walk returned from the whole frame here
      continue;
    }
    if (defs.has(ref) && reachesCycle.has(ref)) {
      stack.push({ name: ref, refs: refsOf.get(ref) ?? [], i: 0 });
      onPath.add(ref);
      path.push(ref);
    }
  }
}

/** Unknown `#include` targets — only when a slug list is supplied. Raw `/m` scan. */
function checkIncludeTargets(text: string, idx: LineIndex, known: readonly string[], out: Diagnostic[]): void {
  const set = new Set(known);
  INCLUDE_RE.lastIndex = 0;
  for (const m of text.matchAll(INCLUDE_RE)) {
    const ref = m[1] ?? '';
    if (!set.has(ref)) {
      const refOffset = (m.index ?? 0) + m[0].indexOf('"') + 1; // inside the quotes
      out.push(err('include.unknown-target', `#include target '${ref}' does not match any known template.`,
        { ...span(idx, refOffset, ref.length), data: { target: ref } }));
    }
  }
}

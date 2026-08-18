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
  checkPlurals(text, idx, opts.locale, opts.knownVariables, diagnostics);
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
function checkPlurals(
  text: string,
  idx: LineIndex,
  locale: string | undefined,
  knownVariables: readonly string[] | undefined,
  out: Diagnostic[],
): void {
  // Guard on the NORMALIZED base (like the plugin): a non-empty locale that
  // normalizes to '' (e.g. "_en") skips the arity check.
  const base = locale && locale !== '' ? normalizeBaseLang(locale) : '';
  const arity = base !== '' ? pluralArity(base) : 0;

  const tainted = macroTaintedNames(text);
  const { setDefs: macros, defDefs: defs } = extractDirectives(text);
  // Names the host says it will supply: runtime context outranks a definition of the
  // same name, so one of these makes a form count unknowable however the template
  // defines it.
  const hostNames = new Set((knownVariables ?? []).map((n) => n.toLowerCase()));

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

    // The form list AS THE RENDERER WILL SEE IT. `render` expands variables before it
    // counts forms (internal/render.ts), so counting the raw pipes here judged a
    // different string than the one that gets rendered — a `#def` holding `few|many`
    // made a correct 3-form Russian template report plural.arity, and a 1-pipe list
    // that expands to 2 forms reported nothing (issue #66, found adopting #65 in the
    // Pascal port).
    const expanded = expandFormsForCounting(block.formsRaw, defs, macros, hostNames);

    // A `#set` whose value carries spintax lands in the form list VERBATIM and is still
    // unresolved when the plural is decided — the same fact plural.count-macro states
    // for the count slot, and exactly what this message already describes.
    if (expanded.directMacroSpintax) {
      out.push(err('plural.nested-brackets', '{plural ...}: forms must not contain nested spintax brackets. Extract via #def first — a #set is substituted verbatim and would put the brackets straight back.', at));
      continue;
    }

    // A reference the template does not define — a host variable, or a chain past the
    // budget — has no static form count. Judging it would repeat the mistake #65 fixed:
    // filing a verdict on a fact the caller never claimed.
    if (expanded.unresolved) continue;

    const count = expanded.forms;
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
      // Two ways to arrive with no arity: nothing was passed, or what was passed does
      // not normalize to a language the engine knows (`_en`). Saying "no locale was
      // supplied" to a caller who supplied one sends them looking for the wrong bug.
      const unusable = locale !== undefined && locale !== '';
      out.push(warn(
        'plural.locale-missing',
        unusable
          ? `{plural ...}: ${count} forms, and the locale '${locale}' does not normalize to a ` +
            `language the engine knows, so render falls back to ${DEFAULT_PLURAL_ARITY} forms and ` +
            `leaves this block unresolved — pass a base tag such as 'en' or 'ru'.`
          : `{plural ...}: ${count} forms, but no locale was supplied. render defaults to ` +
            `${DEFAULT_PLURAL_ARITY} forms and leaves this block unresolved — pass the locale you will render with.`,
        {
          ...at,
          data: {
            got: count,
            defaultArity: DEFAULT_PLURAL_ARITY,
            ...(unusable ? { locale } : {}),
          },
        },
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

/**
 * Any bracket at all — all four, and conditionals too.
 *
 * Two reasons, and both were review findings. Conditionals: one resolves before plurals,
 * so it is not "unresolved at plural time", but its branches can differ in top-level
 * pipes (`{?flag?a|b|c}` freezes as `a` or as `b|c`), and counting is about invariance
 * rather than stage order. Closing brackets: a `#set %x% = ]` balances against a `[`
 * elsewhere in the template, so the bracket checker stays quiet, and every renderer's
 * plural guard is `[{}[\]]` — it rejects the form list on a stray closer exactly as on an
 * opener.
 *
 * Construct-free is a SUFFICIENT condition for the count to be invariant, deliberately
 * not a necessary one: `{a|b}` really does always freeze to one form. It is the property
 * this validator elects to prove, because the cases where a construct is invariant cannot
 * be told from the cases where it is not without evaluating it.
 */
const ANY_BRACKET = /[[\]{}]/u;

/**
 * Passes, not occurrences — each one substitutes EVERY reference, as the renderer's
 * expansion does. Counting occurrences instead made a form list with 51 references
 * exhaust the budget and go unjudged.
 *
 * It is deliberately NOT claimed to match a renderer's own limit (they differ: 50 here
 * and in Python, 51 in both PHP engines). It only has to terminate — a chain deeper than
 * this is suppressed rather than judged, which is the safe direction.
 */
const FORM_EXPANSION_PASSES = 51;
/**
 * How far the form list may GROW under expansion, in characters.
 *
 * Passes alone do NOT bound the work: `#set %a% = %b% %b%` over `#set %b% = %a% %a%`
 * doubles the text every pass, so 51 of them is 2^51 — a 62-character template took
 * `validate()` out with an out-of-memory crash in every engine of the family.
 *
 * Growth, not total size, and the difference is a verdict: `{plural 2: one|<65 KB of
 * ordinary text>}` is plainly two forms and must keep earning `plural.arity` under `ru`.
 * A ceiling on total length called that unknowable and flipped it to valid — a real
 * regression, caught in review before it shipped. Expansion that ADDS this much is a
 * graph exploding; a long form list is just long.
 */
const FORM_EXPANSION_MAX_GROWTH = 64 * 1024;

/**
 * How many forms the plural stage will actually receive — or an admission that it is not
 * knowable.
 *
 * Why this exists: `render` expands `%variables%` and only THEN splits the form list,
 * while this validator used to split the raw source, so any reference inside a form list
 * was judged on the wrong number in both directions (issue #66).
 *
 * The rule is deliberately narrow, and the narrowness IS the correction. A first version
 * tried to predict the roll — counting pipes at bracket depth 0, on the theory that a
 * construct always collapses to one form. It does not:
 *
 *     #set %flag% =
 *     #def %x% = {?flag?a|b|c}     ← the false branch freezes as `b|c`: TWO forms
 *     {plural 1: one|%x%}          ← renders fine under ru; the guess said arity error
 *
 * So a value is counted only when its form count is the same WHATEVER the roll does —
 * that is, when it carries no spintax construct at all. Anything else, any name the host
 * may supply at render time, and any reference the template does not define, suppresses
 * the count-based verdicts. Silence on an unknowable input is the #65 principle; a
 * confident wrong answer is what it replaced.
 *
 * `directMacroSpintax` is the one prediction that survives, because it is not one: a
 * `#set` named DIRECTLY in the form slot is substituted verbatim and is still spintax
 * when the plural is decided — measured, and exactly what the nested-brackets message has
 * always described. Reached through a `#def` it is rolled first, so it is not reported.
 */
function expandFormsForCounting(
  formsRaw: string,
  defs: Record<string, string>,
  macros: Record<string, string>,
  hostNames: ReadonlySet<string>,
): { forms: number; unresolved: boolean; directMacroSpintax: boolean } {
  const unknown = (
    directMacroSpintax = false,
  ): { forms: number; unresolved: boolean; directMacroSpintax: boolean } => ({
    forms: 0,
    unresolved: true,
    directMacroSpintax,
  });

  // Which brackets reach the form slot VERBATIM: follow the `#set` chain out of the raw
  // slot, stopping at anything that changes the answer. "Direct" is a property of the
  // PATH, not of one hop — `#set %a% = %b%` with `#set %b% = {a|b}` never crosses a #def,
  // so the macro text arrives whole and the block renders as the fallback.
  const seenMacro = new Set<string>();
  const refsOf = (text: string): string[] =>
    [...text.matchAll(/%(\w+)%/gu)].map((m) => (m[1] ?? '').toLowerCase());
  /**
   * Iterative, and the order is load-bearing: this is a pre-order depth-first walk in
   * source order, and the FIRST non-clean answer wins. A graph holding both an opaque
   * macro and a brackety one gives different diagnostics depending on which is met
   * first, so a cheaper order would be a different contract.
   *
   * Written recursively it cost one frame per link and threw on a long acyclic `#set`
   * chain — `RangeError` here at ~9000 links, `RecursionError` in the Python port at
   * ~1000, a 20 KB template — while the PHP engines returned a verdict. `validate()`
   * answering with an exception is neither a verdict nor parity. The `seenMacro` set
   * already bounds total work to the number of distinct macros, so no step budget is
   * needed on top.
   */
  const walkMacros = (source: string): 'brackets' | 'opaque' | 'clean' => {
    const stack: { refs: string[]; i: number }[] = [{ refs: refsOf(source), i: 0 }];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { refs: string[]; i: number };
      if (frame.i >= frame.refs.length) {
        stack.pop();
        continue;
      }
      const name = frame.refs[frame.i++] as string;
      // A #def rolls it, and a host value replaces it — either way the macro text does
      // not arrive verbatim, so this path says nothing.
      if (defs[name] !== undefined || hostNames.has(name)) continue;
      const macro = macros[name];
      if (macro === undefined || seenMacro.has(name)) continue;
      seenMacro.add(name);
      // A conditional is where the engines themselves disagree: both PHP renderers
      // resolve one that expansion introduces INSIDE a form list, TS and Python do not.
      // Until that is settled (filed separately), decline to judge rather than pick a
      // side — the retreat this whole fix is built on.
      if (/\{\?/u.test(macro)) return 'opaque';
      if (ANY_BRACKET.test(macro)) return 'brackets';
      stack.push({ refs: refsOf(macro), i: 0 });
    }

    return 'clean';
  };
  const verbatim = walkMacros(formsRaw);
  if (verbatim === 'brackets') return unknown(true);
  if (verbatim === 'opaque') return unknown();

  let text = formsRaw;
  const budget = formsRaw.length + FORM_EXPANSION_MAX_GROWTH;
  for (let pass = 0; pass < FORM_EXPANSION_PASSES; pass++) {
    let sawReference = false;
    let bailed = false;

    // EVERY reference per pass, as the renderer's expansion does. Replacing one at a time
    // spent the budget on a list that merely repeats a name 51 times.
    //
    // Built by hand rather than with `replace()` because the budget has to be enforced
    // DURING the pass: `replace()` materializes the whole next generation before anyone
    // can measure it, so a single pass over 60 KB of self-reference allocates ~900 MB and
    // the check downstream never runs.
    const parts: string[] = [];
    let total = 0;
    let cursor = 0;
    const re = /%(\w+)%/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      sawReference = true;
      const name = (m[1] ?? '').toLowerCase();
      // Runtime context outranks a definition of the same name, so a host-declared name
      // makes the count unknowable even where the template defines one locally.
      const value = hostNames.has(name) ? undefined : defs[name] ?? macros[name];
      // A construct in the value: what it rolls to may or may not carry a top-level pipe,
      // so no single count is true of every render.
      if (value === undefined || ANY_BRACKET.test(value)) {
        bailed = true;
        break;
      }
      parts.push(text.slice(cursor, m.index), value);
      total += m.index - cursor + value.length;
      cursor = m.index + m[0].length;
      if (total > budget) return unknown();
    }

    if (bailed) return unknown();
    parts.push(text.slice(cursor));
    total += text.length - cursor;
    if (total > budget) return unknown();
    text = parts.join('');

    if (!sawReference) {
      // No construct can be left here, so the plain split is what the renderer does too.
      return { forms: text.split('|').length, unresolved: false, directMacroSpintax: false };
    }
  }
  // A cycle, or a chain deeper than this bothers to follow.
  return unknown();
}

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

  // ONE diagnostic per name that takes part in, or leads to, a cycle (issue #59). The set
  // is what the colour walk already computes; emitting per PATH instead re-walked every
  // route through the graph, and the number of routes through a converging diamond is
  // exponential in its depth — a 507-byte template produced 2 097 152 diagnostics in 5.9 s,
  // and 547 bytes took the live /validate-template out with HTTP 503. Four engines were
  // deliberately aligned to per-path (spintax-win aligned to it on 2026-08-07); this is the
  // decision #59 was holding, and per-path cannot be kept, because re-walking every route
  // IS the emission.
  const { reaches: reachesCycle, via } = namesThatReachACycle(defs, refsOf);
  for (const name of defs.keys()) {
    if (!reachesCycle.has(name)) continue;
    out.push(err('variable.circular-reference', `Circular variable reference: ${cyclePath(name, via)}.`,
      { ...(defPos.get(name) ?? somewhere), data: { name } }));
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
function namesThatReachACycle(
  defs: Map<string, string>,
  refsOf: Map<string, string[]>,
): { reaches: Set<string>; via: Map<string, string> } {
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const reaches = new Set<string>();
  // One witness edge per name: the reference through which it first turned out to reach a
  // cycle. Following it name by name reproduces the route the old per-path walk printed,
  // without walking every path to find one.
  const via = new Map<string, string>();
  const mark = (name: string, witness: string): void => {
    if (reaches.has(name)) return; // first discovery wins, so the route is deterministic
    reaches.add(name);
    via.set(name, witness);
  };

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
        if (c === GREY) mark(top.name, ref); // back edge — top sits on a cycle
        else if (c === BLACK) { if (reaches.has(ref)) mark(top.name, ref); }
        else {
          stack.push({ name: ref, refs: refsOf.get(ref) ?? [], i: 0 });
          color.set(ref, GREY);
        }
      } else {
        stack.pop();
        color.set(top.name, BLACK);
        if (stack.length > 0 && reaches.has(top.name)) mark(stack[stack.length - 1]!.name, top.name);
      }
    }
  }
  return { reaches, via };
}

/** Names printed in a circular-reference message before it gives up and counts. */
const CYCLE_PATH_LIMIT = 8;

/**
 * The route from `name` into its cycle, as the message shows it.
 *
 * Following the witness edges reproduces the text the old per-path walk produced — `a → b
 * → a` for a two-cycle, `d0 → c1 → c2 → c1` for a name that merely reaches one — so real
 * cycles read exactly as they did.
 *
 * It is capped because per-name emission alone does not bound the TEXT: one cycle of N
 * names is N diagnostics each printing an N-name route, and a 43 KB template of one giant
 * cycle carried 29 MB of message text. Past a handful of names the route stops being
 * something a human reads, so it becomes a count.
 */
function cyclePath(name: string, via: Map<string, string>): string {
  const seen = new Set<string>([name]);
  const shown: string[] = [name];
  let current = name;

  for (;;) {
    const next = via.get(current);
    if (next === undefined) break; // cannot happen for a name in `reaches`; belt and braces
    if (seen.has(next)) {
      shown.push(next); // the repeat closes the route
      return shown.join(' → ');
    }
    if (shown.length >= CYCLE_PATH_LIMIT) {
      // Count what is left rather than print it — integer steps, no string building.
      let more = 0;
      let walk = next;
      while (!seen.has(walk)) {
        seen.add(walk);
        more += 1;
        const step = via.get(walk);
        if (step === undefined) break;
        walk = step;
      }
      return `${shown.join(' → ')} → … (${more} more)`;
    }
    seen.add(next);
    shown.push(next);
    current = next;
  }

  return shown.join(' → ');
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

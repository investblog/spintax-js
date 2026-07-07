/**
 * Tree-walk renderer with the plugin's staged semantics layered on (parity with
 * Renderer::process_template). Not a naive walk — the deterministic stages are
 * reproduced in order:
 *   - #set is a global pre-pass (parser) → setDefs; those enum values are
 *     COLLAPSED ONCE here (buildVars), skipping values with `{?`/`{plural ` (they
 *     reference vars and defer to the body) — plugin Stage 4b.
 *   - variables resolve against the merged map (runtime context > #set); a value
 *     that itself contains constructs is re-parsed and rendered (recursive, depth
 *     capped) — this covers conditionals/plurals introduced by a variable value
 *     (Stages 6b–6c), so a separate pre/post conditional pass isn't needed.
 *   - conditionals test truthiness against the raw var map; plurals resolve the
 *     count (vars already expanded) then pick the bucket, lenient fullwidth
 *     fallback (Stage 6d, after vars).
 *   - #include (post-tree string pass) and post-process are later PRs.
 *
 * RNG note: cross-engine RNG-sequence parity is a non-goal (§3.2). Enumerations
 * render outer-first and LAZILY (only the picked branch's nested RNG is used) vs
 * the plugin's eager innermost-out; corpus-safe because deterministic nested-enum
 * cases use order-independent sequences. Permutation matches the plugin's exact
 * pick→Fisher-Yates, so its rng-strategy cases are exact.
 */
import type { Node, ParsedAst, PermutationNode, PluralNode, ConditionalNode } from './ast';
import { IncludeResolverError } from './errors';
import { stripSentinels } from './neutralize';
import { parseSequence, parseTemplate } from './parser';
import { normalizeBaseLang, pluralArity, pluralFor } from './plurals';
import type { Rng } from './rng';

const MAX_VARIABLE_DEPTH = 50;
// ASCII whitespace only — PHP `\s` under /u is ASCII; JS `\s` matches Unicode
// whitespace (NBSP etc.), which would diverge on exotic input. Parity.
const INCLUDE_LINE_RE = /^[ \t]*#include[ \t\n\r\f\x0B]+"([^"]+)"[ \t\n\r\f\x0B]*$/gmu;

/** Document-level render context (threads through nested #include resolution). */
export interface RenderCtx {
  /** Runtime/host variable map — inherited by child #includes (NOT parent #set). */
  readonly runtimeContext: Readonly<Record<string, string>>;
  readonly rng: Rng;
  readonly locale: string;
  readonly resolver: ((ref: string) => string | null) | undefined;
  readonly maxDepth: number;
  /** #include ref chain for circular-reference detection. */
  readonly includeStack: readonly string[];
}

/**
 * Render a parsed template: collapse-once #set → tree-walk → resolve #includes
 * (post-tree string pass, like the plugin's Stage 9 resolve_nested, AFTER
 * enum/perm). Post-process (Stage 10) is layered on by the public render().
 */
export function renderAst(ast: ParsedAst, ctx: RenderCtx): string {
  const vars = buildVars(ast.setDefs, ctx.runtimeContext, ctx.rng);
  const text = renderNodes(ast.nodes, { vars, rng: ctx.rng, locale: ctx.locale, depth: 0 });
  return ctx.resolver ? resolveIncludes(text, ctx) : text;
}

/**
 * Replace each `#include "ref"` (line-anchored) with the host-resolved child
 * template, rendered with a CHILD scope: inherits runtime context but NOT the
 * parent's #set locals (plugin `for_child_render`). Circular refs / runaway
 * depth resolve to '' (lenient); a resolver that throws surfaces as
 * IncludeResolverError (programmer error).
 *
 * NOTE: cycles are detected by the ref STRING (the engine has no template
 * identity beyond the host-supplied ref, §4.1), so two aliased refs for one
 * template aren't seen as a cycle and recurse until `maxDepth`. `maxDepth` also
 * caps deep ACYCLIC chains (silently → ''), a guard the plugin lacks.
 */
function resolveIncludes(text: string, ctx: RenderCtx): string {
  INCLUDE_LINE_RE.lastIndex = 0;
  return text.replace(INCLUDE_LINE_RE, (_m, ref: string): string => {
    if (ctx.includeStack.includes(ref) || ctx.includeStack.length >= ctx.maxDepth) return '';
    let included: string | null;
    try {
      included = ctx.resolver!(ref);
    } catch (cause) {
      throw new IncludeResolverError(`includeResolver threw for "${ref}"`, { cause });
    }
    if (included === null) return '';
    return renderAst(parseTemplate(stripSentinels(included)), {
      ...ctx,
      runtimeContext: ctx.runtimeContext, // child inherits runtime, not parent #set
      includeStack: [...ctx.includeStack, ref],
    });
  });
}

export interface RenderInternalOptions {
  /** Merged variable map, keys LOWER-CASED (runtime context wins over #set). */
  readonly vars: Readonly<Record<string, string>>;
  readonly rng: Rng;
  /** Plural-bucket locale (raw; normalized per lookup). Empty ⇒ default 2-form. */
  readonly locale: string;
  /** Variable re-processing depth (guards runaway/circular expansion). */
  readonly depth: number;
}

/**
 * Build the merged variable map: collapse-once each `#set` value (Stage 4b) then
 * overlay the runtime context (which wins). Context keys are lowercased.
 */
export function buildVars(
  setDefs: Readonly<Record<string, string>>,
  context: Readonly<Record<string, string>>,
  rng: Rng,
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(setDefs)) {
    vars[name] = collapseSetValue(value, rng);
  }
  for (const [name, value] of Object.entries(context)) {
    vars[name.toLowerCase()] = value;
  }
  return vars;
}

/** Stage 4b: resolve ONLY enumerations in a #set value once; skip {? / {plural values. */
function collapseSetValue(value: string, rng: Rng): string {
  if (!value.includes('{')) return value;
  if (value.includes('{?') || value.includes('{plural ')) return value;
  return resolveEnumerationsString(value, rng);
}

/** Innermost-out `{a|b}` resolution over a raw string (perms / %vars% untouched). */
function resolveEnumerationsString(text: string, rng: Rng): string {
  let out = text;
  for (let guard = 0; guard < 1000; guard += 1) {
    let changed = false;
    out = out.replace(/\{([^{}]*)\}/gu, (_m, inner: string): string => {
      changed = true;
      const options = splitTopLevelPipes(inner);
      return options.length === 0 ? '' : (options[randomInt(rng, 0, options.length - 1)] ?? '');
    });
    if (!changed) break;
  }
  return out;
}

export function renderNodes(nodes: readonly Node[], opts: RenderInternalOptions): string {
  let out = '';
  for (const node of nodes) out += renderNode(node, opts);
  return out;
}

function renderNode(node: Node, opts: RenderInternalOptions): string {
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'variable':
      return resolveVariable(node.name, opts);
    case 'enumeration':
      return renderEnumeration(node.options, opts);
    case 'permutation':
      return renderPermutation(node, opts);
    case 'conditional':
      return renderConditional(node, opts);
    case 'plural':
      return renderPlural(node, opts);
  }
}

/** `min === max` short-circuits WITHOUT consuming the RNG (plugin `random_int`). */
function randomInt(rng: Rng, min: number, max: number): number {
  return min === max ? min : rng(min, max);
}

/**
 * Resolve a `%var%`. A value containing constructs is re-parsed and rendered
 * (recursive, depth-capped) so nested vars / conditionals / plurals introduced by
 * the value are resolved; a plain value is returned as-is; unresolved ⇒ verbatim.
 */
function resolveVariable(name: string, opts: RenderInternalOptions): string {
  const value = opts.vars[name.toLowerCase()];
  if (value === undefined) return `%${name}%`;
  // At the cap, stop expanding (lenient: partial output, never throws — unlike the
  // plugin which throws→'' on runaway; §9.2 render never throws on content).
  if (opts.depth >= MAX_VARIABLE_DEPTH || !/[{[%]/u.test(value)) return value;
  // parseSequence, NOT parseTemplate: a value must not be re-comment-stripped or
  // re-#set-extracted (those are one-time body passes in the plugin).
  return renderNodes(parseSequence(value), { ...opts, depth: opts.depth + 1 });
}

/** Variable-expansion ONLY (plugin `expand_variables` fixpoint) — leaves enums/perms literal. */
function expandVarsOnly(text: string, opts: RenderInternalOptions): string {
  let out = text;
  for (let i = 0; i < MAX_VARIABLE_DEPTH; i += 1) {
    let changed = false;
    out = out.replace(/%(\w+)%/gu, (m, name: string): string => {
      const value = opts.vars[name.toLowerCase()];
      if (value === undefined) return m;
      changed = true;
      return value;
    });
    if (!changed) break;
  }
  return out;
}

/** Truthy = the raw var value is set and has a non-whitespace char (plugin is_truthy). */
function renderConditional(node: ConditionalNode, opts: RenderInternalOptions): string {
  const value = opts.vars[node.name.toLowerCase()];
  const baseTruthy = value !== undefined && /\S/u.test(value);
  const truthy = node.inverted ? !baseTruthy : baseTruthy;
  return renderNodes(truthy ? node.then : node.else, opts);
}

/**
 * Plural agreement (Stage 6d — after variable-expansion, before enum/perm). The
 * count/forms are expanded with VARIABLES ONLY, so the checks (nested-bracket,
 * numeric erase, arity) see the same state the plugin does — enums/perms still
 * literal. Order: bracket check → numeric erase → arity → bucket pick. The two
 * error paths emit the (var-expanded) construct verbatim with fullwidth braces.
 */
function renderPlural(node: PluralNode, opts: RenderInternalOptions): string {
  const countRaw = expandVarsOnly(node.countRaw, opts);
  const formsRaw = expandVarsOnly(node.formsRaw, opts);

  if (/[{}[\]]/u.test(formsRaw)) return fullwidthVerbatim(countRaw, formsRaw);

  const count = phpTrim(countRaw);
  if (!/^-?\d+$/u.test(count)) return ''; // empty / non-numeric ⇒ erase the block

  const base = normalizeBaseLang(opts.locale);
  const forms = formsRaw.split('|').map((f) => phpTrim(f));
  if (forms.length !== pluralArity(base)) return fullwidthVerbatim(countRaw, formsRaw);

  // The picked form re-enters the pipeline (its enums/perms resolve after plurals).
  const picked = pluralFor(base, Number.parseInt(count, 10), forms);
  return renderNodes(parseSequence(picked), opts);
}

/** Emit the plural construct verbatim with fullwidth braces so later passes leave it alone. */
function fullwidthVerbatim(countRaw: string, formsRaw: string): string {
  return `{plural ${countRaw}:${formsRaw}}`.replace(/\{/gu, '｛').replace(/\}/gu, '｝');
}

/** Pick one option (outer-first) and render it. */
function renderEnumeration(options: readonly (readonly Node[])[], opts: RenderInternalOptions): string {
  if (options.length === 0) return '';
  const picked = options[randomInt(opts.rng, 0, options.length - 1)];
  return picked ? renderNodes(picked, opts) : '';
}

interface Element {
  text: string;
  sep: string | null;
}

function renderPermutation(node: PermutationNode, opts: RenderInternalOptions): string {
  const elements: Element[] = node.options.map((o) => ({
    text: renderNodes(o.nodes, opts),
    sep: o.separator,
  }));
  const total = elements.length;
  if (total === 0) return '';

  const { config } = node;
  const hasMin = config.minsize !== null;
  const hasMax = config.maxsize !== null;
  let min: number;
  let max: number;
  if (hasMin && hasMax) {
    min = config.minsize as number;
    max = config.maxsize as number;
  } else if (hasMin) {
    min = config.minsize as number;
    max = total;
  } else if (hasMax) {
    min = 1;
    max = config.maxsize as number;
  } else {
    min = total;
    max = total;
  }
  min = Math.max(1, Math.min(min, total));
  max = Math.max(min, Math.min(max, total));

  const pick = randomInt(opts.rng, min, max);
  shuffle(elements, opts.rng);
  return joinWithSeparators(elements.slice(0, pick), config.sep, config.lastsep ?? config.sep);
}

/** Fisher-Yates, matching the plugin: i = n-1 … 1, j = randomInt(0, i), swap. */
function shuffle(arr: Element[], rng: Rng): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = randomInt(rng, 0, i);
    const tmp = arr[i] as Element;
    arr[i] = arr[j] as Element;
    arr[j] = tmp;
  }
}

function joinWithSeparators(elements: readonly Element[], globalSep: string, globalLastsep: string): string {
  const count = elements.length;
  if (count === 0) return '';
  if (count === 1) return (elements[0] as Element).text;

  let out = (elements[0] as Element).text;
  for (let i = 1; i < count; i += 1) {
    const el = elements[i] as Element;
    const sep = el.sep ?? (i === count - 1 ? globalLastsep : globalSep);
    out += padSeparator(sep) + el.text;
  }
  return out;
}

/** Purely-alphabetic separators get space-padded; others pass through (plugin). */
function padSeparator(sep: string): string {
  const trimmed = phpTrim(sep);
  if (trimmed === '') return sep;
  if (/^\p{L}+$/u.test(trimmed)) return ` ${trimmed} `;
  return sep;
}

/** Split on top-level `|` (brace/bracket-depth aware) — for the collapse-once enum resolver. */
function splitTopLevelPipes(inner: string): string[] {
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

const PHP_LTRIM_RE = /^[ \t\n\r\0\x0B]+/u;
const PHP_RTRIM_RE = /[ \t\n\r\0\x0B]+$/u;
function phpTrim(s: string): string {
  return s.replace(PHP_LTRIM_RE, '').replace(PHP_RTRIM_RE, '');
}

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
/**
 * A `{plural …}` block the renderer could not resolve, reported through
 * {@link RenderCtx.onPluralError}. Observation only — the render still degrades
 * exactly as it always has (§0.1 lenient contract); the host decides whether a
 * report is fatal. Mirrors the plugin's `on_error` callable.
 */
export interface PluralIssue {
  /**
   * `plural.nested-brackets` and `plural.arity` are the same codes `validate()`
   * emits. `plural.count` has no validate counterpart on purpose — an unresolved
   * count is a runtime-value fact, invisible to static analysis.
   */
  readonly code: 'plural.nested-brackets' | 'plural.arity' | 'plural.count';
  readonly message: string;
  /** The construct as the renderer saw it, AFTER variable expansion. */
  readonly construct: string;
  /** Normalized base language the arity was judged against. */
  readonly locale: string;
  /** Arity verdicts only. */
  readonly expected?: number;
  readonly got?: number;
}

export interface RenderCtx {
  /** Runtime/host variable map — inherited by child #includes (NOT parent #set). */
  readonly runtimeContext: Readonly<Record<string, string>>;
  readonly rng: Rng;
  readonly locale: string;
  readonly resolver: ((ref: string) => string | null) | undefined;
  readonly maxDepth: number;
  /** #include ref chain for circular-reference detection. */
  readonly includeStack: readonly string[];
  /** Optional observer for unresolvable plural blocks; never affects output. */
  readonly onPluralError: ((issue: PluralIssue) => void) | undefined;
}

/**
 * Render a parsed template: build vars → roll `#def` → tree-walk → resolve `#includes`
 * (post-tree string pass, like the plugin's Stage 9 resolve_nested, AFTER
 * enum/perm). Post-process (Stage 10) is layered on by the public render().
 */
export function renderAst(ast: ParsedAst, ctx: RenderCtx): string {
  const base = buildVars(ast.setDefs, ctx.runtimeContext);
  const walkOpts = {
    rng: ctx.rng,
    locale: ctx.locale,
    depth: 0,
    onPluralError: ctx.onPluralError,
  };
  // The roll happens here and not inside buildVars: a definition is rendered against the FULL
  // context, globals and runtime included, so it must wait until that context exists.
  const vars =
    Object.keys(ast.defDefs).length > 0
      ? { ...base, ...rollDefinitions(ast.defDefs, base, ctx.runtimeContext, walkOpts) }
      : base;
  const text = renderNodes(ast.nodes, { ...walkOpts, vars });
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
  /** Optional observer for unresolvable plural blocks; never affects output. */
  readonly onPluralError: ((issue: PluralIssue) => void) | undefined;
}

/**
 * Build the merged variable map: `#set` values go in RAW, then the runtime context overlays them
 * (and wins). Context keys are lowercased.
 *
 * A `#set` is a macro — its value is re-parsed and re-rendered at every `%var%` reference, so any
 * brackets it holds re-roll each time. Nothing is resolved here. (Until 0.3.0 this collapsed
 * enumeration-valued `#set`s once at set-time; that behaviour moved to `#def`.)
 */
export function buildVars(
  setDefs: Readonly<Record<string, string>>,
  context: Readonly<Record<string, string>>,
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(setDefs)) {
    vars[name] = value;
  }
  for (const [name, value] of Object.entries(context)) {
    vars[name.toLowerCase()] = value;
  }
  return vars;
}

/**
 * Render each `#def` value ONCE and return the frozen results, to be merged over `vars`.
 *
 * A definition value is rendered as if it were a miniature body — the same tree walk the document
 * gets — and the result is held for every reference. This runs only after the merged context
 * exists, so a definition can read globals and runtime variables; a runtime variable of the same
 * name outranks it and the definition is then never rolled at all.
 *
 * Values are rendered in dependency order, and that order follows aliases: a `#def` can reach
 * another `#def` through a `#set`, which is expanded at reference time and therefore invisible in
 * the first definition's own text.
 */
export function rollDefinitions(
  defDefs: Readonly<Record<string, string>>,
  vars: Readonly<Record<string, string>>,
  context: Readonly<Record<string, string>>,
  opts: Omit<RenderInternalOptions, 'vars'>,
): Record<string, string> {
  const outranked = new Set(Object.keys(context).map((key) => key.toLowerCase()));
  const rolled: Record<string, string> = {};

  // The alias map is every macro value a definition can see, minus the definitions that will
  // actually be rolled — a `#def` shadows a same-named global, and hopping through the shadowed
  // value computes the wrong graph. A definition the runtime outranks is NOT removed: it is never
  // rolled, so the runtime value is what really gets substituted and the graph must follow it.
  const aliases: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    if (name in defDefs && !outranked.has(name)) continue;
    aliases[name] = value;
  }

  for (const name of orderDefinitions(defDefs, aliases)) {
    if (outranked.has(name)) continue;
    const value = defDefs[name] ?? '';
    rolled[name] = renderNodes(parseSequence(value), { ...opts, vars: { ...vars, ...rolled } });
  }

  return rolled;
}

/** Definition names, dependencies first. A cycle cannot be ordered, so its members come last. */
function orderDefinitions(
  defDefs: Readonly<Record<string, string>>,
  aliases: Readonly<Record<string, string>>,
): string[] {
  const names = Object.keys(defDefs);
  const blocked = new Map<string, Set<string>>();

  for (const name of names) {
    const reached = referencedNames(defDefs[name] ?? '', aliases);
    blocked.set(name, new Set(names.filter((candidate) => reached.has(candidate))));
  }

  const ordered: string[] = [];
  let pending = names;

  while (pending.length > 0) {
    const ready = pending.filter((name) => {
      const deps = blocked.get(name);
      return !deps || ![...deps].some((dep) => dep !== name && pending.includes(dep));
    });
    if (ready.length === 0) return [...ordered, ...pending];
    ordered.push(...ready);
    pending = pending.filter((name) => !ready.includes(name));
  }

  return ordered;
}

/** Every variable name a value reaches, hopping through macro (alias) values to a fixpoint. */
function referencedNames(value: string, aliases: Readonly<Record<string, string>>): Set<string> {
  const seen = new Set<string>();
  const queue = directReferences(value);

  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const alias = aliases[name];
    if (alias !== undefined) queue.push(...directReferences(alias));
  }

  return seen;
}

/** The `%var%` names written literally in a string, lowercased. */
function directReferences(text: string): string[] {
  return [...text.matchAll(/%(\w+)%/gu)].map((match) => (match[1] ?? '').toLowerCase());
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
  const base = normalizeBaseLang(opts.locale);
  const report = (issue: PluralIssue): void => opts.onPluralError?.(issue);

  if (/[{}[\]]/u.test(formsRaw)) {
    report({
      code: 'plural.nested-brackets',
      message:
        'Plural form slot contains nested spintax brackets; extract via #def first — a #set is '
        + 'substituted verbatim and would put the brackets straight back.',
      construct: rawConstruct(countRaw, formsRaw),
      locale: base,
    });
    return fullwidthVerbatim(countRaw, formsRaw);
  }

  const count = phpTrim(countRaw);
  if (!/^-?\d+$/u.test(count)) {
    // Erasing leaves no trace in the output, so this report is the ONLY way a
    // host can tell an intentionally-empty sentence from an unsubstituted %Var%.
    report({
      code: 'plural.count',
      message: `Plural count slot is empty or non-numeric (${JSON.stringify(count)}); block erased.`,
      construct: rawConstruct(countRaw, formsRaw),
      locale: base,
    });
    return '';
  }

  const forms = formsRaw.split('|').map((f) => phpTrim(f));
  if (forms.length !== pluralArity(base)) {
    report({
      code: 'plural.arity',
      message: `Plural has ${forms.length} form(s); locale "${base}" takes ${pluralArity(base)}.`,
      construct: rawConstruct(countRaw, formsRaw),
      locale: base,
      expected: pluralArity(base),
      got: forms.length,
    });
    return fullwidthVerbatim(countRaw, formsRaw);
  }

  // The picked form re-enters the pipeline (its enums/perms resolve after plurals).
  const picked = pluralFor(base, Number.parseInt(count, 10), forms);
  return renderNodes(parseSequence(picked), opts);
}

/** The construct as the renderer saw it — ASCII braces, for reports and logs. */
function rawConstruct(countRaw: string, formsRaw: string): string {
  return `{plural ${countRaw}:${formsRaw}}`;
}

/** Emit the plural construct verbatim with fullwidth braces so later passes leave it alone. */
function fullwidthVerbatim(countRaw: string, formsRaw: string): string {
  return rawConstruct(countRaw, formsRaw).replace(/\{/gu, '｛').replace(/\}/gu, '｝');
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

const PHP_LTRIM_RE = /^[ \t\n\r\0\x0B]+/u;
const PHP_RTRIM_RE = /[ \t\n\r\0\x0B]+$/u;
function phpTrim(s: string): string {
  return s.replace(PHP_LTRIM_RE, '').replace(PHP_RTRIM_RE, '');
}

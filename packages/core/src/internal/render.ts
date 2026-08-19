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
import { parseSequence, parseTemplate, recognizeConditional } from './parser';
import { normalizeBaseLang, pluralArity, pluralFor } from './plurals';
import type { Rng } from './rng';

const MAX_VARIABLE_DEPTH = 50;
/**
 * Characters a single render may produce by expanding `%variables%` (issue #69).
 *
 * Deliberately far above any real document — the point is to end an explosion, not to
 * ration ordinary output. Charged per substitution and checked before the next one, so
 * the bomb dies at the budget rather than after allocating past it.
 */
export const MAX_EXPANSION_CHARS = 1024 * 1024;
// ASCII whitespace only, spelled out — no dialect's `\s` is this set. This comment used to
// claim PHP's `\s` under /u is ASCII; measured (#55), it is the opposite: /u turns on
// PCRE2_UCP, so PHP matched NBSP and all of \p{Z} here until it spelled the class out too.
// The contract is this regex, pinned by the corpus (extract/include-*).
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
  /**
   * Expansion allowance for the WHOLE call, includes and all (issue #69).
   *
   * Per-call, not per-AST: `resolveIncludes` renders each included body through
   * `renderAst`, so a budget created there gave every include a fresh megabyte. Fifty
   * `#include` lines over one 62-character bomb turned 690 bytes into 57 MB — the bound
   * held for each subtree and bounded nothing overall. A host may cap the number of
   * resolutions, but the engine must not need it to.
   */
  readonly budget: { left: number };
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
    budget: ctx.budget,
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
    return renderAst(parseTemplate(included), {
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
  /**
   * Characters of variable expansion left for this render (issue #69).
   *
   * Depth alone does not bound expansion, only its height: `#set %a% = %b% %b%` over
   * `#set %b% = %a% %a%` replaces one reference with two every level, so 50 levels is
   * 2^50 and a 62-character template ended the process — an out-of-memory abort here,
   * a memory fatal in the PHP engines, HTTP 503 on the public Worker. Acyclic doubling
   * does the same, so the cycle guard never sees it.
   *
   * A mutable holder on purpose: `opts` is spread-copied down the walk, so a plain
   * number would give every branch its own budget and bound nothing.
   */
  readonly budget: { left: number };
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

/**
 * Walk a node list, iteratively (#68).
 *
 * A recursive walk costs one frame per level of nesting and threw `RangeError` at
 * about 5000 levels once the parser stopped throwing first — §9.2 says the engine
 * never throws on content, so the guarantee has to hold here too.
 *
 * **The RNG order is the contract, not the traversal shape.** An enumeration picks
 * BEFORE descending, so an unpicked branch never touches the RNG; a permutation
 * renders EVERY element first and consumes its own picks after. Seeded renders are
 * reproducible within the engine (§3.2) and the corpus pins exact picks with
 * `rng: { sequence }` fixtures, so a tidier order would quietly change output.
 * Children are therefore rendered at exactly the moment the recursive version
 * rendered them.
 */
export function renderNodes(nodes: readonly Node[], opts: RenderInternalOptions): string {
  interface Frame {
    nodes: readonly Node[];
    i: number;
    out: string[];
    /** Child lists being rendered for the construct this frame paused on. */
    pending: { lists: (readonly Node[])[]; done: string[]; assemble: (parts: string[]) => string } | null;
  }

  const frame = (list: readonly Node[]): Frame => ({ nodes: list, i: 0, out: [], pending: null });
  const stack: Frame[] = [frame(nodes)];

  while (stack.length > 0) {
    const f = stack[stack.length - 1] as Frame;

    if (f.pending !== null) {
      if (f.pending.done.length < f.pending.lists.length) {
        stack.push(frame(f.pending.lists[f.pending.done.length] as readonly Node[]));
        continue;
      }
      f.out.push(f.pending.assemble(f.pending.done));
      f.pending = null;
      continue;
    }

    if (f.i >= f.nodes.length) {
      const text = f.out.join('');
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent === undefined) return text;
      (parent.pending as { done: string[] }).done.push(text);
      continue;
    }

    const node = f.nodes[f.i] as Node;
    f.i += 1;
    const step = renderNode(node, opts);
    if (typeof step === 'string') f.out.push(step);
    else f.pending = step;
  }

  return '';
}

/** What a node contributes: finished text, or child lists plus how to assemble them. */
type RenderStep = string | { lists: (readonly Node[])[]; done: string[]; assemble: (parts: string[]) => string };

function renderNode(node: Node, opts: RenderInternalOptions): RenderStep {
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
  // Out of budget ⇒ the reference stays literal, exactly as an undefined name does. No
  // new output shape, and the promise that render never throws on content survives.
  if (opts.budget.left <= 0) return `%${name}%`;
  opts.budget.left -= value.length;
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
      // Same purse as resolveVariable: a plural slot is not a separate allowance.
      if (opts.budget.left <= 0) return m;
      opts.budget.left -= value.length;
      changed = true;
      return value;
    });
    if (!changed) break;
  }
  return out;
}

/** Truthy = the raw var value is set and has a non-whitespace char (plugin is_truthy). */
function conditionalTakesThen(name: string, inverted: boolean, opts: RenderInternalOptions): boolean {
  const value = opts.vars[name.toLowerCase()];
  const baseTruthy = value !== undefined && /\S/u.test(value);
  return inverted ? !baseTruthy : baseTruthy;
}

function renderConditional(node: ConditionalNode, opts: RenderInternalOptions): RenderStep {
  const truthy = conditionalTakesThen(node.name, node.inverted, opts);
  return { lists: [truthy ? node.then : node.else], done: [], assemble: (parts) => parts[0] ?? '' };
}

/**
 * Resolve conditionals in the plural COUNT slot, textually — the branch is
 * substituted, never rendered (spintax-js#67).
 *
 * Why this exists: the plugin runs its conditional stage over the whole text
 * before plurals, so `#set %n% = {?flag?1|2}` reaches the count slot as a plain
 * number and the block renders. This engine parses the count slot into a raw
 * string and expanded VARIABLES only, so the conditional survived, failed the
 * numeric test, and the block was ERASED — `validate()` meanwhile returned no
 * diagnostic at all, and `plural.count-macro` documents conditionals as exempt
 * *because* they resolve before plurals. Valid input, silently deleted output.
 *
 * Textual, and only the taken branch's text, because the stage order still holds
 * around it: enums and permutations resolve AFTER plurals, so a branch yielding
 * `{a|b}` must reach the numeric test as `{a|b}` and erase the block, exactly as
 * the plugin does. Rendering the branch would spin it into `a` and invent a
 * count neither engine has.
 *
 * The FORM slot is deliberately not touched: there the engines genuinely
 * disagree and no side has been chosen yet (spintax-js#67).
 *
 * Iterative, over spans, for two reasons paid for in review: recursing into the
 * taken branch made `render()` throw `RangeError` at ~9000 levels of nesting —
 * §9.2 says render never throws on content, and the parsers were made iterative
 * for this exact reason — and re-scanning per `{?` was quadratic (see
 * {@link matchBraces}). Both are reachable from template text through the live
 * public Worker.
 */
function resolveCountConditionals(text: string, opts: RenderInternalOptions): string {
  if (!text.includes('{?')) return text;

  const close = matchBraces(text);
  const out: string[] = [];
  // Spans of `text` still to emit, in order. A taken branch is a SPAN of the same
  // string, never a copy, and the untaken one is skipped — so every character is
  // visited at most once and the pass stays linear.
  const pending: [number, number][] = [[0, text.length]];

  while (pending.length > 0) {
    const segment = pending.pop() as [number, number];
    const segEnd = segment[1];
    let i = segment[0];

    while (i < segEnd) {
      const open = text.indexOf('{?', i);
      // `{?` found past this span belongs to the text around it, not to this span.
      if (open === -1 || open + 1 >= segEnd) {
        out.push(text.slice(i, segEnd));
        break;
      }

      // A close outside the span is no close at all: the branch it would reach
      // into is not ours to read.
      const shut = close[open] ?? -1;
      const head = shut === -1 || shut >= segEnd ? null : recognizeConditional(text, open + 1, shut);
      if (head === null) {
        // Unclosed, or `{?` that is not a conditional — a malformed one is an
        // enumeration to the parser, and enumerations are not this pass's business.
        out.push(text.slice(i, Math.min(open + 2, segEnd)));
        i = open + 2;
        continue;
      }

      out.push(text.slice(i, open));
      const branchEnd = head.sepIndex < 0 ? shut : head.sepIndex;
      const [from, to] = conditionalTakesThen(head.name, head.inverted, opts)
        ? [head.bodyStart, branchEnd]
        : [head.sepIndex < 0 ? shut : head.sepIndex + 1, shut];
      // Continuation first, branch second: the stack pops the branch back out
      // ahead of it, which is what keeps the output in source order.
      pending.push([shut + 1, segEnd]);
      pending.push([from, to]);
      break;
    }
  }

  return out.join('');
}

/**
 * Match `{` to `}` across the whole string in ONE pass — index of the closing
 * brace for every opening one, or -1.
 *
 * Equivalent to calling `findMatchingClose` per `{`, and that is the point: the
 * per-brace call rescans to the end of the string every time it fails to match,
 * so an unbalanced count slot (legal — only the whole `{plural …}` block has to
 * balance, and the slot is cut at the first `:`) made this pass quadratic. A
 * 78 KB slot took 3 seconds, and the public Worker renders untrusted templates.
 */
function matchBraces(text: string): Int32Array {
  const close = new Int32Array(text.length).fill(-1);
  const opens: number[] = [];

  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '{') {
      opens.push(i);
    } else if (ch === '}') {
      const open = opens.pop();
      if (open !== undefined) close[open] = i;
    }
  }

  return close;
}

/**
 * Plural agreement (Stage 6d — after variable-expansion, before enum/perm). The
 * count/forms are expanded with VARIABLES ONLY, so the checks (nested-bracket,
 * numeric erase, arity) see the same state the plugin does — enums/perms still
 * literal. Order: bracket check → numeric erase → arity → bucket pick. The two
 * error paths emit the (var-expanded) construct verbatim with fullwidth braces.
 */
function renderPlural(node: PluralNode, opts: RenderInternalOptions): RenderStep {
  const countRaw = resolveCountConditionals(expandVarsOnly(node.countRaw, opts), opts);
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

  // The picked form re-enters the pipeline (its enums/perms resolve after plurals) —
  // as a child list, so a deeply nested form does not cost a stack frame.
  const picked = pluralFor(base, Number.parseInt(count, 10), forms);
  return { lists: [parseSequence(picked)], done: [], assemble: (parts) => parts[0] ?? '' };
}

/** The construct as the renderer saw it — ASCII braces, for reports and logs. */
function rawConstruct(countRaw: string, formsRaw: string): string {
  return `{plural ${countRaw}:${formsRaw}}`;
}

/** Emit the plural construct verbatim with fullwidth braces so later passes leave it alone. */
function fullwidthVerbatim(countRaw: string, formsRaw: string): string {
  return rawConstruct(countRaw, formsRaw).replace(/\{/gu, '｛').replace(/\}/gu, '｝');
}

/** Pick one option (outer-first) and render it. The pick happens BEFORE the descent,
 *  so an unpicked branch never consumes RNG — that ordering is pinned by fixtures. */
function renderEnumeration(options: readonly (readonly Node[])[], opts: RenderInternalOptions): RenderStep {
  if (options.length === 0) return '';
  const picked = options[randomInt(opts.rng, 0, options.length - 1)];
  if (!picked) return '';
  return { lists: [picked], done: [], assemble: (parts) => parts[0] ?? '' };
}

interface Element {
  text: string;
  sep: string | null;
}

function renderPermutation(node: PermutationNode, opts: RenderInternalOptions): RenderStep {
  if (node.options.length === 0) return '';
  return {
    lists: node.options.map((o) => o.nodes),
    done: [],
    assemble: (parts) => assemblePermutation(node, parts, opts),
  };
}

/** Shuffle and join, once every element has been rendered — the RNG for the size pick
 *  and the shuffle is consumed here, AFTER the children, exactly as it always was. */
function assemblePermutation(node: PermutationNode, rendered: string[], opts: RenderInternalOptions): string {
  const elements: Element[] = node.options.map((o, i) => ({ text: rendered[i] ?? '', sep: o.separator }));
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

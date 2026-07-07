/**
 * Internal AST for @spintax/core. The public `Ast` (spec §9.2) is the opaque,
 * versioned view; `ParsedAst` is the internal shape carrying the node tree that
 * render/validate/extract/analyze walk. Not a serialization format — never
 * persisted across engine versions.
 *
 * Tree nodes: literal / variable / enumeration / permutation / conditional /
 * plural. Directives are NOT tree nodes (plugin parity):
 *   - `#set` is extracted GLOBALLY before the tree is built (line-anchored, like
 *     `extract_set_directives`) → {@link ParsedAst.setDefs}; its lines are
 *     stripped from the body, so a `#set` on its own line even INSIDE a group is
 *     a global definition, not literal text.
 *   - `#include` is resolved by the renderer as a post-tree string pass (the
 *     plugin's `resolve_includes` runs after enum/perm), so it stays literal in
 *     the AST here.
 * Permutation's `<config>` + per-element separators are fully parsed (PR-11b).
 */

/** Bumped only on a breaking change to the node shape (independent of syntax v1). */
export const AST_VERSION = 1;

/** Opaque public handle (re-exported as `Ast` from the package index). */
export interface Ast {
  readonly astVersion: typeof AST_VERSION;
}

/** Internal parsed tree. Carries the original source so validate(Ast) can do
 *  the raw-text checks (bracket balance etc.) and future offset diagnostics, and
 *  the globally-extracted `#set` definitions (name → raw value, name lowercased). */
export interface ParsedAst extends Ast {
  readonly source: string;
  readonly setDefs: Readonly<Record<string, string>>;
  readonly nodes: readonly Node[];
}

export type Node =
  | LiteralNode
  | VariableNode
  | EnumerationNode
  | PermutationNode
  | ConditionalNode
  | PluralNode;

/** Verbatim text. */
export interface LiteralNode {
  readonly type: 'literal';
  readonly value: string;
}

/** `%name%` reference (name stored verbatim; lookup is case-insensitive at render). */
export interface VariableNode {
  readonly type: 'variable';
  readonly name: string;
}

/** `{a|b|c}` — pick one option. Each option is a node sequence. */
export interface EnumerationNode {
  readonly type: 'enumeration';
  readonly options: readonly (readonly Node[])[];
}

/**
 * `[<config>a|b|c]` — select/shuffle/join. PR-10 captures the raw inner
 * verbatim; PR-11 extracts the `<config>` prefix FIRST (before splitting, so a
 * `|` inside a quoted separator like `sep="|"` isn't a false split — matching
 * the plugin's `extract_permutation_config` → `split_top_level` order) and
 * parses the per-element separators + option node sequences.
 */
/** Permutation `<config>` (parsed in PR-11b). `null` size ⇒ default rules at render (§4.2). */
export interface PermConfig {
  readonly minsize: number | null;
  readonly maxsize: number | null;
  readonly sep: string;
  readonly lastsep: string | null;
}

/** One permutation element + its per-element separator (a trailing `<sep>` from the PREVIOUS part). */
export interface PermOption {
  readonly nodes: readonly Node[];
  readonly separator: string | null;
}

export interface PermutationNode {
  readonly type: 'permutation';
  readonly config: PermConfig;
  readonly options: readonly PermOption[];
}

/**
 * `{?VAR?then|else}` / `{?!VAR?then}` — show `then` when VAR is truthy (or falsy
 * if `inverted`), else `else`. A malformed `{?…}` is NOT a conditional: the
 * parser falls back to treating the braces as an enumeration (matching the
 * plugin, where a bad conditional survives the conditional pass unchanged and
 * is then consumed by the enumeration pass).
 */
export interface ConditionalNode {
  readonly type: 'conditional';
  readonly name: string;
  readonly inverted: boolean;
  readonly then: readonly Node[];
  readonly else: readonly Node[];
}

/**
 * `{plural <count>: one|few|many}`. `countRaw` is the raw count slot (may be a
 * `%var%` resolved at render, then integer-parsed); `forms` are the pipe-split
 * form sequences. Discriminated by the literal `{plural ` prefix + a `:`.
 */
export interface PluralNode {
  readonly type: 'plural';
  readonly countRaw: string;
  /**
   * Raw forms text after the colon, kept verbatim. The valid path renders
   * `forms`; the lenient path (a form containing nested `{}`/`[]`, or an arity
   * mismatch) needs the raw text to re-emit the whole construct with fullwidth
   * braces (U+FF5B/FF5D), so M2 reconstructs `{plural <countRaw>:<formsRaw>}`.
   */
  readonly formsRaw: string;
  readonly forms: readonly (readonly Node[])[];
}

/** Depth-first walk over every node, descending into all child sequences. */
export function walk(nodes: readonly Node[], visit: (n: Node) => void): void {
  for (const n of nodes) {
    visit(n);
    switch (n.type) {
      case 'enumeration':
        for (const opt of n.options) walk(opt, visit);
        break;
      case 'conditional':
        walk(n.then, visit);
        walk(n.else, visit);
        break;
      case 'plural':
        for (const form of n.forms) walk(form, visit);
        break;
      case 'permutation':
        for (const opt of n.options) walk(opt.nodes, visit);
        break;
      default:
        break; // literal / variable: no child nodes
    }
  }
}

/** Type guard: is this an internal ParsedAst produced by this engine version? */
export function isParsedAst(value: unknown): value is ParsedAst {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { astVersion?: unknown }).astVersion === AST_VERSION &&
    typeof (value as { source?: unknown }).source === 'string' &&
    Array.isArray((value as { nodes?: unknown }).nodes)
  );
}

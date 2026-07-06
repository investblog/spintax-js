/**
 * Internal AST for @spintax/core. The public `Ast` (spec §9.2) is the opaque,
 * versioned view; `ParsedAst` is the internal shape carrying the node tree that
 * render/validate/extract/analyze walk. Not a serialization format — never
 * persisted across engine versions.
 *
 * M1 scope (PR-10): literal / variable / enumeration / permutation. The full
 * syntax surface (conditional / plural / #set / #include) lands in PR-11.
 */

/** Bumped only on a breaking change to the node shape (independent of syntax v1). */
export const AST_VERSION = 1;

/** Opaque public handle (re-exported as `Ast` from the package index). */
export interface Ast {
  readonly astVersion: typeof AST_VERSION;
}

/** Internal parsed tree. */
export interface ParsedAst extends Ast {
  readonly nodes: readonly Node[];
}

export type Node = LiteralNode | VariableNode | EnumerationNode | PermutationNode;

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
export interface PermutationNode {
  readonly type: 'permutation';
  readonly rawInner: string;
}

/** Type guard: is this an internal ParsedAst produced by this engine version? */
export function isParsedAst(value: unknown): value is ParsedAst {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { astVersion?: unknown }).astVersion === AST_VERSION &&
    Array.isArray((value as { nodes?: unknown }).nodes)
  );
}

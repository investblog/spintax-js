/**
 * Internal AST for @spintax/core. The public `Ast` (spec §9.2) is the opaque,
 * versioned view; `ParsedAst` is the internal shape carrying the node tree that
 * render/validate/extract/analyze walk. Not a serialization format — never
 * persisted across engine versions.
 *
 * M1 scope: literal / variable / enumeration / permutation (PR-10) +
 * conditional / plural / #set / #include (PR-11). Permutation's `<config>` and
 * per-element separators are parsed from `rawInner` in PR-11b.
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

export type Node =
  | LiteralNode
  | VariableNode
  | EnumerationNode
  | PermutationNode
  | ConditionalNode
  | PluralNode
  | SetNode
  | IncludeNode;

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

/** `#set %name% = value` (line-anchored). Global-scope / collapse-once are render (M2) concerns. */
export interface SetNode {
  readonly type: 'set';
  readonly name: string;
  readonly value: readonly Node[];
}

/** `#include "ref"` (line-anchored). Host-injected resolution is a render (M2) concern. */
export interface IncludeNode {
  readonly type: 'include';
  readonly ref: string;
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

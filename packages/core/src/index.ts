/**
 * @spintax/core — framework-agnostic Spintax engine (parse / render / validate /
 * extract / analyze / neutralize). Public API contract per spec §9.2 / §9.3.
 *
 * STATUS: M3. The full §9.2 surface — parse / render / validate / extract /
 * analyze / neutralize — is implemented.
 */

import { parseTemplate } from './internal/parser';
import { validateTemplate } from './internal/validator';
import { extractFromSource } from './internal/extract';
import { renderWith } from './internal/pipeline';
import { neutralize as neutralizeValue } from './internal/neutralize';
import { makeRng } from './internal/rng';
import { AstVersionError } from './internal/errors';
import { isParsedAst, walk, type Ast, type ParsedAst } from './internal/ast';

// ─── Public types (§9.2) ─────────────────────────────────────────────────────

/**
 * Opaque, versioned parse result. NOT a public data contract in v1 — consumers
 * pass it back to render/validate/extract/analyze, they do not introspect it.
 * An in-memory perf handle, not a serialization format (do not persist across
 * engine versions).
 */
export type { Ast };

export interface RenderOptions {
  /** Variable map (T1, author-controlled by default — §6). */
  context?: Record<string, string>;
  /** Deterministic RNG seed; omit ⇒ nondeterministic. */
  seed?: number | string;
  /** Plural-bucket locale (§3.1); omit ⇒ default EN-style 2-form. */
  locale?: string;
  /** Host-injected, SYNCHRONOUS #include resolver (§4.1); omit ⇒ #include disabled. */
  includeResolver?: (ref: string) => string | null;
  /** Default TRUE (§0.1). false skips cosmetic post-process only; the mandatory neutralize safety-restore still runs (§6). */
  postProcess?: boolean;
  /** #include + parse-nesting guard; defaults to {@link DEFAULT_MAX_DEPTH}. */
  maxDepth?: number;
}

export interface ValidateOptions {
  /** Plural-bucket locale for arity verdicts (§3.1); omit ⇒ default 2-form. */
  locale?: string;
  /** Slug/id allow-list; enables "unknown #include target" verdicts. */
  knownIncludes?: readonly string[];
  /**
   * Variable names the host will supply at render (globals / context keys).
   * Suppresses the `variable.undefined` WARNING for them — verdict is unaffected
   * (an undefined var is never an error). Case-insensitive.
   */
  knownVariables?: readonly string[];
}

export interface Diagnostic {
  severity: 'error' | 'warning';
  /** Stable machine code — parity-gated (wording/position are not). */
  code: string;
  message: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  endLine?: number;
  endColumn?: number;
  /** Structured specifics keyed off `code`, e.g. { expected: 3, got: 2 }. */
  data?: Record<string, unknown>;
}

export interface ExtractResult {
  refs: string[];
  sets: string[];
  includes: string[];
}

export interface Analysis extends ExtractResult {
  diagnostics: Diagnostic[];
  /** Best-effort construct counts — NOT a variant-cardinality promise (§9.3). */
  constructs: Record<string, number>;
}

/** Default value for {@link RenderOptions.maxDepth}. */
export { DEFAULT_MAX_DEPTH } from './internal/pipeline';

// ─── Errors (§9.3 — minimal, not a taxonomy) ─────────────────────────────────

export { SpintaxError, IncludeResolverError, AstVersionError, NotImplementedError } from './internal/errors';

// ─── Public API surface (§9.2) ───────────────────────────────────────────────

export function parse(src: string): Ast {
  return parseTemplate(src);
}

export function render(input: string | Ast, opts: RenderOptions = {}): string {
  // Public entry: seed the rng, then run the shared pipeline (internal/pipeline).
  return renderWith(input, makeRng(opts.seed), opts);
}

export function validate(input: string | Ast, opts: ValidateOptions = {}): Diagnostic[] {
  return validateTemplate(resolveSource(input), opts);
}

/** Resolve a `string | Ast` input to its source text (for the raw-text checks). */
function resolveSource(input: string | Ast): string {
  if (typeof input === 'string') return input;
  if (isParsedAst(input)) return input.source;
  throw new AstVersionError('Ast was not produced by this engine version.');
}

export function extract(input: string | Ast): ExtractResult {
  return extractFromSource(resolveSource(input));
}

export function analyze(input: string | Ast, opts: ValidateOptions = {}): Analysis {
  const ast = resolveAst(input);
  const extracted = extractFromSource(ast.source);
  return {
    ...extracted,
    diagnostics: validateTemplate(ast.source, opts),
    constructs: countConstructs(ast, extracted.includes.length),
  };
}

/** Resolve a `string | Ast` input to a parsed AST (parses a string fresh). */
function resolveAst(input: string | Ast): ParsedAst {
  if (typeof input === 'string') return parseTemplate(input);
  if (isParsedAst(input)) return input;
  throw new AstVersionError('Ast was not produced by this engine version.');
}

/**
 * Best-effort construct census (§9.3) — counts author-visible constructs, NOT a
 * variant-cardinality promise. `set`/`include` are directive counts; the rest are
 * AST node types (nested nodes included; literals excluded).
 */
function countConstructs(ast: ParsedAst, includeCount: number): Record<string, number> {
  const counts: Record<string, number> = {
    enumeration: 0,
    permutation: 0,
    variable: 0,
    conditional: 0,
    plural: 0,
  };
  walk(ast.nodes, (n) => {
    if (n.type in counts) counts[n.type] = (counts[n.type] ?? 0) + 1;
  });
  counts.set = Object.keys(ast.setDefs).length;
  counts.include = includeCount;
  return counts;
}

export function neutralize(value: string): string {
  return neutralizeValue(value);
}

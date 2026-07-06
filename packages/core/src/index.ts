/**
 * @spintax/core — framework-agnostic Spintax engine (parse / render / validate /
 * extract / analyze / neutralize). Public API contract per spec §9.2 / §9.3.
 *
 * STATUS: M0.5 scaffolding. The types below are the committed surface; the
 * function bodies are stubs replaced by the real engine at M1 (parser+validator)
 * and M2 (renderer+post-process). They throw {@link NotImplementedError} until then.
 */

import { parseTemplate } from './internal/parser';
import type { Ast } from './internal/ast';

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
export const DEFAULT_MAX_DEPTH = 20;

// ─── Errors (§9.3 — minimal, not a taxonomy) ─────────────────────────────────

/** Base class for programmer-error throws from render(). */
export class SpintaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpintaxError';
  }
}

/** A host-injected includeResolver itself threw. */
export class IncludeResolverError extends SpintaxError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'IncludeResolverError';
    if (options && 'cause' in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Nested #include / parse depth exceeded maxDepth. */
export class MaxDepthExceededError extends SpintaxError {
  constructor(message: string) {
    super(message);
    this.name = 'MaxDepthExceededError';
  }
}

/** An Ast produced by an incompatible engine version was passed back in. */
export class AstVersionError extends SpintaxError {
  constructor(message: string) {
    super(message);
    this.name = 'AstVersionError';
  }
}

/** Thrown by the M0.5 stubs until the engine lands (M1/M2). */
export class NotImplementedError extends SpintaxError {
  constructor(what: string) {
    super(`${what} is not implemented yet (lands at M1/M2).`);
    this.name = 'NotImplementedError';
  }
}

// ─── Public API surface (§9.2) — stubs ───────────────────────────────────────

export function parse(src: string): Ast {
  return parseTemplate(src);
}

export function render(_input: string | Ast, _opts?: RenderOptions): string {
  throw new NotImplementedError('render()');
}

export function validate(_input: string | Ast, _opts?: ValidateOptions): Diagnostic[] {
  throw new NotImplementedError('validate()');
}

export function extract(_input: string | Ast): ExtractResult {
  throw new NotImplementedError('extract()');
}

export function analyze(_input: string | Ast, _opts?: ValidateOptions): Analysis {
  throw new NotImplementedError('analyze()');
}

export function neutralize(_value: string): string {
  throw new NotImplementedError('neutralize()');
}

/**
 * The full render pipeline with an INJECTED rng — the seam shared by the public
 * render() (which seeds the rng from RenderOptions.seed) and the corpus harness
 * (which injects a fixture's `rng` strategy). Keeping the rng a parameter is what
 * lets the deterministic parity fixtures assert exact output.
 *
 * Order: strip stray sentinels → build vars, roll #def, tree-walk (+ #include) →
 * cosmetic post-process (if on) → mandatory neutralize safety-restore (always).
 */
import { renderAst, type PluralIssue, type RenderCtx } from './render';
import { postProcess } from './postprocess';
import { safetyRestore, stripSentinels } from './neutralize';
import { parseTemplate } from './parser';
import { isParsedAst, type Ast, type ParsedAst } from './ast';
import { AstVersionError } from './errors';
import type { Rng } from './rng';

/** Default for {@link PipelineOptions.maxDepth} (#include + parse-nesting guard). */
export const DEFAULT_MAX_DEPTH = 20;

export interface PipelineOptions {
  context?: Record<string, string>;
  locale?: string;
  includeResolver?: (ref: string) => string | null;
  postProcess?: boolean;
  maxDepth?: number;
  onPluralError?: (issue: PluralIssue) => void;
}

export function renderWith(input: string | Ast, rng: Rng, opts: PipelineOptions = {}): string {
  const ctx: RenderCtx = {
    runtimeContext: opts.context ?? {},
    rng,
    locale: opts.locale ?? '',
    resolver: opts.includeResolver,
    maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH,
    includeStack: [],
    onPluralError: opts.onPluralError,
  };
  // Strip stray engine sentinels from author markup so only neutralize() introduces them.
  const ast = resolveAst(typeof input === 'string' ? stripSentinels(input) : input);
  let out = renderAst(ast, ctx);
  // Cosmetic post-process defaults ON (§0.1); false skips it. It runs on the still-
  // shielded form (neutralize sentinels are inert here).
  if (opts.postProcess !== false) out = postProcess(out);
  // Mandatory neutralize safety-restore (§6) — ALWAYS runs, even with postProcess:false.
  return safetyRestore(out);
}

/** Resolve a `string | Ast` input to a parsed AST (parses a string fresh). */
function resolveAst(input: string | Ast): ParsedAst {
  if (typeof input === 'string') return parseTemplate(input);
  if (isParsedAst(input)) return input;
  throw new AstVersionError('Ast was not produced by this engine version.');
}

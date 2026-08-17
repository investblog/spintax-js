/**
 * The three tools, as thin wrappers over `@spintax/core`. Transport-free: this
 * returns a verdict, never a `Response` and never a line of stdout.
 */

import { render, validate, analyze, SpintaxError, type Diagnostic } from '@spintax/core';

export interface IncludeProblem {
  ref: string;
  reason: string;
}

export interface IncludeReport {
  /** The `--include-root` directory, fully resolved (symlinks included). */
  root: string;
  /** The effective depth guard — without it, `depth-exceeded` is unactionable. */
  maxDepth: number;
  resolved: string[];
  missing: IncludeProblem[];
  suppressed: IncludeProblem[];
  /**
   * True when the walk that classifies suppressed refs ran out of budget, so
   * `suppressed` is short. A truncated list that presents itself as complete is worse
   * than an honest partial one.
   */
  truncated: boolean;
}

/**
 * Host-supplied `#include` support. The engine's resolver contract is synchronous
 * and MUST NOT throw — a throwing resolver becomes `IncludeResolverError`, which
 * with a resolver installed is reachable from ordinary template content.
 */
export interface IncludeSupport {
  resolver: (ref: string) => string | null;
  /** Start a fresh accounting window: clears the read cache and the asked-log. */
  begin(): void;
  /** What happened in the window. `source` is the template the caller rendered. */
  report(source: string): IncludeReport;
}

export interface CallToolOptions {
  /** Omit ⇒ no template size cap (the local server has none). */
  maxTemplateChars?: number;
  maxVariants: number;
  include?: IncludeSupport;
  /** Engine `#include`/nesting guard; omit ⇒ the engine default. */
  maxDepth?: number;
}

/**
 * `error` is a tool-level failure — `isError: true` inside a SUCCESSFUL JSON-RPC
 * envelope. `unknown-tool` is a protocol-level `-32602`. Keeping them apart here is
 * what lets both transports render them the same way.
 */
export type ToolOutcome =
  | { kind: 'ok'; text: string; structured: Record<string, unknown> }
  | { kind: 'error'; message: string }
  | { kind: 'unknown-tool'; name: string };

function requireTemplate(args: Record<string, unknown>): string | null {
  const t = args.template;
  if (typeof t !== 'string' || t.length === 0) return null;
  return t;
}

function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : undefined;
}

export function callTool(
  name: string,
  args: Record<string, unknown>,
  opts: CallToolOptions,
): ToolOutcome {
  const template = requireTemplate(args);
  if (template === null) {
    return { kind: 'error', message: 'Missing or empty "template" argument (string required).' };
  }
  const cap = opts.maxTemplateChars;
  if (cap !== undefined && template.length > cap) {
    return {
      kind: 'error',
      message:
        `Template is ${template.length} characters; this server caps templates at ${cap} ` +
        '(free-tier CPU budget). Split the template or render locally with @spintax/core.',
    };
  }
  const locale = typeof args.locale === 'string' ? args.locale : undefined;
  const localeOpt = locale === undefined ? {} : { locale };
  const knownVariables = strArray(args.knownVariables);
  const knownVariablesOpt = knownVariables === undefined ? {} : { knownVariables };

  try {
    switch (name) {
      case 'validate_spintax': {
        // With a resolver installed, the refs that actually resolve become the
        // allow-list — which turns an unresolvable #include from a silent render-time
        // '' into a diagnostic with a line and column.
        //
        // The engine only files those verdicts when the allow-list is NON-EMPTY
        // (`validator.ts`: `knownIncludes && length > 0`), so a template whose every
        // include is broken still validates clean. That is engine contract, gated by
        // the cross-engine corpus, not something to work around from out here — and
        // the include report on render_spintax names every miss regardless.
        let knownIncludesOpt: { knownIncludes?: string[] } = {};
        if (opts.include) {
          opts.include.begin();
          const declared = analyze(template, { ...localeOpt }).includes;
          const resolvable = declared.filter(ref => opts.include!.resolver(ref) !== null);
          if (resolvable.length > 0) knownIncludesOpt = { knownIncludes: resolvable };
        }
        const diagnostics: Diagnostic[] = validate(template, {
          ...localeOpt,
          ...knownVariablesOpt,
          ...knownIncludesOpt,
        });
        const errorCount = diagnostics.filter(d => d.severity === 'error').length;
        const structured = {
          valid: errorCount === 0,
          errorCount,
          warningCount: diagnostics.length - errorCount,
          diagnostics,
        };
        const text = diagnostics.length
          ? diagnostics
              .map(d => `${d.severity} ${d.code} at ${d.line}:${d.column} — ${d.message}`)
              .join('\n')
          : 'Valid: no diagnostics.';
        return { kind: 'ok', text, structured };
      }

      case 'render_spintax': {
        const rawCount = typeof args.count === 'number' ? Math.floor(args.count) : 3;
        const count = Math.min(Math.max(rawCount, 1), opts.maxVariants);
        const seed =
          typeof args.seed === 'string' || typeof args.seed === 'number' ? args.seed : undefined;
        let context: Record<string, string> | undefined;
        if (args.context !== undefined) {
          if (
            typeof args.context !== 'object' ||
            args.context === null ||
            Array.isArray(args.context)
          ) {
            return {
              kind: 'error',
              message: '"context" must be an object mapping variable names to strings.',
            };
          }
          context = {};
          for (const [k, v] of Object.entries(args.context as Record<string, unknown>)) {
            context[k] = String(v);
          }
        }
        const base = {
          ...(context === undefined ? {} : { context }),
          ...localeOpt,
          ...(opts.include === undefined ? {} : { includeResolver: opts.include.resolver }),
          ...(opts.maxDepth === undefined ? {} : { maxDepth: opts.maxDepth }),
        };
        if (opts.include) opts.include.begin();
        const variants: string[] = [];
        for (let i = 0; i < count; i++) {
          variants.push(render(template, { ...base, ...(seed === undefined ? {} : { seed: `${seed}#${i}` }) }));
        }
        let text = variants.join('\n---\n');
        const structured: Record<string, unknown> = { variants };
        if (opts.include) {
          const report = opts.include.report(template);
          structured.include = report;
          // One line per problem in the TEXT content too: an agent acts on what it
          // reads, and a structured block it did not ask for is easy to miss.
          const notes = [
            ...report.missing.map(p => `#include "${p.ref}" not used: ${p.reason}`),
            ...report.suppressed.map(p => `#include "${p.ref}" suppressed: ${p.reason}`),
            // A client that shows only text must not be told a short list is the list.
            ...(report.truncated
              ? ['#include report truncated: the suppressed list above is incomplete.']
              : []),
          ];
          if (notes.length) text += `\n---\n${notes.join('\n')}`;
        }
        return { kind: 'ok', text, structured };
      }

      case 'analyze_spintax': {
        // Deliberately does NOT follow #include on either server: following them
        // would silently change what refs/constructs mean between the two.
        const a = analyze(template, { ...localeOpt, ...knownVariablesOpt });
        const text =
          `refs: ${a.refs.join(', ') || '—'}\nsets: ${a.sets.join(', ') || '—'}\n` +
          `defs: ${a.defs.join(', ') || '—'}\nincludes: ${a.includes.join(', ') || '—'}\n` +
          `constructs: ${JSON.stringify(a.constructs)}\ndiagnostics: ${a.diagnostics.length}`;
        return { kind: 'ok', text, structured: { ...a } };
      }

      default:
        return { kind: 'unknown-tool', name };
    }
  } catch (e) {
    // Template content never throws (the engine is lenient) — but a resolver that
    // throws surfaces here as IncludeResolverError, so this backstop is real, not
    // theoretical, the moment --include-root is on. A multi-line message is safe on
    // stdio: it is inside a JSON string by the time framing sees it.
    const msg = e instanceof SpintaxError ? e.message : 'Internal engine error.';
    return { kind: 'error', message: msg };
  }
}

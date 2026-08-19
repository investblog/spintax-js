/**
 * Reference Cloudflare Worker — the @spintax/core API acceptance gate (spec §8).
 *
 * PURITY BOUNDARY: this consumer imports `@spintax/core` and nothing engine-side
 * imports it back. The Worker owns everything non-engine — HTTP shape, batching,
 * and the T2 shielding of caller-supplied context (§6). The engine owns nothing
 * network-facing.
 *
 * Endpoints (all POST, JSON body with a `template` string):
 *   /validate-template  → validate()   { valid, diagnostics }
 *   /extract-variables  → extract()    { refs, sets, defs, includes }
 *   /analyze-template   → analyze()    { refs, sets, defs, includes, diagnostics, constructs }
 *   /preview-render     → render()     { output }        (post-process on by default)
 *   /render-batch       → host loop over render(ast, { seed: base + i }) → { variants }
 *
 * A source over MAX_TEMPLATE_CHARS — root template plus include bodies — is refused
 * with 413 before any endpoint runs.
 */
import {
  analyze,
  extract,
  neutralize,
  parse,
  render,
  validate,
  AstVersionError,
  IncludeResolverError,
  type RenderOptions,
  type ValidateOptions,
} from '@spintax/core';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;
const MAX_BATCH = 100;
/**
 * Input cap — a HOST policy, not an engine one (§9.3: small core, rich Worker).
 *
 * The engine is lenient by contract and will happily chew on a megabyte of
 * pathological markup; nesting costs the same super-linear time in every engine of
 * the family, and `/render-batch` multiplies it by up to MAX_BATCH. The hosted MCP
 * server has capped templates at this size from the start — this is the same number,
 * so the two public doors answer alike.
 *
 * Measured against the WHOLE source: the root template plus every include body. The
 * first version of this cap read `body.template` only, which bounded nothing — an
 * 18-character `#include "big"` carried an unbounded child past it.
 */
const MAX_TEMPLATE_CHARS = 8192;
/** Include resolutions allowed per render() — see `includeResolver` for why a source cap is not enough. */
const MAX_INCLUDE_RESOLUTIONS = 200;
/**
 * Total characters `/render-batch` may return.
 *
 * **The rule these caps serve is human perception, not byte thrift.** A big answer is fine
 * if it arrives while the caller is still waiting for it; what must never happen is a frozen
 * screen. So a cap is set by measuring the latency envelope and then sitting above every
 * legitimate request and below the point where an answer stops arriving — a cap that refuses
 * work a person would happily have waited for is a bug, not caution.
 *
 * Measured on this deployment (2026-08-19):
 *
 * - the heaviest LEGITIMATE batch the source cap even allows — 8 KB of spinnable prose,
 *   `count: 100` — returns **703 KB in 0.74–0.92 s**;
 * - the deepest nesting the source cap allows, 4 000 levels, renders in **0.98 s**;
 * - so with MAX_TEMPLATE_CHARS in place, everything reachable answers in about a second.
 *
 * This cap exists for the one shape where bytes and time come apart: expansion. A
 * 62-character template can become megabytes (spintax-js#69), and `/render-batch` multiplies
 * it by up to MAX_BATCH — at `count: 10` that used to kill the isolate outright, HTTP 503
 * from 62 bytes. 2 MB is roughly a second of answer, three times the heaviest real batch, and
 * it fires while the request is still alive. An earlier 8 MB never fired at all, which is
 * worse than no cap: it reads as protection.
 *
 * A single render may still return more — the engine's own allowance is 1 MB. It is the
 * multiplication that needed bounding.
 */
const MAX_BATCH_OUTPUT_CHARS = 2 * 1024 * 1024;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

type Body = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

const strArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

function strRecord(v: unknown): Record<string, string> | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
}

function validateOpts(body: Body): ValidateOptions {
  const opts: ValidateOptions = {};
  const locale = str(body.locale);
  if (locale !== undefined) opts.locale = locale;
  const knownIncludes = strArray(body.knownIncludes);
  if (knownIncludes) opts.knownIncludes = knownIncludes;
  const knownVariables = strArray(body.knownVariables);
  if (knownVariables) opts.knownVariables = knownVariables;
  return opts;
}

/** Caller-supplied context is UNTRUSTED (T2) — shield it so data can't inject markup (§6). */
function shieldContext(body: Body): Record<string, string> | undefined {
  const ctx = strRecord(body.context);
  if (!ctx) return undefined;
  const shielded: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx)) shielded[k] = neutralize(v);
  return shielded;
}

/**
 * Two-phase include: the caller passes resolved bodies for the refs extract()
 * surfaced. Include bodies are intentionally T1 (author-trusted, template-shaped) —
 * they carry reusable markup, so they are NOT shielded like T2 context values.
 */
function includeResolver(body: Body): ((ref: string) => string | null) | undefined {
  const map = strRecord(body.includes);
  if (!map) return undefined;
  // Counting the bodies bounds the SOURCE; it does not bound the WORK, because a body may
  // reference another one twice. Twenty such levels is under a kilobyte of unique text and
  // ~2^20 child renders — acyclic, so the engine's cycle guard never fires, and `maxDepth`
  // limits how deep it goes rather than how wide. The budget is per render() call, which is
  // why the resolver is built fresh for each one. Exhausted ⇒ the ref resolves to nothing,
  // the same answer an unknown ref already gets, so render stays lenient.
  let budget = MAX_INCLUDE_RESOLUTIONS;
  return (ref) => {
    if (budget <= 0) return null;
    budget -= 1;
    return ref in map ? (map[ref] ?? null) : null;
  };
}

function renderOpts(body: Body): RenderOptions {
  const opts: RenderOptions = {};
  const ctx = shieldContext(body);
  if (ctx) opts.context = ctx;
  const locale = str(body.locale);
  if (locale !== undefined) opts.locale = locale;
  if (typeof body.seed === 'number' || typeof body.seed === 'string') opts.seed = body.seed;
  if (typeof body.postProcess === 'boolean') opts.postProcess = body.postProcess;
  if (typeof body.maxDepth === 'number') opts.maxDepth = body.maxDepth;
  const resolver = includeResolver(body);
  if (resolver) opts.includeResolver = resolver;
  return opts;
}

// Batch base seed must be numeric for base+i arithmetic; a string seed (valid on
// /preview-render) can't derive a sequence, so batching falls back to base 0.
const seedBase = (seed: unknown): number => (typeof seed === 'number' && Number.isFinite(seed) ? seed : 0);

// render() is lenient (bad markup renders verbatim; a circular/too-deep #include
// resolves to '' — it does NOT throw). So these branches are defense-in-depth for
// the only real programmer-error throws: a resolver that throws, or a foreign Ast.
function mapError(e: unknown): Response {
  if (e instanceof IncludeResolverError) return json({ error: 'include_resolver_failed', message: e.message }, 502);
  if (e instanceof AstVersionError) return json({ error: 'bad_ast', message: e.message }, 400);
  return json({ error: 'internal_error' }, 500);
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const { pathname } = new URL(request.url);

    let body: Body;
    try {
      body = (await request.json()) as Body;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const template = str(body.template);
    if (template === undefined) return json({ error: 'template_required' }, 400);
    // The budget covers the WHOLE source, root plus every include body. Capping the root
    // alone left the cap trivially bypassable: `#include "big"` is 18 characters, and the
    // megabyte it pulls in is parsed and rendered like any other template — up to
    // MAX_BATCH times on /render-batch.
    const source = template.length + Object.values(strRecord(body.includes) ?? {}).reduce((n, v) => n + v.length, 0);
    if (source > MAX_TEMPLATE_CHARS) {
      return json({ error: 'template_too_large', limit: MAX_TEMPLATE_CHARS, got: source }, 413);
    }

    try {
      switch (pathname) {
        case '/validate-template': {
          const diagnostics = validate(template, validateOpts(body));
          return json({ valid: !diagnostics.some((d) => d.severity === 'error'), diagnostics });
        }
        case '/extract-variables':
          return json(extract(template));
        case '/analyze-template':
          return json(analyze(template, validateOpts(body)));
        case '/preview-render':
          return json({ output: render(template, renderOpts(body)) });
        case '/render-batch': {
          const count = Math.max(1, Math.min(MAX_BATCH, Number(body.count) || 1));
          const ast = parse(template); // parse once, render N times (batching is a host concern, §9.3)
          const base = seedBase(body.seed);
          const opts = renderOpts(body);
          const variants: string[] = [];
          let produced = 0;
          for (let i = 0; i < count; i += 1) {
            // A FRESH resolver per variant, so the include budget is per render rather
            // than per request — sharing one across a batch of 100 would quietly drop the
            // includes from every variant after the budget ran out.
            const resolver = includeResolver(body);
            const variant = render(ast, { ...opts, seed: base + i, ...(resolver ? { includeResolver: resolver } : {}) });
            produced += variant.length;
            // Refused rather than truncated: a short batch looks like a valid answer, and a
            // caller asking for 100 variants would silently ship however many fit.
            if (produced > MAX_BATCH_OUTPUT_CHARS) {
              return json({ error: 'batch_output_too_large', limit: MAX_BATCH_OUTPUT_CHARS, variants: i }, 413);
            }
            variants.push(variant);
          }
          return json({ variants });
        }
        default:
          return json({ error: 'not_found' }, 404);
      }
    } catch (e) {
      return mapError(e);
    }
  },
} satisfies ExportedHandler;

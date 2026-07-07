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
 *   /extract-variables  → extract()    { refs, sets, includes }
 *   /analyze-template   → analyze()    { refs, sets, includes, diagnostics, constructs }
 *   /preview-render     → render()     { output }        (post-process on by default)
 *   /render-batch       → host loop over render(ast, { seed: base + i }) → { variants }
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
  return (ref) => (ref in map ? (map[ref] ?? null) : null);
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
          const variants = Array.from({ length: count }, (_v, i) => render(ast, { ...opts, seed: base + i }));
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

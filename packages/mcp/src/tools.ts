/**
 * The tool surface, BUILT rather than declared.
 *
 * The hosted server interpolates its CPU caps into tool descriptions and JSON
 * Schemas (`maxLength`, `count`'s `maximum`, "max N characters"). A shared module
 * with those caps hardcoded would publish schemas that lie on whichever side did
 * not set them — so every cap is a parameter and the tool list is a function.
 */

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

/**
 * `disabled` — no `includeResolver` is installed, so an `#include` line is inert:
 * the engine leaves it in the output verbatim (it is NOT an error and NOT removed).
 * `root` — a host-supplied resolver reads files under one directory.
 */
export type IncludeMode = 'disabled' | 'root';

export interface ToolBuildOptions {
  /** Omit ⇒ no `maxLength` in the schema and no "(max N characters)" in the description. */
  maxTemplateChars?: number;
  /** Required: `count` needs a schema `maximum`, and an unbounded count is a one-line OOM. */
  maxVariants: number;
  /** Default `disabled`, matching the hosted server. */
  include?: IncludeMode;
}

// Everything below is a FACTORY, not a module constant. A JSON Schema shared by
// identity across every buildTools() call is shared mutable state: one consumer poking
// at a nested `properties` object would change what every later call returns, and a
// freshness test that only mutates a top-level field would not notice.
type Schema = Record<string, unknown>;

const diagnosticSchema = (): Schema => ({
  type: 'object',
  properties: {
    severity: { type: 'string', enum: ['error', 'warning'] },
    code: { type: 'string', description: 'Stable machine code, e.g. plural.arity' },
    message: { type: 'string' },
    line: { type: 'integer', description: '1-based' },
    column: { type: 'integer', description: '1-based' },
    endLine: { type: 'integer' },
    endColumn: { type: 'integer' },
    data: { type: 'object' },
  },
  required: ['severity', 'code', 'message', 'line', 'column'],
});

const includeProblemSchema = (): Schema => ({
  type: 'object',
  properties: {
    ref: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['ref', 'reason'],
});

const includeReportSchema = (): Schema => ({
  type: 'object',
  description:
    'What #include resolution did during this call. Best effort: an #include produced by a ' +
    'spin choice is invisible to static analysis, so a suppressed one may go unreported.',
  properties: {
    root: { type: 'string', description: 'The --include-root directory, fully resolved.' },
    maxDepth: { type: 'integer', description: 'The effective #include depth guard.' },
    resolved: { type: 'array', items: { type: 'string' } },
    missing: {
      type: 'array',
      items: includeProblemSchema(),
      description:
        'Refs the resolver refused: denied-shape, outside-root, not-found, not-a-file, too-large, io-error.',
    },
    suppressed: {
      type: 'array',
      items: includeProblemSchema(),
      description:
        'Refs the engine dropped to "" before the resolver saw them: cycle or depth-exceeded. One ref can appear twice with different reasons when different paths reach it.',
    },
    truncated: {
      type: 'boolean',
      description: 'True when the classification walk ran out of budget, so suppressed is short.',
    },
  },
  required: ['root', 'maxDepth', 'resolved', 'missing', 'suppressed', 'truncated'],
});

const localeProp = (): Schema => ({
  type: 'string',
  description:
    'Locale for {plural …} arity, e.g. "en" (2-form) or "ru" (3-form: ru/uk/be/sr/hr/bs). Omit for the 2-form default.',
});

/**
 * Returns a fresh array of fresh objects, all the way down: nothing a caller does to
 * the result can affect a later call.
 */
export function buildTools(opts: ToolBuildOptions): ToolDef[] {
  const { maxTemplateChars, maxVariants } = opts;
  const include = opts.include ?? 'disabled';

  const cap = maxTemplateChars === undefined ? '' : ` (max ${maxTemplateChars} characters)`;
  const includeNote =
    include === 'root'
      ? '#include resolves against the server\'s --include-root directory.'
      : '#include is disabled on this server.';

  // A factory even though the value never varies within one call: three tools share
  // this property, and sharing one object between them means a consumer editing
  // `tools[0]` silently edits `tools[1]` too.
  const templateProp = (): Schema => ({
    type: 'string',
    ...(maxTemplateChars === undefined ? {} : { maxLength: maxTemplateChars }),
    description: `Spintax template source${cap}. ${includeNote}`,
  });

  const knownVariablesProp = (): Schema => ({
    type: 'array',
    items: { type: 'string' },
    description: 'Variable names the caller will supply at render time (case-insensitive).',
  });

  return [
    {
      name: 'validate_spintax',
      title: 'Validate a spintax template',
      description:
        'Static validation: returns diagnostics with severity, stable code, message and 1-based ' +
        'line/column. A template with no "error"-severity diagnostics is safe to render. Pass ' +
        'knownVariables for names you will supply at render time to silence their ' +
        'variable.undefined warnings.' +
        // Precisely what the engine does, not what would be nicer: `validate()` files
        // unknown-target verdicts only for a NON-EMPTY allow-list, so a template whose
        // every include is broken validates clean. Overstating it here would send an
        // agent looking for a diagnostic that is never coming.
        (include === 'root'
          ? ' When at least one #include target resolves under --include-root, targets that do not ' +
            'resolve are reported as errors; render_spintax always reports them in its include block.'
          : ''),
      inputSchema: {
        type: 'object',
        properties: {
          template: templateProp(),
          locale: localeProp(),
          knownVariables: knownVariablesProp(),
        },
        required: ['template'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          valid: { type: 'boolean', description: 'True when no error-severity diagnostics.' },
          errorCount: { type: 'integer' },
          warningCount: { type: 'integer' },
          diagnostics: { type: 'array', items: diagnosticSchema() },
        },
        required: ['valid', 'errorCount', 'warningCount', 'diagnostics'],
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'render_spintax',
      title: 'Render spintax variants',
      description:
        `Renders up to ${maxVariants} variants. With a seed the output is deterministic ` +
        '(variant i uses seed "<seed>#<i>"); without one it is random. The engine is lenient: ' +
        'structural mistakes never throw, they surface in the output — run validate_spintax first.',
      inputSchema: {
        type: 'object',
        properties: {
          template: templateProp(),
          count: {
            type: 'integer',
            minimum: 1,
            maximum: maxVariants,
            default: 3,
            description: `Number of variants (1–${maxVariants}).`,
          },
          seed: {
            type: ['string', 'number'],
            description: 'Deterministic RNG seed; omit for random output.',
          },
          locale: localeProp(),
          context: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Variable map, e.g. {"CITY": "Prague"}. Overrides #set/#def definitions.',
          },
        },
        required: ['template'],
        additionalProperties: false,
      },
      // `required` stays ['variants'] and the schema is open (no additionalProperties:
      // false), so the include-mode output is a SUPERSET: a client validating against
      // the hosted server's published schema still passes against this one.
      outputSchema: {
        type: 'object',
        properties: {
          variants: { type: 'array', items: { type: 'string' } },
          ...(include === 'root' ? { include: includeReportSchema() } : {}),
        },
        required: ['variants'],
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    {
      name: 'analyze_spintax',
      title: 'Analyze a spintax template',
      description:
        'Reports what the template needs and contains: refs (variables referenced), sets (#set ' +
        'macros, re-picked per reference), defs (#def, rolled once per render), includes, ' +
        'diagnostics, and best-effort construct counts. Answers "what variables must I supply" — ' +
        'it is NOT a variant-cardinality counter.',
      inputSchema: {
        type: 'object',
        properties: {
          template: templateProp(),
          locale: localeProp(),
          knownVariables: { type: 'array', items: { type: 'string' } },
        },
        required: ['template'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          refs: { type: 'array', items: { type: 'string' } },
          sets: { type: 'array', items: { type: 'string' } },
          defs: { type: 'array', items: { type: 'string' } },
          includes: { type: 'array', items: { type: 'string' } },
          diagnostics: { type: 'array', items: diagnosticSchema() },
          constructs: { type: 'object', additionalProperties: { type: 'integer' } },
        },
        required: ['refs', 'sets', 'defs', 'includes', 'diagnostics', 'constructs'],
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
  ];
}

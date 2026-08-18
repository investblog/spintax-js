/**
 * The schema freeze.
 *
 * Its provenance has flipped, and saying so matters. The fixture was first extracted
 * MECHANICALLY from the live `functions/mcp.ts` in spintax.net (its TOOLS literal,
 * evaluated) to prove the port changed nothing. Since that endpoint moved onto this
 * module, the fixture is no longer independent evidence about the hosted server — it is
 * the change-detector for the tool contract BOTH doors publish. Regenerating it is
 * therefore a deliberate act that changes what an agent reads, not a way to make a test
 * pass; the review that accompanies it is the real gate.
 *
 * It stays a plain JSON file rather than a vitest snapshot for exactly that reason:
 * `vitest -u` would rewrite a snapshot silently, and a diff on this file is meant to be
 * read.
 */

import { describe, expect, it } from 'vitest';
import { buildTools, type ToolDef } from '../src/tools';
import siteTools from './fixtures/site-tools.json';

/** The hosted server's caps (ADR 0002 in the site repo). */
const SITE_LIMITS = { maxTemplateChars: 8 * 1024, maxVariants: 20 } as const;

const byName = (tools: ToolDef[]): Map<string, ToolDef> => new Map(tools.map(t => [t.name, t]));

describe('buildTools vs the hosted server', () => {
  it('reproduces the live tool list byte for byte with the site caps', () => {
    expect(buildTools({ ...SITE_LIMITS, include: 'disabled' })).toEqual(siteTools);
  });

  it('defaults to include-disabled, i.e. the hosted shape', () => {
    expect(buildTools(SITE_LIMITS)).toEqual(buildTools({ ...SITE_LIMITS, include: 'disabled' }));
  });

  it('shares no state between calls, all the way down the nesting', () => {
    // Mutating a top-level field only would pass even with every nested schema shared
    // by identity — which is how the shared `DIAGNOSTIC_SCHEMA` and `templateProp`
    // objects survived the first version of this test. Reach into the nesting instead.
    const props = (t: ToolDef): Record<string, Record<string, unknown>> =>
      t.inputSchema.properties as Record<string, Record<string, unknown>>;
    const diagItems = (t: ToolDef): Record<string, unknown> =>
      (t.outputSchema.properties as Record<string, Record<string, unknown>>).diagnostics!
        .items as Record<string, unknown>;

    const a = buildTools(SITE_LIMITS);
    props(a[0]!).template!.description = 'mutated';
    diagItems(a[0]!).type = 'mutated';

    const fresh = buildTools(SITE_LIMITS);
    expect(props(fresh[0]!).template!.description).toContain('Spintax template source');
    expect(diagItems(fresh[0]!).type).toBe('object');
    // Nor do the three tools share one template property object between themselves.
    expect(props(fresh[0]!).template).not.toBe(props(fresh[1]!).template);
    expect(props(fresh[0]!).template).toEqual(props(fresh[1]!).template);
  });
});

describe('uncapped (local) build', () => {
  const local = buildTools({ maxVariants: 50, include: 'root' });

  it('omits maxLength and the "(max N characters)" note when there is no cap', () => {
    for (const tool of local) {
      const props = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
      expect(props.template).not.toHaveProperty('maxLength');
      expect(props.template!.description).not.toContain('max ');
    }
  });

  it('says #include resolves, and carries count up to the local maximum', () => {
    const props = byName(local).get('render_spintax')!.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.template!.description).toContain('--include-root');
    expect(props.count!.maximum).toBe(50);
    expect(byName(local).get('render_spintax')!.description).toContain('up to 50 variants');
  });

  it('keeps the tool names, required lists, closed inputs and annotations identical', () => {
    const site = byName(buildTools({ ...SITE_LIMITS, include: 'disabled' }));
    expect([...byName(local).keys()]).toEqual([...site.keys()]);
    for (const [name, tool] of byName(local)) {
      const other = site.get(name)!;
      expect(tool.inputSchema.required).toEqual(other.inputSchema.required);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema.required).toEqual(other.outputSchema.required);
      expect(tool.annotations).toEqual(other.annotations);
    }
  });

  it('grows the render output schema as a SUPERSET — a site-schema client still validates', () => {
    const siteOut = byName(buildTools({ ...SITE_LIMITS })).get('render_spintax')!.outputSchema;
    const localOut = byName(local).get('render_spintax')!.outputSchema;
    const siteProps = siteOut.properties as Record<string, unknown>;
    const localProps = localOut.properties as Record<string, unknown>;
    for (const key of Object.keys(siteProps)) {
      expect(localProps[key]).toEqual(siteProps[key]);
    }
    expect(localProps).toHaveProperty('include');
    expect(localOut.required).toEqual(['variants']);
    // Open output schemas are what makes the superset legal — pin that too.
    expect(localOut).not.toHaveProperty('additionalProperties');
    expect(siteOut).not.toHaveProperty('additionalProperties');
  });
});

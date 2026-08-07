import { describe, expect, it } from 'vitest';
import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import { Spintax } from '../src/nodes/Spintax/Spintax.node';

/**
 * Minimal IExecuteFunctions stand-in: parameters come from a plain object,
 * missing ones fall back to the caller-provided default — which is exactly
 * the contract execute() relies on.
 */
function run(
  params: Record<string, unknown>,
  items: IDataObject[],
  opts: { continueOnFail?: boolean } = {},
): Promise<INodeExecutionData[][]> {
  const mock = {
    getInputData: () => items.map((json) => ({ json })),
    getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
      name in params ? params[name] : fallback,
    continueOnFail: () => opts.continueOnFail === true,
    getNode: () => ({ name: 'Spintax', type: 'spintax', typeVersion: 1 }),
  } as unknown as IExecuteFunctions;
  return new Spintax().execute.call(mock);
}

describe('Spintax node — execute()', () => {
  it('render: item fields become variables, result lands on outputField with pairedItem', async () => {
    const [main] = await run(
      { operation: 'render', template: '{Hello|Hi} %name%!', seed: '42', outputField: 'copy' },
      [{ name: 'Ada' }, { name: 'Grace' }],
    );
    expect(main).toHaveLength(2);
    expect(main![0]!.json['copy']).toMatch(/^(Hello|Hi) Ada!$/);
    expect(main![1]!.json['copy']).toMatch(/^(Hello|Hi) Grace!$/);
    expect(main![0]!.pairedItem).toEqual({ item: 0 });
    expect(main![1]!.pairedItem).toEqual({ item: 1 });
  });

  it('render: incoming markup is shielded by default, fixed pairs are not', async () => {
    const [main] = await run(
      {
        operation: 'render',
        template: '%scraped% %title%',
        seed: '1',
        postProcess: false,
        fixedVariables: { pair: [{ name: 'title', value: '{Mr|Ms}' }] },
      },
      [{ scraped: '{x|y}' }],
    );
    const copy = main![0]!.json['rendered'] as string;
    expect(copy).toMatch(/^\{x\|y\} (Mr|Ms)$/);
  });

  it('renderMany: one item per variant, honesty fields, pairedItem to the source row', async () => {
    const [main] = await run(
      { operation: 'renderMany', template: '{a|b}', count: 5, baseSeed: 'z' },
      [{ id: 1 }],
    );
    expect(main!.length).toBeLessThanOrEqual(2);
    for (const item of main!) {
      expect(item.json['requested']).toBe(5);
      expect(item.json['produced']).toBe(main!.length);
      expect(item.pairedItem).toEqual({ item: 0 });
    }
  });

  it('validate: routes items to Valid/Invalid and carries everything repair needs', async () => {
    const [valid, invalid] = await run(
      { operation: 'validate', template: '={{ ignored }}', cleanModelOutput: false },
      [],
    );
    expect(valid).toEqual([]);
    expect(invalid).toEqual([]);

    const [ok, bad] = await run({ operation: 'validate', template: '{a|b' }, [{ n: 1 }]);
    expect(ok).toHaveLength(0);
    expect(bad).toHaveLength(1);
    const item = bad![0]!.json;
    expect(item['valid']).toBe(false);
    expect(item['cleanedTemplate']).toBe('{a|b');
    expect((item['diagnostics'] as IDataObject[])[0]!['code']).toBe('bracket.unclosed');
  });

  it('validate + cleanModelOutput: diagnostics index the CLEANED string (fence line gone)', async () => {
    const [, invalid] = await run(
      { operation: 'validate', template: '```\n{a|b\n```', cleanModelOutput: true },
      [{}],
    );
    const item = invalid![0]!.json;
    expect(item['cleanedTemplate']).toBe('{a|b');
    expect(item['rawTemplate']).toBe('```\n{a|b\n```');
    // Line 1 of the cleaned template — NOT line 2 of the raw fenced reply.
    expect((item['diagnostics'] as IDataObject[])[0]!['line']).toBe(1);
  });

  it('validate: spintaxMeta from the item supplies locale and known variables', async () => {
    const [valid] = await run(
      {
        operation: 'validate',
        template: '%name%',
        spintaxMeta: { locale: 'ru', allowedVariables: [{ name: 'name' }] },
      },
      [{}],
    );
    expect(valid![0]!.json['warningCount']).toBe(0);
    expect(valid![0]!.json['locale']).toBe('ru');
  });

  it('buildAuthoringPrompt: merges item field names into allowedVariables and stamps spintaxMeta', async () => {
    const [main] = await run(
      {
        operation: 'buildAuthoringPrompt',
        brief: 'Welcome email for %first_name%',
        locale: 'en',
        useItemFieldNames: true,
        allowedVariables: { variable: [{ name: 'plan', case: 'nominative', note: '' }] },
      },
      [{ first_name: 'Ada', company: 'ACME', tags: ['x'] }],
    );
    const meta = main![0]!.json['spintaxMeta'] as {
      allowedVariables: Array<{ name: string }>;
      promptVersion: string;
    };
    expect(meta.allowedVariables.map((v) => v.name)).toEqual(['plan', 'first_name', 'company']);
    expect(main![0]!.json['systemPrompt']).toBeTruthy();
    expect(main![0]!.json['nextStep']).toContain('Validate');
  });

  it('buildRepairPrompt: consumes template/diagnostics/meta straight off the Invalid item', async () => {
    const [, invalid] = await run({ operation: 'validate', template: '{a|b' }, [{}]);
    const carried = invalid![0]!.json;
    const [main] = await run(
      {
        operation: 'buildRepairPrompt',
        template: carried['cleanedTemplate'],
        diagnostics: carried['diagnostics'],
        spintaxMeta: { locale: 'en', allowedVariables: [] },
      },
      [carried],
    );
    expect(main![0]!.json['systemPrompt']).toBeTruthy();
    expect(main![0]!.json['nextStep']).toContain('cap the loop');
  });

  it('buildRepairPrompt: rejects non-array diagnostics; continueOnFail turns it into an error item', async () => {
    await expect(
      run({ operation: 'buildRepairPrompt', template: 'x', diagnostics: 'nope' }, [{}]),
    ).rejects.toThrow(/Diagnostics/);

    const [main] = await run(
      { operation: 'buildRepairPrompt', template: 'x', diagnostics: 'nope' },
      [{}],
      { continueOnFail: true },
    );
    expect(main![0]!.json['error']).toMatch(/Diagnostics/);
    expect(main![0]!.pairedItem).toEqual({ item: 0 });
  });
});

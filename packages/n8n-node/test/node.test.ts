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

  it('renderMany: each output item carries the seed that rebuilds it (#60)', async () => {
    const template = '{a|b|c} {d|e}';
    const [main] = await run(
      { operation: 'renderMany', template, count: 6, baseSeed: 'demo', useIncomingItem: false },
      [{}],
    );
    for (const item of main!) {
      const [one] = await run(
        {
          operation: 'render',
          template,
          seed: item.json['attemptSeed'] as string,
          useIncomingItem: false,
        },
        [{}],
      );
      expect(one![0]!.json['rendered']).toBe(item.json['rendered']);
    }
  });

  it('lint: routes rendered text to Clean/Defective and attaches structured findings', async () => {
    const [clean, defective] = await run(
      { operation: 'lint', text: 'футбол, хоккей, теннис, теннис', locale: 'ru' },
      [{ id: 7 }],
    );
    expect(clean).toHaveLength(0);
    expect(defective).toHaveLength(1);
    const item = defective![0]!.json;
    expect(item['lintClean']).toBe(false);
    expect(item['findingCount']).toBe(1);
    expect((item['findings'] as IDataObject[])[0]!['code']).toBe('repeat.word');
    // The source row rides along — Lint annotates an item, it does not replace it.
    expect(item['id']).toBe(7);
    expect(defective![0]!.pairedItem).toEqual({ item: 0 });

    const [ok] = await run(
      { operation: 'lint', text: 'футбол, хоккей и киберспорт', locale: 'ru' },
      [{}],
    );
    expect(ok![0]!.json['lintClean']).toBe(true);
  });

  it('lint: a template sample is Clean only when every drawn document was', async () => {
    const params = {
      operation: 'lint',
      lintSource: 'template',
      template: '{разборы|прогнозы} по {дисциплинам|видам}, всё по дисциплинам',
      sampleSize: 12,
      baseSeed: 's',
      locale: 'ru',
      useIncomingItem: false,
    };
    const [clean, defective] = await run(params, [{}]);
    expect(clean).toHaveLength(0);
    const report = defective![0]!.json;
    expect(report['checked']).toBe(12);
    expect(report['cleanCount']).toBeLessThan(12);
    expect((report['issues'] as IDataObject[])[0]!['code']).toBe('repeat.word');

    const [allClean] = await run(
      { ...params, template: '{Привет|Здравствуйте}, {друзья|коллеги}!' },
      [{}],
    );
    expect(allClean![0]!.json['cleanCount']).toBe(12);
    expect(allClean![0]!.json['cleanRatio']).toBe(1);
  });

  it('lint: an operational failure never rides the Clean branch', async () => {
    const [clean, defective] = await run(
      // A non-string `text` makes the operation throw inside the item loop.
      { operation: 'lint', text: 42 },
      [{}],
      { continueOnFail: true },
    );
    expect(clean).toHaveLength(0);
    expect(defective![0]!.json['lintClean']).toBe(false);
    expect(defective![0]!.json['error']).toBeTypeOf('string');
  });

  it('uniqueness: measures the whole input as ONE pool and routes Kept/Dropped', async () => {
    const skeleton = 'ставки на спорт принимаются круглосуточно на любой матч сезона';
    const items = [
      { id: 0, rendered: `Первый ${skeleton}` },
      { id: 1, rendered: 'совсем другая статья про рыбалку в северных реках летом' },
      { id: 2, rendered: `Первый ${skeleton}` },
      { id: 3, rendered: 'третий текст о погоде в горах и снегопадах зимой' },
      { id: 4, rendered: 'четвёртая заметка про городской транспорт и его расписание' },
    ];
    // Footprint Limit 1 isolates the dedupe behaviour from the pool-level verdict,
    // which the next test covers on its own.
    const [kept, dropped] = await run(
      { operation: 'uniqueness', locale: 'ru', uniquenessOptions: { footprintMax: 1 } },
      items,
    );

    // The duplicate is the LATER document; the first occurrence always survives.
    expect(dropped).toHaveLength(1);
    expect(dropped![0]!.json['id']).toBe(2);
    const verdict = dropped![0]!.json['uniqueness'] as IDataObject;
    expect(verdict['kept']).toBe(false);
    expect(verdict['nearDupOf']).toBe(0);
    expect(verdict['nearDupJaccard']).toBe(1);
    expect(dropped![0]!.pairedItem).toEqual({ item: 2 });

    expect(kept!.map((i) => i.json['id'])).toEqual([0, 1, 3, 4]);
    // The pool-level verdict rides every item, so either branch can read it.
    const keptVerdict = kept![0]!.json['uniqueness'] as IDataObject;
    expect(keptVerdict['poolSize']).toBe(5);
    expect(keptVerdict['ok']).toBe(false);
    expect(typeof keptVerdict['footprint']).toBe('number');
  });

  it('uniqueness: a pool below the minimum reports the footprint as not measured', async () => {
    const [kept] = await run({ operation: 'uniqueness' }, [
      { rendered: 'one distinct document about trains' },
      { rendered: 'another one about the weather in spring' },
    ]);
    const verdict = kept![0]!.json['uniqueness'] as IDataObject;
    expect(verdict['footprint']).toBeNull();
    expect(verdict['footprintReason']).toMatch(/below minPool/);
    // Nothing measured, nothing duplicated — the pool passes rather than failing blind.
    expect(verdict['ok']).toBe(true);
  });

  it('uniqueness: a missing text field is a named error, not a pool of empty strings', async () => {
    await expect(
      run({ operation: 'uniqueness', textField: 'body' }, [{ rendered: 'x' }, { rendered: 'y' }]),
    ).rejects.toThrow(/"body"/);
  });

  it('protectPlaceholders: restoring without the map is refused, not reported clean', async () => {
    await expect(
      run(
        { operation: 'protectPlaceholders', protectMode: 'restore', text: 'Hello TAG', placeholderMap: {} },
        [{}],
      ),
    ).rejects.toThrow(/Placeholder Map is empty/);
  });

  it('protectPlaceholders: a map whose keys are not markers is rejected as not ours', async () => {
    await expect(
      run(
        {
          operation: 'protectPlaceholders',
          protectMode: 'restore',
          text: 'abc',
          placeholderMap: { '': 'X' },
        },
        [{}],
      ),
    ).rejects.toThrow(/is not a marker/);
  });

  it('uniqueness: a non-string field is not a document either', async () => {
    const items = [
      { id: 0, rendered: 'первый текст о поездах и расписании' },
      { id: 1, rendered: { nested: 'object' } },
      { id: 2, rendered: 'вторая заметка про погоду весной в горах' },
      { id: 3, rendered: 'третий материал о городском транспорте и билетах' },
      { id: 4, rendered: 'четвёртый разбор про велосипеды и дорожки' },
      { id: 5, rendered: 'пятая история о лодках и реках летом' },
    ];
    const [kept, dropped] = await run({ operation: 'uniqueness', locale: 'ru' }, items);
    // "[object Object]" is not a document: it never joins the pool.
    expect(dropped!.map((i) => i.json['id'])).toEqual([1]);
    expect((kept![0]!.json['uniqueness'] as IDataObject)['poolSize']).toBe(5);
  });

  it('uniqueness: a shared string containing commas survives as ONE exact string', async () => {
    // Comma-splitting would turn `#file_links[D:\path,1,S]#` into three entries and
    // then strip every standalone "1" from every document.
    const macro = String.raw`#file_links[D:\path,1,S]#`;
    const items = Array.from({ length: 6 }, (_, i) => ({
      id: i,
      rendered: `${['поезда', 'погода', 'транспорт', 'велосипеды', 'лодки', 'горы'][i]} — заметка номер 1 и ${macro}`,
    }));
    const [kept] = await run(
      {
        operation: 'uniqueness',
        locale: 'ru',
        uniquenessOptions: { macros: macro, footprintMax: 1 },
      },
      items,
    );
    expect(kept).toHaveLength(6);
  });

  it('uniqueness: a pool that fails the footprint keeps nothing — Kept means publishable', async () => {
    // Zero duplicates at the threshold, one skeleton underneath: dropping only
    // near-dups would send every item to Kept and the workflow would publish a pool
    // that failed its own gate.
    const skeleton =
      'ставки на спорт принимаются круглосуточно на любой матч регулярного сезона без заявок';
    const items = Array.from({ length: 6 }, (_, i) => ({ id: i, rendered: `Вариант${i} ${skeleton}` }));
    const [kept, dropped] = await run(
      { operation: 'uniqueness', locale: 'ru', dedupJaccard: 0.99 },
      items,
    );
    const verdict = dropped![0]!.json['uniqueness'] as IDataObject;
    expect(verdict['ok']).toBe(false);
    expect(verdict['nearDupPairs']).toBe(0);
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(6);
  });

  it('uniqueness: an item with no document is dropped WITHOUT joining the measurement', async () => {
    const items = [
      { id: 0, rendered: 'первый текст о поездах и расписании' },
      { id: 1, rendered: 'вторая заметка про погоду весной в горах' },
      { id: 2 },
      { id: 3, rendered: 'третий материал о городском транспорте и билетах' },
      { id: 4, rendered: 'четвёртый разбор про велосипеды и дорожки' },
      { id: 5, rendered: 'пятая история о лодках и реках летом' },
    ];
    const [kept, dropped] = await run({ operation: 'uniqueness', locale: 'ru' }, items);

    expect(dropped!.map((i) => i.json['id'])).toEqual([2]);
    const bad = dropped![0]!.json['uniqueness'] as IDataObject;
    expect(bad['measured']).toBe(false);
    expect(bad['kept']).toBe(false);
    expect(dropped![0]!.pairedItem).toEqual({ item: 2 });
    // Five documents were measured, not six — the empty item never shifted the cutoff.
    expect((kept![0]!.json['uniqueness'] as IDataObject)['poolSize']).toBe(5);
    expect(((kept![0]!.json['uniqueness'] as IDataObject)['problems'] as string[]).join(' ')).toMatch(
      /without being measured/,
    );
  });

  it('uniqueness: continueOnFail routes the whole pool to Dropped instead of aborting', async () => {
    const [kept, dropped] = await run(
      { operation: 'uniqueness', textField: 'body' },
      [{ rendered: 'x' }, { rendered: 'y' }],
      { continueOnFail: true },
    );
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(2);
    expect(dropped![0]!.json['error']).toMatch(/"body"/);
    expect(dropped![1]!.pairedItem).toEqual({ item: 1 });
  });

  it('uniqueness: a blank locale falls back to spintaxMeta, as the Locale field promises', async () => {
    // Turkish folds I → ı; a locale-blind lowercase gives "i" and the two documents
    // stop matching. The pool must see them as the duplicate they are.
    const items = [
      { id: 0, rendered: 'IŞIK lambaları bahçe için uygun fiyatlı ve dayanıklı' },
      { id: 1, rendered: 'ışık lambaları bahçe için uygun fiyatlı ve dayanıklı' },
      { id: 2, rendered: 'tamamen farklı bir metin havalar hakkında kısa not' },
    ];
    const [, dropped] = await run(
      { operation: 'uniqueness', locale: '', spintaxMeta: { locale: 'tr' } },
      items,
    );
    expect(dropped!.map((i) => i.json['id'])).toEqual([1]);
  });

  it('protectPlaceholders: protect → render → restore round-trips a bracketed macro', async () => {
    const macro = String.raw`#file_links[D:\path,1,S]#`;
    const [protectedItems] = await run(
      {
        operation: 'protectPlaceholders',
        template: `Read more: ${macro} — {enjoy|have fun}!`,
        placeholders: { placeholder: [{ value: macro, marker: '' }] },
      },
      [{}],
    );
    const carried = protectedItems![0]!.json;
    expect(carried['protectOk']).toBe(true);

    const [rendered] = await run(
      {
        operation: 'render',
        template: carried['protectedTemplate'] as string,
        seed: '7',
        useIncomingItem: false,
      },
      [{}],
    );
    const [restored] = await run(
      {
        operation: 'protectPlaceholders',
        protectMode: 'restore',
        text: rendered![0]!.json['rendered'] as string,
        placeholderMap: carried['placeholderMap'],
      },
      [{}],
    );
    expect(restored![0]!.json['restored']).toContain(macro);
    expect(restored![0]!.json['restoreOk']).toBe(true);
  });

  it('protectPlaceholders: refuses loudly, and the incoming item fields count as variables', async () => {
    // A lead field named `name` becomes %name% at render time, so a foreign %Name%
    // would be eaten by our engine before the recipient ever sees it.
    const params = {
      operation: 'protectPlaceholders',
      template: 'Hello %name%',
      placeholders: { placeholder: [{ value: '%Name%', marker: '' }] },
    };
    await expect(run(params, [{ name: 'Ada' }])).rejects.toThrow(/foreign placeholder/);

    // Turning the switch off collects the problem instead of stopping the item.
    const [collected] = await run({ ...params, failOnProblems: false }, [{ name: 'Ada' }]);
    expect(collected![0]!.json['protectOk']).toBe(false);
    expect((collected![0]!.json['problems'] as string[]).join(' ')).toMatch(/Rename the variable/);
  });

  it('validate: routes items to Valid/Invalid and carries everything repair needs', async () => {
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

  it('validate: spintaxMeta from the item supplies locale/knownVariables and passes through', async () => {
    const meta = { locale: 'ru', allowedVariables: [{ name: 'name' }] };
    const [valid] = await run(
      { operation: 'validate', template: '%name%', spintaxMeta: meta },
      [{}],
    );
    expect(valid![0]!.json['warningCount']).toBe(0);
    expect(valid![0]!.json['locale']).toBe('ru');
    // The metadata rides the OUTPUT item too — the LLM node upstream dropped
    // it, and downstream Render/Repair defaults read `$json.spintaxMeta`.
    expect(valid![0]!.json['spintaxMeta']).toEqual(meta);
  });

  it('render: blank locale falls back to the spintaxMeta locale (one locale through the funnel)', async () => {
    const params = {
      operation: 'render',
      template: '{plural %n%: форма|формы|форм}',
      postProcess: false,
      fixedVariables: { pair: [{ name: 'n', value: '2' }] },
      locale: '',
      spintaxMeta: { locale: 'ru', allowedVariables: [] },
    };
    const [main] = await run(params, [{}]);
    // Under ru (3-form) n=2 hits the "few" bucket; under the old hard 'en'
    // default the 3-form template was an arity mismatch and rendered with
    // fullwidth-brace leniency instead.
    expect(main![0]!.json['rendered']).toBe('формы');

    const [explicitWins] = await run({ ...params, locale: 'en' }, [{}]);
    expect(explicitWins![0]!.json['rendered']).not.toBe('формы');
  });

  it('renderMany: the Max Attempts parameter reaches the operation', async () => {
    const template = '{a|b|c|d|e|f}';
    const [main] = await run(
      { operation: 'renderMany', template, count: 3, baseSeed: 'q', maxAttempts: 3 },
      [{}],
    );
    // Budget 3 ⇒ exactly the distinct strings among seeds q:0..q:2, no more.
    const expected = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const [one] = await run(
        { operation: 'render', template, seed: `q:${i}`, useIncomingItem: false },
        [{}],
      );
      expected.add(one![0]!.json['rendered'] as string);
    }
    expect(main!.map((v) => v.json['rendered']).sort()).toEqual([...expected].sort());
    expect(main![0]!.json['produced']).toBe(expected.size);
  });

  it('render: when cleaning is requested, audit fields are emitted even for already-clean input', async () => {
    const [main] = await run(
      { operation: 'render', template: '{a|a}', cleanModelOutput: true, seed: '1' },
      [{}],
    );
    expect(main![0]!.json['cleanedTemplate']).toBe('{a|a}');
    expect(main![0]!.json['rawTemplate']).toBe('{a|a}');
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

  it('validate + continueOnFail: an operational error lands on the INVALID branch, never Valid', async () => {
    const [valid, invalid] = await run(
      {
        operation: 'validate',
        template: 'fine',
        // Malformed metadata: allowedVariables is not an array → throws inside the op.
        spintaxMeta: { allowedVariables: 'not-an-array' },
      },
      [{ source: 'kept' }],
      { continueOnFail: true },
    );
    expect(valid).toHaveLength(0);
    expect(invalid).toHaveLength(1);
    expect(invalid![0]!.json['valid']).toBe(false);
    expect(invalid![0]!.json['error']).toBeTruthy();
    expect(invalid![0]!.json['source']).toBe('kept');
    expect(invalid![0]!.pairedItem).toEqual({ item: 0 });
  });
});

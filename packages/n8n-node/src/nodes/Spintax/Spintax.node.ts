import {
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
} from 'n8n-workflow';

import type { Diagnostic } from '@spintax/core';
import type { Channel, VariableSpec, VariationLevel } from '@spintax/authoring-prompt';

import { buildContext, type FixedPair } from '../../ops/context';
import { cleanTemplate, type CleanedInput } from '../../ops/clean';
import { renderOp } from '../../ops/render';
import { renderManyOp } from '../../ops/render-many';
import { validateOp } from '../../ops/validate';
import { buildAuthoringOp, buildRepairOp } from '../../ops/prompts';
import type { SpintaxMeta } from '../../ops/types';

export class Spintax implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Spintax',
    name: 'spintax',
    icon: 'file:spintax.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{ $parameter["operation"] }}',
    description:
      'Render spintax templates, validate them, generate N variants, and build LLM authoring/repair prompts',
    defaults: {
      name: 'Spintax',
    },
    inputs: ['main'],
    // Validate routes each item to Valid/Invalid; every other operation has one output.
    outputs: `={{ $parameter["operation"] === "validate" ? [{"type":"main","displayName":"Valid"},{"type":"main","displayName":"Invalid"}] : [{"type":"main"}] }}`,
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        default: 'render',
        options: [
          {
            name: 'Build Authoring Prompt',
            value: 'buildAuthoringPrompt',
            description:
              'Build the canonical LLM prompt that writes a spintax template from a brief (wire your own LLM node)',
            action: 'Build an authoring prompt',
          },
          {
            name: 'Build Repair Prompt',
            value: 'buildRepairPrompt',
            description: 'Build a fix-it prompt from a template and its validation diagnostics',
            action: 'Build a repair prompt',
          },
          {
            name: 'Render',
            value: 'render',
            description: 'Render one document from a spintax template',
            action: 'Render a spintax template',
          },
          {
            name: 'Render Many',
            value: 'renderMany',
            description:
              'Render N distinct variants (independent draws — a low-cardinality template may produce fewer than asked)',
            action: 'Render many variants',
          },
          {
            name: 'Validate',
            value: 'validate',
            description: 'Validate a template; items route to the Valid or Invalid output',
            action: 'Validate a spintax template',
          },
        ],
      },

      // ── Template ──────────────────────────────────────────────────────────
      {
        displayName: 'Template',
        name: 'template',
        type: 'string',
        typeOptions: { rows: 4 },
        default: '',
        required: true,
        description: 'The spintax template to process',
        displayOptions: { show: { operation: ['render', 'renderMany'] } },
      },
      {
        displayName: 'Template',
        name: 'template',
        type: 'string',
        typeOptions: { rows: 4 },
        default: '={{ $json.text ?? $json.template }}',
        description: 'The template to validate — typically the LLM node output',
        displayOptions: { show: { operation: ['validate'] } },
      },
      {
        displayName: 'Template',
        name: 'template',
        type: 'string',
        typeOptions: { rows: 4 },
        default: '={{ $json.cleanedTemplate ?? $json.template }}',
        description: 'The invalid template — defaults to what Validate attached to the item',
        displayOptions: { show: { operation: ['buildRepairPrompt'] } },
      },
      {
        displayName: 'Clean Model Output',
        name: 'cleanModelOutput',
        type: 'boolean',
        default: false,
        description:
          'Whether to strip code fences, wrapping quotes and "Template:" prefixes from the template before processing (LLMs emit them no matter what the prompt says). The cleaned value is written to cleanedTemplate and used by later operations.',
        displayOptions: { show: { operation: ['render', 'renderMany', 'validate'] } },
      },

      // ── Context (Render / Render Many) ────────────────────────────────────
      {
        displayName: 'Use Incoming Item Fields as Variables',
        name: 'useIncomingItem',
        type: 'boolean',
        default: true,
        description:
          'Whether the incoming item\'s top-level string/number/boolean fields become %variables% (arrays and objects are skipped)',
        displayOptions: { show: { operation: ['render', 'renderMany'] } },
      },
      {
        displayName: 'Neutralize Incoming Values',
        name: 'neutralizeIncoming',
        type: 'boolean',
        default: true,
        description:
          'Whether incoming values are shielded so data containing { | } is treated as text, not spintax markup. Keep enabled for scraped or user-supplied data.',
        displayOptions: { show: { operation: ['render', 'renderMany'], useIncomingItem: [true] } },
      },
      {
        displayName: 'Fixed Variables',
        name: 'fixedVariables',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        description:
          'Extra variables defined here; they win over incoming item fields on name collision',
        placeholder: 'Add Variable',
        options: [
          {
            name: 'pair',
            displayName: 'Variable',
            values: [
              {
                displayName: 'Name',
                name: 'name',
                type: 'string',
                default: '',
              },
              {
                displayName: 'Value',
                name: 'value',
                type: 'string',
                default: '',
                description: 'May intentionally contain spintax markup, e.g. {Mr|Ms}',
              },
              {
                displayName: 'Neutralize',
                name: 'neutralize',
                type: 'boolean',
                default: false,
                description: 'Whether to shield this value too (turn on for pasted external data)',
              },
            ],
          },
        ],
        displayOptions: { show: { operation: ['render', 'renderMany'] } },
      },

      // ── Render options ────────────────────────────────────────────────────
      {
        displayName: 'Seed',
        name: 'seed',
        type: 'string',
        default: '',
        description:
          'Optional seed for a reproducible render (same seed + template + context = same output). Leave empty for a random draw.',
        displayOptions: { show: { operation: ['render'] } },
      },
      {
        displayName: 'Output Field',
        name: 'outputField',
        type: 'string',
        default: 'rendered',
        description: 'Item field to write the rendered text to',
        displayOptions: { show: { operation: ['render'] } },
      },

      // ── Render Many options ───────────────────────────────────────────────
      {
        displayName: 'Count',
        name: 'count',
        type: 'number',
        typeOptions: { minValue: 1, maxValue: 100 },
        default: 5,
        description:
          'Distinct variants wanted. Distinct seeds are independent draws, not distinct results — the node returns what exists (see the produced field) instead of retrying forever.',
        displayOptions: { show: { operation: ['renderMany'] } },
      },
      {
        displayName: 'Base Seed',
        name: 'baseSeed',
        type: 'string',
        default: '',
        description:
          'Optional. Attempt i renders with seed "baseSeed:i", making the whole batch reproducible. Leave empty for independent random draws.',
        displayOptions: { show: { operation: ['renderMany'] } },
      },
      {
        displayName: 'Max Attempts',
        name: 'maxAttempts',
        type: 'number',
        typeOptions: { minValue: 0, maxValue: 500 },
        default: 0,
        description:
          'Attempt budget for collecting distinct variants. 0 = automatic (5 × Count, capped at 500). Raise it when a high-variety template underproduces.',
        displayOptions: { show: { operation: ['renderMany'] } },
      },

      // ── Shared render/validate options ────────────────────────────────────
      {
        displayName: 'Locale',
        name: 'locale',
        type: 'string',
        default: 'en',
        description: 'BCP-47 language tag the template is authored for; drives plural rules',
        displayOptions: { show: { operation: ['buildAuthoringPrompt'] } },
      },
      {
        displayName: 'Locale',
        name: 'locale',
        type: 'string',
        default: '',
        description:
          'BCP-47 language tag; drives plural rules and verdicts. Leave empty to use the locale from spintaxMeta (or "en") — one locale through the whole funnel.',
        displayOptions: { show: { operation: ['render', 'renderMany', 'validate'] } },
      },
      {
        displayName: 'Post-Process',
        name: 'postProcess',
        type: 'boolean',
        default: true,
        description:
          'Whether to run the cosmetic pipeline (spacing, capitalization, shielding) — the engine default',
        displayOptions: { show: { operation: ['render', 'renderMany'] } },
      },

      // ── Validate options ──────────────────────────────────────────────────
      {
        displayName: 'Spintax Meta',
        name: 'spintaxMeta',
        type: 'json',
        default: '={{ $json.spintaxMeta }}',
        description:
          'Metadata stamped by Build Authoring Prompt (locale, allowed variables, prompt version). Supplies the default locale and known variables; Validate passes it through on its output items.',
        displayOptions: {
          show: { operation: ['render', 'renderMany', 'validate', 'buildRepairPrompt'] },
        },
      },
      {
        displayName: 'Known Variables',
        name: 'knownVariables',
        type: 'string',
        default: '',
        description:
          'Comma-separated variable names the runtime will supply; overrides the spintaxMeta list. Unresolved %variables% outside this list surface as warnings.',
        displayOptions: { show: { operation: ['validate'] } },
      },
      {
        displayName: 'Known Includes',
        name: 'knownIncludes',
        type: 'string',
        default: '',
        description:
          'Comma-separated #include names that exist. When set, unknown includes are reported.',
        displayOptions: { show: { operation: ['validate'] } },
      },

      // ── Build Authoring Prompt options ────────────────────────────────────
      {
        displayName: 'Brief',
        name: 'brief',
        type: 'string',
        typeOptions: { rows: 4 },
        default: '',
        required: true,
        description: 'What the template should say — source text or a content brief',
        displayOptions: { show: { operation: ['buildAuthoringPrompt'] } },
      },
      {
        displayName: 'Use Incoming Item Field Names as Variables',
        name: 'useItemFieldNames',
        type: 'boolean',
        default: true,
        description:
          'Whether the incoming item\'s top-level scalar field names join the allowed-variable list (e.g. first_name, company)',
        displayOptions: { show: { operation: ['buildAuthoringPrompt'] } },
      },
      {
        displayName: 'Allowed Variables',
        name: 'allowedVariables',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        description:
          'Variables the model may use, with an optional grammatical case of the VALUE (matters in inflected languages)',
        placeholder: 'Add Variable',
        options: [
          {
            name: 'variable',
            displayName: 'Variable',
            values: [
              {
                displayName: 'Name',
                name: 'name',
                type: 'string',
                default: '',
              },
              {
                displayName: 'Case',
                name: 'case',
                type: 'options',
                default: '',
                options: [
                  { name: 'Accusative', value: 'accusative' },
                  { name: 'Dative', value: 'dative' },
                  { name: 'Genitive', value: 'genitive' },
                  { name: 'Instrumental', value: 'instrumental' },
                  { name: 'Nominative', value: 'nominative' },
                  { name: 'Prepositional', value: 'prepositional' },
                  { name: 'Unspecified', value: '' },
                ],
              },
              {
                displayName: 'Note',
                name: 'note',
                type: 'string',
                default: '',
                description: 'Free-form hint for the model, e.g. "already includes the currency sign"',
              },
            ],
          },
        ],
        displayOptions: { show: { operation: ['buildAuthoringPrompt'] } },
      },
      {
        displayName: 'Channel',
        name: 'channel',
        type: 'options',
        default: 'generic',
        options: [
          { name: 'Email', value: 'email' },
          { name: 'Generic', value: 'generic' },
          { name: 'Landing Page', value: 'landing' },
          { name: 'Push', value: 'push' },
          { name: 'SMS', value: 'sms' },
        ],
        displayOptions: { show: { operation: ['buildAuthoringPrompt'] } },
      },
      {
        displayName: 'Variation Level',
        name: 'variationLevel',
        type: 'options',
        default: 'balanced',
        options: [
          { name: 'Conservative', value: 'conservative' },
          { name: 'Balanced', value: 'balanced' },
          { name: 'Aggressive', value: 'aggressive' },
        ],
        displayOptions: { show: { operation: ['buildAuthoringPrompt'] } },
      },

      // ── Build Repair Prompt options ───────────────────────────────────────
      {
        displayName: 'Diagnostics',
        name: 'diagnostics',
        type: 'json',
        default: '={{ $json.diagnostics }}',
        description: 'The Diagnostic[] array from Validate — defaults to what the Invalid output carries',
        displayOptions: { show: { operation: ['buildRepairPrompt'] } },
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const operation = this.getNodeParameter('operation', 0) as string;

    const main: INodeExecutionData[] = [];
    const invalid: INodeExecutionData[] = [];

    for (let i = 0; i < items.length; i++) {
      try {
        switch (operation) {
          case 'render': {
            const cleaned = readTemplate(this, i);
            const context = readContext(this, i, items[i]!.json);
            const seed = this.getNodeParameter('seed', i, '') as string;
            const outputField = (this.getNodeParameter('outputField', i, 'rendered') as string) || 'rendered';
            const rendered = renderOp(cleaned.cleanedTemplate, {
              context,
              ...(seed !== '' ? { seed } : {}),
              locale: resolveLocale(this, i),
              postProcess: this.getNodeParameter('postProcess', i, true) as boolean,
            });
            main.push(out(i, { ...items[i]!.json, ...cleanFields(cleaned), [outputField]: rendered }));
            break;
          }

          case 'renderMany': {
            const cleaned = readTemplate(this, i);
            const context = readContext(this, i, items[i]!.json);
            const baseSeed = this.getNodeParameter('baseSeed', i, '') as string;
            const maxAttempts = this.getNodeParameter('maxAttempts', i, 0) as number;
            const result = renderManyOp(cleaned.cleanedTemplate, {
              context,
              ...(baseSeed !== '' ? { baseSeed } : {}),
              ...(maxAttempts > 0 ? { maxAttempts } : {}),
              count: this.getNodeParameter('count', i, 5) as number,
              locale: resolveLocale(this, i),
              postProcess: this.getNodeParameter('postProcess', i, true) as boolean,
            });
            for (const variant of result.variants) {
              main.push(
                out(i, {
                  rendered: variant.rendered,
                  variantIndex: variant.variantIndex,
                  requested: result.requested,
                  produced: result.produced,
                }),
              );
            }
            break;
          }

          case 'validate': {
            const cleaned = readTemplate(this, i);
            const meta = readMeta(this, i);
            const localeParam = this.getNodeParameter('locale', i, '') as string;
            const result = validateOp(cleaned.cleanedTemplate, {
              ...(localeParam !== '' ? { locale: localeParam } : {}),
              ...(meta !== undefined ? { meta } : {}),
              ...csvParam(this, i, 'knownVariables'),
              ...csvParam(this, i, 'knownIncludes'),
            });
            const item = out(i, {
              ...items[i]!.json,
              ...cleanFields(cleaned),
              cleanedTemplate: cleaned.cleanedTemplate,
              valid: result.valid,
              diagnostics: result.diagnostics as unknown as IDataObject[],
              errorCount: result.errorCount,
              warningCount: result.warningCount,
              locale: result.locale,
              // Pass the funnel metadata through so downstream Render/Repair
              // defaults (`={{ $json.spintaxMeta }}`) keep working after the
              // LLM node dropped it.
              ...(meta !== undefined ? { spintaxMeta: meta as unknown as IDataObject } : {}),
            });
            (result.valid ? main : invalid).push(item);
            break;
          }

          case 'buildAuthoringPrompt': {
            const brief = this.getNodeParameter('brief', i) as string;
            const collected = (
              this.getNodeParameter('allowedVariables', i, {}) as {
                variable?: Array<{ name: string; case?: string; note?: string }>;
              }
            ).variable ?? [];
            const specs: VariableSpec[] = collected
              .filter((v) => v.name !== '')
              .map((v) => ({
                name: v.name,
                ...(v.case ? { case: v.case as NonNullable<VariableSpec['case']> } : {}),
                ...(v.note ? { note: v.note } : {}),
              }));
            if (this.getNodeParameter('useItemFieldNames', i, true) as boolean) {
              const listed = new Set(specs.map((s) => s.name));
              for (const [name, value] of Object.entries(items[i]!.json)) {
                const scalar =
                  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
                if (scalar && !listed.has(name)) specs.push({ name });
              }
            }
            const result = buildAuthoringOp({
              brief,
              locale: this.getNodeParameter('locale', i, 'en') as string,
              allowedVariables: specs,
              channel: this.getNodeParameter('channel', i, 'generic') as Channel,
              variationLevel: this.getNodeParameter('variationLevel', i, 'balanced') as VariationLevel,
            });
            main.push(out(i, { ...items[i]!.json, ...(result as unknown as IDataObject) }));
            break;
          }

          case 'buildRepairPrompt': {
            const template = this.getNodeParameter('template', i) as string;
            const diagnostics = readDiagnostics(this, i);
            const meta = readMeta(this, i);
            const result = buildRepairOp(template, diagnostics, meta);
            main.push(out(i, { ...items[i]!.json, ...(result as unknown as IDataObject) }));
            break;
          }

          default:
            throw new NodeOperationError(this.getNode(), `Unknown operation "${operation}"`, {
              itemIndex: i,
            });
        }
      } catch (error) {
        if (this.continueOnFail()) {
          const failure = {
            ...items[i]!.json,
            error: error instanceof Error ? error.message : String(error),
          };
          // An operational failure is NOT a valid template — for Validate it
          // must never ride the Valid branch.
          if (operation === 'validate') invalid.push(out(i, { ...failure, valid: false }));
          else main.push(out(i, failure));
          continue;
        }
        if (error instanceof NodeOperationError) throw error;
        throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
      }
    }

    return operation === 'validate' ? [main, invalid] : [main];
  }
}

// ── execute() helpers ─────────────────────────────────────────────────────────

function out(item: number, json: IDataObject): INodeExecutionData {
  return { json, pairedItem: { item } };
}

interface ReadTemplate extends CleanedInput {
  /** Cleaning was switched on — audit fields are emitted even if nothing changed. */
  requested: boolean;
}

function readTemplate(ctx: IExecuteFunctions, i: number): ReadTemplate {
  const raw = ctx.getNodeParameter('template', i) as string;
  const requested = ctx.getNodeParameter('cleanModelOutput', i, false) as boolean;
  return requested
    ? { ...cleanTemplate(raw), requested }
    : { cleanedTemplate: raw, rawTemplate: raw, changed: false, requested };
}

/** When cleaning was requested, both audit fields ride along — even when the
 * input was already clean, so downstream `cleanedTemplate` defaults always
 * resolve (the UI promises exactly this). */
function cleanFields(cleaned: ReadTemplate): IDataObject {
  return cleaned.requested
    ? { cleanedTemplate: cleaned.cleanedTemplate, rawTemplate: cleaned.rawTemplate }
    : {};
}

/** Blank locale ⇒ the spintaxMeta locale ⇒ 'en' — one locale through the funnel. */
function resolveLocale(ctx: IExecuteFunctions, i: number): string {
  const explicit = ctx.getNodeParameter('locale', i, '') as string;
  if (explicit !== '') return explicit;
  const meta = readMeta(ctx, i);
  return typeof meta?.locale === 'string' && meta.locale !== '' ? meta.locale : 'en';
}

function readContext(ctx: IExecuteFunctions, i: number, itemJson: IDataObject): Record<string, string> {
  const pairs = (
    ctx.getNodeParameter('fixedVariables', i, {}) as { pair?: FixedPair[] }
  ).pair?.filter((p) => p.name !== '');
  return buildContext({
    itemJson,
    ignoreIncoming: !(ctx.getNodeParameter('useIncomingItem', i, true) as boolean),
    neutralizeIncoming: ctx.getNodeParameter('neutralizeIncoming', i, true) as boolean,
    ...(pairs !== undefined ? { fixedPairs: pairs } : {}),
  });
}

function readMeta(ctx: IExecuteFunctions, i: number): Partial<SpintaxMeta> | undefined {
  const value = ctx.getNodeParameter('spintaxMeta', i, undefined) as unknown;
  const parsed = typeof value === 'string' && value !== '' ? tryParse(value) : value;
  if (parsed === null || parsed === undefined || typeof parsed !== 'object') return undefined;
  return parsed as Partial<SpintaxMeta>;
}

function readDiagnostics(ctx: IExecuteFunctions, i: number): Diagnostic[] {
  const value = ctx.getNodeParameter('diagnostics', i, []) as unknown;
  const parsed = typeof value === 'string' ? tryParse(value) : value;
  if (!Array.isArray(parsed)) {
    throw new NodeOperationError(
      ctx.getNode(),
      'Diagnostics must be the array produced by the Validate operation',
      { itemIndex: i },
    );
  }
  return parsed as Diagnostic[];
}

function csvParam(
  ctx: IExecuteFunctions,
  i: number,
  name: 'knownVariables' | 'knownIncludes',
): Partial<Record<'knownVariables' | 'knownIncludes', string[]>> {
  const raw = ctx.getNodeParameter(name, i, '') as string;
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return list.length > 0 ? { [name]: list } : {};
}

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

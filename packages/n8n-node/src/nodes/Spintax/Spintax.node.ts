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
import { lintOp, lintSampleOp } from '../../ops/lint';
import { protectOp, restoreOp, TOKEN_GRAMMAR, type PlaceholderSpec } from '../../ops/protect';
import { renderOp } from '../../ops/render';
import { renderManyOp } from '../../ops/render-many';
import { uniquenessOp, type BodyFormat, type UniquenessOptions } from '../../ops/uniqueness';
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
      'Render spintax templates, validate and lint them, generate N variants, and build LLM authoring/repair prompts',
    defaults: {
      name: 'Spintax',
    },
    inputs: ['main'],
    // Validate routes to Valid/Invalid, Lint to Clean/Defective, Uniqueness to
    // Kept/Dropped — each exists so the corrective loop is one wire, not a Merge-node
    // exercise. Every other operation has a single output.
    outputs: `={{ $parameter["operation"] === "validate" ? [{"type":"main","displayName":"Valid"},{"type":"main","displayName":"Invalid"}] : ($parameter["operation"] === "lint" ? [{"type":"main","displayName":"Clean"},{"type":"main","displayName":"Defective"}] : ($parameter["operation"] === "uniqueness" ? [{"type":"main","displayName":"Kept"},{"type":"main","displayName":"Dropped"}] : [{"type":"main"}])) }}`,
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
            name: 'Lint',
            value: 'lint',
            description:
              'Check RENDERED text for defects that live in the combination of choices, not in the template — items route to the Clean or Defective output',
            action: 'Lint rendered text',
          },
          {
            name: 'Protect Placeholders',
            value: 'protectPlaceholders',
            description:
              'Keep placeholders that belong to ANOTHER engine (merge tags, Liquid, CRM macros) out of the render, then put them back and verify',
            action: 'Protect foreign placeholders',
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
            name: 'Uniqueness',
            value: 'uniqueness',
            description:
              'Measure the whole pool of incoming items: near-duplicates and the shared-skeleton footprint; items route to Kept or Dropped',
            action: 'Measure pool uniqueness',
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
          'Optional. Attempt i renders with seed "baseSeed:i", making the whole batch reproducible. Each output item carries the seed that produced it in attemptSeed — after a collision that is no longer "baseSeed:variantIndex". Leave empty for independent random draws.',
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

      // ── Lint options ──────────────────────────────────────────────────────
      {
        displayName: 'Source',
        name: 'lintSource',
        type: 'options',
        default: 'text',
        description:
          'What to lint: text that is already rendered, or a template the node renders a sample from',
        options: [
          {
            name: 'Rendered Text',
            value: 'text',
            description: 'Lint one rendered document from the incoming item',
          },
          {
            name: 'Template Sample',
            value: 'template',
            description:
              'Render a sample from the template and report how many documents came out clean',
          },
        ],
        displayOptions: { show: { operation: ['lint'] } },
      },
      {
        displayName: 'Text',
        name: 'text',
        type: 'string',
        typeOptions: { rows: 4 },
        default: '={{ $json.rendered }}',
        description: 'The rendered document to check — by default what Render/Render Many produced',
        displayOptions: { show: { operation: ['lint'], lintSource: ['text'] } },
      },
      {
        displayName: 'Template',
        name: 'template',
        type: 'string',
        typeOptions: { rows: 4 },
        default: '',
        description: 'The template to sample — variables come from the incoming item',
        displayOptions: { show: { operation: ['lint'], lintSource: ['template'] } },
      },
      {
        displayName: 'Sample Size',
        name: 'sampleSize',
        type: 'number',
        typeOptions: { minValue: 1, maxValue: 500 },
        default: 50,
        description:
          'Documents to render and lint. A defect that appears in one render out of a hundred needs a sample that large to show up.',
        displayOptions: { show: { operation: ['lint'], lintSource: ['template'] } },
      },
      {
        displayName: 'Base Seed',
        name: 'baseSeed',
        type: 'string',
        default: '',
        description:
          'Optional. Sample render i uses seed "baseSeed:i", so the report is reproducible across runs. Leave empty for independent random draws.',
        displayOptions: { show: { operation: ['lint'], lintSource: ['template'] } },
      },
      {
        displayName: 'Ignored Strings',
        name: 'lintIgnore',
        type: 'string',
        typeOptions: { rows: 3 },
        default: '',
        description:
          'EXACT strings the render substituted — a product name, a brand, a merge tag — ONE PER LINE. They are blanked before the check, because a brand name appearing twice in a paragraph is data the author did not write and often cannot avoid; judging it is the wrong complaint.',
        displayOptions: { show: { operation: ['lint'] } },
      },
      {
        displayName: 'Repeat Window',
        name: 'lintWindow',
        type: 'number',
        typeOptions: { minValue: 2, maxValue: 20 },
        default: 6,
        description:
          'Width of the word window scanned for a repetition, so a window of 6 catches repeats up to 5 words apart. Six is the measured sweet spot: at nine, most hits were ordinary cohesion rather than defects.',
        displayOptions: { show: { operation: ['lint'] } },
      },

      // ── Protect Placeholders options ──────────────────────────────────────
      {
        displayName: 'Mode',
        name: 'protectMode',
        type: 'options',
        default: 'protect',
        description: 'Which half of the round trip this node performs',
        options: [
          {
            name: 'Protect (Before Render)',
            value: 'protect',
            description: 'Replace foreign placeholders with tokens the render cannot damage',
          },
          {
            name: 'Restore (After Render)',
            value: 'restore',
            description: 'Put the foreign placeholders back and verify the document',
          },
        ],
        displayOptions: { show: { operation: ['protectPlaceholders'] } },
      },
      {
        displayName: 'Template',
        name: 'template',
        type: 'string',
        typeOptions: { rows: 4 },
        default: '={{ $json.cleanedTemplate ?? $json.template }}',
        description: 'The template containing the foreign placeholders',
        displayOptions: { show: { operation: ['protectPlaceholders'], protectMode: ['protect'] } },
      },
      {
        displayName: 'Placeholders',
        name: 'placeholders',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        default: {},
        placeholder: 'Add Placeholder',
        description:
          'EXACT strings the recipient system must receive untouched, e.g. *|FNAME|* or a bracketed macro',
        displayOptions: { show: { operation: ['protectPlaceholders'], protectMode: ['protect'] } },
        options: [
          {
            name: 'placeholder',
            displayName: 'Placeholder',
            values: [
              {
                displayName: 'Value',
                name: 'value',
                type: 'string',
                default: '',
                description: 'The exact foreign string, copied verbatim',
              },
              {
                // Named "marker", not "token": n8n's community-node lint reads a
                // parameter called `token` as a credential and demands a password field.
                displayName: 'Marker',
                name: 'marker',
                type: 'string',
                default: '',
                description:
                  'Optional. The stand-in left in the template while it renders. Must match ^[A-Z0-9_]+$ — a lowercase marker gets capitalized at a sentence start and the restore then misses it silently. Leave empty for an auto-assigned one.',
              },
            ],
          },
        ],
      },
      {
        displayName: 'Text',
        name: 'text',
        type: 'string',
        typeOptions: { rows: 4 },
        default: '={{ $json.rendered }}',
        description: 'The rendered document whose tokens are put back',
        displayOptions: { show: { operation: ['protectPlaceholders'], protectMode: ['restore'] } },
      },
      {
        displayName: 'Placeholder Map',
        name: 'placeholderMap',
        type: 'json',
        default: '={{ $json.placeholderMap }}',
        description: 'The token → placeholder map from the Protect step, carried on the item',
        displayOptions: { show: { operation: ['protectPlaceholders'], protectMode: ['restore'] } },
      },
      {
        displayName: 'Allowed Placeholders',
        name: 'allowedPlaceholders',
        type: 'string',
        typeOptions: { rows: 3 },
        default: '',
        description:
          'Foreign strings that may legitimately appear in the output without being mapped, ONE PER LINE (they are exact strings and may contain commas). Everything else shaped like %name% is reported as a stray.',
        displayOptions: { show: { operation: ['protectPlaceholders'], protectMode: ['restore'] } },
      },
      {
        displayName: 'Fail on Problems',
        name: 'failOnProblems',
        type: 'boolean',
        default: true,
        description:
          'Whether a collision or a failed verification stops the item. Refusing loudly is the point — turn it off only to collect the problems and decide in the workflow.',
        displayOptions: { show: { operation: ['protectPlaceholders'] } },
      },

      // ── Uniqueness options ────────────────────────────────────────────────
      {
        displayName: 'Text Field',
        name: 'textField',
        type: 'string',
        default: 'rendered',
        required: true,
        description:
          'Item field holding the document. Every incoming item is one document of ONE pool — this operation reads them all together and emits the same items, routed.',
        displayOptions: { show: { operation: ['uniqueness'] } },
      },
      {
        displayName: 'Similarity Threshold',
        name: 'dedupJaccard',
        type: 'number',
        typeOptions: { minValue: 0.05, maxValue: 1, numberPrecision: 2 },
        default: 0.6,
        description:
          'Jaccard score over 5-word shingles at which two documents count as near-duplicates. Each document is judged against the ones already kept, so the first occurrence always survives and nothing is dropped for duplicating something that was itself dropped.',
        displayOptions: { show: { operation: ['uniqueness'] } },
      },
      {
        displayName: 'Options',
        name: 'uniquenessOptions',
        type: 'collection',
        default: {},
        placeholder: 'Add Option',
        displayOptions: { show: { operation: ['uniqueness'] } },
        options: [
          {
            displayName: 'Body Format',
            name: 'bodyFormat',
            type: 'options',
            default: 'plain',
            description:
              'Markup to strip before measuring, so tag attributes do not count as words',
            options: [
              { name: 'BBCode', value: 'bbcode' },
              { name: 'HTML', value: 'html' },
              { name: 'Plain Text', value: 'plain' },
            ],
          },
          {
            displayName: 'Footprint Limit',
            name: 'footprintMax',
            type: 'number',
            typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 3 },
            default: 0.15,
            description:
              'Footprint above which the pool shares one skeleton — and then NOTHING is kept, because publishing one of those documents is the failure this measures. Set it to 1 to make the footprint advisory and route on near-duplicates only. Measured reference points: one template 0.962, five templates 0.103, six 0.017.',
          },
          {
            displayName: 'Footprint Share',
            name: 'footprintShare',
            type: 'number',
            typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
            default: 0.2,
            description:
              'A shingle counts as shared when it appears in more than this fraction of the pool',
          },
          {
            displayName: 'Minimum Pool Size',
            name: 'minPoolForFootprint',
            type: 'number',
            typeOptions: { minValue: 2 },
            default: 5,
            description:
              'Below this many documents the footprint is reported as not measured. On a tiny pool the metric is 1 by construction, and "not measured" beats an impressive meaningless number.',
          },
          {
            displayName: 'Shared Strings',
            name: 'macros',
            type: 'string',
            typeOptions: { rows: 3 },
            default: '',
            description:
              'EXACT strings every document repeats and that are not the copy being judged — a merge tag, a macro, a fixed product name — ONE PER LINE (a macro may contain commas). Left in, they manufacture similarity that is not there: the metric ends up measuring your product name instead of your writing.',
          },
          {
            displayName: 'Shingle Width',
            name: 'shingleWidth',
            type: 'number',
            typeOptions: { minValue: 2, maxValue: 12 },
            default: 5,
            description: 'Words per shingle. Five is the width the reference numbers were measured at.',
          },
        ],
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
          'BCP-47 language tag; drives plural rules, verdicts and the locale-scoped lint rules. Leave empty to use the locale from spintaxMeta (or "en") — one locale through the whole funnel.',
        displayOptions: {
          show: { operation: ['render', 'renderMany', 'validate', 'lint', 'uniqueness'] },
        },
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
          show: {
            operation: [
              'render',
              'renderMany',
              'validate',
              'buildRepairPrompt',
              'lint',
              'uniqueness',
            ],
          },
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
    // The second output — Invalid for Validate, Defective for Lint, Dropped for
    // Uniqueness. For every other operation it stays empty and is never returned.
    const rejected: INodeExecutionData[] = [];

    // Uniqueness is the one POOL operation: the question "are these documents actually
    // different?" is not answerable one item at a time, so it consumes the whole input
    // before the per-item loop and reads its settings from row 0. It gets the same
    // continueOnFail contract as the loop — a failed pool must not abort a workflow
    // that asked to carry on, and a failure is never a pass, so every item leaves on
    // the Dropped branch with its own pairedItem intact.
    if (operation === 'uniqueness') {
      try {
        return runUniqueness(this, items, main, rejected);
      } catch (error) {
        if (!this.continueOnFail()) {
          if (error instanceof NodeOperationError) throw error;
          throw new NodeOperationError(this.getNode(), error as Error);
        }
        const message = error instanceof Error ? error.message : String(error);
        return [
          [],
          items.map((item, i) =>
            out(i, { ...item.json, error: message, uniqueness: { kept: false, measured: false } }),
          ),
        ];
      }
    }

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
                  // The seed this exact variant came from — after a collision
                  // it is no longer `variantIndex`, and without it a persisted
                  // pool cannot rebuild one document (#60).
                  ...(variant.attemptSeed !== undefined ? { attemptSeed: variant.attemptSeed } : {}),
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
            // resolveLocale, not the raw parameter: Render, Lint and Uniqueness all take
            // the locale through it, and Validate reading the same fields differently is
            // how a workflow validated under "no locale" and rendered under `en`. An item
            // carrying `spintaxMeta.locale: ''` used to route Valid with a
            // plural.locale-missing warning and then render the fullwidth fallback — the
            // exact failure #65 was reported for, inside one node.
            const result = validateOp(cleaned.cleanedTemplate, {
              locale: resolveLocale(this, i),
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
            (result.valid ? main : rejected).push(item);
            break;
          }

          case 'lint': {
            const window = this.getNodeParameter('lintWindow', i, 6) as number;
            const locale = resolveLocale(this, i);
            const ignore = splitLines(this.getNodeParameter('lintIgnore', i, '') as string);
            if ((this.getNodeParameter('lintSource', i, 'text') as string) === 'template') {
              const cleaned = readTemplate(this, i);
              const baseSeed = this.getNodeParameter('baseSeed', i, '') as string;
              const report = lintSampleOp(cleaned.cleanedTemplate, {
                context: readContext(this, i, items[i]!.json),
                count: this.getNodeParameter('sampleSize', i, 50) as number,
                ...(baseSeed !== '' ? { baseSeed } : {}),
                ...(ignore.length > 0 ? { ignore } : {}),
                locale,
                window,
              });
              const item = out(i, {
                ...items[i]!.json,
                ...cleanFields(cleaned),
                checked: report.checked,
                cleanCount: report.cleanCount,
                cleanRatio: report.cleanRatio,
                issues: report.issues as unknown as IDataObject[],
                locale: report.locale,
              });
              // A sample is "clean" only when every drawn document was — one defect in
              // fifty is exactly the case the operation exists to surface.
              (report.cleanCount === report.checked ? main : rejected).push(item);
            } else {
              const result = lintOp(this.getNodeParameter('text', i) as string, {
                locale,
                window,
                ...(ignore.length > 0 ? { ignore } : {}),
              });
              const item = out(i, {
                ...items[i]!.json,
                lintClean: result.clean,
                findings: result.findings as unknown as IDataObject[],
                findingCount: result.findings.length,
                locale: result.locale,
              });
              (result.clean ? main : rejected).push(item);
            }
            break;
          }

          case 'protectPlaceholders': {
            const failOnProblems = this.getNodeParameter('failOnProblems', i, true) as boolean;
            if ((this.getNodeParameter('protectMode', i, 'protect') as string) === 'protect') {
              const specs: PlaceholderSpec[] = (
                (
                  this.getNodeParameter('placeholders', i, {}) as {
                    placeholder?: Array<{ value: string; marker?: string }>;
                  }
                ).placeholder ?? []
              )
                .filter((p) => p.value !== '')
                .map((p) => ({
                  value: p.value,
                  ...(p.marker !== undefined && p.marker !== '' ? { token: p.marker } : {}),
                }));
              // The incoming item's scalar fields are exactly what Render turns into
              // %variables%, so both halves are checked for free: the NAMES against the
              // foreign placeholder names (a lead field `name` meeting a foreign
              // `%name%`), and the VALUES against the markers, because the rendered
              // document is template plus data and a marker matching a value would be
              // rewritten just the same.
              const scalars = Object.entries(items[i]!.json).filter(([, v]) =>
                ['string', 'number', 'boolean'].includes(typeof v),
              );
              const result = protectOp(this.getNodeParameter('template', i) as string, specs, {
                contextKeys: scalars.map(([name]) => name),
                contextValues: scalars.map(([, value]) => String(value)),
              });
              if (!result.ok && failOnProblems) {
                throw new NodeOperationError(this.getNode(), result.problems.join('; '), {
                  itemIndex: i,
                });
              }
              main.push(
                out(i, {
                  ...items[i]!.json,
                  protectedTemplate: result.protectedTemplate,
                  placeholderMap: result.map as unknown as IDataObject,
                  unused: result.unused,
                  problems: result.problems,
                  protectOk: result.ok,
                }),
              );
            } else {
              const map = readPlaceholderMap(this, i);
              const allowed = splitLines(
                this.getNodeParameter('allowedPlaceholders', i, '') as string,
              );
              const result = restoreOp(this.getNodeParameter('text', i) as string, map, {
                ...(allowed.length > 0 ? { allowed } : {}),
              });
              if (!result.ok && failOnProblems) {
                throw new NodeOperationError(this.getNode(), result.problems.join('; '), {
                  itemIndex: i,
                });
              }
              main.push(
                out(i, {
                  ...items[i]!.json,
                  restored: result.text,
                  replaced: result.replaced as unknown as IDataObject,
                  mangled: result.mangled,
                  problems: result.problems,
                  restoreOk: result.ok,
                }),
              );
            }
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
          // An operational failure is NOT a pass — for the routing operations it
          // must never ride the Valid / Clean branch.
          if (operation === 'validate') rejected.push(out(i, { ...failure, valid: false }));
          else if (operation === 'lint') rejected.push(out(i, { ...failure, lintClean: false }));
          else main.push(out(i, failure));
          continue;
        }
        if (error instanceof NodeOperationError) throw error;
        throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
      }
    }

    return operation === 'validate' || operation === 'lint' ? [main, rejected] : [main];
  }
}

// ── execute() helpers ─────────────────────────────────────────────────────────

function out(item: number, json: IDataObject): INodeExecutionData {
  return { json, pairedItem: { item } };
}

interface UniquenessUiOptions {
  bodyFormat?: BodyFormat;
  footprintMax?: number;
  footprintShare?: number;
  macros?: string;
  minPoolForFootprint?: number;
  shingleWidth?: number;
}

/**
 * The pool operation. Every incoming item is one document; the same items come back
 * out, each carrying the pool verdict, routed Kept / Dropped. The drop list is applied
 * here rather than reported as indices — handing back `drop: [3, 7]` would push the
 * mechanical part back into a Code node.
 *
 * **`Kept` means publishable, which is a per-document AND a pool-level judgement.** A
 * document that duplicates nothing can still belong to a pool that shares one skeleton,
 * and shipping it is exactly the failure the footprint exists to catch — so when the
 * pool verdict fails, everything routes to `Dropped` carrying the reason. Same rule as
 * Lint's template sample, which is Clean only when every drawn document was.
 */
function runUniqueness(
  ctx: IExecuteFunctions,
  items: INodeExecutionData[],
  main: INodeExecutionData[],
  rejected: INodeExecutionData[],
): INodeExecutionData[][] {
  const textField = (ctx.getNodeParameter('textField', 0, 'rendered') as string) || 'rendered';
  const ui = ctx.getNodeParameter('uniquenessOptions', 0, {}) as UniquenessUiOptions;
  // Blank locale ⇒ spintaxMeta ⇒ 'en', exactly what the Locale parameter promises. The
  // lowercase step is locale-aware, so a `tr` pool folds I/ı the way its own reader does.
  const locale = resolveLocale(ctx, 0);
  const macros = splitLines(ui.macros);

  // A document is a non-empty STRING in `textField` — nothing is coerced. An object
  // stringified to "[object Object]" is not a document, and an item without one is not
  // an empty document: either would add itself to `poolSize` and shift every other
  // item's footprint cutoff. Those items leave on the Dropped branch, and the measured
  // pool is exactly the items that carried text.
  const measured: Array<{ index: number; text: string }> = [];
  const malformed: number[] = [];
  items.forEach((item, i) => {
    const value = item.json[textField];
    if (typeof value !== 'string' || value.trim() === '') malformed.push(i);
    else measured.push({ index: i, text: value });
  });
  if (measured.length === 0) {
    throw new NodeOperationError(
      ctx.getNode(),
      `No incoming item has a non-empty "${textField}" field to measure — set Text Field to the field holding the rendered document`,
    );
  }

  const options: UniquenessOptions = {
    ...(macros.length > 0 ? { macros } : {}),
    ...(ui.bodyFormat !== undefined ? { bodyFormat: ui.bodyFormat } : {}),
    locale,
    ...(ui.shingleWidth !== undefined ? { shingleWidth: ui.shingleWidth } : {}),
    dedupJaccard: ctx.getNodeParameter('dedupJaccard', 0, 0.6) as number,
    ...(ui.footprintShare !== undefined ? { footprintShare: ui.footprintShare } : {}),
    ...(ui.footprintMax !== undefined ? { footprintMax: ui.footprintMax } : {}),
    ...(ui.minPoolForFootprint !== undefined
      ? { minPoolForFootprint: ui.minPoolForFootprint }
      : {}),
  };
  const result = uniquenessOp(
    measured.map((m) => m.text),
    options,
  );

  const problems = [...result.problems];
  if (malformed.length > 0) {
    problems.push(
      `${malformed.length} item(s) had no "${textField}" value and were dropped without being measured`,
    );
  }
  const dropped = new Set(result.drop);
  // Only the FOOTPRINT verdict condemns the whole pool. `ok` is also false when one
  // near-duplicate was dropped, and routing on that would empty the Kept branch every
  // time the operation did its ordinary job.
  const poolFailed = result.footprintExceeded;

  const shared: IDataObject = {
    poolSize: result.poolSize,
    footprint: result.footprint.value,
    footprintExceeded: result.footprintExceeded,
    ...(result.footprint.reason !== undefined ? { footprintReason: result.footprint.reason } : {}),
    sharedShingles: result.footprint.sharedShingles,
    totalShingles: result.footprint.totalShingles,
    nearDupPairs: result.nearDup.length,
    ok: result.ok,
    problems,
  };

  measured.forEach((entry, position) => {
    const near = result.duplicateOf[position];
    const isDuplicate = dropped.has(position);
    const verdict: IDataObject = {
      ...shared,
      index: position,
      kept: !isDuplicate && !poolFailed,
      measured: true,
      ...(near !== undefined
        ? // The index of the RETAINED document it duplicates, in the measured pool.
          { nearDupOf: near.of, nearDupJaccard: near.jaccard }
        : {}),
    };
    (verdict['kept'] === true ? main : rejected).push(
      out(entry.index, { ...items[entry.index]!.json, uniqueness: verdict }),
    );
  });

  for (const i of malformed) {
    rejected.push(
      out(i, {
        ...items[i]!.json,
        uniqueness: {
          ...shared,
          kept: false,
          measured: false,
          reason: `no non-empty "${textField}" field on this item`,
        },
      }),
    );
  }

  return [main, rejected];
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

/** The map is JSON on the item, so a lost or malformed one is named, not silently empty. */
function readPlaceholderMap(ctx: IExecuteFunctions, i: number): Record<string, string> {
  const value = ctx.getNodeParameter('placeholderMap', i, {}) as unknown;
  const parsed = typeof value === 'string' && value !== '' ? tryParse(value) : value;
  if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NodeOperationError(
      ctx.getNode(),
      'Placeholder Map must be the token → placeholder object the Protect step produced',
      { itemIndex: i },
    );
  }
  const map: Record<string, string> = {};
  for (const [token, macro] of Object.entries(parsed as Record<string, unknown>)) {
    // The map is item DATA, so its shape is validated, not assumed. An empty or
    // non-conforming key is the dangerous case: an empty one would build a pattern that
    // matches between every pair of characters and rewrite the entire document.
    if (typeof macro !== 'string' || macro === '') continue;
    if (!TOKEN_GRAMMAR.test(token)) {
      throw new NodeOperationError(
        ctx.getNode(),
        `Placeholder Map key ${JSON.stringify(token)} is not a marker (${String(TOKEN_GRAMMAR)}) — ` +
          'this is not the map the Protect step produced',
        { itemIndex: i },
      );
    }
    map[token] = macro;
  }
  // An empty map cannot be told apart from a lost one by looking at the document: a
  // CUSTOM marker is unrecognisable once its mapping is gone, so a restore with nothing
  // to restore is refused rather than reported as a clean pass over untouched text.
  if (Object.keys(map).length === 0) {
    throw new NodeOperationError(
      ctx.getNode(),
      'Placeholder Map is empty — the map from the Protect step did not reach this node, and a ' +
        'document whose markers are unmapped cannot be verified',
      { itemIndex: i },
    );
  }
  return map;
}

/**
 * One EXACT string per line. Deliberately not comma-separated like the name lists: these
 * carry literal foreign strings, and a real macro (`#file_links[D:\path,1,S]#`) contains
 * commas — splitting on them would silently turn one macro into three entries, one of
 * which is the string "1".
 */
function splitLines(raw: string | undefined): string[] {
  return (raw ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

type CsvParam = 'knownVariables' | 'knownIncludes';

function csvParam(
  ctx: IExecuteFunctions,
  i: number,
  name: CsvParam,
): Partial<Record<CsvParam, string[]>> {
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

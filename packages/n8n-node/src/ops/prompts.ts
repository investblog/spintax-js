import {
  buildAuthoringPrompt,
  buildRepairPrompt,
  PROMPT_VERSION,
  type Channel,
  type VariableSpec,
  type VariationLevel,
} from '@spintax/authoring-prompt';
import type { Diagnostic } from '@spintax/core';

import { DEFAULT_LOCALE, type SpintaxMeta } from './types';

export const NEXT_STEP_AUTHORING =
  'Send systemPrompt/userPrompt to your LLM node, then run Validate on the returned template';
export const NEXT_STEP_REPAIR =
  'Send systemPrompt/userPrompt to your LLM node, then run Validate again (cap the loop, e.g. 2 attempts)';

export interface AuthoringOpOptions {
  brief: string;
  locale?: string;
  /** FULL specs — spintaxMeta keeps them; BuiltPrompt flattens to names. */
  allowedVariables?: VariableSpec[];
  channel?: Channel;
  variationLevel?: VariationLevel;
}

export interface PromptOpResult {
  systemPrompt: string;
  userPrompt: string;
  spintaxMeta: SpintaxMeta;
  nextStep: string;
}

export function buildAuthoringOp(opts: AuthoringOpOptions): PromptOpResult {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const allowedVariables = opts.allowedVariables ?? [];
  const built = buildAuthoringPrompt({
    brief: opts.brief,
    locale,
    allowedVariables,
    ...(opts.channel !== undefined ? { channel: opts.channel } : {}),
    ...(opts.variationLevel !== undefined ? { variationLevel: opts.variationLevel } : {}),
  });
  return {
    systemPrompt: built.systemPrompt,
    userPrompt: built.userPrompt,
    spintaxMeta: { locale, allowedVariables, promptVersion: PROMPT_VERSION },
    nextStep: NEXT_STEP_AUTHORING,
  };
}

export function buildRepairOp(
  template: string,
  diagnostics: readonly Diagnostic[],
  meta?: Partial<SpintaxMeta>,
): PromptOpResult {
  const locale = meta?.locale ?? DEFAULT_LOCALE;
  const allowedVariables = meta?.allowedVariables ?? [];
  const built = buildRepairPrompt(template, diagnostics, { locale, allowedVariables });
  return {
    systemPrompt: built.systemPrompt,
    userPrompt: built.userPrompt,
    spintaxMeta: { locale, allowedVariables, promptVersion: PROMPT_VERSION },
    nextStep: NEXT_STEP_REPAIR,
  };
}

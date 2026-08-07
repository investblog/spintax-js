import { cleanModelTemplate } from '@spintax/authoring-prompt';

export interface CleanedInput {
  /** What every downstream operation consumes — diagnostic positions index THIS string. */
  cleanedTemplate: string;
  /** The model's reply verbatim, kept for audit. */
  rawTemplate: string;
  changed: boolean;
}

/**
 * The canonical tolerant parse of an LLM reply: strips code fences, wrapping
 * quotes and `Template:` prefixes. Contract in the prompt, tolerance in the
 * host — models emit fences no matter what the prompt says.
 */
export function cleanTemplate(raw: string): CleanedInput {
  const cleanedTemplate = cleanModelTemplate(raw);
  return { cleanedTemplate, rawTemplate: raw, changed: cleanedTemplate !== raw };
}

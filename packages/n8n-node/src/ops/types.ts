import type { VariableSpec } from '@spintax/authoring-prompt';

/**
 * Travels on the item from Build Authoring Prompt through the LLM node to
 * Validate / Build Repair Prompt / Render, so the whole funnel checks and
 * teaches the same locale and variable rules (spec §3, "one locale through
 * the whole funnel"). Keeps the FULL variable specs — `BuiltPrompt`
 * flattens them to names, which downstream operations cannot rebuild.
 */
export interface SpintaxMeta {
  locale: string;
  allowedVariables: VariableSpec[];
  promptVersion: string;
}

export const DEFAULT_LOCALE = 'en';

export function metaVariableNames(meta: Partial<SpintaxMeta> | undefined): string[] {
  return (meta?.allowedVariables ?? []).map((v) => v.name);
}

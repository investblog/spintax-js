import { validate, type Diagnostic } from '@spintax/core';

import { DEFAULT_LOCALE, metaVariableNames, type SpintaxMeta } from './types';

export interface ValidateOpOptions {
  locale?: string;
  knownIncludes?: readonly string[];
  knownVariables?: readonly string[];
  /** Explicit options win; the meta stamped by Build Authoring Prompt fills the gaps. */
  meta?: Partial<SpintaxMeta>;
}

export interface ValidateOpResult {
  /** The engine's parity-gated definition: valid ⇔ no `severity: 'error'`. */
  valid: boolean;
  diagnostics: Diagnostic[];
  errorCount: number;
  warningCount: number;
  locale: string;
}

export function validateOp(template: string, opts: ValidateOpOptions = {}): ValidateOpResult {
  const locale = opts.locale ?? opts.meta?.locale ?? DEFAULT_LOCALE;
  const knownVariables = opts.knownVariables ?? metaVariableNames(opts.meta);

  const diagnostics = validate(template, {
    locale,
    ...(opts.knownIncludes !== undefined ? { knownIncludes: opts.knownIncludes } : {}),
    ...(knownVariables.length > 0 ? { knownVariables } : {}),
  });

  const errorCount = diagnostics.filter((d) => d.severity === 'error').length;
  return {
    valid: errorCount === 0,
    diagnostics,
    errorCount,
    warningCount: diagnostics.length - errorCount,
    locale,
  };
}

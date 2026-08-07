import { parse } from '@spintax/core';

import { renderOp, type RenderOpOptions } from './render';

export const RENDER_MANY_DEFAULT_COUNT = 5;
export const RENDER_MANY_MAX_COUNT = 100;
export const RENDER_MANY_MAX_ATTEMPTS = 500;

export interface RenderManyOptions extends Omit<RenderOpOptions, 'seed'> {
  /** Distinct variants wanted. Clamped to 1–100, default 5. */
  count?: number;
  /**
   * With a base seed, attempt i renders with seed `${baseSeed}:${i}` — the
   * documented derivation, portable as-is to the Activepieces/Node-RED ports.
   * Without one, attempts are independent unseeded renders.
   */
  baseSeed?: number | string;
  maxAttempts?: number;
}

export interface RenderManyResult {
  variants: Array<{ rendered: string; variantIndex: number }>;
  /** Honesty fields: distinct seeds are independent draws, not distinct
   * results — a low-cardinality template may not have `requested` variants
   * to give, and `produced` says how many actually exist(ed) within the
   * attempt budget. Never claim exact cardinality. */
  requested: number;
  produced: number;
  attempts: number;
}

export function renderManyOp(template: string, opts: RenderManyOptions = {}): RenderManyResult {
  const requested = clamp(Math.trunc(opts.count ?? RENDER_MANY_DEFAULT_COUNT), 1, RENDER_MANY_MAX_COUNT);
  const maxAttempts = clamp(
    Math.trunc(opts.maxAttempts ?? Math.min(RENDER_MANY_MAX_ATTEMPTS, 5 * requested)),
    requested,
    RENDER_MANY_MAX_ATTEMPTS,
  );

  // Parse once; every attempt walks the same AST.
  const ast = parse(template);
  const seen = new Set<string>();
  const variants: RenderManyResult['variants'] = [];
  let attempts = 0;

  while (variants.length < requested && attempts < maxAttempts) {
    const rendered = renderOp(ast, {
      ...opts,
      ...(opts.baseSeed !== undefined ? { seed: `${opts.baseSeed}:${attempts}` } : {}),
    });
    attempts += 1;
    if (seen.has(rendered)) continue;
    seen.add(rendered);
    variants.push({ rendered, variantIndex: variants.length });
  }

  return { variants, requested, produced: variants.length, attempts };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

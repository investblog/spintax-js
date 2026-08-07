import { neutralize } from '@spintax/core';

/** A fixed key/value pair typed by the workflow author in the node UI (T1). */
export interface FixedPair {
  name: string;
  value: string;
  /** T1 values are author input — shielding is per-entry opt-in, default off. */
  neutralize?: boolean;
}

export interface BuildContextOptions {
  /** Top-level JSON of the incoming item; omit (or `ignoreIncoming`) to skip. */
  itemJson?: Record<string, unknown>;
  ignoreIncoming?: boolean;
  /**
   * Incoming values are data-derived (T2): shielded by default so a scraped
   * `{` is data, not markup. The engine deliberately does not auto-shield —
   * the host must, and this node is a host (spec §5 Q3).
   */
  neutralizeIncoming?: boolean;
  /** Applied after the incoming layer; wins on name collision. */
  fixedPairs?: readonly FixedPair[];
}

/**
 * Core's context is `Record<string, string>`: only top-level scalars qualify.
 * Strings pass as-is, numbers/booleans via String(), null/array/object fields
 * are skipped — mapping those is the workflow's job, not a guess of ours.
 */
export function buildContext(opts: BuildContextOptions): Record<string, string> {
  const context: Record<string, string> = {};

  if (!opts.ignoreIncoming && opts.itemJson) {
    const shield = opts.neutralizeIncoming !== false;
    for (const [name, value] of Object.entries(opts.itemJson)) {
      let text: string;
      if (typeof value === 'string') text = value;
      else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
      else continue;
      context[name] = shield ? neutralize(text) : text;
    }
  }

  for (const pair of opts.fixedPairs ?? []) {
    context[pair.name] = pair.neutralize === true ? neutralize(pair.value) : pair.value;
  }

  return context;
}

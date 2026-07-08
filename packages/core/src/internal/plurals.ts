/**
 * Locale plural rules — ported from the plugin's `Plurals` (parity item §3.1).
 * Shared by the validator (arity check, PR-12) and the renderer (bucket pick, M2).
 */

const PLURAL_PREFIX = '{plural ';

export interface PluralBlock {
  readonly start: number;
  /** Exclusive end offset — one past the block's closing `}` (for diagnostics). */
  readonly end: number;
  readonly countSlot: string;
  readonly formsRaw: string;
}

/**
 * Raw brace-aware scan for `{plural …}` blocks — ported from the plugin's
 * `find_plural_blocks`. Used by the validator (and available to the renderer).
 * Scans the whole text, so it finds plurals nested inside `[…]` permutations too
 * (the AST leaves a permutation body unparsed until PR-11b). A block without a
 * `:` is not a plural (left to the enumeration path).
 */
export function findPluralBlocks(text: string): PluralBlock[] {
  const blocks: PluralBlock[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf(PLURAL_PREFIX, i);
    if (start === -1) break;

    let depth = 1;
    let j = start + PLURAL_PREFIX.length;
    while (j < text.length) {
      const ch = text.charAt(j);
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
      j += 1;
    }
    if (depth !== 0) {
      i = start + PLURAL_PREFIX.length; // unmatched opening — skip past prefix
      continue;
    }

    const inner = text.slice(start + PLURAL_PREFIX.length, j);
    const colon = inner.indexOf(':');
    if (colon === -1) {
      i = j + 1; // no colon ⇒ not a plural
      continue;
    }
    blocks.push({ start, end: j + 1, countSlot: inner.slice(0, colon), formsRaw: inner.slice(colon + 1) });
    i = j + 1;
  }
  return blocks;
}

/** Normalise a locale to its base language tag: `pt-BR`→`pt`, `uk_UA`→`uk`, `RU`→`ru`. */
export function normalizeBaseLang(locale: string): string {
  const first = locale.toLowerCase().split(/[-_]/, 1)[0];
  return first ?? '';
}

/** Expected number of plural forms: 3 for East Slavic (ru/uk/be), else 2 (EN-style). */
export function pluralArity(baseLang: string): number {
  switch (baseLang) {
    case 'ru':
    case 'uk':
    case 'be':
      return 3;
    default:
      return 2;
  }
}

/**
 * Pick the plural form for a count by the locale's grammar.
 * - East Slavic: one (1,21,31… not 11), few (2-4,22-24… not 12-14), many (rest, incl. 0).
 * - EN-style: one (n=1), many (rest). Negative counts use abs().
 */
export function pluralFor(baseLang: string, n: number, forms: readonly string[]): string {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;

  switch (baseLang) {
    case 'ru':
    case 'uk':
    case 'be':
      if (mod10 === 1 && mod100 !== 11) return forms[0] ?? '';
      if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1] ?? '';
      return forms[2] ?? '';
    default:
      return (abs === 1 ? forms[0] : forms[1]) ?? '';
  }
}

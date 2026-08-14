/**
 * Pool uniqueness: normalize → shingles → near-duplicates → footprint.
 *
 * Render Many answers "are these variants different?" by exact-string dedupe. That is
 * necessary and not sufficient: a pool can be free of duplicates and still be trivially
 * clusterable, because every document shares the same sentence skeleton. Measured on
 * real pools of the same size — one template scored a **0.962** footprint, five scored
 * 0.103, six scored 0.017.
 *
 * Two findings from that measurement that are not obvious, and that the operation is
 * shaped to communicate:
 *
 * 1. **The metric tracks variation _density_, not template count.** A template that
 *    varies nearly every word scores 0 — not from some deep diversity, but because no
 *    unchanged five-word window survives. One pool went 0.287 → 0.055 on a single
 *    template once no more than four unchanged words were left in a row.
 * 2. **Adding variants of the same template cannot fix it.** The skeleton is fixed by
 *    the template, so re-rendering dilutes nothing; only new templates move the number.
 *    Hence the wording of the problem text — the intuitive reaction to "not unique
 *    enough" is to ask for more variants, and that is the one thing that will not work.
 *
 * The normalisation is specified as an ORDERED ALGORITHM rather than described, because
 * every skipped choice makes the metric irreproducible: deleting a hyphen joins two
 * words, replacing it with a space splits them — different shingles, different number.
 */

export type BodyFormat = 'plain' | 'html' | 'bbcode';

export const UNIQUENESS_DEFAULTS = {
  shingleWidth: 5,
  dedupJaccard: 0.6,
  footprintShare: 0.2,
  footprintMax: 0.15,
  /** Below this pool size the footprint is not computed — see `footprintShare()`. */
  minPoolForFootprint: 5,
} as const;

export interface NormalizeOptions {
  /**
   * EXACT strings every document repeats and that are not the copy being judged
   * (step 1) — matched literally, never as a `%…%` pattern. Macros and merge tags are
   * the obvious case; a fixed variable value is the one people miss. Measured on the
   * gallery pool: leaving the product name, brand and feature phrase in scored 0.209,
   * and excluding them scored 0.107 — the same twelve documents, the difference being
   * whether the metric judged the writing or the product name.
   */
  macros?: readonly string[];
  bodyFormat?: BodyFormat;
  /** Drives the locale-aware lowercase of step 3 (the Turkish dotless ı trap). */
  locale?: string;
}

/** Steps 1–6: text → words. */
export function normalizeText(text: string, opts: NormalizeOptions = {}): string[] {
  const { macros = [], bodyFormat = 'plain', locale } = opts;
  let s = text;

  // 1. Exact macro strings, removed by match and not by pattern: a `#file_links#`
  //    shared by every document would otherwise manufacture similarity, while a broad
  //    `%…%` pattern would bite into ordinary prose. Longest first, so a nested macro
  //    cannot eat the one enclosing it.
  for (const macro of [...macros].sort((a, b) => b.length - a.length)) {
    if (macro) s = s.split(macro).join(' ');
  }

  // 2. Tags with their attributes; the inner text stays. AFTER step 1 — otherwise we
  //    would strip markup from inside a macro and stop recognising its exact string.
  if (bodyFormat === 'html') s = s.replace(/<[^>]+>/g, ' ');
  else if (bodyFormat === 'bbcode') s = s.replace(/\[[^\]]+\]/g, ' ');

  // 3. NFC first, then the locale-aware lowercase.
  s = s.normalize('NFC');
  s = locale !== undefined && locale !== '' ? s.toLocaleLowerCase(locale) : s.toLowerCase();

  // 4. Punctuation and symbols become a SPACE, never nothing — see the hyphen above.
  s = s.replace(/[\p{P}\p{S}]/gu, ' ');

  // 5. Any whitespace run (JS `\s` covers NBSP U+00A0) collapses to one space; trim.
  s = s.replace(/\s+/gu, ' ').trim();

  // 6. A word is a maximal run of non-space characters.
  return s === '' ? [] : s.split(' ');
}

/**
 * Step 7: the SET of w-word tuples. A document shorter than `width` yields one shingle
 * of all its words — an empty set would leave Jaccard undefined for short texts.
 */
export function shingleSet(
  words: readonly string[],
  width: number = UNIQUENESS_DEFAULTS.shingleWidth,
): Set<string> {
  if (words.length === 0) return new Set();
  if (words.length < width) return new Set([words.join(' ')]);
  const out = new Set<string>();
  for (let i = 0; i + width <= words.length; i++) out.add(words.slice(i, i + width).join(' '));
  return out;
}

/** Jaccard over sets. Two empty sets count as identical (1), not 0/0. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export interface NearDupPair {
  a: number;
  b: number;
  jaccard: number;
}

/**
 * Near-duplicates inside the pool. Comparing every pair is O(n²); instead an inverted
 * index over shingles proposes candidates — only documents sharing at least one shingle.
 * At J ≥ threshold a shared shingle is guaranteed, so nothing is lost versus the full
 * scan (a test asserts exactly that against a brute-force pass).
 */
export function nearDupes(
  docs: ReadonlyArray<ReadonlySet<string>>,
  threshold: number = UNIQUENESS_DEFAULTS.dedupJaccard,
): NearDupPair[] {
  const n = docs.length;
  const hits: NearDupPair[] = [];

  // The index proposes candidates from a shared shingle, which is guaranteed at
  // J ≥ threshold — but only for a POSITIVE threshold and non-empty sets. At
  // threshold 0 every pair qualifies, and two empty documents score 1 while sharing
  // nothing, so both cases fall back to the full scan rather than quietly missing
  // pairs the docstring promises are never lost.
  const anyEmpty = docs.some((set) => set.size === 0);
  if (threshold <= 0 || anyEmpty) {
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const score = jaccard(docs[a]!, docs[b]!);
        if (score >= threshold) hits.push({ a, b, jaccard: score });
      }
    }
    return sortPairs(hits);
  }

  const byShingle = new Map<string, number[]>();
  docs.forEach((set, i) => {
    for (const shingle of set) {
      const list = byShingle.get(shingle);
      if (list) list.push(i);
      else byShingle.set(shingle, [i]);
    }
  });

  // Pair key = a * n + b, a numeric identity that needs no parsing back out.
  const candidates = new Set<number>();
  for (const list of byShingle.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let k = i + 1; k < list.length; k++) candidates.add(list[i]! * n + list[k]!);
    }
  }

  for (const key of candidates) {
    const a = Math.floor(key / n);
    const b = key % n;
    const score = jaccard(docs[a]!, docs[b]!);
    if (score >= threshold) hits.push({ a, b, jaccard: score });
  }
  return sortPairs(hits);
}

function sortPairs(hits: NearDupPair[]): NearDupPair[] {
  return hits.sort((x, y) => y.jaccard - x.jaccard || x.a - y.a || x.b - y.b);
}

export interface FootprintResult {
  /** `null` = not measured, with `reason` saying why. Never a meaningless number. */
  value: number | null;
  sharedShingles: number;
  totalShingles: number;
  reason?: string;
}

/**
 * The share of the pool's unique shingles that appear in more than `share` of its
 * documents.
 *
 * On a tiny pool the metric degenerates: with share = 0.2 and three documents, "appears
 * in more than 0.6 documents" means "appears at all", and the value is 1 by
 * construction. Below `minPool` it returns `null` — "not measured" beats an impressive
 * number that means nothing.
 */
export function footprintShare(
  docs: ReadonlyArray<ReadonlySet<string>>,
  opts: { share?: number; minPool?: number } = {},
): FootprintResult {
  const share = opts.share ?? UNIQUENESS_DEFAULTS.footprintShare;
  const minPool = opts.minPool ?? UNIQUENESS_DEFAULTS.minPoolForFootprint;

  if (docs.length < minPool) {
    return {
      value: null,
      sharedShingles: 0,
      totalShingles: 0,
      reason: `pool of ${docs.length} is below minPool=${minPool} — the metric degenerates on tiny pools`,
    };
  }

  const df = new Map<string, number>();
  for (const set of docs) for (const shingle of set) df.set(shingle, (df.get(shingle) ?? 0) + 1);

  const cutoff = share * docs.length;
  let shared = 0;
  for (const count of df.values()) if (count > cutoff) shared++;

  return {
    value: df.size > 0 ? shared / df.size : 0,
    sharedShingles: shared,
    totalShingles: df.size,
  };
}

export interface UniquenessOptions extends NormalizeOptions {
  shingleWidth?: number;
  dedupJaccard?: number;
  footprintShare?: number;
  footprintMax?: number;
  minPoolForFootprint?: number;
}

/**
 * Which documents survive, decided in input order against the ones RETAINED so far —
 * not pairwise. The difference matters on a chain: with A≈B, B≈C and A≉C, dropping the
 * later member of every pair discards both B and C, even though once B is gone C
 * duplicates nothing that remains. A greedy pass keeps A and C, and the `duplicateOf`
 * it reports always points at a document that is still in the pool.
 */
function greedyDrop(
  pairs: readonly NearDupPair[],
  poolSize: number,
): { drop: number[]; duplicateOf: Map<number, { of: number; jaccard: number }> } {
  const neighbours = new Map<number, Array<{ of: number; jaccard: number }>>();
  for (const pair of pairs) {
    const later = Math.max(pair.a, pair.b);
    const earlier = Math.min(pair.a, pair.b);
    const list = neighbours.get(later);
    if (list) list.push({ of: earlier, jaccard: pair.jaccard });
    else neighbours.set(later, [{ of: earlier, jaccard: pair.jaccard }]);
  }

  const dropped = new Set<number>();
  const duplicateOf = new Map<number, { of: number; jaccard: number }>();
  for (let i = 0; i < poolSize; i++) {
    let best: { of: number; jaccard: number } | undefined;
    for (const candidate of neighbours.get(i) ?? []) {
      if (dropped.has(candidate.of)) continue;
      if (!best || best.jaccard < candidate.jaccard) best = candidate;
    }
    if (best) {
      dropped.add(i);
      duplicateOf.set(i, best);
    }
  }
  return { drop: [...dropped].sort((x, y) => x - y), duplicateOf };
}

export interface UniquenessResult {
  /** No near-duplicates and a footprint within the limit. */
  ok: boolean;
  poolSize: number;
  nearDup: NearDupPair[];
  footprint: FootprintResult;
  /**
   * The POOL-level verdict, separate from `ok` on purpose: `ok` is also false when a
   * single near-duplicate was dropped, which says nothing about the pool as a whole.
   * Only this flag means "the surviving documents share one skeleton".
   */
  footprintExceeded: boolean;
  /** Indices to drop, ascending — each duplicates a document that is being kept. */
  drop: number[];
  /** For each dropped index, the RETAINED document it duplicates and how closely. */
  duplicateOf: Record<number, { of: number; jaccard: number }>;
  /** Human-readable; actionable on purpose. Branch on `ok`/`drop`, not on this. */
  problems: string[];
}

export function uniquenessOp(texts: readonly string[], opts: UniquenessOptions = {}): UniquenessResult {
  const {
    macros,
    bodyFormat,
    locale,
    shingleWidth = UNIQUENESS_DEFAULTS.shingleWidth,
    dedupJaccard = UNIQUENESS_DEFAULTS.dedupJaccard,
    footprintShare: share = UNIQUENESS_DEFAULTS.footprintShare,
    footprintMax = UNIQUENESS_DEFAULTS.footprintMax,
    minPoolForFootprint = UNIQUENESS_DEFAULTS.minPoolForFootprint,
  } = opts;

  const normalizeOptions: NormalizeOptions = {
    ...(macros !== undefined ? { macros } : {}),
    ...(bodyFormat !== undefined ? { bodyFormat } : {}),
    ...(locale !== undefined ? { locale } : {}),
  };
  const docs = texts.map((t) => shingleSet(normalizeText(t, normalizeOptions), shingleWidth));

  const nearDup = nearDupes(docs, dedupJaccard);
  const { drop, duplicateOf } = greedyDrop(nearDup, texts.length);

  const footprint = footprintShare(docs, { share, minPool: minPoolForFootprint });

  const problems: string[] = [];
  if (drop.length > 0) {
    problems.push(
      `${drop.length} near-duplicate document(s) at J ≥ ${dedupJaccard} (${nearDup.length} pair(s))`,
    );
  }
  const footprintExceeded = footprint.value !== null && footprint.value > footprintMax;
  if (footprintExceeded) {
    problems.push(
      `footprint ${(footprint.value ?? 0).toFixed(3)} exceeds ${footprintMax} — the pool shares one skeleton. ` +
        'Diversify with new templates or denser variation, NOT with more variants of the same template: ' +
        'the skeleton is fixed by the template, so re-rendering it dilutes nothing.',
    );
  }

  return {
    ok: problems.length === 0,
    poolSize: texts.length,
    nearDup,
    footprint,
    footprintExceeded,
    drop,
    duplicateOf: Object.fromEntries(duplicateOf),
    problems,
  };
}

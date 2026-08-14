import { extract } from '@spintax/core';

/**
 * Protect foreign placeholders — the ones a DIFFERENT engine must expand.
 *
 * A rendered template is often not the final consumer of its own text: it goes on to
 * Mailchimp merge tags, Shopify Liquid, a CRM, GSA Search Engine Ranker. Those systems
 * have their own `%placeholder%` vocabulary, and the two syntaxes collide — whoever
 * reaches the string first consumes it. Three measured failure modes:
 *
 * 1. **A variable silently eats the recipient's macro.** Our lookup is case-INsensitive;
 *    the recipient may treat case as *meaning* (`%random_anchor_text%` as-is,
 *    `%Random_Anchor_Text%` capitalised, `%RANDOM_ANCHOR_TEXT%` upper — one `#set` on
 *    our side hijacks the whole family). Names overlap in unexpected places, too:
 *    `%link%` is a built-in GSA macro, so a variable named `link` breaks both engines at
 *    once and produces plausible-looking output.
 * 2. **Brackets are destroyed.** `[…]` is permutation syntax here, so a bracketed
 *    foreign macro or BBCode loses its brackets, and there is no author-level escape.
 * 3. **The cosmetic pass edits macro parameters.** With `postProcess: true`, `D:` becomes
 *    `D: ` and `,1,S` becomes `,1, S` inside what is meant to be an opaque token.
 *    `neutralize()` shields a value against the *parser*, not against the *typographer*.
 *
 * The mechanism that survives all three is **post-injection**: render with cosmetics on,
 * then put the foreign macros back. The engine never sees them. That requires a token
 * grammar the typographer cannot touch — `^[A-Z0-9_]+$`, because a lowercase token at a
 * sentence start gets capitalised and the exact-match replace then misses SILENTLY,
 * shipping raw tokens to the platform.
 *
 * The stance throughout: **refuse loudly rather than corrupt quietly.** Every function
 * reports what went wrong; the caller decides whether to fail.
 */

/** A token must survive the typographer, which capitalises and edits `.?!;:,` spacing. */
export const TOKEN_GRAMMAR = /^[A-Z0-9_]+$/;

/** Typographer damage signature: a space inserted after `:`, `,` or `;`. */
const DAMAGE = /[:,;] /;

export const DEFAULT_TOKEN_PREFIX = 'SPXTOKEN';

export interface PlaceholderSpec {
  /** The EXACT foreign string, e.g. `*|FNAME|*`, `{{ product.title }}`, `%Anchor_Text%`. */
  value: string;
  /** Optional explicit token; auto-assigned from the prefix when absent. */
  token?: string;
}

export interface ProtectOptions {
  /** Variable names the host will supply at render time — checked for collisions too. */
  contextKeys?: readonly string[];
  /**
   * Variable VALUES the host will substitute. They are checked for marker collisions
   * exactly like the template text: a marker `VIP` is nowhere in `%segment% *|CODE|*`,
   * and is in the rendered document the moment `segment` is "VIP" — at which point the
   * restore rewrites the data as if it were a marker.
   */
  contextValues?: readonly string[];
  tokenPrefix?: string;
}

export interface ProtectResult {
  ok: boolean;
  protectedTemplate: string;
  /** token → foreign placeholder. Carry this to the Restore step. */
  map: Record<string, string>;
  /** How many times each placeholder was found in the template. */
  replaced: Record<string, number>;
  /** Listed placeholders that do not occur in this template — informational. */
  unused: string[];
  problems: string[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One left-to-right pass that swaps every key for its value, longest key first.
 *
 * Both halves of the round trip need exactly this, and for the same reason: a
 * key-at-a-time loop lets an earlier substitution be eaten by a later key. Protecting
 * `[LONG]` and `SPX` would insert `SPXTOKEN0` and then rewrite it on the `SPX` turn;
 * restoring `TAG` and `TAG1` would eat the prefix of the second and leave no whole
 * marker behind to flag. A single pass cannot do either — what it writes, it never
 * reads again.
 */
function replaceOnce(
  text: string,
  entries: ReadonlyMap<string, string>,
): { text: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const key of entries.keys()) counts[key] = 0;
  // An empty key would contribute an empty alternative, which matches between every
  // pair of characters and rewrites the whole document. The map arrives as item data,
  // so this is a guard against input, not a theoretical one.
  const keys = [...entries.keys()].filter((key) => key !== '');
  if (keys.length === 0) return { text, counts };

  const pattern = keys
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  const replacedText = text.replace(new RegExp(pattern, 'g'), (found) => {
    counts[found] = (counts[found] ?? 0) + 1;
    return entries.get(found)!;
  });
  return { text: replacedText, counts };
}

/** `%name%` → `name`; anything else has no engine-variable name to collide with. */
function variableName(placeholder: string): string | null {
  const m = /^%(\w+)%$/u.exec(placeholder);
  return m ? m[1]! : null;
}

/**
 * Replace foreign placeholders in a template with typographer-proof tokens, and report
 * every way the two vocabularies can collide before a render makes it expensive.
 */
export function protectOp(
  template: string,
  placeholders: readonly PlaceholderSpec[],
  opts: ProtectOptions = {},
): ProtectResult {
  const prefix = opts.tokenPrefix ?? DEFAULT_TOKEN_PREFIX;
  const problems: string[] = [];
  const map: Record<string, string> = {};
  const replaced: Record<string, number> = {};
  const unused: string[] = [];

  const specs = placeholders.filter((p) => p.value !== '');
  const taken = new Set<string>();

  // 1. Token names: grammar first, then collisions with each other and with the prose.
  const assigned: Array<{ token: string; value: string }> = [];
  specs.forEach((spec, i) => {
    const token = spec.token !== undefined && spec.token !== '' ? spec.token : `${prefix}${i}`;
    if (!TOKEN_GRAMMAR.test(token)) {
      problems.push(
        `token "${token}" breaks the grammar ${String(TOKEN_GRAMMAR)} — the typographer would ` +
          'mangle it (a lowercase token gets capitalised at a sentence start, punctuation gets ' +
          'edited) and the restore would then miss it silently',
      );
      return;
    }
    if (taken.has(token)) {
      problems.push(`token "${token}" is used twice — one placeholder would overwrite the other`);
      return;
    }
    // Case-INSENSITIVE, because the typographer changes case: a marker `I` is absent
    // from "i agree" as written, and present in "I agree." after the cosmetic pass —
    // at which point the restore rewrites a word of real copy and reports success.
    const anywhere = new RegExp(escapeRegExp(token), 'i');
    if (anywhere.test(template)) {
      problems.push(
        `token "${token}" already occurs in the template (in some casing) — the render can turn ` +
          'that occurrence into the marker itself, and the restore would rewrite real copy',
      );
      return;
    }
    // The rendered document is template + DATA, so a marker that matches a value is
    // just as dangerous as one that matches the prose.
    const inData = (opts.contextValues ?? []).find((value) => anywhere.test(value));
    if (inData !== undefined) {
      problems.push(
        `token "${token}" occurs in a value the render will substitute (${JSON.stringify(inData)}) ` +
          '— the restore would rewrite that data as if it were a marker',
      );
      return;
    }
    taken.add(token);
    assigned.push({ token, value: spec.value });
  });

  // 2. Substitute in ONE pass, longest placeholder first so a nested one cannot eat the
  //    enclosing one — and so a marker this pass writes is never rewritten by a later key.
  const byValue = new Map<string, string>();
  for (const { token, value } of assigned) {
    byValue.set(value, token);
    map[token] = value;
  }
  const substituted = replaceOnce(template, byValue);
  const protectedTemplate = substituted.text;
  for (const { value } of assigned) {
    const occurrences = substituted.counts[value] ?? 0;
    replaced[value] = occurrences;
    if (occurrences === 0) unused.push(value);
  }

  // 3. Name collisions. Our engine resolves variables case-INsensitively while the
  //    recipient may treat case as meaning, so the comparison is case-insensitive on
  //    both sides: one `#set %Link%` hijacks every casing of the foreign `%link%`.
  const declared = new Set<string>();
  try {
    const found = extract(template);
    for (const name of [...found.sets, ...found.defs]) declared.add(name.toLowerCase());
  } catch {
    // A template too malformed to extract is Validate's problem, not this operation's.
  }
  for (const key of opts.contextKeys ?? []) declared.add(key.toLowerCase());

  for (const spec of specs) {
    const name = variableName(spec.value);
    if (name !== null && declared.has(name.toLowerCase())) {
      problems.push(
        `"${name}" is both a foreign placeholder and a variable this template defines — our ` +
          'engine expands it before the recipient ever sees it, and the output looks plausible ' +
          'and is wrong. Rename the variable.',
      );
    }
  }

  return { ok: problems.length === 0, protectedTemplate, map, replaced, unused, problems };
}

export interface RestoreOptions {
  /** Foreign strings that legitimately appear in the output without being mapped. */
  allowed?: readonly string[];
}

export interface RestoreResult {
  ok: boolean;
  text: string;
  /** token → occurrences restored. */
  replaced: Record<string, number>;
  /**
   * Case variants the typographer produced: the exact-match replace misses these
   * SILENTLY, which is the whole reason for the uppercase marker grammar.
   *
   * There is deliberately no `residual` field beside it. A per-marker loop needs one,
   * because a marker can survive its own pass; the single pass substitutes every
   * occurrence at once, so "a marker left behind" is not a state that exists — and a
   * naive after-the-fact scan reports the marker-shaped text *inside a substituted
   * value* as residual, failing a restore that was correct.
   */
  mangled: string[];
  problems: string[];
}

/**
 * Put the foreign placeholders back into a rendered document and check the result the
 * way a machine can: case-mangled markers, orphaned markers, typographer damage inside
 * a restored macro, leftover braces, and stray `%…%` that are neither ours nor
 * allow-listed. Anything found is reported, never patched over.
 */
export function restoreOp(
  rendered: string,
  map: Record<string, string>,
  opts: RestoreOptions = {},
): RestoreResult {
  const mangled: string[] = [];
  const problems: string[] = [];

  // A Map, not the raw object: a marker is caller data, and `'toString' in map` is true
  // on any object literal.
  const table = new Map(Object.entries(map));
  // Matching is plain, deliberately NOT word-boundary anchored: a placeholder sitting
  // right before a word leaves the marker glued to it (`SPXTOKEN1click`), which a
  // `\b`-anchored restore skips while a boundary-sharing check fails to notice the miss.
  const { text, counts: replaced } = replaceOnce(rendered, table);

  if (table.size > 0) {
    // A marker that came back from the render in altered form is the silent miss this
    // whole operation exists to prevent: the replace does nothing and raw garbage ships.
    const anyCase = [...table.keys()]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join('|');
    for (const found of rendered.match(new RegExp(anyCase, 'gi')) ?? []) {
      if (!table.has(found) && !mangled.includes(found)) mangled.push(found);
    }
  }

  // An auto-assigned marker left in the text with no map entry to restore it: the map
  // was lost between the two halves of the round trip, or never wired at all. This
  // catches the auto-named ones by their reserved prefix; a CUSTOM marker is
  // unrecognisable once its map is gone, which is why the node refuses an empty map
  // outright rather than trusting a scan to find what it cannot name.
  // Scanned on the ORIGINAL text: a restored VALUE that happens to be marker-shaped is
  // not an orphan, and scanning the substituted text would fail a correct restore.
  for (const orphan of new Set(rendered.match(new RegExp(`${DEFAULT_TOKEN_PREFIX}\\d+`, 'g')) ?? [])) {
    if (!table.has(orphan)) {
      problems.push(
        `${orphan} is in the text but not in the placeholder map — the Protect step's map did ` +
          'not reach here, so the foreign placeholder it stands for is lost',
      );
    }
  }
  for (const found of mangled) {
    problems.push(
      `token "${found}" came back from the render in altered case — the typographer edited it ` +
        'and the exact-match restore could not see it',
    );
  }

  // Everything checked "outside the macros" runs on a copy with the known macros cut
  // out: a macro legitimately contains `%…%`, brackets and token-shaped text of its own,
  // and without cutting it out its own content produces false complaints.
  const known = [...Object.values(map), ...(opts.allowed ?? [])].sort(
    (a, b) => b.length - a.length,
  );
  let scan = text;
  for (const value of known) if (value !== '') scan = scan.split(value).join(' ');

  for (const [token, value] of Object.entries(map)) {
    if (DAMAGE.test(value)) continue;
    // The macro carries no "punctuation + space" pair of its own, so finding one inside
    // its boundaries in the text means the cosmetic pass edited a parameter.
    const loose = new RegExp(escapeRegExp(value).replace(/([:,;])/g, '$1 ?'), 'g');
    for (const found of text.match(loose) ?? []) {
      if (found !== value) {
        problems.push(`macro ${token} damaged by the typographer: ${JSON.stringify(found)}`);
      }
    }
  }

  // Both shapes: an ASCII brace the recipient may re-spin as its own syntax, and the
  // fullwidth pair the engine emits for markup it could not parse — the latter is the
  // louder signal, and checking only ASCII would miss exactly the broken case.
  if (/[{}｛｝]/.test(scan)) {
    problems.push(
      'leftover brace in the output — an ASCII { } may be re-spun by the recipient as its own ' +
        'syntax, and a fullwidth ｛ ｝ is the engine reporting markup it could not parse',
    );
  }

  const allowedLower = new Set((opts.allowed ?? []).map((s) => s.toLowerCase()));
  const stray = new Set<string>();
  for (const token of scan.match(/%[^%\s]+%/g) ?? []) {
    if (!allowedLower.has(token.toLowerCase())) stray.add(token);
  }
  for (const token of stray) {
    problems.push(
      `stray ${token} in the output — neither a restored placeholder nor allow-listed, so it is ` +
        'either an unresolved engine variable or a foreign macro nobody will expand',
    );
  }

  return { ok: problems.length === 0, text, replaced, mangled, problems };
}

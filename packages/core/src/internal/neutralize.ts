/**
 * T2 shielding (§6). Text-safe / context-agnostic — NOT the plugin's HTML-entity
 * encoding (that only round-trips in an HTML sink; this engine targets Telegram /
 * plaintext / CLI too). Structural chars `{ } [ ] % #` map to Private-Use-Area
 * sentinels (U+E000–U+E005) the engine's passes never interpret as markup; the
 * mandatory {@link safetyRestore} (always run, even with postProcess:false) maps
 * them back to their literal glyphs. PUA (not the `\x00…` scheme post-process
 * uses) so the two shielding mechanisms can't collide.
 *
 * "Text-safe" = safe against re-interpretation as spintax markup, NOT against an
 * HTML/JS sink — neutralize does not touch `< > &`, so it is not XSS mitigation
 * (an HTML-entity variant is a host concern, §6).
 *
 * RESERVED RANGE: U+E000–U+E005 are engine sentinels. `parseTemplate` strips them
 * from author markup (template source + #include results) via {@link stripSentinels}
 * — every door from author source into a tree, so `parse()`/`analyze()`/`render()`
 * agree — and the restore rewrites them in output, so a RAW (non-neutralized) context
 * value carrying these code points will be altered — hosts should neutralize/strip
 * such data.
 */
const STRUCTURAL = ['{', '}', '[', ']', '%', '#'] as const;
const SENTINEL_BASE = 0xe000;

const SHIELD = new Map<string, string>();
const RESTORE = new Map<string, string>();
STRUCTURAL.forEach((ch, i) => {
  const sentinel = String.fromCharCode(SENTINEL_BASE + i);
  SHIELD.set(ch, sentinel);
  RESTORE.set(sentinel, ch);
});

const SHIELD_RE = /[{}[\]%#]/gu;
const RESTORE_RE = new RegExp(
  `[${String.fromCharCode(SENTINEL_BASE)}-${String.fromCharCode(SENTINEL_BASE + STRUCTURAL.length - 1)}]`,
  'gu',
);

/** Shield data-derived (T2) input so it can't be re-interpreted as spintax markup. */
export function neutralize(value: string): string {
  return value.replace(SHIELD_RE, (ch) => SHIELD.get(ch) ?? ch);
}

/** Mandatory final stage: restore shielded structural chars to literal glyphs. */
export function safetyRestore(text: string): string {
  return text.replace(RESTORE_RE, (ch) => RESTORE.get(ch) ?? ch);
}

/** Remove stray sentinels from author markup (template / #include) so only
 *  neutralize() can introduce them — otherwise safetyRestore would rewrite them. */
export function stripSentinels(text: string): string {
  return text.replace(RESTORE_RE, '');
}

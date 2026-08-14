# Changelog — `n8n-nodes-spintax`

Versioned independently of `@spintax/core`. Releases are tagged `n8n-node-vX.Y.Z` and published
with npm provenance via OIDC (`RELEASING.md`).

## 0.2.0

Everything here came out of building a 1000-article pool on top of the node — four issues filed
from real use, each fixing something that was actually stumbled over, not imagined.

### Added

- **Lint operation** (#61) — checks the *render*, which is the defect class `validate()`
  structurally cannot see: a flawless template still emits broken text when two adjacent slots
  pick the same word, a noun from one slot meets a relative pronoun from another and they
  disagree in gender, or an unlucky join leaves a space before a comma. Routes each item to
  **Clean** / **Defective**, or samples N renders from a template and reports `cleanRatio` plus a
  tally of the issues, worst first. On the pool that motivated it: **2% clean** on the first run
  over 200 renders, 100% after the slots it pointed at were fixed — while a defect that shipped
  before the linter existed sat in 18% of the pool and was caught by a human noticing a
  screenshot.
  - The repeat window is configurable and defaults to **6 words** — at 9, 82% of the hits were
    ordinary cohesion rather than defects.
  - Rules are locale-scoped: the gender/pronoun rule is Russian, repeats and punctuation are
    language-neutral, a locale with no stop-word table gets the neutral rules only, and `fr` is
    exempt from *space-before-punctuation* for `; : ! ?` where that spacing is correct.
  - It skips what it cannot judge (a Russian soft sign is ambiguous — `путь` masculine, `тень`
    feminine) rather than guessing. Case agreement *inside* a slot stays the author's job.
- **Uniqueness operation** (#62) — the pool question exact-string dedupe cannot answer. Reads
  every incoming item as ONE pool, drops near-duplicates (**Kept** / **Dropped**, the later
  document of a pair, so the first occurrence always survives) and reports the shared-shingle
  footprint. Measured on real pools of the same size: one template **0.962**, five 0.103, six
  **0.017**. The normalisation is specified as an ordered algorithm because every skipped choice
  makes the metric irreproducible — deleting a hyphen joins two words, replacing it with a space
  splits them. Below `minPoolForFootprint` documents it returns "not measured" instead of a
  number that is 1 by construction.
- **Protect Placeholders operation** (#63) — for text whose *real* consumer is another engine
  (Mailchimp merge tags, Liquid, CRM or SEO macros). `Protect` swaps the foreign strings for
  markers before the render and `Restore` puts them back and verifies; the marker grammar is
  `^[A-Z0-9_]+$` because a lowercase marker gets capitalized at a sentence start and the
  exact-match restore then misses **silently**. Protect also catches the collision that produces
  plausible-and-wrong output: a variable named like a foreign macro (`%link%`), compared
  case-insensitively because our lookup ignores case while the recipient may treat it as meaning.
- **`attemptSeed` on every Render Many variant** (#60) — the seed that actually produced it. It
  is derived from the *attempt* counter while `variantIndex` counts *accepted* variants: the two
  agree until the first collision and diverge permanently after it. Without it a persisted pool
  cannot rebuild a single document — not to repair a torn file, not to top up without
  re-rendering everything, not to prove the pool is reproducible at all.
- New gallery template `templates/product-copy-pool.json`: brief → LLM writes one template →
  Validate (+ one capped repair round) → Render Many → Lint → Uniqueness.

### Contracts worth knowing before wiring a workflow

- **Uniqueness `Kept` means publishable** — per-document *and* pool-level. A document that
  duplicates nothing can still belong to a pool that shares one skeleton, so when the footprint is
  exceeded nothing is kept. Set `Footprint Limit` to 1 to make that verdict advisory and route on
  near-duplicates only.
- Uniqueness drops greedily in input order against the documents still **retained**, so a chained
  overlap (`A≈B`, `B≈C`, `A≉C`) keeps A and C rather than discarding both B and C, and every
  reported `nearDupOf` names a survivor.
- An item without a document is not an empty document: it leaves on `Dropped` with
  `measured: false` instead of joining the pool and shifting everyone else's footprint cutoff.
- Uniqueness honours `continueOnFail` and the blank-locale `spintaxMeta` fallback like every other
  operation, despite running before the per-item loop.
- A document is a non-empty **string**; an object is not coerced into `"[object Object]"` and
  counted.
- Protect and Restore each substitute in ONE alternation pass, longest key first: a key-at-a-time
  loop lets `TAG` eat the prefix of `TAG1` on restore, and lets a `SPX` placeholder rewrite the
  `SPXTOKEN0` marker protect had just inserted. There is deliberately no `residual` field — with a
  single pass a leftover marker is not a state that exists, while an after-the-fact scan reports
  marker-shaped text *inside a restored value* and fails a correct restore.
- Marker/prose collision is checked case-**insensitively**: the render is what creates the
  collision (`i agree` → `I agree.`), so a case-sensitive check would let a marker rewrite real copy.
- Restore refuses an empty placeholder map: a custom marker cannot be recognised once its mapping
  is gone, so "nothing to restore" and "the map was lost" would look identical.
- `Shared Strings` and `Allowed Placeholders` take one exact string **per line**, not
  comma-separated — a real macro contains commas (`#file_links[D:\path,1,S]#`).
- A marker is checked against the incoming item's VALUES as well as the template: the rendered
  document is template plus data, so a marker matching a value would be rewritten just the same.
  The placeholder map's keys are validated against the marker grammar, since an empty key would
  build a pattern matching between every pair of characters.
- **Known boundary:** a *partially* lost map with **custom** markers cannot be detected — a raw
  custom marker is indistinguishable from ordinary uppercase copy. Auto-assigned markers are
  recoverable by their reserved prefix, and a wholly missing map is refused; leaving markers
  auto-assigned is therefore the safe default.

### Notes

- No breaking changes: `attemptSeed` is additive, and the three operations are new. Validate,
  Render, Render Many and the prompt operations behave exactly as in 0.1.4.
- The published tarball smoke now asserts that every documented operation is registered and that
  two-output routing works from the installed artifact.

## 0.1.0 – 0.1.4

Initial releases: the five original operations (Render, Render Many, Validate, Build Authoring
Prompt, Build Repair Prompt), two-output Validate, the bundled zero-dependency engine, npm
provenance via Trusted Publishing, and the first two workflow templates. See the git history and
`docs/spec-n8n-node.md` for the detail.

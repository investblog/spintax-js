# Changelog — `n8n-nodes-spintax`

Versioned independently of `@spintax/core`. Releases are tagged `n8n-node-vX.Y.Z` and published
with npm provenance via OIDC (`RELEASING.md`).

## 0.3.1

**HTML entity names were being counted as words** — by Lint's `repeat.word` and by Uniqueness's
footprint. Stripping `&` and `;` as ordinary punctuation left the NAME standing, so `&nbsp;`
became the word `nbsp`. Found by measurement rather than by reading: run the lint over 120 KB of
long-form French and `nbsp` is the most-reported "repetition" on the page, ahead of every real
word, with `mdash` and `rarr` behind it. The rule was reporting typography.

- **Lint.** Entity names no longer become tokens. Numeric forms (`&#160;`, `&#x2014;`) are decoded
  to the character they stand for; a named one becomes a space, because resolving the HTML5 name
  table is a parser's job and the cost of not doing it — `caf&eacute;` cut to `caf` — can only
  hide a repetition, never invent one.
- **Uniqueness.** Same strip inside the `html` body format. Every document in an HTML pool carries
  the same handful of entities, so their names were shared vocabulary by construction and pushed
  the footprint up: measured on six variants of one skeleton, **0.4545 with them and 0.4 without**.
  A metric whose job is to say whether a pool is varied must not count typography as sameness.

**Two numbers move, and both were wrong before.** A footprint on an HTML body comes out slightly
lower — if you gate on Footprint Limit, a pool that used to fail may now pass, correctly. And Lint
findings shift in *both* directions: the false entity repeats go, but an entity no longer pads the
repeat window, so a genuine repetition it was holding apart can now land inside it and be reported.
That is the same effect Ignored Strings already documents, for the same reason: a token that is not
a word must not occupy the space of one.

## 0.3.0

**Lint's `repeat.word` no longer runs on a locale whose function words it does not know**
(spintax-js#77). It used to: the lookup was `STOP_WORDS[language] ?? []`, so for every locale but
`ru` and `en` an empty stop set meant "judge every preposition and article as content". Reported
from a production pipeline of nine campaigns — on a live Spanish pool of 1000 articles the single
word `para` produced **2303 findings**. Nothing crashed; the gate simply became unreadable, which
is worse than no gate, because the real findings go out buried in the noise.

Three changes, and the first is the one that matters:

- **The rule is skipped where it cannot judge, and says so.** Lint's output gains `skipped`, an
  array of the rules that did not run. A workflow branching on `lintClean` — or on the Clean
  output — must now read it too: silence from a rule that never ran is not evidence. The
  language-neutral punctuation rules are unaffected and keep running on every locale.
- **New parameter, Function Words** (`stopWords`): the caller's own list for a locale we ship no
  table for, merged with the built-in table rather than replacing it. This is what turns
  `repeat.word` back on for an untabled locale, and it is deliberately the caller's call — we are
  not going to assert the closed-class vocabulary of a language nobody here has measured.
- **Tables for `de`, `es` and `pt`**, contributed by the reporting pipeline and grouped by
  language as they had them, measured on real text rather than written from a grammar. `pt-BR`
  resolves to `pt`.

**This is a behaviour change on any locale outside `ru`/`en`/`de`/`es`/`pt`:** `repeat.word` used
to report there and now reports nothing until you fill in Function Words. That is the point — what
it reported was noise — but a workflow that was quietly tolerating it will see its Defective output
go empty. Hence the minor bump rather than a patch.

## 0.2.8

Bundles `@spintax/core` **0.6.1**: the engine no longer throws `RangeError` on deeply nested
content (spintax-js#68). A Render or Validate node fed an author-supplied template with ~2000
levels of nesting — 3.9 KB — used to take the workflow down with an exception rather than
returning the lenient fullwidth fallback. No behaviour change otherwise; output is byte-identical.

## 0.2.7

Bundles `@spintax/core` **0.6.0**: `validate()` emits one `variable.circular-reference` per NAME
rather than per PATH (spintax-js#59). A Validate node fed a template with a converging diamond of
definitions could previously return millions of identical diagnostics — 507 bytes produced
2 097 152 of them — which is a workflow-killer whatever n8n does with the items. Messages are
unchanged for ordinary templates.

## 0.2.6

Bundles `@spintax/core` **0.5.3**: the expansion budget added in 0.5.2 was per rendered
template, so every `#include` handed it a fresh allowance — fifty includes over one 62-character
body made 57 MB out of 690 bytes. It is per `render()` call now. **Upgrade from 0.2.5.**

## 0.2.5

Bundles `@spintax/core` **0.5.2**, which stops `render()` dying on a 62-character template
(spintax-js#69) — a doubling pair of `#set` definitions ended the Node process, so a Render
node fed an author-supplied template took the workflow down with it. Not a regression: every
released engine did this. **Upgrade from 0.2.4.**

## 0.2.4

Bundles `@spintax/core` **0.5.1**, which fixes two crashes in the 0.5.0 form-counting path — a
62-character template could take `validate()` out with an out-of-memory crash, and a long `#set`
chain threw `RangeError`. Both reachable from template text, so a Validate node fed
author-supplied templates could take the workflow down with it. **Upgrade from 0.2.3.**

No node-side change; no verdict changes for a template that was not crashing.

## 0.2.3

Bundles `@spintax/core` **0.5.0**. **A workflow's Validate branching can change** — read on.

### Fixed

- **Validate ignored the node's Locale resolution.** The operation read the raw `locale` parameter
  while Render resolved it through the same helper every other operation uses, so an item carrying
  `spintaxMeta.locale: ""` was *validated* as "no locale given" and *rendered* under the resolved
  default. One item, two answers, from one node.

  An item that used to leave on **Valid** with a `plural.locale-missing` warning can now leave on
  **Invalid** with `plural.arity`, which is the truth about how it will render. This is a routing
  change: check any workflow that branches on the Validate outputs.

### Changed

- **Bundled engine 0.4.0 → 0.5.0.** Plural form counting now expands definitions before counting,
  so `{plural 2: one|%tail%}` with `#def %tail% = few|many` under `ru` stops reporting a false
  `plural.arity` (spintax-js#66); and a conditional in a plural's count slot resolves instead of
  silently deleting the block (`#set %n% = {?flag?1|2}`). Both move templates from wrong output or
  wrong verdict to right, so a workflow's results can change — for the better, but not identically.

## 0.2.2

Refresh: bundles `@spintax/core` **0.4.0**. No behaviour change for a workflow, and the version
is a patch because measuring said so.

### Changed

- **Bundled engine 0.3.4 → 0.4.0**, which adds a `plural.locale-missing` warning
  (spintax-js#65) for a `{plural …}` block that cannot resolve at the render default when **no
  locale was supplied**.

  The first draft of this entry claimed the warning would fire whenever the Locale field is left
  empty — the field's default — and that was wrong. Reading `validateOp` settled it: an empty
  field omits the option, and the op falls back to `spintaxMeta.locale` and then to
  `DEFAULT_LOCALE` (`en`). So this node never validates without a locale, and a three-form
  Russian plural has always come back as an arity **error** on the Invalid branch rather than
  silently. The new warning is reachable here only if an item's `spintaxMeta.locale` is an
  explicit empty string.

  Kept as a release anyway so the artifact users install carries the current engine — the family
  moves together — and pinned by a test, so the `en` default that makes this a non-event is
  recorded rather than assumed.

## 0.2.1

The release exists because the published pool template got ahead of the published node: the
gallery workflow already passes **Ignored Strings** to Lint, and an option a template uses
before the node ships it is a template that arrives broken. Everything here came out of running
that template end to end on a live n8n against the published 0.2.0 — three runs, three
findings, all real.

### Added

- **Ignored Strings on the Lint operation** (`lintIgnore`) — one exact string per line. A value
  the render substituted is data the author did not write and often cannot avoid; on the live
  pool, every hit outside one parallel construction was the brand or the product name. The same
  reasoning already shapes Uniqueness's Shared Strings.
  - An ignored value is replaced by **as many filler words as it contained**, not blanked and
    not collapsed: the first version substituted a single space, pulled a deliberately
    sentence-apart `#def` repeat inside the six-word window, and failed all twelve documents on
    the next run. Distances survive the ignore.
  - Punctuation rules still read the original text — blanking would leave gaps that read as
    debris the render never produced.
- **`less` and `fewer` join the English stop list** beside `more`/`most`: the same quantifier
  class, and a parallel "less to fuss with and less to go wrong" is style, not a defect.

### Changed

- **The pool template configures in ONE node** ("Your brief and product"), per n8n's own Best
  Practices line about grouping user-configured variables in a Set node; downstream nodes read
  the five values by expression, and Uniqueness's Shared Strings reads the same fields instead
  of repeating their literals — editing the Set node can no longer leave the metric measuring a
  product name nobody updated elsewhere.
- **The pool template's stickies obey the published numeric rules** read off the Creator hub:
  one yellow overview (293 words, their "### How it works" / "### Setup" headings), three grey
  sections of 27–31 words each stretched across several nodes.
- The template passes its configured values into both Lint and Uniqueness, so the two
  operations judge the author's text rather than the author's data.

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

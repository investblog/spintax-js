# Changelog

All notable changes to `@spintax/core` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0 — 2026-07-18

Serbian, Croatian and Bosnian join the 3-form plural family. Minor, not patch: this
changes a **validation verdict**, which §0.1 classes as breaking.

### Added

- **BCS plural buckets — `sr`, `hr`, `bs`.** On integers, BCS shares the East-Slavic rule
  character for character (`mod10===1 && mod100!==11` → one; `mod10∈[2,4] && mod100∉[12,14]`
  → few; else → many), so it reuses that branch rather than getting its own. CLDR names the
  third bucket `other` rather than `many` — positionally the same slot. The genuine
  BCS/East-Slavic divergence is fractional-only and unreachable here, since a non-numeric
  count slot is erased to `''` before the bucket math (§3.1).

  **Script and region subtags carry no plural grammar.** `sr-Latn`, `sr-Cyrl` and `sr_RS` all
  normalise to `sr` and pick identical buckets; the script lives only in the author's form text.
  Corpus fixtures pin each form, and the arity fixtures pin that a script subtag does not rescue
  a 2-form template. The ladder runs past two digits, where `mod100` has to beat `mod10`: 101 is
  `one`, 111 is not.

  Render fixtures probe with `sat` (1 sat / 2 sata / 5 sati) because all three buckets differ
  there. The tempting `bonus|bonusa|bonusa` collapses few and other, so it would pass against a
  broken rule.

  Landed in all three engines at once — `@spintax/core`, the WordPress plugin 2.5.0, and
  `spintax/core` 0.2.0 — because plural buckets are a parity-required item and the golden
  corpus gates every engine.

### Changed

- **BREAKING (verdict): `{plural 2: one|many}` under `sr`/`hr`/`bs` is now `plural.arity`.**
  Previously these locales fell through to the EN-style 2-form default, so a 2-form BCS
  template validated clean and rendered from the wrong bucket set. Any existing BCS template
  must grow a third form. No other locale changes behaviour.
- The LLM authoring prompt (`@spintax/authoring-prompt`) now emits a BCS grammar block —
  agreement rules, the 3-bucket warning, and a "do not mix Latin and Cyrillic inside one
  template" rule. Without it a model writes 2-form BCS that the validator then rejects.

## 0.1.6 — 2026-07-13

Two post-process fixes. **Supersedes 0.1.5** — upgrade straight past it. No API change.

### Fixed

- **A run of sentence punctuation is no longer split from the inside.** This is not a Spanish issue
  and it predates the 0.1.5 work: the "space after `.!?`" rule looked exactly one character ahead
  and never at the rest of the run, so it fired *between* the marks.

  ```
  wait... what?   →  Wait. . . What?      (0.1.5 and earlier)
  wow!!!          →  Wow! ! !
  really?!        →  Really? !
  ```

  The ASCII ellipsis is the common casualty — and the Unicode `…` is *not* in the `[.!?]` class,
  which is exactly why the corpus's existing ellipsis fixture never caught it. A run is now matched
  whole and required to be complete: `([.!?]+)(?![.!?])`. The guard is load-bearing — a greedy `+`
  alone gives ground back *into* the run to satisfy the lookaheads and yields `Wow!! !`.

- **`¡¿Qué haces?!` keeps its capital.** The 0.1.5 opener rule allowed exactly *one* opener, so the
  RAE form for a sentence that is both a question and an exclamation — the most Spanish sentence
  there is — still lost its capital. An opener followed by markup (`¿<strong>cómo</strong> estás?`,
  `<p>¿<a href="/ayuda">necesitas ayuda</a>?</p>`) failed for the same reason: the old lead only
  allowed `tags → opener → letter`, never `opener → tags → letter`.

  The lead is now any run of tags, sentence openers and whitespace, in any order. The opener set
  stays deliberately **narrow** — quotes and brackets are still not openers, and the fixtures added
  in 0.1.5 keep guarding that.

### Notes

- Mirrored into the PHP plugin engine (released there as 2.3.3). Verified against the shared golden
  corpus in both engines: TS 243 tests; the conformance runner against the real plugin engine 107
  tests / 120 assertions. No performance regression — the pathological-input cost is unchanged from
  0.1.5 and comes from the URL/domain shields, not from these rules.

## 0.1.5 — 2026-07-13

Spanish post-process fix. No API change.

### Fixed

- **`postProcess` no longer strips the capital from every Spanish sentence.** Spanish is the only
  European language whose punctuation *opens* a sentence, and the capitalization passes upper-cased
  the first **character** after a sentence boundary — which, for `¿cómo estás?`, is `¿`. An inverted
  mark has no uppercase form, so the pass was a no-op and the real first letter stayed lowercase.
  The spacing pass had the mirror-image gap: it knew "no space *before* closing punctuation" but had
  no rule for an opener, so `¿ qué tal ?` only half-collapsed.

  ```
  hola. ¿cómo estás? ¡genial!   →  Hola. ¿Cómo estás? ¡Genial!
  Hola. ¿ qué tal ?             →  Hola. ¿Qué tal?
  ```

  A new `SENTENCE_OPENERS = '¿¡'` concept drives both: an opener binds to the word it opens (before
  capitalization, deliberately), and the four capitalization sites — start of text, after `.!?…`,
  after a block-level tag, and after a newline — allow an optional opener between the boundary and
  the letter. HTML paragraphs and multi-line templates were broken exactly like the bare `. ¿` case.

  The opener set is deliberately **narrow**: quotes and brackets both open *and* close, so
  capitalizing after them would mangle list markers (`Elige una. (a) primero`). Golden-corpus
  fixtures guard both the fix and its narrowness, in **both** engines.

### Notes

- Mirrored into the PHP plugin engine to hold the post-process parity contract. Verified against the
  shared golden corpus in both engines: TS 230 tests; the conformance runner against the real plugin
  engine 99 tests / 112 assertions; the plugin's own suite 578 tests, no regressions.
- The plugin carries the same fix but ships it in a later release, so for a short window a published
  plugin and this package can differ on Spanish output. The parity *contract* holds — the engines'
  behavior agrees and the corpus proves it — only the release timing differs.

## 0.1.4 — 2026-07-13

A post-process bug fix (hit in production) plus docs. No API change.

### Fixed

- **`postProcess` no longer mangles `mailto:` / `tel:` URIs.** They carry no `//` authority,
  so the URL shield missed them; the email shield then carved the address out from under the
  prefix, and the "space after a colon" rule split the leftover into a malformed
  `mailto: contact@example.com` href. They are now shielded as whole tokens (with the same
  trailing-punctuation handling as URLs) before the email/domain passes. Mirrored into the PHP
  engine and covered by 4 golden-corpus fixtures, so the post-process parity contract holds
  in both engines. Reported in [#41](https://github.com/investblog/spintax-js/issues/41).

### Changed

- Docs: a **Use Cases** section (cold email, notifications, chatbots, A/B copy, programmatic
  SEO, spinning LLM-drafted templates locally) and the N-variants recipe — call `render` N
  times with different seeds — with the caveat that distinct seeds are *independent draws, not
  distinct results*, so a low-cardinality template will repeat. Batching stays a host concern.
- npm keywords broadened (`text-spinner`, `email-template`, `placeholders`, `variables`,
  `conditionals`) to match how people actually search for this.

## 0.1.3 — 2026-07-08

Precise diagnostic positions. Backward-compatible — `validate()` verdicts (pass/fail),
codes, and severities are unchanged (still not parity-gated per §3.1); only the
best-effort position fields are improved. No render/parse behavior change.

### Added

- **`validate()` diagnostics now carry accurate `line`/`column` for every code**, not just
  brackets. Previously `plural.*`, `permutation.*`, `set.malformed`, and `include.*` reported
  a line with `column: 1`, and `variable.*` had no position at all (defaulted to `1:1`). All
  now point at the offending token.
- **`endLine`/`endColumn`** are populated so a consumer can underline the exact span (e.g. the
  whole `%name%` reference or `{plural …}` block).
- **Structured `data`** on diagnostics: `variable.undefined` → `{ name }`; `plural.arity` →
  `{ expected, got }`; `permutation.*` → `{ key }` / `{ value }`; `bracket.*` → `{ bracket }` /
  `{ open, close }`; `include.unknown-target` → `{ target }`. Lets a bot/editor build UI without
  parsing the (non-parity-gated) `message`.
- `PluralBlock.end` (internal) — exclusive end offset, so validation can span the full block.

### Notes

- `variable.undefined` still reports **once per unique name**, now anchored at its first
  occurrence. Consumers that want to highlight every occurrence can expand via `data.name`.

## 0.1.2 — 2026-07-08

Docs. No engine or API changes.

### Changed

- **Cross-engine parity is now machine-verified.** The shared golden corpus was executed against
  the actual PHP Spintax plugin engine (via the new `packages/conformance/php` runner) — 88 cases,
  no divergence. Upgraded the README claim from "TS side; PHP execution pending" to parity-verified
  against both engines.

## 0.1.1 — 2026-07-08

Docs + metadata. First release published from CI with **provenance** (npm Trusted Publishing).
No engine or API changes.

### Changed

- npm `keywords` + `description` reworked for discoverability — spintax / text-spinning /
  LLM-authoring workflow; dropped the obscure `gtw` tag.
- README: badges, npm + [301.st](https://301.st) links, and LLM-pairing positioning (draft a
  template with a model once, generate unlimited deterministic variations on-device).

## 0.1.0 — 2026-07-07

First public release. Feature-complete engine; the TS suite passes the full **deterministic**
golden corpus that encodes the Spintax WordPress plugin's behavior contract (validation verdicts,
plural buckets, conditional truthiness, `#set` collapse, post-process output, enum/perm selection).
Cross-engine execution of that corpus by the PHP plugin is the remaining verification gate (see Notes).

### Added

- `parse(input)` — opaque, versioned AST for reuse.
- `render(input, opts)` — seeded, lenient rendering: enumerations, permutations (config +
  per-element separators), variables (recursive), `#set` (collapse-once), conditionals, plurals
  (locale buckets), `#include` (host-injected resolver, scope isolation, circular guard), and the
  12-step cosmetic post-process (URL/email/domain/abbreviation shielding, spacing, capitalization).
  Post-process defaults on; `postProcess: false` yields the raw pick.
- `validate(input, opts)` — diagnostics with a parity-gated verdict (valid ⇔ no `error`);
  `knownIncludes` / `knownVariables` options.
- `extract(input)` — `{ refs, sets, includes }`.
- `analyze(input, opts)` — extract + validate + a best-effort construct census.
- `neutralize(value)` — text-safe shielding of data-derived input, with a mandatory safety-restore.

### Notes

- `render()` is lenient on depth: a circular / too-deep `#include` resolves to `''` (there is
  **no** `MaxDepthExceededError`), matching the plugin. It throws only on a resolver that itself
  throws (`IncludeResolverError`) or a foreign `Ast` (`AstVersionError`) — revised after the
  reference-Worker dogfood surfaced the phantom error export.
- Zero runtime dependencies; ESM-first with dual CJS. Node 18+, Cloudflare Workers, browser.
- Cross-engine RNG-sequence parity with the PHP plugin is a non-goal; only deterministic behavior
  is parity-gated. The PHP-side corpus runner is the remaining cross-engine verification gate.

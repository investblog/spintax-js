# Changelog

All notable changes to `@spintax/core` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- **`postProcess()` no longer emits a raw U+0000** into the returned text — on input carrying
  none. A URI body runs to the first delimiter, so the URL rule and the `mailto:`/`tel:` rule
  overlap whenever one URI carries the other's scheme, and shielding them in two passes let the
  second run into a placeholder the first had minted:

  ```js
  render('mailto:sales@example.com?body=see%20https://shop.example.com/cart');
  // 'mailto:sales@example.com?body=see%20\x00URL_0\x00'  ← before this release
  ```

  The swallowed key never restored, so the engine returned its own placeholder delimiter: illegal
  in an XML document, replaced with U+FFFD by an HTML parser, rejected by PostgreSQL in
  `text`/`varchar` — and a live key again as soon as an edit detaches it from the `mailto:` prefix
  that was shielding it, at which point the next render substitutes an unrelated URL into the
  contact link. It also silently disabled the linear restore below, whose guard is
  `input.includes('\x00')`.

  The two rules are now **one alternation**, so the leftmost match takes the whole token whichever
  scheme it is. Reordering the passes was the other candidate and is not equivalent: it moves the
  damage onto a URL whose path carries a `mailto:`, where the leading half then loses its trailing
  dot to the punctuation pass. Both directions are fixtures now, the second one negative. U+0000 is
  also excluded from the URI body class, for a caller-supplied one.

  Mirrored into the WordPress plugin engine, and gated by three golden-corpus fixtures — the
  cross-engine contract, so `spintax-php`, `spintax-py` and `spintax-win` inherit the gate.
  ([#53](https://github.com/investblog/spintax-js/issues/53))

### Performance

- **Post-process no longer goes quadratic on shield-heavy text.** The restore step replaced each
  shielded placeholder across the whole text one key at a time — O(text × placeholders) — and
  since URLs, `mailto:`/`tel:` URIs, emails, domains, decimals and abbreviations are all shielded,
  the placeholder count grows with the input. The stage came to dominate the render:

  | input  | `postProcess: false` | before     | after   |
  |--------|----------------------|------------|---------|
  | 47 KB  | 0.007 s              | 0.18 s     | 0.014 s |
  | 189 KB | 0.006 s              | 3.06 s     | 0.057 s |
  | 756 KB | 0.081 s              | **43.9 s** | 0.25 s  |

  A single left-to-right pass replaces the loop, behind a guard on the input. The two are not the
  same function: the loop is a repeated *substring* substitution, so it rewrites every occurrence
  of a key rather than the one the shield placed. Most of the disagreement needs a literal `\x00`
  from the caller, and the guard sends that input to the original loop.

  **One shape survives the guard**, and on it the behaviour changed deliberately: two adjacent
  placeholders can sandwich caller text that spells a key, so one token's closing delimiter, that
  text, and the next token's opening delimiter form a third occurrence of a real key. Rendering
  `https://a.io e.g. URL_0mailto:x@y.io` — no `\x00` anywhere in it — the loop substituted the
  forgery, destroyed two real tokens and returned raw `\x00` bytes; the single pass returns the
  text intact. Measured over 456 976 probes, 12 `\x00`-free inputs distinguish the two restores and
  the loop emits a raw `\x00` on all 12. A corpus fixture now pins the surviving answer, since the
  engines disagreed on it. `npm run bench:postprocess` records the scaling.
  ([#52](https://github.com/investblog/spintax-js/issues/52),
  [#54](https://github.com/investblog/spintax-js/issues/54))

## 0.3.1 — 2026-07-21

Author markup is sanitised in one place, so a handle renders exactly like its source.

### Fixed

- **`render(parse(src))` no longer diverges from `render(src)`** when the template contains an
  author-typed engine sentinel (the reserved range U+E000–U+E005). The strip that keeps stray
  sentinels out of a tree lived at the render entry points, so `parse()` and `analyze(str)` — two
  of the three doors into the parser — skipped it, and the mandatory safety-restore then rewrote
  the author's character into a structural glyph they never wrote:

  ```js
  const src = `a${String.fromCharCode(0xe000)}b`;
  render(src, { postProcess: false }); // "ab"
  render(parse(src), { postProcess: false }); // "a{b"  ← before this release
  ```

  The strip now lives in `parseTemplate`, the single door from author source into an AST, so all
  three entry points agree. `parseSequence` is deliberately **not** sanitised — it re-parses a
  variable's *value*, where sentinels a host `neutralize()`d are legitimate and must survive to the
  restore — and `ParsedAst.source` still keeps the original bytes so diagnostics point at what was
  typed. ([#51](https://github.com/investblog/spintax-js/issues/51))

  Templates that contain no reserved-range characters are unaffected: the strip is a no-op on them.
  The Python port fixed the same defect the same way; the PHP engines never had it (no `parse()`
  handle, no PUA sentinels).

## 0.3.0 — 2026-07-19

`#set` goes back to being a macro and a new `#def` carries roll-once. Breaking: it changes what
existing templates mean. Ships in lockstep with the WordPress plugin 3.0.0, `spintax/core` and the
OpenCart port; the corpus landed last, after both PHP engines.

### Changed

- **`#set` is a macro.** The value is substituted at every `%var%` reference and whatever brackets
  it holds resolve independently each time. Until now an enumeration-valued `#set` collapsed once at
  set-time; that behaviour moved to `#def`.

  Worth recording *why* the revert, because the reasoning is not recoverable from the diff:
  collapse-once was the newcomer. It shipped in the plugin on 2026-07-04, was announced in one
  changelog line, and contradicted the project's published documentation from the day it landed.
  Macro expansion is what the engine did before that and what consumers written against those docs
  assume.

- **`AST_VERSION` 1 → 2.** `ParsedAst` gained `defDefs`. An `Ast` cached by an older version carries
  no definition map, so rendering it would silently drop every `#def`; the version guard turns that
  into an `AstVersionError` instead.

- **`extract()` reports `defs`** alongside `sets`. Additive for readers, but a consumer building a
  variable list from `sets` alone will now miss `#def` names.

- **`plural.nested-brackets` advice.** "Extract via `#set` first" was correct under collapse-once and
  is wrong under a macro — the value is substituted verbatim and puts the brackets straight back into
  the form slot, raising the very error it was meant to avoid. It now says `#def`.

### Added

- **`#def %var% = value` — roll-once.** The value is rendered once per render, as if it were a
  miniature body, and the result is held for every reference. It covers enumerations *and*
  permutations, resolves **after** the merged context exists (so it can read globals and runtime
  variables; a runtime variable of the same name outranks it), and resolves in dependency order —
  an order that follows aliases **through** macro values, since a `#def` can reach another `#def` by
  way of a `#set` expanded only at reference time.

  This is where a plural counter now lives: `#def %n% = {1|4|9}` then `{plural %n%: …}` prints and
  agrees the same number. Under `#set` the two disagree and the block is dropped.

- **Four diagnostics**: `def.malformed`, `definition.duplicate-name` (a name belongs to one
  directive, once — this also closes silently-last-wins duplicate `#set`s), `def.include-in-value`
  (includes resolve after a value is frozen; legal inside a `#set`), and `plural.count-macro`.

  `plural.count-macro` is decided by **stage order, not bracket type**: conditionals resolve before
  plurals and are exempt, enumerations and permutations resolve after and are not, and a nested
  `{plural …}` resolves in the *same* pass so it is not exempt either. Taint propagates through
  `#set` → `#set` references to a fixpoint.

### Corpus

The difference between the directives is a difference in how many RNG draws a render consumes, so
seeded-sequence fixtures pin it exactly and cross-engine — `set/macro-re-rolls-at-every-reference`
and `def/rolled-once-and-held` share a template and a sequence and differ only in whether the second
draw is reached. The corpus grew 138 → 160 cases, green against this engine, the WordPress plugin
and `spintax/core`.

The previous rule here said collapse could only be pinned with RNG-free values, and the consequence
was that **nothing pinned it at all**: the semantics flipped in the plugin without a single fixture
noticing. All-identical alternatives are not sufficient either — they render the same under both
semantics and would pass against an engine implementing `#def` as an alias of `#set`.

### Migration

A `#set` whose value is an enumeration or permutation *and* which is referenced more than once for
consistency — a plural counter, a brand name that must not vary mid-sentence — becomes `#def`. One
line per definition; references are untouched.

## 0.2.0 — 2026-07-18

Serbian, Croatian and Bosnian join the 3-form plural family; the plural error model and the
locale helpers that go with it land in the same release. Minor, not patch: the BCS change
below alters a **validation verdict**, which §0.1 classes as breaking.

Nothing here shipped separately — 0.2.0 was never published, so these additions fold into it
rather than minting a version between them. That matters for `@spintax/authoring-prompt`,
whose peer range `>=0.2.0` would otherwise be satisfiable by a 0.2.0 without the exports it
now imports at runtime.

### Added

- **`pluralArity(locale?)` and `normalizeBaseLang(locale?)` are public.** Exported so a
  consumer that must AGREE with the engine about plurals can ask it instead of keeping a copy
  of the table. The copy is not hypothetical: this repo's own authoring prompt kept one and it
  drifted twice — once in content (a locale added here and not there) and once in shape
  (`locale.slice(0, 2)`, which disagrees with this normalization on any 3-letter tag).

  `pluralArity` takes a RAW locale and normalizes internally, unlike the internal helper of the
  same name — a public function answering 2 for `sr-Latn` would be a trap. Both accept an absent
  locale, matching `RenderOptions.locale?` / `ValidateOptions.locale?`, so the same optional
  value can be threaded straight through.

  Note one asymmetry: an absent locale makes `validate()` skip the arity check entirely, while
  `pluralArity` answers the 2-form default `render()` would apply. It tells you what render will
  do, not what validate will enforce.

  `findPluralBlocks` is deliberately NOT exported alongside them — it returns byte offsets into
  the source, and publishing it would freeze a parser internal and invite consumers onto the
  parse layer, the same reason `Ast` is opaque.

- **`RenderOptions.onPluralError` — an observer for unresolvable `{plural …}` blocks.**
  The port of the plugin's `on_error` callable, and the missing half of its error model:
  this engine already behaved exactly like the plugin's *lenient* mode (arity mismatch and
  nested-bracket errors degrade to fullwidth-brace verbatim, an unresolved count erases the
  block), but there was no way to learn that it had happened.

  Observation only. Output is byte-identical with and without the callback, and `render()`
  still never throws on template content (§9.3) — the host decides whether a report is
  fatal. A report carries the diagnostic `code`, the construct **as the renderer saw it**
  (after variable expansion), the normalized `locale`, and `expected`/`got` for arity.

  The `plural.count` code has no `validate()` counterpart on purpose: an unresolved count is
  a runtime-value fact that static analysis cannot see. It is also the case that most needs
  the seam — erasing leaves no trace, so a host persisting a render otherwise cannot tell an
  unsubstituted `%Var%` from copy that was meant to be empty.

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

# Spintax npm engine — `@spintax/core`

Status: IMPLEMENTED — `@spintax/core` **0.1.4** is published to npm (MIT, provenance via OIDC).
M0–M5 are shipped: golden corpus, engine (parse / render / validate / extract / analyze /
neutralize), the reference Cloudflare Worker, and the Telegram bot. **M6** (browser playground on
`spintax.net`) is the one open milestone. The spec stays the source of truth for the parity
contract (§3.1), the fixture schema (§7.1), and the public API surface (§9.2) — behavior changes
are argued against it and the golden corpus, not against the current code.
Owner: 301st
Canonical location: this file, `W:\projects\spintax-js\docs\spec-npm-engine.md`.

> **Cross-repo path convention.** This spec lives in the **spintax-js** repo but references
> the parent WordPress-plugin repo at `W:\projects\spintax\`. Unless a path is absolute
> (`W:\…`) or clearly local (`packages/…`, this repo's `docs/…`), any `docs/…` or `plugin/…`
> path below refers to the **parent repo** `W:\projects\spintax\`.

Related (parent repo `W:\projects\spintax\`): `docs/product-roadmap-2026.md` (Phase 4
Cloudflare API is the first consumer), `docs/gtw-syntax-reference.md` (authoring contract),
`docs/spec-v1.md` (plugin engine behavior), `docs/adr-0001-runtime-var-trust-levels.md`
(trust model).
Reference implementations: `W:\spintax-java` (Java algorithm origin), the PHP plugin engine
in `W:\projects\spintax\plugin\src\Core\Engine` + `…\Core\Render`, `W:\projects\spintax-opencart`
(PHP port).

> This is a **separate branch of the project**, not a plugin feature. It does not touch the
> plugin. It has its own repo (`W:\projects\spintax-js`, git `main`, initial commit) and its
> own memory namespace, exactly like the OpenCart port. Nothing here blocks the WooCommerce
> Phase 3 roadmap; the two proceed independently.

---

## 0. Decisions locked in this session

Three product decisions frame everything below (asked & answered 2026-07-05):

1. **Role = public core engine.** `@spintax/core` is an **open-source** parser + renderer
   published to npm. It is itself a discovery/trust channel (like the free WP plugin and
   GitHub stars), embeddable by anyone with zero WordPress dependency. The Cloudflare
   Workers API (roadmap Phase 4) and the Telegram bot (Phase 5) become **its consumers**,
   not private forks of the engine.
2. **Relationship to PHP = independent implementation.** The TS engine is written fresh
   against the syntax contract — **not** a line-by-line transcription of the PHP, and
   **not** byte-for-byte output parity with the plugin. See §3 for exactly what must stay
   in parity and what is deliberately allowed to diverge.
3. **Immediate action = write this spec.** Spec-first, discuss, then decide on the repo.

### 0.1 Resolved after review (2026-07-05)

- **Q1 → YES, post-process is a parity-target.** `preview-render` MUST show what the user
  sees on the live site, RNG selection aside. Grounded in the current PHP render path:
  `post_process()` is the final stage of `Renderer::render()`
  (`plugin/src/Core/Render/Renderer.php:331`) and the logic lives in
  `Parser::post_process()` (`plugin/src/Core/Engine/Parser.php:248`). Practical rule:
  post-process is parity-target for the deterministic golden cases (shielding, spacing,
  capitalization), but the engine exposes a low-level `postProcess: false` escape hatch for
  debugging/tooling. Public `render()` and the API `preview-render` default to `true`.
- **Q5 → MIT for the npm packages; WP plugin stays GPL (as needed).** MIT fits the
  "public core engine / discovery channel" intent — trivially embeddable in commercial
  SaaS, CMSes, agent tooling, browser playgrounds, and Workers. WordPress.org requires
  GPL-*compatibility*, and MIT/Expat is GPL-compatible per the FSF license list, so the
  GPL plugin can depend on / share behavior with an MIT engine with no conflict.
  Refs: [WP plugin guidelines](https://developer.wordpress.org/plugins/wordpress-org/detailed-plugin-guidelines/),
  [OSI MIT](https://opensource.org/license/MIT),
  [FSF license list (Expat)](https://www.gnu.org/licenses/license-list.html#Expat).
  **Caveat:** MIT is correct *because* this is an independent TS implementation sharing only
  behavior tests. If we ever literally transcribe GPL-licensed PHP fragments line-for-line
  into the TS engine, that code inherits GPL — so either keep the reimplementation clean
  (recommended) or explicitly dual-license / assign copyright for any ported verbatim block.

---

## 1. Purpose & positioning

Content teams and agents increasingly want the spintax engine **outside** WordPress:
in Cloudflare Workers, in Node/serverless, in a browser playground on `spintax.net`, in
CI that validates author templates, in a Telegram bot. Today the only real engine is PHP,
locked inside the plugin runtime. `@spintax/core` is the portable engine that unlocks all
of those surfaces from one codebase.

Positioning against the roadmap product ladder (`product-roadmap-2026.md` §7):

- It is **not** a commercial layer. It is a second free/OSS wedge alongside the WP plugin —
  same "strong free entry point" strategy, different runtime.
- It is the **shared runtime** the roadmap's Phase 4 API and Phase 5 bot were going to need
  anyway. Building it as a named public package (rather than an inlined Worker dependency)
  means the API, the bot, and a web playground all import the same tested engine.

The roadmap currently describes only a *hosted* JS surface (Phase 4 endpoints). This spec
proposes promoting the engine underneath those endpoints to a **first-class published
package** and adding a product-line row for it.

---

## 2. Scope

### 2.1 In scope (the package)

The pure, side-effect-free authoring engine:

- **Parser** — GTW-compatible recursive-descent parse of the full syntax surface (§4).
- **Renderer** — resolve a parsed template to one output string given a variable context
  and an RNG.
- **Validator** — static analysis returning structured diagnostics with line/column,
  matching the plugin's save-time validation semantics (§3, parity item).
- **Extraction** — enumerate `%var%` references, `#set` definitions, and `#include` refs in
  a template (powers the roadmap's `extract-variables` endpoint, the two-phase include
  prefetch §4.1, and author tooling).
- **Post-process pipeline** — the domain/email/decimal shielding + spacing + capitalization
  passes (§5), because validation-quality output is a product promise, not cosmetic.
- **Deterministic mode** — seedable RNG so tests, previews, and "show me N variants" are
  reproducible.

### 2.2 Out of scope (the package)

Everything that is a *runtime host* concern, not an *engine* concern — kept out so the
package stays lean and universally embeddable:

- No WordPress, ACF, WooCommerce, or bindings concepts. `%product_*%` / `%post_*%` /
  `%acf_*%` context sources are **host-supplied variable maps**, not engine features. The
  engine takes a `Record<string, string>` context; where those keys come from is the host's
  job.
- No caching, no cron, no persistence, no CPT — those are plugin/host responsibilities.
- No LLM/provider integration, no API-key handling, no billing (roadmap §5.4 boundary).
- No HTTP surface — the Cloudflare API (Phase 4) wraps this package; it is not in it.
- No CLI in the core package (a thin `@spintax/cli` on top is a possible sibling, deferred).

---

## 3. Relationship to the PHP engine — parity contract

"Independent implementation" (decision #2) means we write idiomatic TS and do **not**
promise identical bytes. But three things MUST match, or the cross-runtime promise
("author with the npm/API validator, render in the WP plugin") breaks for the user. Draw
the line explicitly:

### 3.1 MUST stay in parity (author-visible contract)

- **Accepted syntax surface.** Every construct the plugin parses, the package parses, and
  vice versa. A template that is valid in one is valid in the other. No dialect drift.
- **Validation verdicts.** What the plugin rejects at save time (malformed brackets,
  plural arity/form errors, nested brackets in plural forms), the package's validator also
  rejects — and what it accepts, the package accepts. Diagnostic *wording* may differ;
  **pass/fail classification may not**. NOTE: **circular `#include` is NOT a static
  verdict** — the plugin's `Validator` never resolves includes (it only checks a target
  *exists*, and only when the host passes a slug list; `Validator.php:43-45,401-417`). Cycle
  protection is a **render-time guard** (§4.1, `maxDepth`), not a `validate()` error.
- **Plural grammar buckets.** Given the same locale + count, both engines pick the same
  form slot (RU/UK/BE 3-form one|few|many; EN-style 2-form). Deterministic math, not RNG —
  must match exactly. Includes the edge rules: empty/non-numeric count **erases the block →
  `''`**, negative counts are `abs()`-normalized (`Plurals.php:224-228,271`). The `locale`
  identifier format is the **same vocabulary the golden corpus uses** (§7.1); an
  unknown/malformed locale falls back to the default 2-form and never throws.
  (Reference: `plugin/src/Core/Engine/Plurals.php`.)
- **Conditional truthiness.** `{?VAR?…}` "set + non-whitespace" truthiness, inverted
  `{?!VAR?…}`, resolution before AND after `%var%` expansion — identical rules.
- **`#set` collapse-once semantics.** An enumeration in a `#set` value collapses once at
  set-time to a single stable value (plugin Renderer Stage 4b, `Renderer.php:246-262`) so
  `{plural %n%: …}` sees a numeric count. The **parity gate is the *semantic* rule** (one
  stable value per render; a numeric count reaches `{plural}`), **NOT which value the RNG
  picks** — that diverges cross-engine (§3.2). So deterministic collapse fixtures MUST use
  RNG-free values (`#set %n% = 5`, or all-identical alternatives); an enumeration-valued
  `#set` is a within-engine/structural case, never a cross-engine exact-output gate.
- **Other deterministic, author-visible behaviors** (not RNG, not wording — each earns
  corpus coverage): **enumeration preserves inner whitespace, permutation trims each
  element** (`{ a | b }` keeps the spaces, `[ a | b ]` does not); `%var%` expansion is
  **recursive** up to a depth cap (a var value containing `%other%` expands,
  `MAX_VARIABLE_DEPTH=50`); **conditional name grammar differs from `%var%`** — conditionals
  require `[A-Za-z_][A-Za-z0-9_]*` (no leading digit; malformed ⇒ left literal) while `%var%`
  allows `\w+` (leading digit OK). A port that shares one regex across both will diverge.

### 3.2 Deliberately allowed to diverge

- **Random selection results.** Which option `{a|b|c}` picks, which N elements `[…]`
  shuffles — inherently RNG, no value in matching PHP's `mt_rand` sequence. Seedable mode
  gives reproducibility *within* the package; cross-engine sequence parity is a non-goal.
- **Internal architecture.** No obligation to mirror the PHP class layout (`Parser`,
  `RenderContext`, `Renderer` stages). TS can use whatever AST/visitor shape is cleanest.
- **Performance characteristics, error message strings, i18n of diagnostics.**

### 3.3 Post-process pipeline — a judgment call to settle

The plugin's `Parser::post_process` (domain/email/decimal shielding, space collapsing,
capitalization — see §5) shapes *output*, not accepted syntax. Under "output may diverge"
it is technically free to differ. **But** it's a big part of why plugin output looks
polished, and the roadmap sells `preview-render` as a real preview of what the site will
produce. Recommendation: **treat the post-process pipeline as parity-target too** (port its
behavior, share its golden corpus) even though it's output-shaping — because a preview that
capitalizes/spaces differently from the live site is a misleading preview.
**RESOLVED (§0.1): YES, parity-target.** `render()` / `preview-render` default
`postProcess: true`; a `postProcess: false` escape hatch stays for tooling/debug.

---

## 4. Syntax coverage matrix

Source of truth: `docs/gtw-syntax-reference.md` + the plugin engine. The package must cover
the full surface. Enumerated here so the port has a checklist, not prose.

| Construct | Example | Parity class |
|---|---|---|
| Enumeration | `{a\|b\|c}`, nested `{a\|{b\|c}}`, empty `{\|a\|b}` | syntax + validation |
| Permutation | `[a\|b\|c]` | syntax; output RNG |
| Permutation single sep | `[< and > a\|b]` | syntax |
| Permutation configured | `[<minsize=2;maxsize=3;sep=", ";lastsep=" and "> …]` | syntax + minsize/maxsize default **and clamp** rules; `<config>` vs HTML-start-tag disambiguation (`[<li>…]` is HTML, not config) |
| Per-element separator | `[<, > a\|b < and >\|c]` | syntax; sep travels with element on shuffle |
| Variable ref | `%var%` (case-insensitive) | syntax |
| Local set | `#set %v% = value` | syntax + collapse-once (§3.1) |
| Conditional | `{?VAR?then\|else}`, `{?!VAR?…}` | syntax + truthiness (§3.1) |
| Plural | `{plural <count>: one\|few\|many}` | syntax + bucket math (§3.1); prefix is literal `{plural ` **with trailing space** + mandatory `:` (no colon ⇒ left as literal text); brace-depth-aware scan; rejects nested brackets in form slots; empty/non-numeric count ⇒ `''` |
| Block comment | `/#...#/` | syntax (stripped) |
| Include | `#include "slug-or-id"` | syntax + circular guard; **resolver is host-injected** (§4.1) |

### 4.1 `#include` resolution is host-injected

The package cannot know how to fetch template `"slug-or-id"` — in WP it's a CPT lookup, in
the API it's a store/DB call, in the bot it may be disallowed entirely. The engine accepts
an **include resolver callback** `(ref: string) => string | null`; the circular-reference
guard and scope-isolation rules (child inherits global+runtime vars, NOT parent `#set`
locals — plugin key design decision) live in the engine, but the *fetch* is the host's.

**The resolver is synchronous** (`(ref) => string | null`) — this keeps `render()` a plain
sync `string` call, right for the Workers CPU model and the browser playground. Where the
include source is async I/O (Worker KV/D1/HTTP), the host uses a **two-phase pattern**:
`extract(src).includes` → host async-prefetches every ref into a map → `render()` with a
sync map-backed resolver. Nested includes surface new refs, so the prefetch loop repeats
until no new refs appear (bounded by `maxDepth`). The engine deliberately does NOT go async;
batching/prefetch is a host (Worker) concern (§9.3).

### 4.2 minsize/maxsize defaults (parity)

Port exactly (plugin key design decision): only `maxsize` set → `minsize = 1` (not total);
only `minsize` set → `maxsize = total`. **Clamp out-of-range values**:
`minsize = max(1, min(minsize, total))`, `maxsize = max(minsize, min(maxsize, total))`
(`Parser.php:572-573`). Auto-spacing: purely-alphabetic separators get padded with spaces;
punctuation separators do not. The `[<…>…]` parse must first disambiguate a real `<config>`
header from a leading HTML start tag (`looks_like_html_start_tag`) — a prime divergence
site, so it earns heavy corpus coverage.

---

## 5. Post-process pipeline (parity-target — resolved §0.1)

Order matters — mis-sequencing corrupts domains/emails. Port the plugin's order verbatim:

1. Shield URLs, emails, bare domains (ASCII + punycode + IDN), decimals, multi-dotted
   abbreviations (`т.д.`), single-token whitelist abbreviations (`соц.`, `Mr.`, `Inc.`) → placeholders
2. Collapse duplicate spaces/tabs
3. Remove whitespace before punctuation
4. Add space after `,;:` and `.!?` where missing
5. Capitalize first letter (skip leading HTML tags)
6. Capitalize after `.!?…` (through HTML tags)
7. Capitalize after block-level HTML tags (`<p>`, `<h1>`–`<h6>`, `<li>`, `<div>`, …)
8. Capitalize after line breaks
9. Restore placeholders

The abbreviation whitelist and IDN/punycode handling are the fiddly parts — these get the
heaviest golden-corpus coverage (§7). Two output-affecting details to port exactly: the
space-after-punctuation steps are gated by `(?!\d)` (so `a,1` stays unspaced — protects
decimals), and capitalization is Unicode-aware (`\p{Ll}` + locale-safe uppercasing — mind
the Turkish-i hazard). A TS port using ASCII `[ \t]` or a naive `toUpperCase()` will
mismatch the corpus.

---

## 6. Trust model & the shielding question

The plugin's ADR-0001 splits variable sources into **T1 markup-authoring** (template /
`#set` / globals / shortcode args — values MAY be spintax, no shielding) and **T2
data-derived** (context/siblings reading records — values MUST be shielded `{ } [ ] % #` +
access-gated). `SpintaxShield::neutralize_map()` implements the neutralization.

For the package this maps cleanly:

- The engine treats its input **context map** as T1 by default (author-controlled), exactly
  like the plugin treats `#set`/globals/shortcode args.
- **Shielding is a host concern, exposed as a utility.** The package ships a
  `neutralize()` helper (`SpintaxShield` port, source `plugin/src/Support/SpintaxShield.php`)
  so a host that feeds *data-derived* values (a CMS field, a product description, user input)
  into the context can shield them before handing them to the engine — same discipline as
  the plugin's T2 sources. The engine does not auto-shield, because it cannot know which
  context keys are T1 vs T2. The **API/bot host** is responsible for shielding untrusted
  input (matters a lot once the Phase 4 API accepts arbitrary caller-supplied variable maps
  — see §8).

**Representation — decided pre-code (differs from the plugin on purpose).** The plugin's
`SpintaxShield` encodes `{ } [ ] % #` as **HTML numeric entities** (`&#123;` …,
`SpintaxShield.php:37-54`) — which only round-trip because the plugin's sink is HTML
(`wp_kses_post` + browser decode `&#123;`→`{`). This engine targets **non-HTML sinks too**
(Telegram, plain-text Worker responses, CLI), where a verbatim port would leak literal
`&#123;`. So `@spintax/core`'s `neutralize()` is **context-agnostic / text-safe by
default**: it guarantees the value survives `render()` and emerges as its literal glyphs in
*any* sink (mechanism — an internal sentinel restored by a **mandatory safety stage**, or
equivalent — settled at M2 against the corpus), NOT HTML-entity encoding. An HTML-entity
variant is a *host* concern, not shipped in core v0.1 (§9.3). This is a deliberate,
documented divergence from the plugin, not a parity break — `neutralize()` is a host utility
(§3.1 lists no shielding-representation parity gate).

**Shielding restore is NOT part of cosmetic post-process — it must survive `postProcess:false`.**
The renderer's tail is two *separate* stages: **(a) mandatory safety restore** — shielded
structural chars come back as their literal glyphs and are **never re-parsed** — always runs;
**(b) cosmetic post-process** (spacing/capitalization §5) — gated by the `postProcess` flag.
`postProcess:false` disables **(b) only**. It must not leak a sentinel into output, and must
not give a neutralized `{ } [ ] % #` a second chance to execute. Concretely:
`render("%t%", { context: { t: neutralize("A {x|y}") }, postProcess: false })` must yield the
literal `A {x|y}` — sentinel gone, braces inert — not a raw sentinel and not a resolved
`{x|y}`.

---

## 7. Testing — shared golden corpus

The single highest-leverage artifact for "independent impl, but parity where it counts":
a **language-neutral golden corpus** of `(template, context, locale, seed) → expected`
cases, consumed by BOTH the PHP suite and the TS suite.

- Format: JSON fixtures (there's already a stray `tests/fixtures/rendered-output.txt` in the
  plugin working tree — formalize this into a versioned corpus).
- **Deterministic cases** (validation verdicts, plural buckets, conditional truthiness,
  `#set` collapse, post-process pipeline) assert exact output in both engines → these are
  the §3.1 parity gates, machine-checked.
- **RNG cases** run in seeded mode and assert *within-engine* reproducibility only, plus
  structural invariants (e.g. permutation output is a valid shuffle of a valid subset).
- Corpus **lives in this repo at `packages/conformance/fixtures/*.json`** (Q3 resolved,
  §10); the parent PHP suite reads it by local path/env var during M0, and it is published as
  `@spintax/conformance` later, once the §7.1 schema and cases have stabilized. This is what
  keeps the two engines honest over time without forcing byte-parity everywhere.

The plugin has ~562 PHPUnit test methods, of which **~276 are parity-relevant**
(`ParserTest` 87, `PluralsTest` 74, `RendererTest` 39, `ConditionalsTest` 36,
`ValidatorTest` 26, …); the rest are WordPress-coupled and non-portable. Even inside the
parity set, `RendererTest` is bound to `wp_insert_post`/`WP_UnitTestCase` and needs
de-WordPressing (drive `Renderer::process_template()` directly, which takes raw markup), and
several `PluralsTest` cases assert the internal `plural_for()` method rather than the
`{plural N: …}` string surface, so they must be lifted to the string level before reuse.
**Budget M0 against ~276, not 577.**

### 7.1 Corpus fixture schema (lock BEFORE extracting any case — M0 task #1)

Both engines consume identical JSON, so the schema is fixed *first* — otherwise the PHP-side
extraction and the later TS reader disagree on structure and force a re-extraction. Each
case:

```jsonc
{
  "id": "plural/ru-few",
  "kind": "deterministic" | "rng",     // THE discriminator — decides the assertion mode
  "op": "render" | "validate" | "extract" | "neutralize",
  "template": "…",
  "context": { "n": "5" },             // optional; string map (T1)
  "locale": "ru-RU",                   // optional; SAME vocabulary the engine accepts (§3.1)
  "knownIncludes": ["hero"],           // optional; validate/analyze only → ValidateOptions §9.2
  "postProcess": false,                // optional bool, default TRUE (mirrors render()); false ⇒ raw pre-cosmetic output
  "rng": "first" | "last" | { "sequence": [0, 2, 1] },  // injected RNG (semantics below), NOT choice indices
  "expect": { … }                      // shape is discriminated by `op` (below)
}
```

> **Post-process default matters for expected output.** `render()` defaults `postProcess:
> true`, and the pipeline **capitalizes the first letter** — so a raw pick `a` emerges as
> `A`, `товара` as `Товара`. A case asserting the raw selection/resolution stage must set
> `postProcess: false`; a case exercising the post-process pipeline leaves it at the default.

`expect` is **discriminated by `op`** — each op has its own shape, they do not share `output`:

- `op:'render'|'neutralize'` + `kind:'deterministic'` → `expect: { output: "…" }`, asserted
  **exact in both engines**.
- `op:'extract'` → `expect: { refs: [...], sets: [...], includes: [...] }`, asserted exact
  (order-normalized) in both engines. (`extract()` returns an object, never a string.)
- `op:'validate'` → `expect: { verdict: 'valid' | 'invalid', diagnostics?: [{ code, line, column }] }`
  (codes are parity-gated, wording is not — §3.1). Uses the case's `locale`/`knownIncludes`.
- `kind:'rng'` (render only) → assert **within-engine reproducibility** + the §7.2 structural
  invariants only; **never** a cross-engine exact-output gate.

**Why `rng` strategy ≠ `seed`.** Most exact-output PHP tests fix the *pick* by injecting a
selection strategy (`make_first`/`make_last`/`make_sequence`, `ParserTest`), not a PRNG
seed. A `seed` is engine-private (PHP `mt_rand` ≠ any JS PRNG), so seed-only fixtures push
separator/config/join behavior into the invariant-only bucket where a broken separator still
passes. The injected `rng` strategy is what turns those ~45% of assertions into **exact
cross-engine gates**. Both engines already expose the injection point (PHP `Parser`'s
`$random_fn`; TS mirrors it).

**`rng` semantics — pin exactly.** Both engines inject a **raw RNG of signature
`(min, max) => int`**, NOT a choice-index picker. Verified against `ParserTest.php:17-47`:

- `"first"` ⇒ `fn(min, max) => min`; `"last"` ⇒ `fn(min, max) => max`.
- `{ "sequence": [v0, v1, …] }` ⇒ each `vi` is a **raw RNG return value**, clamped to the
  call's range as `max(min, min(max, vi))`, consumed in order; **after the sequence is
  exhausted the last value is reused** for every further call.

A TS extractor that treats `sequence` elements as 0-based choice indices instead of raw
clamped RNG returns will silently diverge from PHP — the values are RNG outputs, not picks.

### 7.2 RNG structural invariants (per construct)

For `kind:'rng'` cases, assert these instead of exact output:

- **Enumeration** `{…}`: output ∈ the recursively-resolved alternative set.
- **Permutation** `[…]`: output is a subset of the elements, size ∈ `[minsize, maxsize]`
  (post-clamp §4.2), each element carrying its own per-element separator, joined by
  `sep`/`lastsep`, in any order.
- **Nested** constructs: the invariant holds recursively on every resolved sub-construct.

---

## 8. Reference consumers (dogfood the API)

**Why this is in the spec, not deferred.** A library API designed in a vacuum looks clean
and fits nothing — the same class of miss as shipping the plugin's 2.0.0 bindings without
the ACF integration smoke (see the parent's release-checklist gates). The fix is to design
the public API *against a real consumer* and make a working consumer the **acceptance gate**
for that API. So the API contract (§9.2) is committed now, and two reference consumers are
first-class deliverables — **built after M2 (render works), never before M1**, because you
cannot dogfood an engine that does not exist yet.

**Purity boundary (non-negotiable).** Consumers **import `@spintax/core`; the engine never
imports them.** They live in `examples/` in this monorepo and depend only on the published
engine surface (§9.2) — no reaching into internals. This is what lets a consumer *prove* the
API without *polluting* it; §2.2 (no HTTP/bot/host concepts in the engine) still holds.

Two consumers, chosen to stress the API differently:

1. **`examples/worker` — thin Cloudflare Worker (FIRST, the dogfood gate; roadmap Phase 4).**
   HTTP-shaped, stateless, minimal non-engine scaffolding — the smallest thing that exercises
   the *whole* public surface. Endpoints map to package calls: `validate-template` →
   `validate()`, `preview-render` → seeded `render()`, `extract-variables` → `extract()`,
   `analyze-template` → `analyze()`. `render-batch` is a **host loop** over
   `render(ast, { seed: base + i })` — the batching/dedupe product layer lives in the Worker,
   not core (§9.3). The Worker owns HTTP, auth, rate limiting, and **shielding of
   caller-supplied context** (§6, T2). The engine owns nothing network. Shipping this Worker
   green **is** the sign-off that the §9.2 contract is usable.
2. **`examples/telegram-bot` — Telegram authoring bot (SECOND, the flagship example; roadmap
   Phase 5).** Interactive/stateful — catches what the stateless Worker cannot: multi-turn
   drafting, "show me N variants", plain-language explanation of validation failures, export
   of a WordPress-ready body. Imports `@spintax/core` directly (a second, independent dogfood
   path) or calls the Worker API. No third engine.

- **Web playground on `spintax.net`** runs the package **client-side** (pure TS, no server
  for validate/preview) — a strong SEO/education asset (roadmap §4.1) at near-zero hosting
  cost. Not a dogfood gate, but a fourth surface that falls out for free.

Payoff of a named package over an inlined Worker dependency: one engine, four surfaces, and
each consumer keeps the API honest from a different angle.

---

## 9. Package & repo shape

### 9.1 Monorepo layout

```
packages/
  core/           # @spintax/core — pure engine (§9.2). ZERO runtime deps.
  conformance/    # @spintax/conformance — shared golden corpus, fixtures/*.json §7 (Q3 resolved; published later)
  cli/            # @spintax/cli — deferred until after the M4/publish gate (Q4 resolved)
examples/
  worker/         # thin Cloudflare Worker — FIRST dogfood gate (§8), roadmap Phase 4
  telegram-bot/   # Telegram authoring bot — flagship example (§8), roadmap Phase 5
```

`examples/*` import `@spintax/core` only; they are consumers, never imported by the engine
(§8 purity boundary).

- **Language:** TypeScript, ESM-first, dual CJS build, zero runtime deps in `@spintax/core`
  (target: runs on Workers, Node 18+, and in-browser unchanged).
- **Naming (Q2 — availability checked 2026-07-05):** bare `spintax` on npm is **taken** by
  a real, active, same-domain MIT package (`spintax@1.1.2`, maintainer `johnhenry`,
  "combinatorial string generator", republished 2025-04-16) — NOT a squatter, so
  npm's name-dispute policy will not transfer it. `github.com/spintax` is also taken. **The
  whole `@spintax/*` scope is free** (`@spintax/core`, `@spintax/cli`, `@spintax/conformance`
  all 404). **Direction: claim the npm org `spintax` and publish scoped `@spintax/*`** — the
  scope + org is the brand asset for `spintax.net`; the bare unscoped name is not required.
  Fallback handles if the org can't be claimed: `spintax-js` / `spintaxjs` (both free on npm
  AND GitHub). Action needed from the maintainer (needs npm auth — cannot be automated here):
  create the `spintax` npm org (free for public packages) or publish a `@spintax/core@0.0.0`
  placeholder to reserve the scope.
- **Repo:** `W:\projects\spintax-js` (created; git `main`), own CI + memory namespace (mirror
  the OpenCart port's spin-off). GitHub remote handle TBD (`spintax-js` free, or under
  `investblog`).

### 9.2 Public API contract (`@spintax/core`)

This is the committed surface the reference consumers (§8) are built against and the API
acceptance gate checks. Signatures are the contract; names/shapes may be refined only with a
consumer-driven reason, not casually. TypeScript sketch:

```ts
parse(src: string): Ast
render(input: string | Ast, opts?: RenderOptions): string   // bare string; batching is a host concern (§9.3)
validate(input: string | Ast, opts?: ValidateOptions): Diagnostic[]
extract(input: string | Ast): { refs: string[]; sets: string[]; includes: string[] }
analyze(input: string | Ast, opts?: ValidateOptions): {   // cautious "stats" layer — see §9.3 caveat
  diagnostics: Diagnostic[]
  refs: string[]; sets: string[]; includes: string[]
  constructs: Record<string, number>       // best-effort construct counts, NOT variant cardinality
}
neutralize(value: string): string          // §6 text-safe shielding (host applies to T2 values)

interface RenderOptions {
  context?: Record<string, string>          // variable map; T1 (author-controlled) by default §6
  seed?: number | string                    // deterministic RNG; omit ⇒ nondeterministic
  locale?: string                           // plural buckets §3.1; default EN-style 2-form
  includeResolver?: (ref: string) => string | null   // host-injected §4.1; SYNC (two-phase prefetch, §4.1); omit ⇒ #include disabled
  postProcess?: boolean                     // default TRUE (§0.1); false = skip COSMETIC spacing/caps ONLY —
                                            //   the mandatory neutralize safety restore still runs (§6)
  maxDepth?: number                         // include + parse-nesting guard; safe default (e.g. 20) if omitted
}

interface ValidateOptions {                 // validation is locale- and include-aware (§3.1)
  locale?: string                           // plural-bucket verdicts; SAME vocab as render/corpus; omit ⇒ default 2-form
  knownIncludes?: readonly string[]         // slug/id allow-list; enables "unknown #include target" errors
                                            //   (omit ⇒ include targets are NOT verdict-checked — parity with the plugin)
  knownVariables?: readonly string[]        // host-supplied var names (globals/context); suppresses the
}                                           //   `variable.undefined` WARNING for them (verdict unaffected). Case-insensitive.

interface Diagnostic {
  severity: 'error' | 'warning'
  code: string                              // STABLE machine code (parity gate; wording may vary)
  message: string                           // human-readable (NOT parity-gated)
  line: number                              // 1-based
  column: number                            // 1-based
  endLine?: number                          // 1-based; span end, for editor/playground underlines
  endColumn?: number                        // 1-based
  data?: Record<string, unknown>            // structured specifics keyed off `code`
                                            //   (e.g. { expected: 3, got: 2 }) so a bot/API
                                            //   builds copy WITHOUT parsing `message`
}

// Additional committed value exports (kept minimal per §9.3):
export const DEFAULT_MAX_DEPTH = 20         // RenderOptions.maxDepth default

class SpintaxError extends Error {}         // base for render() programmer-error throws
class IncludeResolverError extends SpintaxError {}   // a host includeResolver threw
class AstVersionError extends SpintaxError {}        // an incompatible Ast was passed back
class NotImplementedError extends SpintaxError {}    // reserved guard for unimplemented paths
```

> **No `MaxDepthExceededError`** (revised after the `examples/worker` dogfood, §8). Exceeding
> `maxDepth` — a circular / too-deep `#include` or runaway variable recursion — is **lenient**:
> the guard resolves to `''`, matching the plugin (which logs and returns `''`). Throwing would
> break the "never throws on content" contract, so no depth-breach error is exported. `render()`
> throws only on a resolver that itself throws (`IncludeResolverError`) or a foreign `Ast`
> (`AstVersionError`).

Contract rules (parity-relevant — see §3.1):

- **`validate()` verdict = parity gate.** "Valid" ⇔ no `severity:'error'`. The set of inputs
  that produce an error must match the plugin (malformed brackets, plural arity/form errors,
  nested brackets in plural form slots). Two verdicts are **`opts`-dependent**: plural
  form-count validation is **locale-sensitive** (`{plural 2: one|many}` is valid for `en` but
  an arity error for `ru` 3-form — needs `opts.locale`), and **unknown `#include` target** is
  only checked when `opts.knownIncludes` is supplied (parity with the plugin's slug-list
  gate). **Circular `#include` is NOT a verdict here** — it is a render-time `maxDepth`
  guard (§3.1, §4.1), because static `validate()` cannot resolve host-injected includes. An
  unresolved `%var%` that may legitimately come from the host is a **`warning`, not an
  `error`** (mirrors the plugin's non-blocking behavior).
- **`render()` is lenient, never throws on malformed markup.** A single bad construct renders
  verbatim with fullwidth braces (U+FF5B / U+FF5D), matching the plugin — a bad block must not
  crash the page/bot/Worker. `render()` may throw only on programmer error (e.g. an
  `includeResolver` that itself throws), not on template content.
- **Determinism.** With a fixed `seed` + `context` + `locale`, `render()` is reproducible
  *within this engine*. Cross-engine RNG-sequence parity with PHP is a NON-goal (§3.2).
- **`Ast` is opaque/versioned**, not a public data contract in v1 — consumers pass it back to
  `render()`/`validate()`/`extract()`/`analyze()`, they don't introspect it. It is an
  in-memory perf handle, **not a serialization format** — do not persist it across engine
  versions (relevant to the bot caching a draft's Ast between turns). (Revisit if a real
  consumer needs introspection.)

### 9.3 Deliberately NOT in core v0.1 — the product layer lives in the Worker/bot

Design principle: **small core, rich Worker/bot.** `@spintax/core` ships *primitives*;
convenience/product surfaces are built on top by the reference consumers (§8), so the engine
stays small and universally embeddable. Explicitly **out** of the committed v0.1 surface:

- **`renderBatch()` / "N distinct variants".** N seeded renders + dedupe is a host loop over
  `render(ast, { seed: base + i })`; the Worker's `render-batch` and the bot's "show N" own
  it. Core's primitive is `render(string | Ast)` — parse once, render many.
- **`randomSeed()` helper.** Seed generation is a host concern (`Math.random()` / the
  runtime's RNG); not part of the surface.
- **Exact variant cardinality.** `analyze().constructs` gives best-effort construct counts,
  **not** a precise count of possible outputs — `%var%` / `#include` / nesting make it
  indeterminate. We do not promise cardinality as a contract.
- **A large typed-error hierarchy.** `render()` throws only on programmer error (a resolver
  that throws, an incompatible `Ast`, a depth breach); v0.1 keeps that minimal, not a
  taxonomy.

Any of these may be promoted into core later **only** with a consumer-driven reason (the §8
rule), after the Worker proves the need — never speculatively.

---

## 10. Open questions (need sign-off before coding)

- ~~**Q1 — post-process parity.**~~ **RESOLVED (§0.1): YES, parity-target** with a
  `postProcess: false` escape hatch.
- ~~**Q5 — license.**~~ **RESOLVED (§0.1): MIT** for the npm packages; WP plugin stays GPL
  (MIT/Expat is GPL-compatible). Caveat on verbatim GPL transcription noted in §0.1.
- ~~**Q2 — npm naming.**~~ **RESOLVED (§9): scoped `@spintax/*`.** Bare `spintax` is taken by
  an active MIT package (not disputable); the whole `@spintax/*` scope is free. Direction is
  set — publish scoped `@spintax/core|cli|conformance`, fallback `spintax-js`. The only
  remainder is a one-time maintainer action (claim the `spintax` npm org / reserve the scope,
  needs npm auth); that is an operational step, not a spec decision, so it does not block code.
- ~~**Q3 — corpus home.**~~ **RESOLVED: live in THIS repo at
  `packages/conformance/fixtures/*.json`**, published later as `@spintax/conformance`. During
  M0 the parent PHP suite reads the fixtures by a local path / env var (or a worktree/submodule
  path); a git submodule is explicitly NOT the first step — too much ceremony before the
  corpus stabilizes. Promote to a published package only once the schema (§7.1) and cases have
  settled. (§7, §9.1.)
- ~~**Q4 — CLI now or later.**~~ **RESOLVED: deferred.** No public `@spintax/cli` promises
  now; the CLI is deferred until **after the M4/publish gate**. The only exception is a tiny
  *internal, non-published* corpus runner if M0/M0.5 tooling needs one — that is not the
  public CLI. (§9.1, §9.3 principle.)
- ~~**Q6 — versioning independence.**~~ **RESOLVED: `@spintax/core` semver is independent of
  the WP plugin's version.** "**Syntax v1**" = the compatibility surface of the §3.1 parity
  contract **plus** the §7.1 fixture-schema major. A change to the accepted syntax surface or
  the validation verdict set is a **breaking** change for `@spintax/core`; a new host
  integration (WP/Worker/bot) does NOT bump the syntax version. `Ast` version (§9.2) tracks
  the in-memory handle and may move independently of syntax v1.

---

## 11. Suggested milestones (once questions close)

1. **M0 — corpus extraction.** **First task: lock the §7.1 fixture schema** (incl. the `rng`
   selection-strategy discriminator). Then turn the ~276 parity-relevant PHPUnit cases (§3.1)
   + post-process cases into the shared golden corpus. Do this *before* any TS, so the port
   has a target. Cross-repo: the PHP-side corpus runner is a parent-repo `W:\projects\spintax\`
   change — its owner/wiring is assigned there, outside this repo's implementer scope.
1.5. **M0.5 — repo tooling / test harness.** Strict `tsconfig`, build (tsup/unbuild), test
   runner (vitest) wired to read the corpus, dual ESM/CJS + `exports` map + `types` entry, CI
   green on an empty suite. M1's "pass corpus cases" presumes this exists — make it an
   explicit gate (this is what resolves the repo's outstanding "Commands TBD").
2. **M1 — parser + validator.** Parse the full §4 surface; pass all deterministic
   validation-verdict corpus cases. No rendering yet.
3. **M2 — renderer + post-process.** Seeded render; pass deterministic render + post-process
   corpus. RNG cases pass structural invariants.
4. **M3 — extract + neutralize + docs.** Public API surface (§9.2) complete; README. **Do
   NOT publish `0.1.0` yet** — the §8 acceptance gate (M4 Worker) must dogfood the contract
   first; publishing before that inverts §8's own thesis. Tag an internal `0.1.0-rc` at most.
5. **M4 — `examples/worker` (API acceptance gate).** Thin Cloudflare Worker exposing the
   Phase 4 endpoints (`validate-template`, `preview-render`, `render-batch`,
   `extract-variables`, `analyze-template`) importing `@spintax/core`. Green Worker = sign-off
   that the §9.2 contract is usable from a real consumer (§8). Any API friction found here
   feeds back into §9.2 *before* the bot. **Publish `0.1.0` to npm once the Worker is green**
   — the contract is dogfooded, so the public version ships behind the acceptance gate, not
   before it (M3).
6. **M5 — `examples/telegram-bot` (flagship example).** Interactive/stateful consumer:
   draft-from-brief, validate-pasted, show-N-variants, plain-language error explanation,
   export WP-ready body. Second independent dogfood path (§8).
7. **M6 — browser playground** on `spintax.net` running the package client-side (SEO/edu).

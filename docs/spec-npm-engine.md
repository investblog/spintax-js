# Spintax npm engine — `@spintax/core` (spec draft)

Status: DRAFT (spec-first — repo scaffolded at `W:\projects\spintax-js`, engine code pending M1)
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
- **Variable extraction** — enumerate `%var%` references and `#set` definitions in a
  template (powers the roadmap's `extract-variables` endpoint and author tooling).
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
  circular `#include`, plural arity/form errors, nested brackets in plural forms), the
  package's validator also rejects — and what it accepts, the package accepts. Diagnostic
  *wording* may differ; **pass/fail classification may not**.
- **Plural grammar buckets.** Given the same locale + count, both engines pick the same
  form slot (RU/UK/BE 3-form one|few|many; EN-style 2-form). This is deterministic math,
  not RNG — it must match exactly. (Reference: `plugin/src/Core/Engine/Plurals.php`.)
- **Conditional truthiness.** `{?VAR?…}` "set + non-whitespace" truthiness, inverted
  `{?!VAR?…}`, resolution before AND after `%var%` expansion — identical rules.
- **`#set` collapse-once semantics.** An enumeration in a `#set` value collapses once at
  set-time to a single stable value (plugin Renderer Stage 4b, 2.2.1) so `{plural %n%: …}`
  sees a numeric count. This is a *semantic* rule, not RNG, and must match.

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
| Permutation configured | `[<minsize=2;maxsize=3;sep=", ";lastsep=" and "> …]` | syntax + minsize/maxsize default rules |
| Per-element separator | `[<, > a\|b < and >\|c]` | syntax; sep travels with element on shuffle |
| Variable ref | `%var%` (case-insensitive) | syntax |
| Local set | `#set %v% = value` | syntax + collapse-once (§3.1) |
| Conditional | `{?VAR?then\|else}`, `{?!VAR?…}` | syntax + truthiness (§3.1) |
| Plural | `{plural <count>: one\|few\|many}` | syntax + bucket math (§3.1); rejects nested brackets in form slots |
| Block comment | `/#...#/` | syntax (stripped) |
| Include | `#include "slug-or-id"` | syntax + circular guard; **resolver is host-injected** (§4.1) |

### 4.1 `#include` resolution is host-injected

The package cannot know how to fetch template `"slug-or-id"` — in WP it's a CPT lookup, in
the API it's a store/DB call, in the bot it may be disallowed entirely. The engine accepts
an **include resolver callback** `(ref: string) => string | null`; the circular-reference
guard and scope-isolation rules (child inherits global+runtime vars, NOT parent `#set`
locals — plugin key design decision) live in the engine, but the *fetch* is the host's.

### 4.2 minsize/maxsize defaults (parity)

Port exactly (plugin key design decision): only `maxsize` set → `minsize = 1` (not total);
only `minsize` set → `maxsize = total`. Auto-spacing: purely-alphabetic separators get
padded with spaces; punctuation separators do not.

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
heaviest golden-corpus coverage (§7).

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
  `neutralize()` helper (port of `SpintaxShield`) so a host that feeds *data-derived*
  values (a CMS field, a product description, user input) into the context can shield them
  before handing them to the engine — same discipline as the plugin's T2 sources. The
  engine does not auto-shield, because it cannot know which context keys are T1 vs T2. The
  **API/bot host** is responsible for shielding untrusted input (matters a lot once the
  Phase 4 API accepts arbitrary caller-supplied variable maps — see §8).

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
- Corpus lives where both repos can pull it (shared submodule, or published as
  `@spintax/conformance`). This is what keeps the two engines honest over time without
  forcing byte-parity everywhere.

The plugin currently sits at 577 PHPUnit tests — many encode exactly these semantics and
are the raw material for the corpus.

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
   the *whole* public surface. Endpoints map 1:1 to package calls: `validate-template` →
   `validate()`, `preview-render` → seeded `render()`, `render-batch` → N seeded renders,
   `extract-variables` → `extractVariables()`, `analyze-template` → validator + extraction +
   stats. The Worker owns HTTP, auth, rate limiting, and **shielding of caller-supplied
   context** (§6, T2). The engine owns nothing network. Shipping this Worker green **is** the
   sign-off that the §9.2 contract is usable.
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
  conformance/    # @spintax/conformance — shared golden corpus §7 (pending Q3)
  cli/            # @spintax/cli — npx spintax validate|render|extract (pending Q4)
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
render(input: string | Ast, opts?: RenderOptions): string
validate(src: string): Diagnostic[]
extractVariables(src: string): { refs: string[]; sets: string[] }
neutralize(value: string): string          // SpintaxShield port §6 (host applies to T2)

interface RenderOptions {
  context?: Record<string, string>          // variable map; T1 (author-controlled) by default §6
  seed?: number | string                    // deterministic RNG; omit ⇒ nondeterministic
  locale?: string                           // plural buckets §3.1; default EN-style 2-form
  includeResolver?: (ref: string) => string | null   // host-injected §4.1; omit ⇒ #include disabled
  postProcess?: boolean                     // default TRUE (§0.1); false = raw, for tooling
  maxDepth?: number                         // circular/runaway guard for nested #include
}

interface Diagnostic {
  severity: 'error' | 'warning'
  code: string                              // STABLE machine code (parity gate; wording may vary)
  message: string                           // human-readable (NOT parity-gated)
  line: number                              // 1-based
  column: number                            // 1-based
}
```

Contract rules (parity-relevant — see §3.1):

- **`validate()` verdict = parity gate.** "Valid" ⇔ no `severity:'error'`. The set of inputs
  that produce an error must match the plugin (malformed brackets, circular `#include`,
  plural arity/form errors, nested brackets in plural form slots). An unresolved `%var%` that
  may legitimately come from the host is a **`warning`, not an `error`** (mirrors the plugin's
  non-blocking behavior).
- **`render()` is lenient, never throws on malformed markup.** A single bad construct renders
  verbatim with fullwidth braces (U+FF5B / U+FF5D), matching the plugin — a bad block must not
  crash the page/bot/Worker. `render()` may throw only on programmer error (e.g. an
  `includeResolver` that itself throws), not on template content.
- **Determinism.** With a fixed `seed` + `context` + `locale`, `render()` is reproducible
  *within this engine*. Cross-engine RNG-sequence parity with PHP is a NON-goal (§3.2).
- **`Ast` is opaque/versioned**, not a public data contract in v1 — consumers pass it back to
  `render()`, they don't introspect it. (Revisit if a real consumer needs to.)

---

## 10. Open questions (need sign-off before coding)

- ~~**Q1 — post-process parity.**~~ **RESOLVED (§0.1): YES, parity-target** with a
  `postProcess: false` escape hatch.
- ~~**Q5 — license.**~~ **RESOLVED (§0.1): MIT** for the npm packages; WP plugin stays GPL
  (MIT/Expat is GPL-compatible). Caveat on verbatim GPL transcription noted in §0.1.
- **Q2 — npm naming.** `@spintax/core` scope vs unscoped name; who owns the npm org.
- **Q3 — corpus home.** Shared git submodule vs published `@spintax/conformance` package vs
  duplicated fixtures kept in sync by CI.
- **Q4 — CLI now or later.** Is `npx spintax validate` an early adoption driver (author/CI
  ergonomics) worth building alongside core, or strictly deferred?
- **Q6 — versioning independence.** The npm engine's semver is decoupled from the plugin's
  version — confirm, and define what "syntax v1" compatibility means across both.

---

## 11. Suggested milestones (once questions close)

1. **M0 — corpus extraction.** Turn the parity-critical PHPUnit cases (§3.1) + post-process
   cases into the shared golden corpus. Do this *before* any TS, so the port has a target.
2. **M1 — parser + validator.** Parse the full §4 surface; pass all deterministic
   validation-verdict corpus cases. No rendering yet.
3. **M2 — renderer + post-process.** Seeded render; pass deterministic render + post-process
   corpus. RNG cases pass structural invariants.
4. **M3 — extract + neutralize + docs.** Public API surface (§9.2) complete; README; publish
   `0.1.0` to npm.
5. **M4 — `examples/worker` (API acceptance gate).** Thin Cloudflare Worker exposing the
   Phase 4 endpoints (`validate-template`, `preview-render`, `render-batch`,
   `extract-variables`, `analyze-template`) importing `@spintax/core`. Green Worker = sign-off
   that the §9.2 contract is usable from a real consumer (§8). Any API friction found here
   feeds back into §9.2 *before* the bot.
6. **M5 — `examples/telegram-bot` (flagship example).** Interactive/stateful consumer:
   draft-from-brief, validate-pasted, show-N-variants, plain-language error explanation,
   export WP-ready body. Second independent dogfood path (§8).
7. **M6 — browser playground** on `spintax.net` running the package client-side (SEO/edu).

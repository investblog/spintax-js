# @spintax/conformance

Shared **golden corpus** for the Spintax parity contract — language-neutral JSON fixtures
consumed **identically** by every engine in the family: the TypeScript engine (`@spintax/core`,
via vitest), **both** PHP engines (the `spintax/core` Composer package and the WordPress plugin,
via the PHPUnit runner in `php/`), the Python engine (`spintax-core`, whose CI checks this repo
out) and the Object Pascal engine (`spintax-win`, via its `check-corpus.sh` gate). This is what
keeps five independent implementations honest without forcing byte-for-byte parity everywhere.
See the governing spec §7 / §7.1.

> Status: **the live contract.** The M0 extraction is long done; fixtures grow whenever a
> behaviour becomes contract — recognition rules (#55–#57), the permutation-config guard (#58),
> `/# … #/` comments, the neutralize-vs-cosmetics answer, the definition-graph emission shapes.
> The npm publication deferred by spec §10 Q3 was never needed: every consumer reads the files
> from a checkout of this repository.

## Layout

```
schema/fixture.schema.json   # JSON Schema (draft 2020-12) — a corpus file is an array of cases
fixtures/*.json              # arrays of cases, grouped by category
```

## Case shape (§7.1)

Every case is one object. `kind` is **the discriminator** that decides the assertion mode:

| field | meaning |
|---|---|
| `id` | stable unique slug, e.g. `plural/ru-few` |
| `kind` | `deterministic` (exact output asserted in every engine that asserts the case) or `rng` (within-engine reproducibility + §7.2 invariants only) |
| `op` | `render` \| `validate` \| `extract` \| `neutralize` |
| `template` | the spintax source |
| `context` | optional variable map (string→string, T1) |
| `locale` | optional plural-bucket locale (§3.1) |
| `knownIncludes` | optional; `validate`/`analyze` only — enables "unknown #include target" verdicts |
| `seed` | PRNG seed for `kind:rng` cases (engine-private; never a cross-engine equality basis) |
| `postProcess` | optional bool, **default `true`** (mirrors `render()`); set `false` to assert raw pre-cosmetic output. render/analyze only |
| `neutralizeContext` | optional string[]; render only — harness `neutralize()`s these context keys before rendering (tests the neutralize→render round-trip; asserts the final literal output, mechanism-independent) |
| `rng` | injected selection strategy, **orthogonal to `seed`** (see below) |
| `engines` | optional `("ts"\|"php"\|"py")[]`; absent = **all engines**. An explicit list marks a deliberate divergence — e.g. `["ts","py"]` for behaviour the PHP plugin does not provide. A runner skips cases whose `engines` omit its own id |
| `expect` | shape **discriminated by `op`** (see below) |

> **`neutralize()`'s glyph-restore is not universal.** The plugin's `SpintaxShield`
> entity-encodes (`{`→`&#123;`) and never decodes — its literal glyph only appears in an HTML
> browser. `@spintax/core` and the Python engine restore literal glyphs in any sink (§6), so the
> `neutralize/roundtrip-*` cases are tagged `"engines": ["ts","py"]` and the PHP runner skips
> them. `neutralize/identity-plain` (no structural chars) carries no tag, but the PHP runner
> skips the whole `op: neutralize` — the plugin has no standalone neutralize to call — so in
> practice it too is asserted by TS and Python only.
>
> Worth knowing before trusting a green: `identity-plain` alone is passed by a `neutralize()`
> that returns its input unchanged. The round-trips are what actually gate the shielding, so an
> engine that omits itself from them is not testing `neutralize` at all.

> **Post-process gotcha.** `render()` defaults `postProcess: true`, and the pipeline
> capitalizes the first letter — so a raw pick `a` renders as `A`, `товара` as `Товара`.
> A case that means to assert the raw selection/resolution stage must set `postProcess: false`.

### `expect` by `op`

- `render` / `neutralize` (deterministic) → `{ "output": "…" }` — exact in every asserting engine.
- `render` (`kind:rng`) → structural invariants: `{ reproducible, oneOf?, subsetOf?, sizeRange?, separator?, lastSeparator? }`.
- `extract` → `{ refs?, sets?, defs?, includes? }` — arrays order-normalized before comparison.
  `sets` and `defs` are separate buckets: the two directives differ in semantics (`#set` is a
  macro, `#def` rolls once), so a consumer that lints one must be able to tell them apart.
- `validate` → `{ verdict: "valid"|"invalid", diagnostics?: [{ code, severity?, line?, column? }] }`.
  **`verdict` is asserted exactly; `diagnostics` is a SUBSET assertion** — every listed
  `{code[, severity]}` must be present in the engine's output, but extras are allowed (a
  template can legitimately raise more than the salient diagnostic — e.g. a malformed `#set`
  also yields an `variable.undefined` warning). `code` is parity-gated; wording/position are not.

### Diagnostic codes (canonical, parity-gated)

`validate` cases assert the `code` (+ `severity`), **not** `line`/`column` — positions are not
parity-gated (§3.1); the plugin hardcodes many, the TS engine may be more precise. The corpus
is the source of truth for these stable codes; every engine maps its diagnostics onto them.

**How forms are counted** (spintax-js#66 — every engine got this wrong the same way): `render`
expands `%variables%` and only THEN splits the form list, so a validator that counts the raw
source judges a different string. Substitute definition values — every reference per pass, as
the renderer does — and split the result.

**Count only what is provably invariant.** A value carrying any bracket — all four, and
conditionals too — is not counted. Note what that claim is and is not: construct-free is a
*sufficient* condition for the count to be invariant, **not a necessary one**. `{a|b}` really
does always freeze to one form. But `{?flag?a|b|c}` freezes as `a` or as `b|c`, and the two
cannot be told apart without evaluating the construct — so the rule proves the easy property
instead of guessing at the hard one. A
reference to such a value, a name the host may supply at render time (runtime context outranks
a definition of the same name), a name the template does not define, and a chain past the
expansion budget all suppress the count-based verdicts — `plural.arity` and
`plural.locale-missing` alike. Silence on an unknowable input is the rule; a confident wrong
answer is what it replaced. Predicting the roll was tried first and produced false errors.

**The renderer does not stay silent, and a host cannot pre-screen for that.** The suppression is a
validator policy; `render()` still has to decide, and it decides destructively — a form count that
disagrees with the locale degrades the block to the lenient fullwidth `｛…｝` fallback, in the
output the reader sees. Minimal case, no directives at all:

    You have %n% {plural %n%: %B% a|%B% b|%B% c}.

`validate(en)` and `analyze(en)` report no error; `render(en)` emits `｛plural 3: …｝`. So a host
that gates on "no error-severity diagnostics" can ship the fallback. Reported here rather than
fixed: closing it means the validator counting top-level separators before substitution, which is a
verdict change in five engines for a victim that needs both a variable inside a form slot AND a
form count wrong for the render locale. Measured 2026-08-23; what would move it into work is a
host hitting it in production.

One prediction is not a prediction: a `#set` named **directly** in the form slot is substituted
verbatim and is still spintax when the plural is decided, so its brackets earn
`plural.nested-brackets`. Reached through a `#def` it is rolled first and earns nothing.

| code | severity | condition |
|---|---|---|
| `bracket.unclosed` | error | an opening `{`/`[` never closed |
| `bracket.unexpected-closing` | error | a `}`/`]` with no matching opener |
| `bracket.mismatched` | error | `{` closed by `]` (or `[` by `}`) |
| `set.malformed` | error | `#set` not matching `#set %name% = value` |
| `def.malformed` | error | `#def` not matching `#def %name% = value` |
| `definition.duplicate-name` | error | a name defined more than once, by either directive in any combination |
| `def.include-in-value` | error | `#include` inside a `#def` value — includes resolve after the value is frozen (legal inside a `#set`) |
| `permutation.unknown-key` | error | config key not in {minsize,maxsize,sep,lastsep} |
| `permutation.minsize-not-integer` | error | `minsize=` value is not a run of ASCII digits (note: `0` passes `ctype_digit`, so it does NOT flag) |
| `permutation.maxsize-not-integer` | error | `maxsize=` value is not a run of ASCII digits |
| `plural.nested-brackets` | error | `{plural …}` forms slot contains `{}`/`[]`, or a `#set` reference in it carries them — a `#set` is substituted verbatim and is still spintax when the plural is decided |
| `plural.arity` | error | form count ≠ locale arity (only when `locale` given) |
| `plural.locale-missing` | **warning** | no locale normalizes AND the form count is not the render default (2). No verdict is filed without a locale — the template may be right for the locale the host renders with — but rendering resolves against the default, so the block would reach finished text as the fullwidth fallback. A 2-form block stays silent |
| `plural.count-macro` | error | the count slot resolves — transitively — to a `#set` macro still carrying `[` or `{` that does not open a conditional. Conditionals resolve *before* plurals and are exempt; a nested `{plural …}` resolves in the *same* pass and is not |
| `variable.self-reference` | error | a definition value references its own name |
| `variable.circular-reference` | error | a cycle among definitions (A→B→A), either directive |
| `variable.undefined` | **warning** | a `%var%`/conditional ref not defined locally or globally — may be runtime; does NOT invalidate |
| `include.unknown-target` | error | `#include` slug not in `knownIncludes` (only when supplied) |

**Not a verdict:** circular `#include` is a render-time `maxDepth` guard, never a `validate()`
error (the plugin's validator does not resolve includes).

**Not parity-gated: how MANY identical diagnostics come back.** The engines emit one
`variable.circular-reference` per NAME that takes part in, or leads to, a cycle (spintax-js#59,
decided 2026-08-18). They used to emit one per PATH, which is exponential on a converging diamond —
507 bytes produced 2 097 152 diagnostics and 547 bytes took a live endpoint out with HTTP 503. The
subset assertion is what made that invisible here, and it stays that way on purpose: a fixture
pins that a code IS present, never how often. Each engine pins its own multiplicity in its own
suite. The same goes for the route printed in the message — it is capped past a handful of names,
and where it is capped is not gated either.

**Not parity-gated: what a truncated explosion looks like.** Every engine bounds how much
text one render may produce by expanding `%variables%` (spintax-js#69) — `#set %a% = %b% %b%`
over `#set %b% = %a% %a%` doubles every pass, and 2^50 ended the process in all four before
the bound existed. The *contract* is that render terminates, stays lenient, and leaves the
references it could not afford as literal `%name%`. The exact output is NOT asserted, and no
fixture pins it: the engines expand by different mechanisms — a per-reference tree walk here
and in Python, a whole-text fixpoint in both PHP engines — so they stop at different places
and produce different byte counts for the same bomb (measured: 1 198 223 vs 599 191 characters
for the same input). Making those agree would mean rewriting one engine's expansion to match
another's traversal, for input that no author writes. Each engine pins its own bound in its
own suite instead.

## Known divergences, measured and not currently gated

These are places where the engines demonstrably differ and no fixture says so. They are recorded
here rather than in the issue tracker, because an open issue reads as "someone should change
this" — and in each case the measured answer was that changing it costs more than the difference
does. An implementer needs to know they exist; nobody needs to be nudged into fixing them.

**Diagnostic ORDER differs in all four engines, and the PHP API cannot express one.** Measured on
`%undef1%\n#include "missing"\n%undef2%` with `knownIncludes: ["known"]`:

| engine | order |
|---|---|
| `@spintax/core` | both `variable.undefined`, then `include.unknown-target` — includes appended last |
| `spintax-core` (py) | source order, and a test pins it |
| `spintax/core` (PHP) | returns `{errors, warnings}` — two lists, so an error and a warning have no relative order at all; its warnings also carry `line: 0` |
| `spintax-win` | `include.unknown-target` first, then the variable warnings |

**Order is not contract.** `code` and `severity` are what §3.1 gates, `diagnostics` is asserted as
a subset, and no fixture pins an order. A consumer that wants a stable order should sort by
position itself. Making it contract would mean changing the PHP two-list API for a property nobody
has asked for.

**A conditional that expansion introduces INTO a plural form list renders differently.** Both PHP
engines resolve it; `@spintax/core` and `spintax-core` do not. `#set %x% = {?flag?a|b|c}` used as
`{plural 1: one|%x%}` gives PHP `｛plural 1: one|b|c｝` and the others
`｛plural 1: one|｛? Flag? A|b|c｝｝` — both fall back, with different text; in some shapes PHP
resolves to a working render where the others do not. The **validators deliberately retreat there**
rather than pick a side: a form list whose macro path reaches a conditional gets no count verdict in
any engine, so no verdict is wrong anywhere. Picking a side would change two or three renderers,
which is a breaking change to finished text, for a shape no user has reported hitting.

**Four characters trim differently in post-process.** `render("x" + ch)` — is the trailing
character kept?

| character | `@spintax/core` | `spintax-core` | `spintax/core` (PHP) |
|---|---|---|---|
| form feed `U+000C`, NBSP `U+00A0`, line separator `U+2028` | trimmed | trimmed | **kept** |
| NUL `U+0000` | **kept** | **kept** | trimmed |

PHP's `trim()` charlist is `" \t\n\r\0\x0B"`; JavaScript's takes the Unicode whitespace set and
never NUL. Post-process *is* parity-gated, so this one is a genuine unresolved divergence rather
than a non-goal — it is here because a template that ends in an invisible is not something anyone
writes on purpose, and because NUL is the shielding sentinel, so changing the trim needs the
`neutralize()` round-trip checked first (spintax-js#52–#54 were all paid for in that area).

**What would move any of these into work:** someone rendering the same template through two engines
and getting output they cannot explain. Then the fix is worth its cost — and these notes are the
starting measurement.

### `rng` — pin exactly

`rng` injects a **raw RNG of signature `(min, max) => int`** (NOT a choice-index picker),
matching the plugin's `Parser::__construct($random_fn)` seam:

- `"first"` ⇒ `fn(min, max) => min`
- `"last"` ⇒ `fn(min, max) => max`
- `{ "sequence": [v0, v1, …] }` ⇒ each `vi` is a **raw RNG return**, clamped to the call's
  `[min, max]` as `max(min, min(max, vi))`, consumed in order; **after exhaustion the last
  value is reused**. Verified vs the plugin's `ParserTest.php:17-47`.

A `kind:deterministic` render case may carry an `rng` strategy to fix the picks — that makes
its output exact and cross-engine-comparable. `kind:rng` cases run in seeded (PRNG) mode and
assert invariants only.

> **Nested-enum deterministic cases must use order-independent `rng` sequences.** The
> engines consume enum RNG in different orders (and the TS tree-walk skips unpicked branches,
> so even the call count differs) — cross-engine RNG-sequence parity is a non-goal (§3.2). So
> a `{sequence}` on a nested enum only stays a valid cross-engine gate when every ordering
> yields the same output (e.g. `{a|{b|c}}` with `[1,1]`). Permutation is exact **as long as every
> engine follows the same pick→Fisher-Yates** — TS and PHP do, which is why its rng-strategy cases
> are unrestricted. That is an obligation on a new engine, not an observation: implement a
> different shuffle and those fixtures break, correctly.

## Validating fixtures against the schema

```
npm run validate    # ajv-cli, draft 2020-12
```

(Machine validation of every fixture is wired into CI at milestone M0.5.)

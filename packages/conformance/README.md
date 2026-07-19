# @spintax/conformance

Shared **golden corpus** for the Spintax parity contract — language-neutral JSON fixtures
consumed **identically** by the TypeScript engine (`@spintax/core`, via vitest) and the PHP
plugin (via a PHPUnit runner). This is what keeps two independent implementations honest
without forcing byte-for-byte parity everywhere. See the governing spec §7 / §7.1.

> Status: **schema-locked, seed fixtures only.** Real parity cases are extracted from the
> plugin's PHPUnit suite in milestone M0 (PRs 03–07). Published to npm later, once the schema
> and cases have stabilized (spec §10 Q3).

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
| `plural.nested-brackets` | error | `{plural …}` forms slot contains `{}`/`[]` |
| `plural.arity` | error | form count ≠ locale arity (only when `locale` given) |
| `plural.count-macro` | error | the count slot resolves — transitively — to a `#set` macro still carrying `[` or `{` that does not open a conditional. Conditionals resolve *before* plurals and are exempt; a nested `{plural …}` resolves in the *same* pass and is not |
| `variable.self-reference` | error | a definition value references its own name |
| `variable.circular-reference` | error | a cycle among definitions (A→B→A), either directive |
| `variable.undefined` | **warning** | a `%var%`/conditional ref not defined locally or globally — may be runtime; does NOT invalidate |
| `include.unknown-target` | error | `#include` slug not in `knownIncludes` (only when supplied) |

**Not a verdict:** circular `#include` is a render-time `maxDepth` guard, never a `validate()`
error (the plugin's validator does not resolve includes).

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

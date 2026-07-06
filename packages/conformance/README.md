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
| `kind` | `deterministic` (exact output asserted in BOTH engines) or `rng` (within-engine reproducibility + §7.2 invariants only) |
| `op` | `render` \| `validate` \| `extract` \| `neutralize` |
| `template` | the spintax source |
| `context` | optional variable map (string→string, T1) |
| `locale` | optional plural-bucket locale (§3.1) |
| `knownIncludes` | optional; `validate`/`analyze` only — enables "unknown #include target" verdicts |
| `seed` | PRNG seed for `kind:rng` cases (engine-private; never a cross-engine equality basis) |
| `postProcess` | optional bool, **default `true`** (mirrors `render()`); set `false` to assert raw pre-cosmetic output. render/analyze only |
| `rng` | injected selection strategy, **orthogonal to `seed`** (see below) |
| `expect` | shape **discriminated by `op`** (see below) |

> **Post-process gotcha.** `render()` defaults `postProcess: true`, and the pipeline
> capitalizes the first letter — so a raw pick `a` renders as `A`, `товара` as `Товара`.
> A case that means to assert the raw selection/resolution stage must set `postProcess: false`.

### `expect` by `op`

- `render` / `neutralize` (deterministic) → `{ "output": "…" }` — exact in both engines.
- `render` (`kind:rng`) → structural invariants: `{ reproducible, oneOf?, subsetOf?, sizeRange?, separator?, lastSeparator? }`.
- `extract` → `{ refs?, sets?, includes? }` — arrays order-normalized before comparison.
- `validate` → `{ verdict: "valid"|"invalid", diagnostics?: [{ code, severity?, line?, column? }] }` — `code` is parity-gated, wording is not.

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

## Validating fixtures against the schema

```
npm run validate    # ajv-cli, draft 2020-12
```

(Machine validation of every fixture is wired into CI at milestone M0.5.)

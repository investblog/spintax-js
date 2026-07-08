# Golden-corpus parity runner (PHP side)

Runs the shared language-neutral fixtures in [`../fixtures/*.json`](../fixtures) — the **same
files** the TypeScript [`@spintax/core`](../../core) suite consumes — through the **PHP Spintax
plugin's** WP-free Core engine, and asserts the fixtures' expected values.

**Why:** the corpus's `expected` values encode the plugin's behavior contract. The TS suite is
green against them, but that only proves TS is self-consistent with our *reading* of the PHP
engine. Running the same fixtures against the *actual* PHP engine closes the loop — green here
**and** green in TS = the deterministic parity contract is machine-verified in both engines, not
assumed. (See the repo `docs/spec-npm-engine.md` §3.1, §7.)

## Prerequisites

- PHP **7.4+** and [Composer](https://getcomposer.org/).
- A local checkout of the **PHP plugin** (this repo's sibling). The runner autoloads the engine
  from its `src/` directory — no WordPress, wp-env, or MySQL required (the Core engine classes
  are pure PHP).

## Run

```sh
cd packages/conformance/php
composer install

# Default: expects the plugin at ../../../../spintax/plugin/src (sibling ../spintax checkout).
vendor/bin/phpunit

# Or point at the plugin explicitly:
SPINTAX_PLUGIN_SRC=/path/to/spintax/plugin/src vendor/bin/phpunit

# Fixtures default to ../fixtures; override with SPINTAX_FIXTURES if needed.
```

## What it checks (and deliberately doesn't)

- **`op: validate`** — asserts the **verdict** (valid ⇔ no errors). Per-diagnostic `code`s are a
  TS-side surface (the plugin emits human messages, not machine codes), so they are **not**
  asserted — the verdict is the parity gate.
- **`op: render`** — replicates the plugin `Renderer::process_template` **stage order**
  (`Renderer.php:240-331`) on the WP-free primitives, stopping at (or before) `post_process` and
  **never** applying `wp_kses_post` (a WP sink concern, out of scope). Honours `postProcess:false`.
  - `kind: deterministic` → exact `output`, injecting the fixture's `rng` strategy.
  - `kind: rng` → structural invariants only (`oneOf` / `subsetOf` / `sizeRange` + distinctness);
    cross-engine RNG-sequence parity is a non-goal.
- **`op: extract`** — `sets` + `includes` via the engine's public methods; `refs` via the
  Validator regexes over the `#set`-stripped body.
- **`op: neutralize`** and any `engines: ["ts"]` fixture — **skipped**: neutralize is a deliberate
  TS-only divergence (the plugin entity-encodes and never decodes; `@spintax/core` restores literal
  glyphs).

## Note

The original plan placed this runner in the plugin repo. It lives here instead so the whole
conformance harness sits next to the corpus it drives and **nothing is written into the GPL plugin
repo** — the runner only *reads* the plugin's engine locally via `SPINTAX_PLUGIN_SRC`.

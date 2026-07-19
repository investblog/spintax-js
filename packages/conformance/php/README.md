# Golden-corpus parity runner (PHP side)

Runs the shared language-neutral fixtures in [`../fixtures/*.json`](../fixtures) — the **same
files** the TypeScript [`@spintax/core`](../../core) suite consumes — through the **PHP Spintax
plugin's** WP-free Core engine, and asserts the fixtures' expected values.

**Why:** the corpus's `expected` values encode the plugin's behavior contract. The TS suite is
green against them, but that only proves TS is self-consistent with our *reading* of the PHP
engine. Running the same fixtures against the *actual* PHP engine closes the loop — green here
**and** green in TS = the deterministic parity contract is machine-verified in each engine that
asserts it, not assumed. (See the repo `docs/spec-npm-engine.md` §3.1, §7.)

## Prerequisites

- PHP **7.4+** and [Composer](https://getcomposer.org/).
- A local checkout of a **PHP engine** — either the WordPress plugin or the `spintax/core` Composer
  package. The runner autoloads it straight from `src/`; no WordPress, wp-env or MySQL is required,
  because the Core engine classes are pure PHP.

## Run

```sh
cd packages/conformance/php
composer install

# Default: the WordPress plugin at ../../../../spintax/plugin/src (a sibling ../spintax checkout).
vendor/bin/phpunit

# Or name the engine explicitly. Both layouts work:
SPINTAX_PLUGIN_SRC=/path/to/spintax/plugin/src vendor/bin/phpunit   # plugin:  Spintax\      -> src/
SPINTAX_PLUGIN_SRC=/path/to/spintax-php/src   vendor/bin/phpunit    # package: Spintax\Core\ -> src/

# Fixtures default to ../fixtures; override with SPINTAX_FIXTURES if needed.
```

## In CI

Both directions are enforced, so neither side can drift alone:

- **Here** (`php-parity` in this repo's CI) — the corpus *as changed by a PR* is run against both PHP
  engines. A fixture cannot land unless the engines it binds already satisfy it. The consequence is
  deliberate: if a fixture describes behaviour the PHP side has not shipped yet, this goes red. Land
  the PHP change first, then the corpus.
- **In the plugin** (`conformance` in `investblog/spintax`) — every push runs this runner against
  `plugin/src`, and the release ZIP is gated on it.

Before both jobs existed, this was a manual gate — which is precisely how three post-process defects
reached users: a fix shipped in the plugin with no PHP-side test, because its only guard was a
fixture in *this* repository that nothing over there ever ran.

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
- **`op: neutralize`** and any fixture whose `engines` omits `"php"` — **skipped**: the
  glyph-restore is a deliberate divergence (the plugin entity-encodes and never decodes, while
  `@spintax/core` and the Python engine restore literal glyphs). Those cases are tagged
  `["ts","py"]`.
- **`defs`** in an `op: extract` expectation is **not asserted here yet**, so such fixtures are
  tagged to exclude PHP. `Parser::extract_directives()` already returns them — wiring it up and
  dropping the tag is a small, self-contained follow-up.

## Note

The original plan placed this runner in the plugin repo. It lives here instead so the whole
conformance harness sits next to the corpus it drives and **nothing is written into the GPL plugin
repo** — the runner only *reads* the plugin's engine locally via `SPINTAX_PLUGIN_SRC`.

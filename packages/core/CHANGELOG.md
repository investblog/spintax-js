# Changelog

All notable changes to `@spintax/core` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

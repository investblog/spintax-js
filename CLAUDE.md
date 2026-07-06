# @spintax/core — Spintax engine for JavaScript / TypeScript

## Project overview

Open-source, framework-agnostic **TypeScript port of the Spintax engine**, published to
npm. This is a **separate branch** of the Spintax project — a second free/OSS wedge
alongside the WordPress plugin, with **zero WordPress dependency**. It is the shared runtime
that will power the roadmap's Cloudflare Workers API, the Telegram bot, and a browser
playground on `spintax.net` — one engine, many surfaces.

- **Parent project (PHP/WordPress plugin):** `W:\projects\spintax` (the engine origin)
- **Governing spec:** `docs/spec-npm-engine.md` (in THIS repo) — read it before any design
  work; it is the source of truth for scope, the parity contract, and open questions. It
  references the parent repo `W:\projects\spintax\` for the PHP engine and roadmap docs.
- **Algorithm references:** the PHP plugin engine (`plugin/src/Core/Engine` + `Core/Render`
  in the parent repo), `W:\spintax-java` (Java origin), `W:\projects\spintax-opencart`
  (PHP port precedent for spinning a port into its own repo).
- **License:** MIT (see `LICENSE` and §Decisions). The WP plugin stays GPL; MIT/Expat is
  GPL-compatible.
- **Status:** DRAFT / pre-code. Scaffolding only. First code lands at milestone **M1**.

## Agent division of labour (IMPORTANT)

This repo runs a two-agent workflow with a hard role split:

- **Claude Code = implementer.** *This file (`CLAUDE.md`) governs you.* You design, write,
  and refactor the engine, tests, and tooling.
- **Codex = reviewer only.** `AGENTS.md` governs Codex and puts it under a **code-freeze**:
  it reviews diffs/PRs and produces comments, and must not write, edit, or create source
  files. If you (Claude) are asked to configure or invoke Codex, preserve that boundary —
  Codex reviews, Claude implements.

Do not weaken the code-freeze in `AGENTS.md` unless the user explicitly asks.

## Locked decisions (from the spec §0 / §0.1)

1. **Public OSS core engine.** `@spintax/core` is embeddable by anyone; the API and bot are
   its *consumers*, not private forks.
2. **Independent implementation, NOT a byte-for-byte port** of the PHP.
   - **Parity REQUIRED:** accepted syntax surface, validation pass/fail verdicts, plural
     grammar buckets, `{?…}` truthiness, `#set` collapse-once semantics, **and the
     post-process pipeline** (shielding / spacing / capitalization).
   - **Allowed to diverge:** RNG selection results, internal architecture, diagnostic
     message strings, performance.
3. **MIT** for all npm packages here. Keep the reimplementation clean — do **not** transcribe
   GPL-licensed PHP fragments verbatim (that would pull in GPL); reimplement from the
   behavior contract + the shared golden corpus instead.
4. **Post-process default on.** Public `render()` and the API `preview-render` default to
   `postProcess: true`; a low-level `postProcess: false` escape hatch exists for tooling.

## Parity contract (the whole point of this repo)

"Independent impl, but parity where it counts" is enforced by a **shared golden corpus** —
language-neutral JSON fixtures `(template, context, locale, seed) → expected`, consumed by
BOTH the PHP suite (parent repo) and this TS suite.

- **Deterministic cases** (validation verdicts, plural buckets, conditional truthiness,
  `#set` collapse, post-process output) assert exact output in both engines. These are the
  machine-checked parity gates.
- **RNG cases** run in seeded mode and assert *within-engine* reproducibility + structural
  invariants only (a permutation result is a valid shuffle of a valid subset). Cross-engine
  RNG-sequence parity is a NON-goal.

When in doubt about a behavior, the corpus + `spec-npm-engine.md` decide — not a guess.

## Architecture (planned — realised over the milestones)

npm workspaces monorepo, ESM-first + dual CJS, zero runtime deps (must run on Cloudflare
Workers, Node 18+, and in-browser unchanged):

```
packages/
  core/           # @spintax/core — parse / render / validate / extract / neutralize
  conformance/    # shared golden corpus — see spec §7 / Q3
  cli/            # (pending Q4) npx spintax validate|render|extract
examples/
  worker/         # thin Cloudflare Worker — FIRST dogfood gate (spec §8), roadmap Phase 4
  telegram-bot/   # Telegram authoring bot — flagship example (spec §8), roadmap Phase 5
```

`examples/*` import `@spintax/core` ONLY — they are consumers, never imported by the engine.
This purity boundary is non-negotiable (spec §8): a consumer *proves* the API, it must not
*pollute* it.

**Public API contract is committed in spec §9.2** — build against it; refine only with a
consumer-driven reason. Surface:

Design principle: **small core, rich Worker/bot** — core ships primitives; convenience
surfaces (`render-batch`, "N variants", stats) live in the consumers (§9.3). `validate`,
`extract`, and `analyze` all accept `string | Ast` so a consumer parses once and reuses.

- `parse(src): Ast` — `Ast` is opaque/versioned in v1, not introspected by consumers; an
  in-memory perf handle, NOT a serialization format (don't persist across engine versions)
- `render(input, { context, seed, locale, includeResolver, postProcess, maxDepth }): string`
  — lenient (never throws on malformed markup; bad block renders verbatim with fullwidth
  braces U+FF5B/U+FF5D); `postProcess` defaults TRUE. Bare string — batching is a host job
- `validate(input, opts?): Diagnostic[]` — **parity gate**: valid ⇔ no `severity:'error'`;
  unresolved `%var%` is a `warning`, not an `error`. `ValidateOptions { locale?, knownIncludes? }`
  — plural verdicts are locale-sensitive; unknown-`#include` is checked only with `knownIncludes`.
  **Circular `#include` is NOT a static verdict** — it's a render-time `maxDepth` guard
- `extract(input): { refs, sets, includes }` — includes enable the §4.1 two-phase prefetch
- `analyze(input, opts?): { diagnostics, refs, sets, includes, constructs }` — cautious stats
  layer (takes the same `ValidateOptions`); `constructs` is best-effort counts, NOT cardinality
- `neutralize(value): string` — text-safe/context-agnostic shielding (NOT the plugin's
  HTML-entity encoding — that only round-trips in an HTML sink; we target Telegram/plaintext
  too). Host shields data-derived (T2) input; the engine does NOT auto-shield. Its safety
  restore is **mandatory** — it survives `postProcess:false` (that flag skips cosmetics only)
- `Diagnostic` carries optional `endLine`/`endColumn`/`data` so a bot/API builds copy without
  parsing the (non-parity-gated) `message`

NOT in core v0.1 (spec §9.3): `renderBatch()`, `randomSeed()`, exact variant cardinality, a
large typed-error hierarchy — these are host/product concerns, promoted only on a
consumer-driven reason.

`#include` resolution is **host-injected** and **synchronous** (`(ref) => string | null`);
async sources use the two-phase pattern (`extract().includes` → host prefetch → sync map
resolver). The circular-reference guard and scope isolation (child inherits global+runtime
vars, NOT parent `#set` locals) live in the engine, the *fetch* does not.

## Milestones (spec §11)

- **M0 — corpus extraction.** FIRST lock the §7.1 fixture schema (incl. the `rng`
  selection-strategy discriminator, orthogonal to `seed`); then turn ~276 parity-relevant
  parent PHPUnit cases + post-process cases into the shared golden corpus. BEFORE any TS.
- **M0.5 — repo tooling / harness.** Strict tsconfig, build (tsup/unbuild), vitest wired to
  the corpus, dual ESM/CJS + `exports` map + `types`, CI green on empty suite. Resolves the
  "Commands TBD" below; M1 presumes it exists.
- **M1 — parser + validator.** Full syntax surface; pass all deterministic validation cases.
- **M2 — renderer + post-process.** Seeded render; pass deterministic render + post-process
  cases; RNG cases pass structural invariants.
- **M3 — extract + neutralize + docs.** API surface (§9.2) complete. Do NOT publish `0.1.0`
  yet (internal `-rc` only) — publish is gated on M4 green, per §8.
- **M4 — `examples/worker` (API acceptance gate).** Worker exposing the Phase 4 endpoints.
  Green Worker = sign-off that the §9.2 contract is usable → **publish `0.1.0` now**. API
  friction feeds back into §9.2 BEFORE the bot. Reference consumers are built AFTER M2, never
  before M1 (can't dogfood an engine that doesn't exist).
- **M5 — `examples/telegram-bot` (flagship example).** Interactive/stateful consumer; second
  independent dogfood path.
- **M6 — browser playground** on `spintax.net`, client-side.

## Commands

TBD — filled in at **M0.5** (build via tsup/unbuild, test via vitest are the likely picks;
not locked). Until then this repo is docs + scaffolding only.

## Conventions

- TypeScript strict, ESM-first, zero runtime dependencies in `@spintax/core`.
- No WordPress / ACF / WooCommerce / HTTP / caching concepts in the engine — those are host
  concerns (spec §2.2).
- Push to `main` once green (single-dev repo; mirror the parent's no-PR-unless-asked norm).
- Every behavior change is justified against the golden corpus, not vibes.

## Open questions still to close (spec §10)

Q3 corpus home (submodule vs published `@spintax/conformance`), Q4 CLI now-or-later,
Q6 versioning independence from the plugin. Q1 (post-process parity), Q2 (naming —
**scoped `@spintax/*`**, spec §9) and Q5 (MIT) are RESOLVED; treat naming as decided.
The only Q2 remainder is a manual npm-org claim, not a design choice.

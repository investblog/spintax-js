# @spintax/core — Spintax engine for JavaScript / TypeScript

## Project overview

Open-source, framework-agnostic **TypeScript port of the Spintax engine**, published to
npm. This is a **separate branch** of the Spintax project — a second free/OSS wedge
alongside the WordPress plugin, with **zero WordPress dependency**. It is the shared runtime
that will power the roadmap's Cloudflare Workers API, the Telegram bot, and a browser
playground on `spintax.net` — one engine, many surfaces.

- **Parent project (PHP/WordPress plugin):** `W:\projects\spintax` (the engine origin)
- **Governing spec:** `W:\projects\spintax\docs\spec-npm-engine.md` — read it before any
  design work; it is the source of truth for scope, the parity contract, and open questions.
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
  conformance/    # (maybe) shared golden corpus — see spec §7 / Q3
  cli/            # (deferred — Q4) npx spintax validate|render|extract
```

Public API surface (straw-man, spec §9):

- `parse(src): Ast`
- `render(ast|src, { context, seed, includeResolver, postProcess }): string`
- `validate(src): Diagnostic[]` — parity gate
- `extractVariables(src): { refs, sets }`
- `neutralize(value): string` — `SpintaxShield` port; host shields data-derived (T2) input,
  the engine does NOT auto-shield (it can't know which context keys are T1 vs T2)

`#include` resolution is **host-injected** (`(ref) => string | null`); the circular-reference
guard and scope isolation (child inherits global+runtime vars, NOT parent `#set` locals)
live in the engine, the *fetch* does not.

## Milestones (spec §11)

- **M0 — corpus extraction.** Turn parity-critical parent PHPUnit cases + post-process cases
  into the shared golden corpus. Do this BEFORE any TS.
- **M1 — parser + validator.** Full syntax surface; pass all deterministic validation cases.
- **M2 — renderer + post-process.** Seeded render; pass deterministic render + post-process
  cases; RNG cases pass structural invariants.
- **M3 — extract + neutralize + docs.** API complete; publish `0.1.0`.
- **M4 — first consumer.** Worker exposing `validate-template` + `preview-render`.
- **M5 — browser playground** on `spintax.net`, client-side.

## Commands

TBD — filled in at M1 (build via tsup/unbuild, test via vitest are the likely picks; not
locked). Until then this repo is docs + scaffolding only.

## Conventions

- TypeScript strict, ESM-first, zero runtime dependencies in `@spintax/core`.
- No WordPress / ACF / WooCommerce / HTTP / caching concepts in the engine — those are host
  concerns (spec §2.2).
- Push to `main` once green (single-dev repo; mirror the parent's no-PR-unless-asked norm).
- Every behavior change is justified against the golden corpus, not vibes.

## Open questions still to close (spec §10)

Q2 npm naming (`@spintax/*` scope — bare `spintax` likely taken), Q3 corpus home
(submodule vs published `@spintax/conformance`), Q4 CLI now-or-later, Q6 versioning
independence from the plugin. Q1 (post-process parity) and Q5 (MIT) are RESOLVED.

# Changelog

All notable changes to `@spintax/mcp` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0 — 2026-08-18

Minor rather than patch: `validate_spintax` returns a diagnostic it did not return before, on
templates that used to come back clean.

### Changed

- **Requires `@spintax/core` ^0.4.0**, which adds `plural.locale-missing` — a warning on a
  `{plural …}` block whose form count is not the 2 that `render` defaults to, when no locale was
  supplied (issue [#65](https://github.com/investblog/spintax-js/issues/65), reported from a
  pipeline rendering ~1000 articles per campaign that shipped `｛plural …｝` to live pages).

  Nothing in this package changed to make that happen — the tools pass diagnostics through — but
  the consequence is worth stating: **"no error" was never the whole answer, and now the missing
  half is machine-readable.** `valid` still means "no error-severity diagnostic", a template that
  validated clean still validates clean, and a 2-form block stays silent because the default
  resolves it.

  The README's tools table said "No `error` ⇒ safe to render". It now says what the engine
  actually delivers.

## 0.1.1 — 2026-08-17

Metadata only — `dist/` is byte-identical to 0.1.0.

### Added

- **`mcpName: "net.spintax/mcp"` in the manifest.** The MCP Registry verifies ownership of an npm
  package by checking that field against the server name, so it is the precondition for listing
  this package on the existing `net.spintax/mcp` entry — one registry record, two ways to run the
  same tools: the hosted endpoint over HTTP and this package over stdio.

  Note what does *not* change: the local server still reports `serverInfo.name` as
  `spintax-local`, not `spintax-net`. They are genuinely different deployments — different caps,
  and only one of them can read your filesystem — and a client is better off seeing which door it
  is on. The registry validates the manifest field, not `serverInfo`.

- First release published through OIDC Trusted Publishing; 0.1.0 needed the token bootstrap
  because a Trusted Publisher entry cannot precede a package's first publish.

## 0.1.0 — 2026-08-17

First release. A local MCP server for spintax templates over stdio, and the shared module the
hosted server at `https://spintax.net/mcp` will run from the same source.

### Added

- **Three tools over `@spintax/core`** — `validate_spintax`, `render_spintax`, `analyze_spintax`,
  identical in name, schema and result shape to the hosted server's. The proof is mechanical:
  `test/fixtures/site-tools.json` was extracted by evaluating the live server's `TOOLS` literal,
  and `buildTools` with the hosted caps must reproduce it exactly.
- **No caps that exist for someone else's CPU budget.** The hosted server stops at 8 KB of template
  and 20 variants (ADR 0002 over there); locally the template cap is gone entirely and
  `--max-variants` defaults to 50. `count` keeps a schema `maximum` because an unbounded count on a
  100 KB template is a one-line OOM.
- **`--include-root` — `#include` from disk**, the one thing a hosted server must never offer. A
  ref is untrusted template data, so the resolver is a jail: a narrow shape whitelist, lexical
  containment, then containment re-checked against the **realpath**, which is what stops a symlink
  or junction inside the root from reading `~/.ssh/id_rsa`. Non-files are refused (a FIFO would hang
  a synchronous resolver forever), a byte cap applies, a BOM is stripped, and every failure is a
  `null` rather than a throw — a throwing resolver becomes `IncludeResolverError`, which with a
  resolver installed is reachable from ordinary template content.
- **An include report on `render_spintax`.** The engine drops a cyclic or too-deep `#include` to `''`
  *before* the resolver is asked, so a suppressed include is byte-identical to a miss. The report
  reconstructs the difference — `resolved` / `missing` (with a reason) / `suppressed` (cycle vs
  depth) by walking the include tree with the engine's own stack, so it names the reference that was
  refused rather than every file in the cycle. Two honesty flags come with it: it says out loud that
  it is best effort (an `#include` produced by a spin choice is invisible to static analysis), and it
  sets `truncated: true` if the walk hits its 5000-edge budget, because distinct paths through a
  diamond-shaped graph multiply and a short list that looks complete is worse than none.
- **`knownIncludes` when a root is configured**, turning a broken partial from a silent render-time
  empty string into a diagnostic with a line and column. Bounded by engine contract: `validate()`
  files those verdicts only for a non-empty allow-list, so a template whose every include is broken
  still validates clean — the include report is what covers that case.
- **A transport-free main entry.** The dispatcher, tool builder and engine wrappers import no Node
  builtin, so the same module runs on Cloudflare Workers where there is no `nodejs_compat` flag.
  Asserted on the built bundle by walking the entry's import graph and matching against the real
  builtin list — the first version of that guard grepped for `node:` and passed on everything,
  because esbuild rewrites `node:fs` to bare `fs`.
- **stdio done properly**: newline framing that survives CRLF and split writes, one fifo so
  responses leave in request order, a resync after an over-long line instead of a desynced stream,
  EOF as the shutdown signal (the spec's only portable one), exit 0 on a dead pipe, and stdout that
  carries protocol JSON and nothing else — enforced by `no-console` in the source and by spawning
  the real binary in the test suite.

### Notes

- **Two deliberate divergences from today's hosted server**, which it inherits when it adopts this
  module. Both are written down so the refactor can be verified against a known list rather than
  producing a surprise diff:
  - `server/discover` is exempt from the `_meta.clientCapabilities` requirement. That method is the
    era probe, sent before the client has agreed anything, and per the spec it must answer with a
    `DiscoverResult` or a recognized modern error — a `-32602` there makes a strict-but-incomplete
    client conclude "legacy server" and fall back.
  - A request whose `id` is anything but a string, a number or `null` — object, array, boolean — is
    answered `-32600` with `id: null` instead of having that id echoed. JSON-RPC allows only those
    three, so echoing anything else emits an envelope no conforming client can read.
- Two asymmetries are preserved on purpose, each with a test that says so: a result carries
  `_meta.serverInfo` and an error never does; `resultType: 'complete'` is present everywhere except
  `initialize`. A third is structural — the `-32020` header-mirroring family is unreachable over
  stdio, because the spec is explicit that stdio has no header layer.
- The wire protocol stays hand-rolled and `@spintax/core` is the only dependency (the hosted
  server's ADR 0005; not revisited here).

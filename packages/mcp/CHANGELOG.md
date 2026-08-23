# Changelog

All notable changes to `@spintax/mcp` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.3.0 — 2026-08-23

A fourth tool, `spintax_authoring_guide`, and `@spintax/authoring-prompt` as a second real
dependency. Minor rather than patch: the tool list is a contract, and services bind to it.

**Why a tool at all.** The other three VERIFY, and verification cannot teach. `validate_spintax`
calls `{fast|quick}` sound — because it is sound — so an agent authoring from whatever notion of
spintax it arrived with gets a green verdict and never learns that `#def` is how two mentions
agree, that a count belongs in `{plural …}`, or that a bare permutation joins with a space. The
absence of a construct is not a diagnostic, and no engine tool can report it. The MCP surface was
verification-only by construction, while the client reaching it is the one doing the writing.

**Why a tool rather than a resource or a longer `instructions`.** The rules are locale-dependent —
the Slavic block is most of their value — and the locale is only known at call time; a static
resource can carry only the language-neutral half, which was the half that was already adequate.
`instructions` would also charge every session, including the many that only render, ~2k tokens it
never reads (en 7 183 characters, ru 10 066, hr 9 177). Tools are also the one MCP primitive every
client implements. `instructions` does gain one sentence naming the guide: the agent that most
needs it is by definition the one that does not know anything is missing.

`spintax_authoring_guide({ locale?, variationLevel? })` → `{ rules, promptVersion, locale? }`,
`readOnlyHint`, and **no template argument** — it is the one tool asked BEFORE there is a template,
so it returns above the shared template guard in `callTool`.

Backed by `authoringRules()`, new in `@spintax/authoring-prompt` 0.3.0: the authoring prompt minus
the OUTPUT CONTRACT. That exclusion is the whole reason the export exists rather than a dummy-brief
call into `buildAuthoringPrompt` — "your entire reply is fed straight into the renderer" is true
for a host driving an LLM and harmful for an agent that has to answer a person. Everything else is
shared verbatim and asserted to be, at both boundaries.

The tool-list fixture (`test/fixtures/site-tools.json`) is regenerated, which its own header calls
a deliberate act whose diff is meant to be read — this entry is that review. The hosted card must
name the new tool before this ships: `parity-card.test.ts` fails until `spintax.net`'s
`.well-known/mcp.json` description does.

**The tarball smoke found a real defect and was widened.** It installed `@spintax/authoring-prompt`
from the registry, which still served the release before the export this package had started using,
so the installed artifact threw *does not provide an export named authoringRules* — the same trap
the engine dependency was already packed locally to avoid, in its second instance. All three
`@spintax` packages are packed locally now, the smoke drives the guide over stdio (the one call
that proves the new dependency resolves in the installed tree), and it waits for `close` rather
than `exit`, because the responses grew from a few hundred bytes to ~20 KB.

## 0.2.3 — 2026-08-18

Depends on `@spintax/core` **^0.6.0**, which changes what `validate_spintax` returns for a template
whose definitions form a converging diamond into a cycle: one diagnostic per name rather than one
per route (spintax-js#59). Before it, 507 bytes of such definitions produced 2 097 152 diagnostics —
an answer no agent can read and no transport should carry. Messages for ordinary templates are
unchanged.

## 0.2.2 — 2026-08-18

Depends on `@spintax/core` **^0.5.3** (which bounds what one render may expand, and made that
bound per call rather than per included template). Adds the cap the count limit was never able
to provide.

### Added

- **`maxOutputChars`** on `CallToolOptions` — total characters `render_spintax` may return
  across all variants. Omit it and nothing changes, which is right for the local stdio server:
  it renders what its owner asked for, on their own machine. A hosted deployment should set it.

  A count cap bounds how MANY variants, not how BIG they are, and the engine's allowance is per
  render — so the two multiply. Measured on `spintax.net/mcp` before this existed: a
  62-character expansion bomb at `count: 20` answered **HTTP 200 with a 48 MB body after 29
  seconds**. Nothing was broken, nothing said no, and the caller had spent 62 bytes.

  The call is refused rather than truncated, and the message names the variant it stopped at
  and what to do — a short list of variants looks like a valid answer, and an agent that asked
  for twenty would quietly act on however many happened to fit.

## 0.2.1 — 2026-08-18

Depends on `@spintax/core` **^0.5.0** (a real dependency, not bundled — the site ends up with one
engine copy). Two plural fixes reach every tool through it: form counts are computed after
definitions expand, so a false `plural.arity` on `{plural 2: one|%tail%}` is gone (spintax-js#66);
and a conditional in a plural's count slot resolves instead of silently deleting the block.

### Changed

- **`validate_spintax`'s description no longer says a clean error list means "safe to render".**
  It says the template is structurally sound and tells the agent to read the warnings, because some
  of them — `plural.locale-missing` above all — mean a block will not resolve. An agent that stops
  at the verdict ships the fullwidth fallback into finished copy.

  The hosted `spintax.net/mcp` advertises the old wording until it is redeployed; the parity test
  in that repo compares names and schemas, never description text, for exactly this reason.

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

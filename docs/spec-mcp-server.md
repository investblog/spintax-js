# `@spintax/mcp` — one tool module, two transports

Status: **shipped** (0.2.2; the hosted twin `spintax.net/mcp` is registry entry `net.spintax/mcp` 1.0.5). Source of the requirement: issue
[#64](https://github.com/investblog/spintax-js/issues/64). This document records the decisions and
the measured facts, not the API — for the API read `packages/mcp/README.md`, and for what changed
read `packages/mcp/CHANGELOG.md`.

## 1. Why a second door

`https://spintax.net/mcp` is live, in the official registry as `net.spintax/mcp`, and is a
hand-rolled Cloudflare Pages Function. Its caps come from the Workers free plan (body ≤ 32 KB,
template ≤ 8 KB, variants ≤ 20 — ADR 0002 in the site repo), and it refuses `#include` because a
hosted server must not read anyone's filesystem. Every one of those is right for a hosted server and
wrong for an author working on a real template: the templates people ship are bigger than the cap,
local-first and air-gapped users want "verified here", and partials live on disk.

## 2. The shape decision

The issue proposed **two implementations** of one tool surface, pinned by a drift test. We built
**one shared module and two transports** instead. A drift test catches divergence after it happens;
a single source of tool definitions and a single dispatcher make the interesting divergence
impossible — a renamed tool or a changed result shape cannot differ between two servers when there
is only one of each.

What that costs, and it is the whole design constraint: **the shared entry must not import a Node
builtin.** The site's Pages project has no `nodejs_compat` flag — there is no wrangler config for it
in that repo at all — so `node:fs`, stdio and `--include-root` live behind the executable, never
behind `@spintax/mcp`'s main entry.

There is no compiler flag for that rule. `types: []` in `tsconfig.base.json` stops `process` and
`Buffer` from type-checking, but `import { readFileSync } from 'node:fs'` compiles happily under
`moduleResolution: Bundler`. So it is asserted on the built bundle, by walking the entry's import
graph (tsup hoists shared code into `chunk-*.js`, so reading one file proves nothing) and matching
specifiers against `builtinModules`. **The first version of that guard grepped for `node:` and
reported green on a bundle that imports the filesystem** — esbuild rewrites `node:fs` to bare `fs`
on the node platform. A guard is a claim about a mechanism; check the mechanism.

## 3. Proof the port changed nothing

`packages/mcp/test/fixtures/site-tools.json` is not a retyped copy of the hosted tool list. It was
extracted mechanically: the `TOOLS` literal was sliced out of the live `functions/mcp.ts` and
evaluated, with no edits to the site repo. `buildTools({ maxTemplateChars: 8192, maxVariants: 20 })`
must deep-equal it. It is a plain JSON file rather than a vitest snapshot on purpose — `vitest -u`
would silently rewrite a snapshot, and this file *is* the contract a published server advertises.

Three things in the hosted `callTool` do not compile under this repo's stricter tsconfig
(`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `lib: ES2022`/`types: []` versus the
site's plain `strict` with DOM): `seed: undefined` passed into an optional property, `m[1]`, and
`atob`. They were rewritten output-identically, which is what the fixture proves.

## 4. Preserved asymmetries, and the one deliberate change

Each of these looks like a bug and is not. Each has a test whose name says so, because the next
person to read the dispatcher will want to "fix" them.

- A **result** carries `_meta['io.modelcontextprotocol/serverInfo']`; an **error** never does.
- `resultType: 'complete'` appears on every result **except** `initialize` — era-correct.
- `initialize` answers `2025-06-18` to a client that asks for `2026-07-28`. Opening with a handshake
  is itself the legacy signal; the modern era is entered per-request through `_meta`. The whole
  version table is pinned case by case.
- The **`-32020` header-mirroring family is unreachable over stdio**, so a body the hosted server
  rejects for a header mismatch is served locally. That is the spec's own rule — for stdio, "all
  request metadata is carried inline in the JSON-RPC message body… There is no header layer" — and
  it is why header mirroring lives behind a `HeaderAdapter` the transport supplies or omits.
- `capabilities` is **derived** from whether a resource provider was configured, not a constant. The
  local server advertises `{ tools: { listChanged: false } }` and answers `-32601` for every
  `resources/*` method; the hosted one keeps its Markdown mirrors. An empty resource list would be a
  lie, and answering a method you do not advertise is the same lie in the other direction.

**Two intentional divergences**, which the hosted server inherits when it adopts this module. They
are listed here so the refactor is verified against a known list instead of producing a surprise
diff:

1. `server/discover` is exempt from the `_meta.clientCapabilities` requirement. That method is the
   era *probe*, sent before the client has agreed anything, and per the spec it must answer with a
   `DiscoverResult` or a recognized modern error — anything else means "legacy server, fall back to
   `initialize`". Requiring a field there mis-classifies a client that is strict but incomplete.
2. A request whose `id` is anything other than a string, a number or `null` — an object, an array, a
   boolean — is answered `-32600` with `id: null`, rather than having that id echoed back. JSON-RPC
   requires one of those three; echoing anything else emits an envelope no conforming client can
   read, so the hosted server's cast-and-echo is a latent defect rather than a contract.

## 5. `#include` from disk

A ref is **untrusted template data**, not a path an operator typed, so `--include-root` is a jail:
a narrow shape whitelist (`[A-Za-z0-9._-]` segments joined by `/`, no `..`) that rejects absolute
paths, drive letters, backslashes, UNC prefixes, NUL and URLs in one line; lexical containment; then
containment **re-checked against the realpath**, which is the step that stops a link or junction
inside the root from reading `~/.ssh/id_rsa`. Non-files are refused because a FIFO would block a
synchronous resolver forever with no timeout. Nothing throws: a throwing resolver becomes
`IncludeResolverError`, and with a resolver installed that is reachable from ordinary template
content.

The report exists because of one ordering fact in the engine (`internal/render.ts`): **cycles and
depth are decided BEFORE the resolver is called**, so a suppressed include is byte-identical to a
resolver miss. The report reconstructs the difference from what the resolver *did* see plus static
analysis of the source and of every child text returned. Two facts about it, both stated in the
schema rather than glossed:

- It is **best effort** — an `#include` produced by a spin choice (`{#include "a"|text}`) is
  invisible to `analyze()`.
- A **cycle member appears in both `resolved` and `suppressed`**: it was answered once, then cut on
  re-entry. The first implementation skipped anything already asked for and therefore reported no
  cycles at all — the feature, silently absent.
- The walk classifies **edges, not nodes** — "which reference did the engine refuse?", not "is this
  ref part of a cycle?". On `source → A → B → A` only the closing reference to A is dropped; B
  resolves normally. Classifying nodes reported both, which is a report that invents work for the
  reader. Suppressions are keyed by `(ref, reason)`, so a ref cut as a cycle on one path and by depth
  on another appears twice rather than collapsing to whichever the walk met first.
- The walk carries a **5000-edge budget** and reports `truncated: true` when it runs out. Distinct
  *paths* through a diamond-shaped include graph multiply (two files per level, thirteen levels =
  8192 paths through 26 files), and this runs inside a request. A truncated list that presented
  itself as complete would be worse than no list. Note that repeating one ref inside a single file
  does **not** produce that shape: `analyze().includes` dedupes per file.
Because the walk mirrors the engine rather than inferring from what the resolver was asked, a ref
that resolved at one depth and was *also* cut by the guard deeper in the tree is reported — the case
the earlier, asked-based implementation could not see at all. What remains outside its reach is only
what static analysis cannot see, plus whatever the budget cut.

One limit belongs in the same list even though it is not part of the report: the stdio framing cap
(`--max-message-chars`, 8 MiB by default) is the only thing that can still refuse a very large
template. It is a flag, and the README says so, because an undocumented transport limit and a
template cap are indistinguishable from where the client stands.

**Engine boundary found here, worth remembering:** `validate()` files unknown-`#include` verdicts
only for a **non-empty** `knownIncludes` (`internal/validator.ts`). So passing the refs that
actually resolve turns a typo'd partial into a line-and-column error — but a template whose *every*
include is broken still validates clean. That is corpus-gated behaviour across five engines, not
something to work around from a consumer; the render-time report is what covers the case.
`analyze_spintax` deliberately does **not** follow includes on either server: following them would
change what `refs` and `constructs` mean between the two.

## 6. stdio, and the bug the first version had

Ordering is not decoration. The first implementation wrote parse errors synchronously and real
answers through a promise queue, so **a client saw the answer to line 2 before the answer to line
1**. There is now one fifo drained by one worker, and a test that interleaves a bad line between two
good ones.

The rest, each line of it from a spec MUST or a known failure mode: newline framing that tolerates
CRLF and split writes; a resync after an over-long line so one bad message cannot desync every
following one; **stdout carries protocol JSON and nothing else** (enforced by `no-console` in the
package's source *and* by asserting on the spawned binary, because it is invisible to every other
kind of test); `--help`/`--version` print before any stdin handler attaches; EOF is the shutdown
signal (the spec's only portable one — Windows clients cannot deliver SIGTERM); a dead pipe exits 0,
because an unhandled EPIPE exits non-zero and clients report that as a crash; and the exit code is
set rather than `process.exit()` called, which would truncate the last response.

Flags are hand-rolled: `node:util.parseArgs` is stable only from Node 20 and the CI matrix still
covers 18. An unknown flag is an error, not something to ignore — a typo in a client config would
otherwise start a server with silently different limits.

## 7. Follow-ups

> **Follow-ups 1–3 are done** (2026-08-17/18): the site refactor shipped with the core pin moved,
> `decodeSentinel` was fixed there, and follow-up 4 landed as `packages[]` on the registry entry.
> The list is kept because each records why the decision was made.

1. **The site refactor.** `functions/mcp.ts` becomes ~40 lines: CORS, method guards,
   `MAX_BODY_BYTES`, `JSON.parse`, `dispatch(msg, headerAdapter)`, status mapping, and the `ASSETS`
   resource provider. **Precondition:** that repo pins `@spintax/core` at exactly `0.3.3` while this
   package depends on `^0.3.4`, so npm would install two copies and wrangler would inline both —
   which defeats the one-engine-copy goal that motivated making core a real dependency here. Move
   the pin in the same change and verify a single engine copy in the bundled
   `.wrangler/tmp/pages-*/functionsWorker-*.mjs`.
2. **`decodeSentinel` mangles non-ASCII.** `atob` yields a byte string, so a `=?base64?…?=` header
   value encoding anything non-ASCII decodes to mojibake and never equals the body value → a
   spurious `-32020`. The shared module keeps the site's decoder bug-for-bug through
   `HeaderAdapter.decode`; fixing it is a site change with its own test.
3. **`server/discover` and `_meta.clientCapabilities`** — §4. Already correct here; the site inherits
   it at refactor time.
4. **Registry identity.** The issue left this open on purpose: the MCP registry schema allows an npm
   **package** distribution alongside a remote on one server entry, so `net.spintax/mcp` could gain
   `packages: [{ registryType: "npm", identifier: "@spintax/mcp" }]` instead of claiming a second
   name. That is a spintax.net change (`server.json` + `static/.well-known/mcp.json`, which this
   package's `parity-card.test.ts` already guards), and the promo plan's trap applies — name, auth
   method and URL must agree across the card, the manifest and the live server.

## 8. `maxOutputChars`, and why a variant count was never a bound (0.2.2)

`maxTemplateChars` bounds the input. `maxVariants` bounds how MANY variants come back. Neither
bounds how BIG they are, and the engine's own expansion allowance is **per render**, so the two
multiply.

Measured on `spintax.net/mcp` before this existed, with both caps satisfied — a 62-character
template and `count: 20`:

```
HTTP 200, 47 929 371 bytes, 28.7 s
```

The template was `#set %a% = %b% %b%` over `#set %b% = %a% %a%` and a reference to it: doubling
expansion, engine issue #69. Nothing was broken, nothing said no, and the caller had spent
62 bytes. After the cap (2 MB): 428 bytes, ~1 s, a tool error naming the variant it stopped at.

Three decisions worth keeping:

- **Optional.** Omitted ⇒ no cap, which is right for the local stdio server: it renders what its
  owner asked for, on their own machine. A hosted deployment sets it; the site passes 2 MB.
- **Refused, not truncated.** A short list of variants looks like a valid answer, and an agent
  that asked for twenty would quietly act on however many happened to fit. The message names the
  variant it stopped at and what to do — including that a definition may expand into itself.
- **2 MB came from measurement, not from taste.** The reference Worker's first batch cap was 8 MB
  and never fired once: the isolate was killed before the loop reached it, so the bound existed
  only in the unit test. A cap that never fires is worse than none — it reads as protection.

Standing cost, unchanged: the registry entry names an exact package version, so releasing this
package drags the card, `server.json`, the Function, the parity pin, an apex deploy and a registry
publish, in that order. 0.2.2 went out as server `1.0.5`.

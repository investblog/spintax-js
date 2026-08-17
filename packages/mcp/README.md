# @spintax/mcp

[![npm](https://img.shields.io/npm/v/@spintax/mcp.svg)](https://www.npmjs.com/package/@spintax/mcp)
[![CI](https://github.com/investblog/spintax-js/actions/workflows/ci.yml/badge.svg)](https://github.com/investblog/spintax-js/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@spintax/mcp.svg)](https://github.com/investblog/spintax-js/blob/main/LICENSE)

A **local MCP server** for [spintax](https://spintax.net) templates: an agent on your machine
can validate, render and analyze a template through [`@spintax/core`](https://www.npmjs.com/package/@spintax/core),
the reference engine — over stdio, with no network call and no size caps.

There is also a hosted door at `https://spintax.net/mcp` (in the official registry as
`net.spintax/mcp`). Use this package instead when you want:

- **no caps** — the hosted server stops at 8 KB of template and 20 variants, because it pays for
  its own CPU; the templates people actually ship are bigger than that;
- **no network** — local-first and air-gapped setups included;
- **`#include`** — resolving partials from disk, which a hosted server must never do.

This package holds **the tool module and the dispatcher both doors are meant to run** — one source
of tool definitions, so a renamed tool or a changed result shape cannot differ between them. The
tool list here is asserted, byte for byte, against the list the hosted server currently serves; the
hosted server's own switch to this module is the next change on that side.

## Use it

```jsonc
// Claude Desktop, Claude Code, Cursor, … — an MCP client config entry
{
  "mcpServers": {
    "spintax": { "command": "npx", "args": ["-y", "@spintax/mcp"] }
  }
}
```

With partials on disk:

```jsonc
{
  "mcpServers": {
    "spintax": {
      "command": "npx",
      "args": ["-y", "@spintax/mcp", "--include-root", "/abs/path/to/partials"]
    }
  }
}
```

Or install it and run the binary directly:

```sh
npm install -g @spintax/mcp
spintax-mcp --help
```

## Tools

| Tool | What it answers |
|------|-----------------|
| `validate_spintax` | Diagnostics with severity, a stable code and 1-based line/column. No `error` ⇒ safe to render. |
| `render_spintax` | N variants. With a seed it is deterministic — variant *i* uses seed `<seed>#<i>`. |
| `analyze_spintax` | Which variables the template needs, which directives it defines, best-effort construct counts. |

Two things worth knowing, because they are the traps this server exists to make visible:

- **Plural arity is locale-sensitive, and silent without a locale.** With no `locale`, the engine
  files no arity verdict at all — a 3-form `{plural %n%: one|few|many}` validates clean and then
  renders through the 2-form default. Name the locale when you mean it.
- **The engine is lenient.** Structural mistakes never throw; they surface in the output, with
  fullwidth braces `｛…｝` marking markup the parser could not read. Run `validate_spintax` first.

## Options

| Flag | Default | Notes |
|------|---------|-------|
| `--include-root <dir>` | — | Resolve `#include` against `<dir>`. Without it, an `#include` line is **inert**: it stays in the output verbatim. |
| `--max-variants <n>` | `50` | Cap for `render_spintax`'s `count`. |
| `--max-depth <n>` | `20` | `#include` / nesting depth guard. |
| `--max-include-bytes <n>` | `1048576` | Refuse an `#include` file larger than this. |
| `--max-message-chars <n>` | `8388608` | Refuse a single JSON-RPC message longer than this. |

Each has an `SPINTAX_MCP_*` environment fallback (`SPINTAX_MCP_INCLUDE_ROOT`, …), used only when
the flag is absent.

There is deliberately **no cap on the template itself** — removing it is the point. One limit can
still meet a very large one, and it is a flag rather than a secret: `--max-message-chars` bounds the
whole JSON-RPC line a template arrives in. It exists because a message past a few megabytes almost
always means a client has lost the newline framing, not that someone wrote an 8 MB template; if you
did, raise it.

### `#include` from disk

A ref is untrusted template data, not a path an operator typed, so `--include-root` is a jail and
not a hint. A ref must look like `partials/opener.txt` — `[A-Za-z0-9._-]` segments joined by `/` —
and the resolved real path must still sit inside the root, which is re-checked **after** resolving
symlinks. That last step is what stops a link or junction inside the root from reading
`~/.ssh/id_rsa`. Non-files are refused (a FIFO would hang a synchronous resolver forever), a size
cap applies, and a leading BOM is stripped. Nothing raises: every refusal is a miss.

Because the engine drops a cyclic or too-deep `#include` to an empty string *before* the resolver
is asked, `render_spintax` attaches an **include report** telling the two apart:

```jsonc
"include": {
  "root": "/abs/path/to/partials",
  "maxDepth": 20,
  "resolved": ["opener.txt", "cta.txt"],
  "missing": [{ "ref": "signoff.txt", "reason": "not-found" }],
  "suppressed": [{ "ref": "loop.txt", "reason": "cycle" }],
  "truncated": false
}
```

It is **best effort** by construction: an `#include` produced by a spin choice
(`{#include "a"|plain text}`) is invisible to static analysis, so a suppressed one can go
unreported. With a root configured, `validate_spintax` also gets the refs that really resolve as
its allow-list, which turns a broken partial into a diagnostic with a line and column — as long as
at least one sibling resolves (the engine files those verdicts only for a non-empty allow-list).

## Embedding it

The package's main entry is the transport-free half — the dispatcher, the tool builder and the
engine wrappers — and it imports no Node builtin, so it runs on Cloudflare Workers and in a browser
unchanged. That is not a side effect; it is why the hosted server can share it:

```ts
import { buildTools, createDispatcher } from '@spintax/mcp';

const tools = buildTools({ maxVariants: 20, maxTemplateChars: 8192 });
const mcp = createDispatcher({
  serverInfo: { name: 'my-server', title: 'My server', version: '1.0.0' },
  instructions: 'Spintax tools.',
  tools,
  limits: { maxVariants: 20, maxTemplateChars: 8192 },
});

const outcome = await mcp.dispatch(await request.json(), {
  get: name => request.headers.get(name),
});
// { kind: 'accepted' } → HTTP 202, no body
// { kind: 'response', body, httpStatus } → JSON with that status
```

Caps are **parameters, never constants**: they are interpolated into tool descriptions and JSON
Schemas, so a server that hardcoded them would publish schemas that lie. The `headerAdapter`
argument is how header mirroring stays out of the shared code — stdio has no header layer at all,
which the MCP spec is explicit about, so the transport simply passes nothing.

The wire protocol is hand-rolled (revision **2026-07-28**, plus `initialize` for the four earlier
revisions) and the only runtime dependency is `@spintax/core`. No SDK: that decision belongs to the
hosted server's ADR 0005 and this package continues it.

## License

MIT — see [LICENSE](https://github.com/investblog/spintax-js/blob/main/LICENSE).

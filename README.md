# Spintax for JavaScript / TypeScript

[![npm](https://img.shields.io/npm/v/@spintax/core.svg)](https://www.npmjs.com/package/@spintax/core)
[![CI](https://github.com/investblog/spintax-js/actions/workflows/ci.yml/badge.svg)](https://github.com/investblog/spintax-js/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@spintax/core.svg)](./LICENSE)

Framework-agnostic [spintax](https://spintax.net) engine for JS/TS — parse, render,
validate, and extract variables from spintax templates, with **zero WordPress dependency**.
Runs on Cloudflare Workers, Node 18+, and in the browser.

```sh
npm install @spintax/core
```

→ **[`@spintax/core` on npm](https://www.npmjs.com/package/@spintax/core)** · package docs in
[`packages/core`](./packages/core/README.md).

> **Status: released & stable.** The engine (`@spintax/core`) is feature-complete — parse, render,
> validate, extract, analyze, neutralize. Its deterministic golden corpus passes against **both**
> the TS engine and the PHP plugin, and it's proven by a reference Cloudflare Worker (`examples/worker`, M4).
> See the [spec](./docs/spec-npm-engine.md) and [`packages/core`](./packages/core/README.md).

## Try it live 🎮

- 🤖 **Telegram bot — [@spintaxnetbot](https://t.me/spintaxnetbot)** — paste a spintax template and
  it validates it and replies with random variations; or `/draft <brief>` and an AI writes the
  template for you.
- 🌐 **Reference Worker API** — `validate-template` / `preview-render` / `extract-variables` /
  `analyze-template` / `render-batch` over HTTP.

Both are thin reference consumers built on `@spintax/core` (they import the engine, never the other
way round) — source in [`examples/`](./examples).

## What this is

The open-source core engine behind the Spintax ecosystem. It is a **companion** to the
[Spintax WordPress plugin](https://wordpress.org/plugins/spintax/) — an *independent* TypeScript
implementation that shares the same syntax and a machine-checked **parity contract**: a shared
golden corpus that passes against **both** engines (verified, not just intended). Not a line-by-line port.

One engine, many surfaces: the planned Cloudflare Workers API, a Telegram authoring bot, and
a client-side playground on `spintax.net` are all consumers of this package.

### The same engine, other runtimes

| | install | |
| --- | --- | --- |
| **JavaScript / TypeScript** | `npm i @spintax/core` | this package |
| **PHP** | [`composer require spintax/core`](https://packagist.org/packages/spintax/core) | [investblog/spintax-php](https://github.com/investblog/spintax-php) — MIT, zero deps |
| **WordPress** | [wordpress.org/plugins/spintax](https://wordpress.org/plugins/spintax/) | templates, ACF / post-meta bindings, WooCommerce context, WP-CLI |
| **OpenCart 3.x** | [Spintax SEO](https://github.com/investblog/spintax-opencart) | product / category copy and SEO URLs |

The parity contract is not a promise — it is a job. [`php-parity`](.github/workflows/ci.yml) runs the
corpus in this repository against **both** PHP engines on every pull request, so a fixture cannot
land here unless the engines it binds already satisfy it.

## Spintax syntax (at a glance)

- `{a|b|c}` — enumeration (pick one), nestable `{a|{b|c}}`
- `[a|b|c]` — permutation (pick N, shuffle, join), configurable separators
- `%var%` — variable reference · `#set %v% = value` — local variable
- `{?VAR?then|else}` — conditional · `{plural <count>: one|few|many}` — plural agreement
- `#include "slug-or-id"` — embed another template · `/# … #/` — comments

Full authoring reference lives in the parent project's `docs/gtw-syntax-reference.md`.

## Repository layout

```
packages/
  core/              # @spintax/core — the engine (published)
  conformance/       # the shared golden corpus — the cross-engine parity gate
  authoring-prompt/  # the canonical LLM prompt for writing spintax (shared by every surface)
examples/
  worker/            # Cloudflare Worker — HTTP API (validate/render/extract/analyze); deployed
  telegram-bot/      # Telegram bot @spintaxnetbot — validate + preview + AI /draft; deployed
docs/spec-npm-engine.md  # governing spec (design source of truth)
LICENSE              # MIT
```

Consumers **import** the engine and never feed back into it — the purity boundary (spec §8) is
about *direction*, not import count. The bot, for instance, imports both `@spintax/core` and
`@spintax/authoring-prompt`, and contributes to neither: a consumer proves the API, it must not
pollute it. The prompt lives in its own package precisely so that no surface grows a private
dialect of it.

## Design & specs

Releases publish from CI with provenance via npm Trusted Publishing — see
[`RELEASING.md`](./RELEASING.md).

The governing spec is [`docs/spec-npm-engine.md`](./docs/spec-npm-engine.md) in this repo —
it holds the locked decisions, the parity contract, and the milestone plan. It mirrors the
behavior contract of the parent [Spintax WordPress plugin](https://wordpress.org/plugins/spintax/)
(the PHP engine this port is verified against).

## License

[MIT](./LICENSE). The Spintax WordPress plugin remains GPL; MIT/Expat is GPL-compatible, so
the two coexist cleanly.

---

Part of the **[301.st](https://301.st)** toolset. Product home: [spintax.net](https://spintax.net).

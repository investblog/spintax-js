# Spintax for JavaScript / TypeScript

[![npm](https://img.shields.io/npm/v/@spintax/core.svg)](https://www.npmjs.com/package/@spintax/core)
[![CI](https://github.com/investblog/spintax-js/actions/workflows/ci.yml/badge.svg)](https://github.com/investblog/spintax-js/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@spintax/core.svg)](./LICENSE)

Framework-agnostic [spintax](https://spintax.net) engine for JS/TS — parse, render,
validate, and extract variables from GTW-compatible spintax templates, with **zero
WordPress dependency**. Runs on Cloudflare Workers, Node 18+, and in the browser.

```sh
npm install @spintax/core
```

→ **[`@spintax/core` on npm](https://www.npmjs.com/package/@spintax/core)** · package docs in
[`packages/core`](./packages/core/README.md).

> **Status: `0.1.0`.** The engine (`@spintax/core`) is feature-complete — parse, render,
> validate, extract, analyze, neutralize — passes the full deterministic parity corpus, and is
> proven by a reference Cloudflare Worker (`examples/worker`, M4).
> See the [spec](./docs/spec-npm-engine.md) and [`packages/core`](./packages/core/README.md).

## What this is

The open-source core engine behind the Spintax ecosystem. It is a **companion** to the
[Spintax WordPress plugin](https://wordpress.org/plugins/spintax/) — an *independent*
TypeScript implementation that shares the same syntax and a machine-checked **parity
contract** (via a shared golden test corpus), not a line-by-line port.

One engine, many surfaces: the planned Cloudflare Workers API, a Telegram authoring bot, and
a client-side playground on `spintax.net` are all consumers of this package.

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
  core/           # @spintax/core — the engine (M1+)
examples/
  worker/         # Cloudflare Worker — API dogfood gate (M4)
  telegram-bot/   # Telegram authoring bot — flagship example (M5)
docs/spec-npm-engine.md  # governing spec (design source of truth)
LICENSE           # MIT
```

`examples/*` import `@spintax/core` only — consumers dogfood the engine's public API without
polluting it.

## Design & specs

The governing spec is [`docs/spec-npm-engine.md`](./docs/spec-npm-engine.md) in this repo —
it holds the locked decisions, the parity contract, and the milestone plan. It mirrors the
behavior contract of the parent [Spintax WordPress plugin](https://wordpress.org/plugins/spintax/)
(the PHP engine this port is verified against).

## License

[MIT](./LICENSE). The Spintax WordPress plugin remains GPL; MIT/Expat is GPL-compatible, so
the two coexist cleanly.

---

Built and maintained by [301.st](https://301.st). Project home: [spintax.net](https://spintax.net).

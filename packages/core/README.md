# @spintax/core

[![npm](https://img.shields.io/npm/v/@spintax/core.svg)](https://www.npmjs.com/package/@spintax/core)
[![CI](https://github.com/investblog/spintax-js/actions/workflows/ci.yml/badge.svg)](https://github.com/investblog/spintax-js/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/@spintax/core.svg)](https://www.npmjs.com/package/@spintax/core)
[![license](https://img.shields.io/npm/l/@spintax/core.svg)](https://github.com/investblog/spintax-js/blob/main/LICENSE)

Framework-agnostic **[spintax](https://spintax.net) engine** for JavaScript / TypeScript —
parse, render, validate, extract, analyze, and neutralize spintax templates.

> **Pairs naturally with LLMs.** Have a model draft a spintax template once, then generate
> unlimited variations on-device — deterministic, free, and offline, with no per-generation
> API calls. The LLM handles creativity; the engine handles scale.

- **Zero runtime dependencies.** Runs unchanged on Cloudflare Workers, Node 18+, and in the browser.
- **ESM-first, dual CJS.** Ships `.d.ts` types for both.
- **Parity-verified against the [Spintax WordPress plugin](https://wordpress.org/plugins/spintax/).**
  An *independent* TypeScript implementation (not a line-by-line port) held to the plugin's behavior
  contract by a shared golden corpus — the **same** fixtures pass against both this engine and the
  PHP plugin (deterministic verdicts, plural buckets, conditionals, `#set`/`#def` semantics,
  post-process), with no divergence.
- **MIT** licensed.

> **Status: released & stable.** Feature-complete — parse / render / validate / extract / analyze /
> neutralize. The deterministic golden corpus passes against **both** this engine and the PHP
> plugin, and the §9.2 API is proven by a reference Cloudflare Worker (`examples/worker`).

## Install

```sh
npm install @spintax/core
```

## Quick start

```ts
import { render, validate, extract } from '@spintax/core';

render('{Hello|Hi|Hey} %name%!', { context: { name: 'Ada' }, seed: 42 });
// → "Hi Ada!"  (deterministic for a given seed; post-processed by default)

validate('{a|b');          // → [{ severity: 'error', code: 'bracket.unclosed', … }]
extract('%title% {?promo?Sale}'); // → { refs: ['title', 'promo'], sets: [], includes: [] }
```

## Use cases

Anywhere one message has to go out many times without reading like a form letter:

- **Cold email & outreach** — one template, a distinct body per recipient, personalized through `context`.
- **SMS / push / notifications** — deterministic output in a few kilobytes, no API call per send.
- **Chatbots & agents** — vary canned replies so a bot doesn't repeat itself verbatim.
- **A/B and multivariate testing** — enumerate copy variants in the template instead of in application code.
- **Programmatic SEO / content generation** — thousands of pages from one authored source.
- **LLM output at scale** — have a model draft the template once, then spin it locally, forever, for free.

The core renders a **single** string per call — batching is a host concern. To emit N variants, call
`render` N times with different seeds; a seeded call is reproducible, so any variant can be
regenerated later from its seed alone:

```ts
const template = '{Hi|Hello|Hey} %name%, {quick|short|small} question about {pricing|billing}';
const variants = [1, 2, 3].map((seed) => render(template, { context: { name: 'Ada' }, seed }));
// → [ 'Hello Ada, quick question about billing',
//     'Hey Ada, quick question about pricing',
//     'Hey Ada, quick question about pricing' ]   ← same as seed 2; see the caveat below
```

Distinct seeds are **independent draws, not distinct results** — like any sampling they can repeat,
and the fewer combinations a template has, the more often they will. If you need N *unique* variants,
dedupe in the host and cap the retries: a template may simply not have N combinations to give.

## Spintax syntax

| Construct | Example | Meaning |
| --- | --- | --- |
| Enumeration | `{a\|b\|c}` | pick one (nestable: `{a\|{b\|c}}`) |
| Permutation | `[a\|b\|c]` | pick N, shuffle, join — `[<minsize=1;maxsize=2;sep=", ">a\|b\|c]` |
| Variable | `%var%` | substitute a context value |
| Local set | `#set %v% = value` | define a macro — re-picked at every use |
| Local def | `#def %v% = value` | define a value — picked once per render, held at every use |
| Conditional | `{?VAR?then\|else}` | `then` if `VAR` is truthy, else `else` |
| Plural | `{plural %n%: one\|few\|many}` | grammatical agreement by locale |
| Include | `#include "slug-or-id"` | embed another template (host-resolved) |
| Comment | `/# … #/` | stripped before rendering |

## API

All functions accept a `string` **or** a parsed `Ast` (from `parse`) as their first argument.

### `render(input, options?): string`

Renders a template to a single string. **Lenient** — never throws on malformed markup (a bad
block is emitted verbatim with fullwidth braces `｛…｝`). Cosmetic post-processing (spacing,
capitalization, URL/email shielding) is **on by default**.

```ts
render(input, {
  context?:         Record<string, string>,   // variable map
  seed?:            number | string,           // deterministic RNG; omit ⇒ random
  locale?:          string,                     // plural buckets, e.g. 'ru' (3-form)
  includeResolver?: (ref: string) => string | null,  // host-injected, synchronous
  postProcess?:     boolean,                    // default true; false ⇒ raw pick
  maxDepth?:        number,                      // #include / nesting guard (default 20)
});
```

`#include` is resolved only when you pass an `includeResolver`; child templates inherit the
runtime context but **not** the parent's `#set` locals. Circular / too-deep includes resolve to
`''` (lenient).

### `validate(input, options?): Diagnostic[]`

Returns diagnostics. A template is **valid** ⇔ no diagnostic has `severity: 'error'`. An
unresolved `%var%` is a `warning`, not an error.

```ts
validate(input, {
  locale?:         string,             // locale-aware plural-arity verdicts
  knownIncludes?:  readonly string[],  // enables "unknown #include target" errors
  knownVariables?: readonly string[],  // suppresses undefined-variable warnings
});
// Diagnostic: { severity, code, message, line, column, endLine?, endColumn?, data? }
```

### `extract(input): { refs, sets, includes }`

Variable references (`%var%`, `{?…}`, plural counts), `#set` names, and `#include` targets.

### `analyze(input, options?): Analysis`

`extract` + `validate` + a best-effort `constructs` census (`{ enumeration, permutation,
variable, conditional, plural, set, include }`). The census counts author-visible constructs;
it is **not** a variant-cardinality promise.

### `parse(input): Ast`

Parses once for reuse. `Ast` is **opaque and versioned** — pass it back to the other functions,
do not introspect or persist it across engine versions.

### `neutralize(value): string`

Shields data-derived (untrusted) text so it can't be re-interpreted as spintax markup — use it
on any value you inject via `context` that isn't author-controlled. It is **text-safe**
(round-trips to literal glyphs in any sink), not HTML/XSS escaping.

```ts
render('%bio%', { context: { bio: neutralize('Save {50|60}% today') }, postProcess: false });
// → "Save {50|60}% today"   (the braces stay literal, not a random pick)
```

## Determinism & RNG

With a `seed`, `render` is reproducible within this engine. Cross-engine RNG-sequence parity
with the PHP plugin is a **non-goal** — only the *deterministic* behavior (validation verdicts,
plural buckets, conditional truthiness, `#set` collapse, post-process output) is parity-gated.

## Links

- 📦 npm — [`@spintax/core`](https://www.npmjs.com/package/@spintax/core)
- 🤖 Try it — [@spintaxnetbot](https://t.me/spintaxnetbot) (Telegram: validate + preview + AI `/draft`)
- 🧩 Source — [investblog/spintax-js](https://github.com/investblog/spintax-js)
- 🌐 Product — [spintax.net](https://spintax.net)
- 🏠 Maintainer — [301.st](https://301.st)

## License

[MIT](https://github.com/investblog/spintax-js/blob/main/LICENSE). The Spintax WordPress plugin
remains GPL; MIT/Expat is GPL-compatible.

---

Part of the [301.st](https://301.st) toolset. Product home: [spintax.net](https://spintax.net).

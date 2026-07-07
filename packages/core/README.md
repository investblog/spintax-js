# @spintax/core

Framework-agnostic **[spintax](https://spintax.net) engine** for JavaScript / TypeScript —
parse, render, validate, extract, analyze, and neutralize GTW-compatible spintax templates.

- **Zero runtime dependencies.** Runs unchanged on Cloudflare Workers, Node 18+, and in the browser.
- **ESM-first, dual CJS.** Ships `.d.ts` types for both.
- **Parity-tested** against the [Spintax WordPress plugin](https://wordpress.org/plugins/spintax/)
  via a shared golden corpus — an *independent* TypeScript implementation, not a line-by-line port.
- **MIT** licensed.

> **Status: `0.1.0-rc.1`** — release candidate. The engine is feature-complete and passes the
> full deterministic parity corpus; the API is being dogfooded by a reference Cloudflare Worker
> before the `0.1.0` publish.

## Install

```sh
npm install @spintax/core
```

## Quick start

```ts
import { render, validate, extract } from '@spintax/core';

render('{Hello|Hi|Hey} %name%!', { context: { name: 'Ada' }, seed: 42 });
// → "Hi Ada!"  (deterministic for a given seed; post-processed by default)

validate('{a|b');          // → [{ severity: 'error', code: 'bracket.unbalanced', … }]
extract('%title% {?promo?Sale}'); // → { refs: ['title', 'promo'], sets: [], includes: [] }
```

## Spintax syntax

| Construct | Example | Meaning |
| --- | --- | --- |
| Enumeration | `{a\|b\|c}` | pick one (nestable: `{a\|{b\|c}}`) |
| Permutation | `[a\|b\|c]` | pick N, shuffle, join — `[<minsize=1;maxsize=2;sep=", ">a\|b\|c]` |
| Variable | `%var%` | substitute a context value |
| Local set | `#set %v% = value` | define a variable (one line) |
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

## License

[MIT](../../LICENSE). The Spintax WordPress plugin remains GPL; MIT/Expat is GPL-compatible.

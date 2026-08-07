# n8n-nodes-spintax

**Use AI to create the template once. Use spintax to generate safely and cheaply forever.**

An [n8n](https://n8n.io) community node for [spintax](https://spintax.net) templates:
render personalized copy at scale, validate templates, generate N distinct variants,
and drive an LLM authoring loop — without shipping a single credential (you wire your
own LLM node).

```
Sheets/CRM item → Build Authoring Prompt → LLM node → Validate ──Valid──→ Render / Render Many → Email/TG/CRM
                                                          │
                                                       Invalid
                                                          ↓
                                              Build Repair Prompt → LLM node ──┘ (cap the loop, e.g. 2 attempts)
```

## Install

Self-hosted n8n: **Settings → Community Nodes → Install** → `n8n-nodes-spintax`.

The node is pure compute: no credentials, no network calls, no filesystem access.
The spintax engine ([`@spintax/core`](https://www.npmjs.com/package/@spintax/core))
is bundled in — the package has zero runtime dependencies.

## 60-second start

1. Add the **Spintax** node, operation **Render**.
2. Template: `{Hello|Hi|Hey} %first_name%, {welcome to|great to see you at} %company%!`
3. Feed it items with `first_name` / `company` fields — every top-level string,
   number or boolean field of the incoming item is a `%variable%` automatically.
4. Each item comes out with a `rendered` field. Same seed → same output; no seed →
   a fresh draw per run.

## Operations

- **Render** — one document per item. Incoming values are *neutralized* by default:
  a scraped lead name containing `{` is data, not markup. Fixed variables you type in
  the node are yours, so they may deliberately contain spintax (e.g. `{Mr|Ms}`) — with
  a per-entry shield toggle for pasted external data.
- **Render Many** — N distinct variants with honesty built in: distinct seeds are
  *independent draws, not distinct results*. A low-cardinality template may simply not
  have N variants to give; the node returns what exists (`produced` vs `requested`)
  instead of retrying forever or silently under-delivering.
- **Validate** — routes each item to a **Valid** or **Invalid** output (valid ⇔ no
  error-severity diagnostics — warnings ride along). Diagnostics carry structured
  `code`, `line`/`column` spans and `data`, so downstream logic never parses messages.
- **Build Authoring Prompt** — emits `systemPrompt`/`userPrompt` for *your* LLM node,
  from a brief + the allowed variables (with grammatical case for inflected
  languages). Provider-agnostic by construction; `spintaxMeta` rides the item so the
  whole loop shares one locale and variable list.
- **Build Repair Prompt** — turns Validate's diagnostics into a fix-it prompt that
  points at the exact offending token. Defaults read everything straight off the
  Invalid output; cap the loop in your workflow (2 attempts is plenty).

Tip for the LLM loop: enable **Clean Model Output** on Validate — models wrap replies
in code fences no matter what the prompt says. The cleaned text lands in
`cleanedTemplate` and every position in the diagnostics refers to exactly that string.

## Why spintax (the 30-second argument)

Sending tools that "support spintax" parse flat `{a|b|c}` and stop there. The full
syntax adds **permutations** (order and length vary, nothing gets thesaurus-swapped),
**conditionals** (`{?HasWebsite?…}` — the clause exists or it doesn't), **plural
agreement** (`{plural %n%: …}` — no "1 languages"), and **roll-once definitions**
(`#def` — a name drawn once doesn't contradict itself three lines later).
[The arithmetic](https://spintax.net/spintax-for-cold-email/): replacing two synonym
groups with permutations took one real five-line email from 59 049 combinations to
8 503 056 — ~3 035 duplicate bodies per 20 000 sends down to ~24.

## Part of a maintained ecosystem

One syntax contract, held by a shared 234-case conformance corpus across four
independent engine implementations — JavaScript
([npm](https://www.npmjs.com/package/@spintax/core)), PHP
([Packagist](https://packagist.org/packages/spintax/core)), Python
([PyPI](https://pypi.org/project/spintax-core/)) and Object Pascal — plus a
[browser playground](https://spintax.net/play/), a
[Telegram bot](https://t.me/spintaxnetbot),
[Spintax Studio](https://apps.microsoft.com/detail/9mw3ch7b530p) (native Windows
editor in the Microsoft Store), and an MCP server in the official registry.
Docs and guides: [spintax.net](https://spintax.net).

A template you author in this node carries over to any of them — same accepted
syntax, same validation verdicts, same plural/conditional semantics, same
post-processing (random selection is each engine's own). The template is the asset;
engines are interchangeable runtimes.

## License

[MIT](https://github.com/investblog/spintax-js/blob/main/LICENSE)

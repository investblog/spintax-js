# n8n-nodes-spintax

**Use AI to create the template once. Use spintax to generate safely and cheaply forever.**

An [n8n](https://n8n.io) community node for [spintax](https://spintax.net) templates:
render personalized copy at scale, validate templates, generate N distinct variants,
check what actually came out, and drive an LLM authoring loop — without shipping a
single credential (you wire your own LLM node).

```
Sheets / CRM item
  └─► Build Authoring Prompt
        └─► your LLM node
              └─► Validate ──Invalid──► Build Repair Prompt
                    │            ▲              │
                  Valid          └── LLM node ◄─┘
                    │              (cap the loop, e.g. 2×)
                    └─► Render / Render Many
                          └─► Lint ──Defective──► drop it, draw another
                                │
                              Clean
                                └─► Uniqueness ──Dropped──► near-duplicates out
                                      │
                                    Kept
                                      └─► Email · Telegram · CRM
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
  instead of retrying forever or silently under-delivering. With a base seed each
  variant carries `attemptSeed` — the seed that actually produced it, which after a
  collision is no longer `baseSeed:variantIndex`, so a persisted pool can rebuild any
  single document later.
- **Validate** — routes each item to a **Valid** or **Invalid** output (valid ⇔ no
  error-severity diagnostics — warnings ride along). Diagnostics carry structured
  `code`, `line`/`column` spans and `data`, so downstream logic never parses messages.
- **Lint** — checks the *render*, not the template. A perfectly valid template still
  emits broken text when two adjacent slots pick the same word, a noun from one slot
  meets a pronoun from another, or an unlucky join leaves a space before a comma —
  none of it visible in the source. Routes **Clean** / **Defective**, or samples N
  renders from a template and reports how many came out clean. On a real pool that
  number was 2% before the slots it pointed at were fixed, and 100% after.
- **Uniqueness** — the pool question exact-string dedupe cannot answer: *are these
  documents actually different, or is it one skeleton wearing N hats?* Reads every
  incoming item as one pool, drops near-duplicates (**Kept** / **Dropped**) and
  reports the shared-shingle footprint. Measured: one template scores **0.962**, six
  templates of the same pool size score **0.017** — and more variants of the same
  template cannot fix it, because the skeleton is fixed by the template.
- **Protect Placeholders** — for text that goes on to *another* engine (Mailchimp
  merge tags, Liquid, CRM or SEO macros). `%name%` means one thing here and another
  there, `[…]` is permutation syntax so bracketed macros lose their brackets, and the
  cosmetic pass edits `D:` into `D: ` inside a macro parameter. Protect swaps them for
  markers before the render and puts them back after, verifying the result — and
  refuses loudly instead of corrupting quietly.
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

## Ready-made workflows

Importable templates, verified against a live n8n (**⋯ → Import from URL…**):

- **[Product-copy pool](https://raw.githubusercontent.com/investblog/spintax-js/main/packages/n8n-node/templates/product-copy-pool.json)** —
  the whole pipeline: brief → LLM writes one template → validate (+ one capped repair round) →
  12 variants → **Lint** each one → **Uniqueness** across the pool. The LLM runs once; every
  future run costs nothing.
- **[Cold-email bridge](https://raw.githubusercontent.com/investblog/spintax-js/main/packages/n8n-node/templates/cold-email-bridge.json)** —
  leads (or a *product feed*) in, a unique subject + body per row out, ready for your sending
  tool. Shows per-row deterministic seeds, data-driven conditionals and plural agreement; the
  same pattern writes unique product descriptions per storefront.
- **[AI authoring funnel](https://raw.githubusercontent.com/investblog/spintax-js/main/packages/n8n-node/templates/ai-authoring-funnel.json)** —
  brief → Build Authoring Prompt → your LLM → Validate → (one capped repair round) → Render
  5 variants. Connect credentials on the model node, or swap in any LLM node.

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

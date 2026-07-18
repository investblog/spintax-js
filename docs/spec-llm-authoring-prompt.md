# Canonical LLM Spintax Authoring Prompt (spec draft)

Status: **IMPLEMENTED — v1 shipped.** `packages/authoring-prompt` exists (merged in
[#46](https://github.com/investblog/spintax-js/pull/46)); the Telegram bot is its first consumer.
This document is now the **rationale**, not a plan — read it for *why* the prompt is shaped this
way. The one part still outstanding is §4, the prompt-conformance suite, tracked as
[#47](https://github.com/investblog/spintax-js/issues/47).
Owner: 301st
Tracking issue: [#45](https://github.com/investblog/spintax-js/issues/45) — **closed, delivered**.
Prerequisite for: [`spec-n8n-node.md`](./spec-n8n-node.md) (#44) — **satisfied**.

> **What shipped beyond the original design.** Three rules were forced by running the prompt's own
> examples through the real engine, and they generalise to every surface:
>
> 1. **Locale discipline.** `validate()` skips plural-arity checks when given no locale, while
>    `render()` defaults to 2-form — so a 3-form plural passes validation and then renders as the
>    fullwidth fallback `｛…｝`. Validate with the *same* locale you render with.
> 2. **`lastsep`.** The engine supports it; without it every generated list reads "a, b, c" instead
>    of "a, b and c". The default permutation separator is a **space**, so clauses without `sep`
>    come out as mush.
> 3. **Grammatical case is part of a variable's value.** A variable is substituted verbatim and
>    cannot be inflected from outside, which in Russian forces one variable per case. Hence
>    `AllowedVariable = string | { name, case?, note? }` — the case is **declared, never inferred
>    from the name**. (A real template set had `%CasinoGamesAcc%` holding *instrumental* forms: the
>    naming convention lied, the declaration could not.)

## 1. Why — this is extraction, not greenfield

**The drift already happened, in production.** The bot's `/draft` prompt
(`examples/telegram-bot/src/index.ts`, `DRAFT_SYSTEM`) teaches the model exactly three
constructs: `{a|b|c}`, `[a|b|c]`, and `%var%`. It does **not** teach `{?VAR?then|else}` or
`{plural %n%: …}` — the two locale-aware constructs a model will never reach for unaided, and the
two where this engine is actually differentiated. It carries no grammar-safety rules and no
self-check step.

So `/draft` today produces templates that any regex toy could render. Every new surface (n8n,
playground, API) would otherwise grow its *own* prompt, each a different subset. **Prompt v1 is a
consolidation of something that already exists and is already wrong** — the bot is its first
consumer, not an afterthought.

The material to consolidate is already written, as guides on spintax.net (§6).

## 2. Where it lives — a versioned artifact, not a web page

A canonical prompt that lives only as a page at `spintax.net/docs/llm-authoring-prompt/` will be
**copy-pasted by each consumer and will drift** — which is the exact failure we are fixing.

**Canonical source: `packages/authoring-prompt/`** in this repo — a tiny zero-dependency package
that exports the prompt and a builder. The website *renders* it; it is not the source.

- Consumers: the Telegram bot, the n8n node, the browser playground, a future API — all import it.
- **NOT part of `@spintax/core`.** The core is the engine; a prompt is product content (§2.2, small
  core). The engine must not grow authoring opinions.
- Same shape as the golden corpus: one language-neutral source of truth, many consumers. *The
  corpus is the engine's contract; the prompt is the authoring contract.*
- Ships a `promptVersion` (`"1"`), emitted by consumers alongside output, so any generated template
  is traceable to the prompt that produced it.

## 3. The prompt contract (v1)

Sections, in order:

1. **Role** — "you write valid Spintax templates".
2. **Goal** — **readable template first, variety second.** Every resolved variant must read like a
   human wrote it. (From *Reverse Authoring Mindset*: write the final text first, add markup last.)
3. **Supported syntax** — the minimum viable set, nothing else exists:
   `{a|b}` · `[a|b]` · `%var%` · `{?VAR?then|else}` · `{plural %n%: one|few|many}`
4. **Hard rules** — grammar-safe branches (all options must agree in the surrounding sentence);
   variables only from the supplied allow-list; **no unsupported syntax invented**; no nesting
   deeper than needed.
5. **Output contract** — return the template and nothing else: no prose, no quotes, no code fences.
6. **Self-check** — before answering: mentally render ~5 variants; if any reads awkwardly or breaks
   agreement, fix the branch, not the sentence.

### Language is not a cosmetic knob

Grammar-safety is **language-specific, and the Slavic languages are the hard case** (gender /
case / number agreement). For `ru`/`uk`/`be` and `sr`/`hr`/`bs` the prompt must:

- carry the agreement rules, and
- **push the model into `{plural %n%: …}` instead of a hand-rolled `{товар|товара|товаров}`** —
  the model cannot get the bucket boundaries right on its own, and this is precisely where the
  engine's locale-aware plural buckets are the moat.

`targetLanguage` therefore selects a **rules block**, not a translation hint.

### `variationLevel` needs an operational definition

`conservative | balanced | aggressive` is vibes unless defined as *which markup the model may
use*. Straw man, to be pinned in v1:

| level | allowed |
| --- | --- |
| conservative | `{a\|b}` only, and only on words that carry no agreement |
| balanced | + `%var%`, + `{?…}`, + `{plural}` |
| aggressive | + `[a\|b]` permutations, + nesting |

## 4. The prompt is testable — and we own the tester ⭐

This is what turns a "canonical prompt" from a doc into an engineering artifact.

A prompt that emits templates can be held to a **machine-checked bar**, because `validate()`
exists:

1. A fixture set of **briefs** (`brief`, `locale`, `allowedVariables`, `channel`, `variationLevel`).
2. Run each through the prompt against ≥1 model.
3. Assert: **zero diagnostics with `severity: 'error'`**, and `render()` produces N samples without
   throwing.
4. Track **valid-rate** per prompt version.

**Honest limit:** LLM output is nondeterministic, so unlike the golden corpus this gate is
**statistical, not exact** — the bar is a threshold (e.g. ≥95% valid across briefs × samples), not
byte equality. That is still enough to catch a prompt edit that quietly degrades output, which is
the actual failure mode.

Secondary metrics worth recording: share of drafts that use `{plural}` when the brief has a count,
and share that use `{?…}` when a variable is optional — i.e. *did the prompt actually teach the
differentiated features*, which is the very thing the bot's current prompt fails.

## 5. The loop needs a repair step

The obvious workflow dead-ends:

```
Build Prompt → LLM → Validate → Render samples
                        ↑ and when this returns errors… then what?
```

The missing piece is **Build Repair Prompt**: `(invalid template, Diagnostic[]) → a fix-it prompt`.

This is where the 0.1.3 investment pays off: precise `line` / `column` / `endLine` / `endColumn`
plus structured `data` let us point the model at the **exact span**, instead of "something is
wrong". The real funnel is:

```
draft → validate → repair (loop, capped) → render samples
```

**Never trust the output contract.** "No code fences" is correct to state and models will violate
it anyway — consumers must defensively strip fences/quotes *before* validating. Contract in the
prompt, tolerant parsing in the host.

## 6. What to distill, from which guide

Not one long page — a **compact operational prompt** assembled from the existing series:

| source guide | what v1 takes |
| --- | --- |
| [Reverse Authoring Mindset](https://spintax.net/docs/authoring-mindset/) | the goal: final readable text first, markup last |
| [Syntax Reference](https://spintax.net/docs/syntax) | the minimal syntax set — and *only* that set |
| [Grammar-safe Synonymization](https://spintax.net/docs/grammar-safe-spintax/) | the grammar checklist (EN agreement, **RU cases**) |
| [Conditional Spintax](https://spintax.net/docs/conditional-spintax/) | short rule: when to branch on a value |
| [Plural Agreement](https://spintax.net/docs/plural-spintax/) | short rule: counts → `{plural}`, never hand-rolled |
| [Template Composition](https://spintax.net/docs/template-composition/) | **advanced note only — out of the MVP prompt** |

## 7. Open questions

- **Q1 — model floor.** The bot runs a small Workers AI model and its drafts are already flagged as
  rough. Does v1 hold its valid-rate bar on that model, or does the bar imply a bigger one? *The
  prompt conformance suite answers this with a number instead of an opinion — run it across models
  and publish the valid-rate.*
- **Q2 — one prompt or a family?** Channel (email / SMS / push / landing) probably changes length
  and tone rules only. Start with one prompt + parameters; split only if the suite shows a channel
  dragging the valid-rate down.
- **Q3 — does the prompt own `neutralize()`?** No — shielding untrusted data is a *host* job at
  render time. But the prompt must know that `%var%` values arrive from the host and must never be
  invented. (See the n8n spec's Q3.)

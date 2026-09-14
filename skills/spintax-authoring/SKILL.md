---
name: spintax-authoring
description: Turn finished copy into a spintax template that generates many grammatical variants. Use when asked to build a spintax template from scratch, spin existing text, design variable scoping across sites, or compose large templates from reusable blocks.
---

# Authoring spintax templates

Writing a template directly, brace by brace, produces text that reads like a template. The
workflow below is the one the spintax.net guide series teaches, and it produces copy that
reads like copy.

## 1. Write the finished text first

Draft one concrete, publishable version. No braces, no variables — the piece you would ship
if you only needed one. This is the reference for what "good" sounds like, and every variant
you generate later is measured against it.

Settle one thing in the draft already: **no sentence ends on an address.** Write "Write to
info@example.com and we will reply within a day", not "Our address is info@example.com." Right
after an email address, a URL or a domain the cosmetic post-process cannot always tell where the
address ends, so a sentence glued on — a permutation opened straight after the period is the usual
way — is printed as part of the address. Keep the domain ending in lower case, too: `.com`, not
`.Com`.

## 2. Open it up, one decision at a time

Go back through the finished text and replace what can genuinely vary:

- interchangeable words → `{a|b|c}`, keeping the grammar of the surrounding sentence intact
- facts that differ per site or per product → `%variables%`
- lists whose order does not matter → `[a|b|c]` with a separator config
- sentences that only apply under a condition → `{?VAR?…}`
- anything counted → `{plural %n%: …}`

Two habits keep the result clean:

- **Fork the smallest span that differs.** Never repeat the fixed parts in both branches —
  `{Spintax (spin syntax) is|Spintax — "spin syntax" — is}` should be
  `Spintax {(spin syntax)|— "spin syntax" —} is`; repeating the fixed text only invites it to drift.
- **A fixed comma list is usually a permutation.** "alternatives, orderings, conditions,
  variables" reads better as `[<…> alternatives|orderings|conditions|variables]` — the order
  varies and it never reads as a keyword list.

Resist opening up everything. A template with a branch in every clause generates mush; the
variants that matter are the ones a reader would notice.

Guide: <https://spintax.net/docs/authoring-mindset.md>

## 3. Decide variable scope deliberately

The engine's own contract is one rule: **runtime variables override template-local
`#set`/`#def`** — both of them, so a local helper that shadows a runtime name silently
loses. Hosts add their own layers in between; the standard order, strongest first, is
**runtime → site → system → template-local**. Put facts that change per render at runtime,
per-site facts in the host's site layer, and keep template-local helpers for phrasing.
This is what lets one template serve many sites.

Four traps:

- **Directives own their line.** `#set` and `#def` are recognised only at the start of a
  line, one per line, above the copy that uses them. Written mid-sentence, a directive is
  not a directive: it stays literal text and is printed to the reader, and `validate()`
  reports nothing but an undefined-variable warning.
- **The re-roll gotcha.** A `#set` value re-rolls at every reference; use `#def` when the
  references must agree. Neither correlates two *different* variables — forms that must agree
  have to come from ONE roll: synonyms that decline alike with the ending outside the definition
  (`#def %e% = {магазин|сайт}` → `для %e%а`), or one `#def` stem that every form references
  (`#def %s% = {посетител|гост}`, `#def %V% = %s%и`, `#def %VG% = %s%ей`).
- **Separator collisions.** A list variable that already renders with a trailing `and`
  (`lastsep=" and "`) followed by fixed text that also starts with `and` reads
  "Slack, Jira, and Linear and other tools". Add a comma, restructure, or drop the conjunction.
- **Variable values are markup-capable by default.** The engine re-parses a value that
  contains `{`, `[` or `%`. If host- or user-supplied data must stay literal, pass it
  through the engine's `neutralize()` (exported by `@spintax/core`) before putting it in
  the context — the render pipeline restores the literal characters in the output.

Guide: <https://spintax.net/docs/variables.md>

## 4. Compose rather than grow

Past a screenful, stop extending one template and split it: an **item** template renders one
unit, a **section** template assembles items, an **orchestrator** assembles sections. Variables
hold rendered chunks, so the pieces stay independently testable and reusable.

When the host provides an include resolver, `#include "ref"` is the engine-level alternative
for reusable blocks — but know its boundary: an included template renders as its own
document, inheriting **runtime variables only**, never the parent's `#set`/`#def`. Where no
resolver exists (the playground, the MCP server), the directive stays in the output as
literal text.

Guide: <https://spintax.net/docs/template-composition.md>

## 5. Verify by volume

Render tens of variants and read them, not one. Specifically check:

- every conditional branch, both truthy and falsy
- every plural form, including the numbers that select the rarely-hit form (in Russian: 1, 2, 5, 11, 21)
- the shortest and longest permutation outcomes, for separator and spacing artefacts
- that no two rolls of the same `#set` variable were meant to agree with each other

## Patterns worth knowing

**Serial lists in titles and headings.** `[<minsize=2;maxsize=3;sep=", ";lastsep=" and "> …]`
gives headings that vary in both content and length without ever reading as a list of keywords.
Guide: <https://spintax.net/docs/permutations.md>

**Grammar binding.** Vary the whole phrase, not the one word inside it — that is what keeps
agreement, prepositions and articles correct. In Russian this extends to noun case.
Guide: <https://spintax.net/docs/grammar-safe-spintax.md>

**Repair by recipe, not by rewrite.** `validate()` judges the template; a lint over rendered
variants finds what lives in the combination of branches (a noun from one slot meeting a
relative pronoun from another, a root repeated across two slots, an empty pair of brackets).
Each defect class has ONE named recipe — bind the governed word into each branch, hoist the
noun into a one-gender `#def`, keep the root in one slot — so apply the recipe to the span
that produced the finding and change nothing else; never free-rewrite a template to fix it.
Guide: <https://spintax.net/docs/repairing-spintax.md>

**Draft with an LLM, render with an engine.** The economical shape is: pay a model once to
write the template, then render variants for free forever. The cost maths is worked through at
<https://spintax.net/ai-content-costs.md>.

## Related

- Worked example — a finished paragraph ("About Spintax") reverse-authored step by step, with real renders: <https://spintax.net/examples.md>
- `spintax-syntax` — the constructs themselves and the traps in each
- `spintax-engines` — running the template from JavaScript, PHP, Python, Object Pascal or .NET
- Whole documentation core in one fetch: <https://spintax.net/llms-full.txt>

---
name: spintax-syntax
description: "Write and debug spintax templates — {a|b} enumerations, [a|b|c] permutations, %variables%, #set/#def, {?VAR?then|else} conditionals and {plural n: form|form} agreement. Use when authoring, reviewing or fixing a spintax template, or when a template renders ungrammatical or unvarying output."
---

# Spintax syntax

Spintax is a template syntax for generating many variants of one text. This skill is the
working reference; every section links to the full page, which is also available as clean
Markdown at the same URL with `.md` appended.

## The constructs

| Construct | Meaning |
|---|---|
| `{blue\|grey\|clear}` | Enumeration — pick one option at random. An empty option (`{\|free\|paid}`) means "sometimes nothing". |
| `[1\|2\|3\|4]` | Permutation — shuffle the list. `[<, > 1\|2\|3]` sets the separator; `[<minsize=1;maxsize=3;sep=", ";lastsep=" and "> a\|b\|c]` sets size bounds too. |
| `%name%` | Variable reference. Names match `[A-Za-z_][A-Za-z0-9_]*` and are **case-insensitive**. |
| `#set %v% = …` | Declare a **macro**: the right-hand side is re-rolled at every reference. |
| `#def %v% = …` | Declare a **value**: rolled once per render, identical at every reference. |
| `#include "name"` | Pull in another template by name. |
| `{?VAR?then\|else}` | Conditional. Also `{?VAR?then}` (no else) and `{?!VAR?then\|else}` (inverted). |
| `{plural %n%: form\|form\|form}` | Grammatical number agreement for the render locale. |
| `/# … #/` | Comment — stripped before anything else runs. |

Everything nests: an enum option can contain a permutation, a permutation element can
contain an enum, a `#set` body can contain either.

Full reference: <https://spintax.net/docs/syntax.md> ·
Nesting depth and variant maths: <https://spintax.net/docs/nested-spintax.md>

## The traps that actually bite

**`#set` is not `#def`.** `#set %greeting% = {Hello|Hi|Hey}` gives a *different* greeting at
every `%greeting%`; `#def` gives the same one throughout the render (but still varies between
renders). Reach for `#def` when the value must stay consistent — a name, a tone, a count.
Two separate `#def` variables roll independently: `#def` fixes a value, it does not correlate
two variables with each other.

**Plural counts must be `#def`, never `#set`.** A `#set` count re-rolls between the number you
print and the number the plural form reads, so they disagree. The engine reports this as
`plural.count-macro`. Details: <https://spintax.net/docs/variables.md>

**Plural arity is per locale and is not what you would guess.** `ru`, `uk`, `be`, `sr`, `hr`
and `bs` take **three** forms; every other locale takes **two** — including `pl` (despite being
linguistically three-form) and `zh`/`ja`/`ko` (which get two, not one). Supplying the wrong
count of forms is an error, not a silent fallback.
Details: <https://spintax.net/docs/plural-spintax.md>

**Conditional truthiness is stricter than JavaScript's.** Undeclared, empty and
whitespace-only are falsy. `"0"` and `"false"` are **truthy** — they are non-empty strings.
There is no `{?VAR??else}` form; write `{?!VAR?else}`.
Details: <https://spintax.net/docs/conditional-spintax.md>

**A conditional is not a coin flip.** `{a|b}` picks at random; `{?VAR?a|b}` picks from a fact.
Using an enum where the choice depends on data produces text that contradicts itself.

**Swapping a word can break the sentence around it.** Synonyms must agree with their
articles, prepositions and (in Russian) case. Bind the varying parts together rather than
varying one word inside fixed scaffolding:
<https://spintax.net/docs/grammar-safe-spintax.md>

## Validating

Do not eyeball a template — run it. `@spintax/core` exports `validate(template)`, which
returns structured diagnostics with positions, and `render(template, opts)`, which runs the
whole pipeline in one call. See the `spintax-engines` skill for install and API.

Render at least a few dozen variants before shipping: single-render output hides the branch
that is ungrammatical. The browser playground at <https://spintax.net/play/> does this
interactively with inline error highlighting.

A template that validates clean can still render dirty — the defect lives in the combination
of branches, not in the source. Repair it by the named recipe for its class, never by a free
rewrite: <https://spintax.net/docs/repairing-spintax.md>

## Related

- `spintax-authoring` — the workflow for turning finished copy into a template
- `spintax-engines` — installing and calling an engine from JavaScript, PHP, Python, Object Pascal or .NET
- Whole documentation core in one fetch: <https://spintax.net/llms-full.txt>

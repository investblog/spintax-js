---
type: decision
status: proposed
tags: [syntax, parser, post-process, parity, interop]
issues: ["#92"]
---

# 0001 — A verbatim span: `/! … !/` stays in the output exactly as written

**Date:** 2026-10-19. **Status:** proposed — the owner accepts or amends before the first fixture.

## Context

An author cannot keep a fragment of a template literal. `{ }` and `[ ]` are always syntax, `/# … #/`
removes its content, and there is no escape (`\[` does not work — measured in #63). Three kinds of text
hit that wall:

- **Foreign markup** that goes on to another engine: GSA SER data-source macros (`#file[list.txt,1,S]`),
  BBCode (`[b]…[/b]`, `[url=…]`), merge tags. The brackets are eaten as a permutation, and the
  post-process edits the macro's parameters (`D:` → `D: `, `,1,S` → `,1, S`).
- **Markdown**: `[Spintax](https://spintax.net)` renders `Spintax(https://spintax.net)` — a permutation
  of one.
- **Prose about spintax itself**: `Write {Hello|Hi}` cannot be shown; it is rendered.

What exists today solves halves of this, outside the template:

- `neutralize()` shields a **value** the host injects through `context` against the parser — but not
  against the post-process, and not text the author writes in the template.
- *Protect / Restore* (`n8n-nodes-spintax`) swaps listed fragments for `^[A-Z0-9_]+$` markers around a
  render. Only that host has it, and the host must know the list.
- `spintax-win`'s GSA converter (its ADR 0005) lifts every construct it cannot express into a variable
  the caller must merge, so the default render reproduces the source. Correct, but the template is no
  longer self-contained, and the lifted text still meets the post-process unless the caller turns it off
  for the whole document.

The missing construct is the opposite of a comment: a span that **stays in the output as written**,
untouched by the parser **and** by the post-process.

### Measured (2026-10-19)

Over 3 560 stored documents of the family's own products (production templates in four languages, their
variable preludes, generated campaign templates in ten languages), the WP plugin, the site source and the
GSA test fixtures: the candidate delimiters `/!`, `!/`, `{=`, `=}`, `/=`, `=/`, `/~`, `~/` occur **0**
times each. Choosing any of them changes no stored output.

## Decision

Add one construct: **`/!` opens a verbatim span, the first `!/` after it closes it.** Its content is
emitted byte for byte; nothing inside is syntax, and the cosmetic post-process does not see it.

```
Docs: /![Spintax](https://spintax.net)!/       → Docs: [Spintax](https://spintax.net)
Write /!{Hello|Hi}!/ to get two variants        → Write {Hello|Hi} to get two variants
Pull from /!#file[D:\lists\kw.txt,1,S]!/ here   → Pull from #file[D:\lists\kw.txt,1,S] here
```

The delimiters mirror the comment's `/# … #/`: `/!` reads as "keep" where `/#` reads as "drop".

### Mechanism: the content is encoded in place, not stored in a table

A span is replaced, where it stands, by a **self-contained token**:

```
U+F0000  (digit digit)*  U+F0001        one pair of digits per code point of the content
digit = U+F1000 + n, n in 0..4095       pair for code point c = (c >> 12, c & 0xFFF)
```

All of it lies in Supplementary Private Use Area-A, which real text does not use (icon fonts sit in the
BMP PUA, untouched). The token carries its content, so there is no table, no AST-local key and no
re-keying: a `parse()` reused across renders, an `#include` body parsed separately, a `#set` value, the
#78 splice re-reading a construct's raw text — each just carries the token along. Every pass sees code
points that are not a letter, a digit, whitespace, punctuation, `|`, `%`, `#`, a bracket or a quote, so
none can read into it. Decoding is defined per **code point**, so engines that work in UTF-8 (PHP,
Object Pascal), code points (Python) or UTF-16 (JS, .NET) produce the same token.

### The rules — each pinned by a fixture before any engine changes

1. **One scanner for both block constructs, first.** A single left-to-right pass over the **original**
   source finds the next `/#` or `/!`; whichever comes first opens and runs to the first matching closer
   (`#/` or `!/`), searched from the end of the opener — so `/!/` is not a span (`/!/x!/` is the span
   `/x`). A comment may contain `/!` (removed with it); a span may contain `/#` and `#/` (kept). No
   nesting. An unclosed `/!` is literal text from there on, as an unclosed `/#` is. An empty span `/!!/`
   is removed, like an empty comment — it leaves no token behind to block the capitalizer or the trim.
2. **Sanitising happens outside spans only.** The scanner runs before `stripSentinels`; the reserved
   ranges — the neutralize sentinels U+E000–U+E005 and the span range U+F0000–U+F1FFF — are stripped from
   author text outside spans, so an author cannot forge a token; inside a span they are content, encoded
   like any other code point, and come back byte for byte.
3. **Then directives, then the tree.** Tokens are in place before `extractDirectives`. A span is a single
   token for every line-based rule, line terminators included (`\r\n`, `\r`, `\n`, U+2028, U+2029 are
   content): `#set %x% = /!a⏎b!/` is one valid `#set` line whose value renders `a⏎b`. A `#set`/`#def`
   line *inside* a span is text. A `%var%` inside is not a reference. A `|` inside is not a separator
   (`{a|/!x|y!/}` has two options, `a` and `x|y`).
4. **Every door from author source.** The template and every `#include` body go through `parseTemplate`,
   so both carry spans. A runtime `context` value does **not**: it is re-parsed by `parseSequence`, which
   does not strip comments either, so `/!` in a value is two characters — data must not decide what the
   post-process may skip. A host that wants a value literal calls `neutralize()`, unchanged by this ADR.
   For the same reason the span range U+F0000–U+F1FFF is **stripped from every runtime `context` value**
   when it enters the render, so data cannot carry a ready-made token past rule 2 (a forged token in a
   value is pinned: it renders as the post-processed text around it, the reserved code points gone).
5. **A span in a control slot is opaque text, nothing more.** Each construct treats it as it treats any
   text that is not its grammar: `{plural /!2!/: one|many}` has a non-numeric count; `{?/!flag!/?a|b}` is
   no conditional name; `#set %/!x!/% = …` is no directive; `[<sep="/! and !/">a|b]` is a separator that
   is not all letters, so it is emitted as written, unpadded (an author can force an exact separator this
   way). The fixtures pin each of these outputs; no engine special-cases a slot.
6. **What the engine hands to the host is decoded.** An `#include` ref containing a span reaches the
   resolver decoded, and `extract()` reports names and refs decoded — the host never sees a token.
7. **Decoding is last, always.** After `#include` resolution, after the post-process, **after**
   `safetyRestore` (so a U+E000–U+E005 inside a span is not rewritten into a brace), and also with
   `postProcess: false`. Decoding is **one left-to-right pass that never rescans what it emitted**: a
   span whose content is itself a well-formed token (reserved code points are content, rule 2) decodes
   once, to those code points, and stays so (pinned). Only a well-formed token (open, digit pairs, close)
   is decoded; with author text and runtime values both stripped of the range, nothing else in it can
   reach the decoder, and an engine that met one would leave it as it is.
7a. **Budgets measure the decoded content.** The expansion budget charges a token as the length of its
   content in the engine's own unit, not the token's encoded length (about four UTF-16 units per code
   point), so the encoding does not move the point where a bounded expansion stops.
8. **Around the span the post-process works as usual.** A token is not whitespace and not a closer, so
   `Hello./!x!/` gets the space a word would get (`Hello. x`); it is not a letter, so the capitalizer
   leaves a span alone at the start of the text, after a sentence end and after a block tag
   (`/!npm!/ install` stays lower-case); the final trim does not remove it, so a span's own edge
   whitespace survives (`/!  x  !/`). The URL, email and domain shields may swallow a token that touches
   them (`https://x.io/!a!/`); the token rides inside the shielded value and is decoded after the restore.
9. **Validation.** `validate()`, `extract()` and `analyze()` scan the same projection as the parser
   (comments removed, spans encoded), so a bracket inside a span raises nothing and a `%var%` inside is
   not reported. Diagnostic positions are mapped back to the author's source through the scanner's segment
   map — which also ends today's position shift after a comment (positions are not parity-gated; no
   fixture asserts them). An unclosed `/!` is a **warning**, `verbatim.unclosed` — not silent, as an
   unclosed comment is, because its content then parses as spintax and fails quietly (a markdown link
   becomes a permutation of one). A warning needs no mapping on the site's `/play/` (warnings are exempt).
10. **`analyze()`** counts spans in `constructs` (`verbatim`), the empty `/!!/` included (it is a span
    that renders nothing). Best-effort counts are not corpus-gated; the count is pinned in the engine's
    own suite.

### What a span cannot do

Contain `!/` — the first one closes it, as a comment cannot contain `#/`. There is no escape, by the same
reasoning as for comments: the delimiter pair is rare enough (measured 0) that an escape would cost more
than it saves.

## Corpus: one schema extension comes first

The current fixture schema cannot express what this ADR needs, and `#include` rendering is in fact
not gated across engines at all today:

- **`includes`** — a render-only map `ref → body`, from which every runner builds a synchronous resolver
  (an absent ref resolves to `null`). Needed for "a span in an include body and in the parent", for the
  decoded ref (rule 6) and for ADR 0002's pins. Every runner (TS, both PHP, py, win, dotnet) implements
  it before the span fixtures land.
- `analyze` stays out of the corpus (rule 10).

## Alternatives considered

- **A table of span contents in the AST, keyed by placeholders** (the first draft of this ADR). Keys end
  up in `setDefs`/`defDefs`, in the raw text the #78 splice re-reads, in plural and config slots; each
  `#include` body is a separate AST with colliding keys; every one of those places would need re-keying
  into a per-render registry, in six engines. The in-place encoding has none of that.
- **Protect / Restore promoted to `@spintax/core`.** No grammar change, but the host must know which
  fragments to protect: it does not help an author typing a markdown link into a template.
- **Document the limit** ("no literal braces or brackets"). Still worth a line next to the new
  construct; it solves none of the three cases.
- **A backslash escape** (`\[`, `\{`). Every bracket of a markdown link or a macro would need one, and
  `\` already occurs in real content (Windows paths in GSA macros); a span keeps a fragment as pasted.

## Consequences

- **A syntax-surface change is breaking** under this repo's contract: `@spintax/core` **0.14.0** (a minor
  on 0.x), `spintax/core` 0.14.0; the changelog says so. No stored output changes (measured).
  **`AST_VERSION` 4 → 5**: the shape does not change (tokens are text), but an AST parsed by a v4 parser
  carries no tokens, and a new renderer given one would spin `/!{a|b}!/` instead of emitting it — the
  same reasoning as v3 → v4, which kept the shape and bumped because old ASTs lacked `raw`.
- **Corpus:** the `includes` schema extension and its runners first; then `comments.json` (scanner order,
  `/!/`, `/!!/`, adjacent spans, unclosed opener followed by a comment and by a span), `render-semantics`
  (opacity, `|`, `#set`/`%var%`/`#include` inside, a span in a `#set` value and across its line, in an
  include body and the parent, CRLF and U+E000 inside, a span whose content is a well-formed token, a
  forged token in a `context` value, every control slot of rule 5), `render-postprocess`
  (adjacency, capitalizer, edge whitespace, a token inside a URL, `postProcess:false`), `validate`
  (`verbatim.unclosed`, no bracket diagnostic inside), `extract` (nothing inside reported; a decoded ref).
- **Mirrors:** both PHP engines (scanner at Stage 3 with the comment strip, decode after `post_process`
  and the sentinel restore; the plugin's own `[spintax]` placeholders are `\x00NESTED_n\x00` and do not collide),
  the three ports through their trackers.
- **Downstream:** syntax docs and the site's `/play/` highlighting; Studio and the browser extension
  highlighting; MCP needs nothing; `spintax-win`'s GSA converter can emit `/! … !/` instead of lifting
  unconvertible constructs into variables (its tracker). Teaching the span in the canonical authoring
  prompt is a `PROMPT_VERSION` bump with a site skill copy and a paid conformance run — the owner's call,
  not part of this change.

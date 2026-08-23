# Changelog

All notable changes to `@spintax/authoring-prompt` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The package version and `PROMPT_VERSION` are two different numbers. `PROMPT_VERSION` moves when
the prompt TEXT changes in a way that can change model output — it is what a consumer asserts
against, and what a conformance report is filed under. The package version follows semver over
the exported API.

## 0.2.1 — 2026-08-23

`PROMPT_VERSION` `'3'` → `'4'`. No API change. Two fixes in the Slavic grammar teaching, both
raised by the spintax.net session and both verified against the engine before being taken.

**A WRONG/RIGHT pair that rendered identically.** The east-slavic block taught
`в {городе|деревню}` → `{в городе|в деревню}`, and both forms produce the same output set
(`В городе` / `В деревню`): the preposition never varied, so moving it inside changed nothing. The
model was being shown a distinction it could not observe. Replaced with
`{после|при} первом заказе` → `{после первого заказа|при первом заказе}`, which renders
`После первом заказе` before (ungrammatical — `после` takes the genitive) and is clean after. BCS
had the same inert shape (`u {gradu|selo}`) and gets `{u|iz} gradu` → `{u gradu|iz grada}`. A test
now asserts the output sets DIFFER, so an inert pair cannot ship again.

**How to spin a declined noun — the ladder that was missing entirely.** A definition correlates a
name with ITSELF; nothing in the engine correlates two names. So two per-case definitions are two
independent rolls, and `#def %V% = {посетители|гости}` beside
`#def %VG% = {посетителей|гостей}` renders `Гости — для посетителей`. The first draft of this
advice said "one word per family, never a list" — which throws away the variety `#def` exists to
provide, and the owner rejected it. The correct rule keeps the list and collapses the roll:

1. Choose synonyms that **decline alike** and keep the endings outside the definition, so one roll
   serves every case: `#def %e% = {магазин|сайт|проект}` → `О %e%е, для %e%а, к %e%у`. Test every
   branch against every case — one differing ending disqualifies the branch, and `{больш|нов}`
   breaks in the nominative alone (`Большый проект`), which is the kind of defect that survives
   proofreading.
2. Endings agree, stems differ — cut at the stem and name the cases by REFERENCING it:
   `#def %s% = {посетител|гост}`, `#def %V% = %s%и`, `#def %VG% = %s%ей`. The stem must be `#def`:
   under `#set` it re-rolls per use and the correlation is lost. This is where the `#def`/`#set`
   distinction is at its most destructive, and the prompt now shows it there.
3. They genuinely decline differently — the whole span in one enumeration.

Every rung is asserted in the suite against the real engine, including the anti-pattern.

Conformance re-run: `conformance/reports/v4-claude-opus-5-2026-08-23.json`, **24/24 valid**, all
four secondary metrics at 100%.

Also from the same review, and NOT taken into the engine: `validate()` suppresses `plural.arity`
when a form slot holds a variable, while `render()` degrades the block to the fullwidth fallback —
so a host cannot pre-screen for it. That suppression is the deliberate #66 rule; what was missing
was any record of what the renderer does instead. Written up in
`packages/conformance/README.md` with the minimal repro and what would move it into work.

## 0.2.0 — 2026-08-23

`PROMPT_VERSION` `'2'` → `'3'`. No API change: same exports, same types. The prompt TEXT gained
three things it was missing, all found by auditing the built prompt against the engine's actual
syntax surface rather than against the spec.

**The prompt now states its own scope.** #76 established that the prompt writes the prose of ONE
block and the host composes structure — and said so in the spec and in the `Channel` doc comment,
i.e. to readers of this repo. The built v2 system prompt was 6 939 characters containing **zero**
occurrences of `long`, `block`, `paragraph`, `article` or `structure`; the only length signal
anywhere was `CHANNEL: generic short marketing copy` in the user part, which is a default the brief
is allowed to override. A host asking for an article got one, with invented markup. v3 carries a
`SCOPE` paragraph: one block, never a document, and if the brief describes structure, write the
single block it most directly asks for. **This changes output** for briefs that ask for long or
structured copy — deliberately, and that is what the version bump announces.

**Two passes, stated.** The reverse-authoring ordering was one clause in GOAL ("write the final copy
as if for a human, then add markup"). It is now its own paragraph, named as two passes that are
never merged, with the reason attached: inventing prose and choosing branches at once is what
produces variants that disagree with themselves, and it degrades with length — which is precisely
where the old phrasing was weakest.

**`#def` / `#set` own their line** (HARD RULE 6 + self-check). The grammar is line-anchored, and the
prompt left that to inference from how the worked examples happen to be laid out. The cost is
unusual enough to belong in the prompt rather than in a tool: `Hello. #def %a% = {x|y} and %a%
here.` validates with **no error** — the only diagnostic is a `variable.undefined` warning — and
renders the directive text to the reader. Neither `validate()` nor a repair round built from it can
see the defect, so the prompt is the only place the rule can live. The test asserts the engine
behaviour too, so the day mid-line directives start erroring is the day the rule can be relaxed.

**`{?VAR?then}` is taught.** The one-branch conditional was supported by the engine and absent from
the prompt, which taught only `{?VAR?then|else}` — so a model needing "print this only if the host
has a value" invented filler for the else half.

Conformance re-run on the new text: `conformance/reports/v3-claude-opus-5-2026-08-23.json`,
**24/24 valid**, all four secondary metrics at 100%. The v2 baseline report stays committed as
history.

Not taken, from the same audit: `#include` and `/# … #/` comments remain untaught (a resolver is the
host's, comments are dead weight in generated output), and the permutation shorthand
`[<", ">a|b]` stays untaught in favour of the explicit `sep`/`lastsep` form.

## 0.1.0 — 2026-08-21

First publish ([#75](https://github.com/investblog/spintax-js/issues/75)). Nothing in the prompt
changed: `PROMPT_VERSION` is still `'2'`, and the committed conformance baseline
(`conformance/reports/v2-claude-opus-5-2026-08-08.json`, 24/24 valid) still describes it.

Until now the package was `private`, and the only way to reach it from outside this repo was the
n8n node, which bundles the prompt into its own dist. A pipeline that wanted the same
draft → `validate()` → repair loop had two choices: a sibling checkout, or a copy of the prompt
text — and a copy is exactly the drift the package exists to stop (the bot's `/draft` had already
drifted to teaching three constructs before the prompt was centralized).

Public surface, now a contract: `buildAuthoringPrompt`, `buildRepairPrompt`, `cleanModelTemplate`,
`promptExamples`, `PROMPT_VERSION`, and the types `AuthoringPromptOptions`, `RepairPromptOptions`,
`BuiltPrompt`, `PromptExamples`, `VariableSpec`, `AllowedVariable`, `GrammaticalCase`, `Channel`,
`VariationLevel`.

`@spintax/core` is a **peer** dependency, `>=0.2.0`: the prompt asks the engine for plural arity
(`pluralArity`, `normalizeBaseLang` — public since core 0.2.0) instead of keeping its own copy of
the table, which had drifted twice. A peer rather than a dependency so the host ends up with one
engine — the prompt must agree with the engine the host validates with, not with a second copy
nested underneath. The range is open above on purpose: a core release that changed what the prompt
reads would be cut together with a prompt release, in the same wave.

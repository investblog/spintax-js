# @spintax/authoring-prompt

[![npm](https://img.shields.io/npm/v/@spintax/authoring-prompt.svg)](https://www.npmjs.com/package/@spintax/authoring-prompt)
[![CI](https://github.com/investblog/spintax-js/actions/workflows/ci.yml/badge.svg)](https://github.com/investblog/spintax-js/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@spintax/authoring-prompt.svg)](https://github.com/investblog/spintax-js/blob/main/LICENSE)

The **canonical prompt for writing [spintax](https://spintax.net) templates with a language
model** — one prompt, shared by the Telegram bot, the n8n node, the playground and any pipeline
that drafts templates with an LLM, so that a template drafted anywhere is drafted the same way.

It is product content, deliberately **not** part of [`@spintax/core`](https://www.npmjs.com/package/@spintax/core):
the engine must not grow authoring opinions. The engine is a peer dependency for exactly one
reason — the prompt asks it how many plural forms a locale has, instead of keeping a copy of the
table that can drift.

## Install

```sh
npm i @spintax/authoring-prompt @spintax/core
```

## Use it

The loop every consumer runs: build the prompt, call a model, strip what the model wrapped its
answer in, validate with the engine, and — when validation fails — ask the model to repair the
exact spans the engine reported.

```ts
import { buildAuthoringPrompt, buildRepairPrompt, cleanModelTemplate } from '@spintax/authoring-prompt';
import { validate } from '@spintax/core';

const prompt = buildAuthoringPrompt({
  brief: 'A two-sentence welcome message for a new subscriber',
  locale: 'en',
  channel: 'email',
  allowedVariables: ['firstName', { name: 'product', note: 'brand name — do not inflect' }],
});

// Any model. `systemPrompt` is stable per locale and cacheable; `userPrompt` carries the brief
// and the per-request allow-list.
let template = cleanModelTemplate(await callModel(prompt.systemPrompt, prompt.userPrompt));

let diagnostics = validate(template, { locale: 'en' });
if (diagnostics.some((d) => d.severity === 'error')) {
  const repair = buildRepairPrompt(template, diagnostics, {
    locale: 'en',
    allowedVariables: prompt.allowedVariables,
  });
  template = cleanModelTemplate(await callModel(repair.systemPrompt, repair.userPrompt));
}
```

Pass the **same `locale`** to the prompt, to `validate()` and later to `render()`: it selects the
grammar block and the plural arity the model is taught, and a mismatch is the bug the repair
prompt exists to fix.

## What it does not do

The prompt writes **the prose of one block** and never emits markdown or HTML; `channel` sets length
and tone only (`landing` is a headline plus one sentence, not page markup), and no option relaxes
that. If you need structure — an article of `<h2>` / `<p>` / `<ul>`, a document of sections — call
the prompt **once per block** and compose the structure in your code: wrap each block in its tag,
build the block-level permutations, write the separators yourself. That puts a whole class of
template defects (a literal `
` in a `sep=`, a dangling `</p>`, a triple newline from an empty
branch) out of reach by construction. Want a longer block? Ask for it in `brief` — the channel is a
default, the brief is the instruction.

## API

- `buildAuthoringPrompt(opts): BuiltPrompt` — `brief`, optional `locale`, `allowedVariables`
  (bare names or `{ name, case?, note? }`), `channel`, `variationLevel`.
- `buildRepairPrompt(template, diagnostics, opts?): BuiltPrompt` — takes `validate()` output
  verbatim; restate `locale` and `allowedVariables` so a repair cannot smuggle in a variable.
- `cleanModelTemplate(raw): string` — strips code fences, a `template:` label and wrapping quotes.
- `promptExamples(locale?)` — the worked examples the prompt teaches from, exported so a test can
  `validate()` the exact strings a model is shown.
- `PROMPT_VERSION` — bumps when the prompt text changes in a way that can change model output.
  Assert it in a pipeline that stores generated templates, and file conformance results under it.

`BuiltPrompt` is `{ systemPrompt, userPrompt, allowedVariables, promptVersion }`.

## Why it is shaped this way

The rationale is in [`docs/spec-llm-authoring-prompt.md`](https://github.com/investblog/spintax-js/blob/main/docs/spec-llm-authoring-prompt.md).
The reference loop — the one the committed conformance baseline was measured with — is
[`conformance/run.mjs`](https://github.com/investblog/spintax-js/blob/main/packages/authoring-prompt/conformance/run.mjs)
in this package's source.

## License

MIT.

# Changelog

All notable changes to `@spintax/authoring-prompt` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The package version and `PROMPT_VERSION` are two different numbers. `PROMPT_VERSION` moves when
the prompt TEXT changes in a way that can change model output — it is what a consumer asserts
against, and what a conformance report is filed under. The package version follows semver over
the exported API.

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

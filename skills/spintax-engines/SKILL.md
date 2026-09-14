---
name: spintax-engines
description: Install and call an open-source spintax engine from JavaScript, PHP, Python, Object Pascal or .NET — @spintax/core on npm, spintax/core on Packagist, spintax-core on PyPI, Spintax.Core on NuGet, and a Free Pascal engine on GitHub. Use when adding spintax rendering or validation to an application, choosing between the engines, or wiring a template pipeline into a runtime.
---

# Spintax engines

Five MIT-licensed, zero-dependency engines implement the same syntax and are held to a
shared corpus of golden fixtures. Pick by runtime, not by feature list.

| Runtime | Package | Install |
|---|---|---|
| JavaScript / TypeScript | `@spintax/core` | `npm install @spintax/core` |
| PHP 8.0+ | `spintax/core` | `composer require spintax/core` |
| Python 3.10+ | `spintax-core` | `pip install spintax-core` |
| Object Pascal / Free Pascal 3.2.2+ | the `spintax-win` repo | `git clone` (no package registry) |
| .NET (netstandard2.0, net472) | `Spintax.Core` | `dotnet add package Spintax.Core` |

There is also a GPL-2.0 WordPress plugin, which embeds the PHP engine and adds an editor,
caching and field bindings. The engines above are the engine on its own.

They are independent implementations, not ports of one another: JavaScript is the
reference engine and the home of the corpus, PHP is an extraction of the plugin's own
engine by the same copyright holder, and Python, Pascal and .NET are independent
reimplementations.
Overview: <https://spintax.net/spintax-engines.md>

## JavaScript

One `render()` call runs the entire pipeline — comments, `#set`/`#def`, conditionals,
variables, plurals, enumerations, permutations, post-processing. Do not compose the stages
by hand; there is no stage-composition API.

```js
import { render, validate } from '@spintax/core';

const out = render(template, { seed: 42, locale: 'ru', postProcess: true });

const diagnostics = validate(template, { locale: 'ru' });
// Diagnostic[] — each with severity, code, message and a position.
// Valid ⇔ no entry with severity 'error'.
```

`seed` makes a render reproducible; omit it for fresh randomness. `locale` selects plural
arity. `render()` is total on template content — a malformed construct degrades visibly in
the output rather than throwing, which is why you validate separately when you need to
report errors. It throws `SpintaxError` only on programmer error.

The package also exposes `parse`, `analyze` and `neutralize`, plus `pluralArity` and
`normalizeBaseLang`. Full API: <https://spintax.net/spintax-for-javascript.md>

## PHP

```php
use Spintax\Core\Render\Pipeline;

echo $pipeline->render($raw, $runtimeVars, $context, $locale, $postProcess);
```

`Validator::validate($template, $knownSlugs, $globalVarNames, $locale)` returns
`['errors' => [...], 'warnings' => [...]]` with message, line and column.

Two things the PHP package deliberately does **not** have: no AST (so no `analyze` /
`neutralize`), and no `seed` — you inject the RNG yourself. Note also that `Plurals::apply()`
on its own is **strict** and throws on a broken construct; `Pipeline` opts into lenient mode
for you, which is why `render()` does not throw.
Full API: <https://spintax.net/spintax-for-php.md>

## Python

```python
from spintax_core import render, validate, parse

render("{Hello|Hi} there!", seed=42)             # same seed, same output
render("Hi %name%!", context={"name": "Sam"})    # "Hi Sam!"
```

`spintax-core` is an independent implementation rather than a port, kept behaviourally
identical by the shared golden-fixture corpus. Two traps: **post-processing is on by
default** and capitalizes sentence starts (pass `post_process=False` for the raw pick),
and the bare `spintax` name on PyPI is a different, unmaintained GPLv3 package — install
`spintax-core`.

## Object Pascal / Free Pascal

No package registry — clone <https://github.com/investblog/spintax-win> and add the unit.

```pascal
uses Spintax;
var ctx: TSpContext;
begin
  DefaultSystemCodePage := CP_UTF8;   { declare UTF-8 once }
  ctx := Default(TSpContext);
  ctx.PostProcess := True;
  SpRender('{Hello|Hi} there!', ctx);
end;
```

Determinism is injected, not seeded: leave `ctx.Rng` nil for random output, or inject a
strategy (`TFirstRng`, `TLastRng`, `TSequenceRng`, seeded `TMulberry32Rng`). Free Pascal
3.2.2+ in `{$mode delphi}`; passes 254 of the corpus's 258 cases (the 4 skipped are the
engine-private RNG assertions).

## .NET

```
dotnet add package Spintax.Core
```

```csharp
using Spintax.Core;

Engine.Render("{Hello|Hi} there!", new RenderOptions { Seed = "42" }); // same seed, same bytes
foreach (var d in Engine.Validate("{a|b"))
    Console.WriteLine($"{d.Severity} {d.Line}:{d.Column} [{d.Code}] {d.Message}");
Engine.Combinations("{a|b} {c|d|e}"); // 6
```

`Spintax.Core` (NuGet, MIT, zero dependencies) builds `netstandard2.0` and `net472` from one
source, so it runs on .NET Framework 4.7.2+ and every .NET since. The surface is a static
`Engine` — `Render`, `Validate`, `Extract`, `Analyze`, `Neutralize`, plus `Combinations`
(exact count of distinct texts, by walking the tree) and `MaxLength` — flat on purpose:
strings, dictionaries, small option objects, no `Task<T>`, no mutable static state, so it
drops into automation hosts that load a dll by name (ZennoPoster-style) and renders the
same bytes from the same seed on many threads. Diagnostics carry a stable `Code` and a
1-based position. Rendering is lenient and post-processed by default; `Context` values
are re-parsed as templates — pass data through `Engine.Neutralize` first. Passes all 258
corpus cases on both targets. Source: <https://github.com/investblog/spintax-dotnet>

## n8n (no-code)

The JavaScript engine also ships as an n8n community node — `n8n-nodes-spintax` (the engine
is bundled in; zero runtime dependencies, no credentials, no network access). Eight
operations: Render, Render Many (each variant carries the `attemptSeed` that produced it),
Validate (routes items to Valid/Invalid outputs with structured diagnostics), Build
Authoring Prompt and Build Repair Prompt for an LLM authoring loop, plus three checks on
what the render produced — Lint (defects that live in the combination of choices, not in
the template; routes Clean/Defective), Uniqueness (reads all incoming items as one pool:
drops near-duplicates and reports the shared-skeleton footprint; routes Kept/Dropped) and
Protect Placeholders (round-trips foreign `%macros%` a second engine expands, past both the
parser and the cosmetic pass). Install on self-hosted n8n via Settings → Community Nodes.
Guide: <https://spintax.net/spintax-for-n8n.md>

## Cross-engine expectations

- **Identical output is guaranteed by the corpus, not by shared code.** If two engines
  disagree on a fixture, that is a bug worth reporting, not a documented difference.
- **The same seed does not mean the same output across engines.** Reproducibility is
  per-engine; only the set of legal outputs is shared.
- **Diagnostic codes are engine-specific.** Map them explicitly rather than falling through
  to a generic error — new codes appear on minor version bumps and silently degrade
  error reporting when unmapped.
- **A caret on a 0.x minor does not cross minors.** `^0.3.0` will not pick up `0.4.0`; bump
  the range deliberately when tracking a pre-1.0 engine.

## Related

- `spintax-syntax` — what the templates you pass in may contain
- `spintax-authoring` — designing those templates in the first place
- Browser playground, running `@spintax/core` client-side: <https://spintax.net/play/>

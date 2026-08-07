# n8n community node — `n8n-nodes-spintax` (spec)

Status: **DESIGNED + REVIEWED — ready to build (2026-08-07).** The draft's open questions are
resolved (§5), n8n's live verification constraints are folded into the packaging design (§4),
and the launch/marketing plan is pinned (§6). Codex review (same day, 10 findings) is applied:
the funnel carries `spintaxMeta` end-to-end, cleanup writes `cleanedTemplate` so spans match,
neutralize follows the trust tier, Render Many has an implementable contract, the scanner runs
post-publish, and R1 assumes verification unavailable until n8n confirms eligibility. Nothing is
written yet; the build plan is §7.

> **Build status (2026-08-07, same day):** `packages/n8n-node/` is BUILT — N0 and the code half of
> N1 are done (five operations, two-output Validate via a dynamic `outputs` expression, 27 tests,
> lint/typecheck/smokes green; the smoke proved it can see breakage via a control mutation).
> **Live-verified in a local n8n 2.33.7** (npm-linked via `~/.n8n/custom`): the node registers
> with all five actions, Render executed (`{Dr|Prof} Ada` T1 markup drew correctly under seed),
> and Validate's dynamic two-output routing sent a broken template to the Invalid branch with
> the full structured payload (cleanedTemplate, diagnostics with spans + data, counts, locale).
> **RELEASED: `n8n-nodes-spintax@0.1.1` is on npm** (0.1.0 bootstrapped via a one-off token —
> a Trusted Publisher entry cannot precede the first publish; 0.1.1 fixed the scanner's two
> author-field findings; the Trusted Publisher entry is live and the workflow is back to
> OIDC-only). n8n's official scanner passes ALL checks on 0.1.1 — run it via the
> `scan-n8n.yml` workflow (Linux; the scanner's tar breaks on Windows paths). N2 is next:
> eligibility ask (R1), gallery templates, forum post, hub obvyazka.
Owner: 301st
Tracking issue: [#44](https://github.com/investblog/spintax-js/issues/44).
Channel strategy: [spintax.net ADR 0007](https://github.com/investblog/spintax.net/blob/main/docs/decisions/0007-workflow-channels.md)
(this node first → Activepieces + Node-RED as ports → Pipedream gets a guide; Zapier/Make/Power
Automate deferred because they demand a hosted REST API).

> **Start here.** `buildAuthoringPrompt()` and `buildRepairPrompt()` already take
> `{ locale, allowedVariables }`, and `allowedVariables` accepts `{ name, case?, note? }` — which is
> exactly what this node needs, because its allow-list comes from the current item's fields and (in
> an inflected language) each field carries a grammatical case. The *rules* live in the system
> prompt and the *per-item list* in the user prompt, so the stable half stays cacheable across rows.

## 1. Why this, and why here

A language port buys a new **registry**. A surface buys a new **user**. n8n community nodes *are*
npm packages, so this needs **zero new engine work** — `@spintax/core` is already zero-dep, dual
ESM/CJS, Node 18+.

The n8n audience is precisely ours (cold-email sequences, content ops, automation plumbing), and
discovery happens **in-product**: users search for nodes inside n8n. That is a distribution channel
we have no equivalent of today.

**Home: `packages/n8n-node/` in this repo.** It is a TypeScript npm package that depends on
`@spintax/core`, so it belongs where the TS toolchain already is — npm workspaces, tsup, vitest,
the CI matrix, and the OIDC release pipeline all come for free. It is a **publishable product**,
not an example, hence `packages/` and not `examples/`.

## 2. The purity boundary still applies (§8)

Apart from the required `n8n-workflow` host SDK, the node's domain logic imports the public
exports of `@spintax/core` and `@spintax/authoring-prompt` **only** — never internal subpaths —
and neither sibling package imports the node. A consumer *proves* the API; it must not *pollute*
it. If building the node turns out to need something the core genuinely
lacks, that is a **consumer-driven reason** to revisit §9.2 — and surfacing exactly that kind of
feedback is the point of building it. What must **not** happen is convenience creep back into the
engine.

## 3. Node design

**One node, `Spintax`** (`displayName: "Spintax"`, `name: "spintax"`, group `transform`,
programmatic style — there is no remote API to be declarative about), with an `operation`
selector. All UI copy is **English only** — a hard verification rule (§4); the *templates and
prompts the node produces* are in whatever language the user works in, that is content, not UI.

> **The node is not a renderer — it is an authoring funnel.** Render/Validate alone make a utility;
> the prompt operations are what make an n8n user able to *produce* a good template without
> learning spintax theory. The canonical prompt shipped as `packages/authoring-prompt` (#46); the
> node consumes it, it does not invent its own — a second ad-hoc prompt here is exactly the drift
> the prompt package was built to fix.

The funnel the operations are designed around:

```
Sheets/CRM item → Build Authoring Prompt → LLM node → Validate ──Valid──→ Render / Render Many → Email/TG/CRM
                                                          │
                                                       Invalid
                                                          ↓
                                              Build Repair Prompt → LLM node ──┘ (capped, e.g. 2 attempts)
```

**One `locale` through the whole funnel.** Every operation takes the same `locale` option
(explicit default `en`); Build Authoring Prompt stamps it into `spintaxMeta` on the item, and
Validate / Build Repair Prompt / Render default to the stamped value. Authoring, validation,
repair and rendering disagreeing about locale is exactly the plural-arity failure the prompt
package exists to prevent — gallery workflows must carry `spintaxMeta` across the LLM node.

### Operation: Render

- Inputs: `template` (expression-friendly string) · **context** (next bullet) · `seed` (optional,
  expression-friendly) · `locale` · `postProcess` (default **on**, matching the engine).
- **Context: two layers, not a mutually-exclusive selector.** The incoming item's **top-level
  scalar fields** (default on; strings pass as-is, numbers/booleans via `String(value)`,
  null/array/object fields are skipped unless explicitly mapped — core's context is
  `Record<string, string>`) plus optional fixed key/value pairs defined in the node UI, which win
  on collision. "Ignore incoming item" is a toggle, not a third source.
- **Neutralize follows the trust tier, not one global switch** (§5 Q3). Incoming-item values are
  data-derived (T2) and pass through `neutralize()` **by default** (advanced off-toggle), so a
  scraped lead name containing `{` is data, not markup. Fixed pairs are author-typed (T1) and are
  **not** neutralized by default — each entry gets its own opt-in — so a deliberate `{Mr|Ms}`
  value keeps working without dropping the shield on the whole item.
- Advanced: `cleanModelOutput` (default off) — runs the canonical `cleanModelTemplate()` from
  `@spintax/authoring-prompt` (strips code fences, wrapping quotes, `Template:` prefixes, trims);
  the funnel templates switch it on because LLMs emit fences no matter what the prompt says.
  Contract in the prompt, tolerant parsing in the host. The cleaned value is written to
  `cleanedTemplate` on the item (original preserved as `rawTemplate`) and the operation consumes
  exactly that field — see Validate for why.
- Output: the incoming item with the rendered string on `outputField` (default `rendered`).
- NOT exposed in v1: `includeResolver` (verification forbids fs/env access and there is no host
  store to resolve against; `#include` refs render as-is per engine leniency), `maxDepth`.

### Operation: Render Many (N variants)

The host-level convenience the core deliberately does **not** ship (§9.3 — batching is a host
concern) — with an implementable contract, not a sketch: inputs `count` (default **5**, range
1–100), optional `baseSeed`, `maxAttempts` (default `min(500, 5 × count)`). **Parse once** (one
`parse()` handle for all attempts). With `baseSeed`, attempt *i* uses the documented derivation
`` `${baseSeed}:${i}` `` — deterministic, and portable as-is to the Activepieces/Node-RED ports;
without it, unseeded independent renders. Dedupe by the final rendered string. Emit one item per
variant — `{ rendered, variantIndex, requested, produced }` — **with `pairedItem` set to the
source input index** on every emitted item (n8n's item-linking requirement; unlinked fan-out
breaks downstream field access to the source row). Never claim exact cardinality.

> **Carry the honest caveat from the README into the node's UI copy.** Distinct seeds are
> *independent draws, not distinct results* — a low-cardinality template will repeat, and may
> simply not have N combinations to give. The node degrades gracefully (returns what exists, says
> how many) rather than spinning forever. The competing generic npm approach hides exactly this
> behind a `Set` + retry loop that silently returns fewer than asked; we say so out loud.

### Operation: Validate

- **Two outputs: `Valid` / `Invalid`** (refined from the draft's diagnostics-as-items). Valid ⇔ no
  `severity:'error'`, exactly the engine's parity-gated definition. The item passes through with
  `diagnostics` attached (warnings ride along on the Valid branch too), so the Invalid branch
  already carries everything Build Repair Prompt needs — the repair loop is one wire, no Merge
  node gymnastics.
- Diagnostics are structured: `severity`, `code`, `message`, `line`, `column`, `endLine`,
  `endColumn`, `data`. The precise positions and structured `data` shipped in **0.1.3** are what
  make a usable node UI possible **without parsing `message`** — which matters, because `message`
  is explicitly *not* parity-gated and may change.
- Same `cleanModelOutput` advanced option as Render (the funnel validates raw LLM output).
  **Diagnostic positions always refer to `cleanedTemplate`**, and Build Repair Prompt / Render
  consume that same field — otherwise Repair's "exact span" points into a string whose fence line
  the cleaner removed, off by exactly the stripped lines.
- Options: `locale` (plural verdicts are locale-sensitive; defaults from `spintaxMeta`),
  `knownIncludes` (unknown-`#include` checking is opt-in, matching `ValidateOptions`), and
  `knownVariables` — defaulted from `spintaxMeta.allowedVariables` names, so the allow-listed
  runtime variables don't surface as avoidable unresolved-`%var%` warnings.

### Operation: Build Authoring Prompt

We do **not** embed an LLM provider or ship credentials — the node emits a prompt, the user wires
their own LLM node (OpenAI / Anthropic / Gemini / local). Provider-agnostic by construction.

- Inputs: `brief` / source text · `targetLanguage` · `allowedVariables` — a fixedCollection of
  `{ name, case?, note? }` (mapped from the current item's fields; `case` matters in inflected
  languages) with an "use incoming item's field names" convenience mode · `channel`
  (email / SMS / push / landing) · `variationLevel` (conservative / balanced / aggressive — the
  prompt spec's operational definition; without one it is unreproducible).
- Output on the item:

```json
{
  "systemPrompt": "…",
  "userPrompt": "…",
  "spintaxMeta": {
    "locale": "ru",
    "allowedVariables": [{ "name": "first_name", "case": "nominative" }, { "name": "company" }],
    "promptVersion": "2"
  },
  "nextStep": "Send this to your LLM node, then run Validate on the returned template"
}
```

`promptVersion` is the package's exported `PROMPT_VERSION` (currently `'2'`), never a literal in
the node. `spintaxMeta` keeps the *full* variable specs (`{ name, case?, note? }`, not bare
names) and the locale, because Validate / Repair / Render downstream need exactly those to check
and teach the same rules the authoring prompt taught.

### Operation: Build Repair Prompt

`(template, Diagnostic[]) → a fix-it prompt.` Without this the workflow **dead-ends** the first
time the model returns something invalid — and it will. The precise 0.1.3 spans let the repair
prompt point at the exact offending token rather than saying "something is wrong". Defaults read
`cleanedTemplate` (falling back to `template`), `diagnostics` and `spintaxMeta` from the incoming
item — i.e. straight off Validate's Invalid output, with the spans and the string they index
guaranteed to match. The loop is **capped by the workflow** (templates show 2 attempts); the node
documents that.

## 4. Packaging — shaped by n8n's verification rules

Verification constraints (re-checked against the live guidelines 2026-08-07; **re-read them again
at submission time**):

- **Zero runtime dependencies.** Verified nodes may not declare `dependencies`. So the node
  **bundles** `@spintax/core` and `@spintax/authoring-prompt` into its `dist` via tsup
  `noExternal` — the published manifest has an empty `dependencies`, and `peerDependencies` is
  exactly `{ "n8n-workflow": "*" }` — the literal value n8n's `valid-peer-dependencies` lint rule
  enforces. This also **settles the launch-checklist "publish-or-bundle" question for the node:
  bundle, forced.** Publishing `@spintax/authoring-prompt` to npm stays desirable for
  spintax.net's skill-drift check (drop the sibling-checkout hack) but is no longer a gate here.
- **GitHub Actions + provenance is mandatory** for verified nodes since May 2026 — our OIDC
  release pipeline already works exactly this way.
- **English-only** node interface and docs (parameter names, descriptions, errors, README).
- **MIT** (✓), **TypeScript** (✓), **public repo with matching npm metadata** — monorepo is fine
  via `repository.directory: "packages/n8n-node"`.
- **No env-var or filesystem access** — the engine is pure compute; nothing to hide.
- `eslint-plugin-n8n-nodes-base` goes into this repo's CI gates. **The scanner cannot** — 
  `npx @n8n/scan-community-package n8n-nodes-spintax@X.Y.Z` downloads the npm release, verifies
  its provenance and fetches the attested source commit, so an unpublished package cannot pass
  it. The exact-version scan runs **after** each publish and gates the *verification submission*,
  not the first publication.
- The node must not duplicate an existing node — **checked 2026-08-07: no spintax node exists and
  the npm name `n8n-nodes-spintax` is free** (registry 404).

Mechanics:

- npm name **`n8n-nodes-spintax`**, keyword **`n8n-community-node-package`** (what n8n's
  in-product search indexes — without it the node is invisible). Package version is independent
  semver; the node description's n8n `version` starts at 1.
- Output **CJS** (n8n loads nodes via require), built with the workspace tsup. Layout follows the
  n8n scaffold conventions (`nodes/Spintax/Spintax.node.ts`, `package.json` `n8n` block, SVG
  icon) even though we build in-monorepo rather than from the `n8n-node` CLI scaffold — the
  scanner and linter are the arbiters of convention, and they run in CI.
- **Release:** own tag prefix `n8n-node-vX.Y.Z`, own workflow (clone of `release.yml` scoped to
  the package, same gate list), and its **own npm Trusted Publisher entry** — the
  `@spintax/core` entry does not cover it (see `RELEASING.md`).

**Risk R1 — assume Cloud verification is unavailable until n8n says otherwise.** The current
rules want each package to "integrate exactly one third-party service" and exclude logic/flow
nodes; a bundled local library is **not** a third-party service, and framing it as *the*
integration for the Spintax ecosystem changes positioning, not the technical category. So: **ask
n8n for eligibility feedback before N2** rather than discovering the answer at submission. If
refused, distribution is npm + the self-hosted instances *whose admin policy permits unverified
community packages* (not "every instance"), and discovery shifts to the gallery templates, the
article and the forum post (§6) rather than the Cloud node picker. Cloud verification is upside,
not the load-bearing floor.

## 5. Resolved design questions (were §5 open questions)

- **Q1 — one node or three?** **One node** with an `operation` selector (n8n convention; five
  operations share one template/context vocabulary).
- **Q2 — how is `context` supplied?** **Both**, defaulting to the incoming item's JSON — that is
  what makes it useful in a real workflow (lead list in, personalized copy out); fixed pairs
  override item fields on collision.
- **Q3 — `neutralize()` on context values?** **Yes, default on**, with an advanced off-toggle.
  Data-derived values (a scraped lead name containing `{`) must be data, not markup; the engine
  deliberately does not auto-shield, so the host must — and this node is a host.

## 6. Launch & marketing plan

Sequenced; the build (§7) gates everything below it. Hub-side execution lives in spintax.net's
`docs/TODO.md` (`/spintax-for-n8n/` entry, already gated on this node shipping) and ADR 0007.

Two positioning rules inherited from the hub's editorial line (`.claude/rules/content.md` there),
so no surface here drifts from it:

- **The pitch is the hub's core message**, not a new formulation: *"Use AI to create the template
  once. Use Spintax to generate safely and cheaply forever."* The authoring funnel (Build Prompt →
  LLM → Validate/Repair → Render) is that sentence operationalized — README, forum post and
  template descriptions lead with it.
- **Engine-level, not tool-level.** The hub spent 2026-07 scrubbing "WordPress plugin" and "GTW"
  out of positioning copy because *WordPress is a runtime, not the product* — the same rule
  applies here: n8n is **a runtime among many**, never "the product is now an n8n node".

1. **Finish the package as a landing page first** — npm captures the README in the published
   tarball, so it precedes the publish, not follows it. README (English): the core message, the
   funnel diagram, a 60-second quickstart, the honest N-variants caveat as a stated
   differentiator, and the ecosystem block — **one syntax contract across the
   npm/Packagist/PyPI/Pascal engines, held to the shared 234-case conformance corpus** (four
   independent implementations, per the governing spec — never "the same engine everywhere"),
   plus the live bot, the MCP server in the official registry and **Spintax Studio in the
   Microsoft Store** — a maintained ecosystem, not a weekend wrapper. Plus the SVG icon, package
   metadata, packed-file list, clean-install smoke test.
2. **Ship `n8n-nodes-spintax@0.1.0`** to npm with provenance (§4 release path).
3. **Run the exact-version scan, then submit for n8n Cloud verification** — with the eligibility
   feedback from §4 risk R1 already in hand, re-reading the live guidelines at submission time.
4. **2–3 workflow templates** in the n8n gallery — each is a discovery page and the onboarding at
   once:
   - *Cold-email bridge:* Google Sheets leads → Render per row → the user's sending tool
     (Instantly / Smartlead / etc. via their own n8n nodes). This automates the
     **render-then-upload bridge** that spintax.net's `/spintax-for-cold-email/` article teaches
     manually (write full-syntax template → render locally / Studio XLSX → upload the column as a
     merge field) — the article has already built the demand argument for exactly this workflow
     (sending platforms parse flat `{a|b|c}` only; permutations/conditionals/plurals are the gap).
   - *AI authoring funnel:* brief → Build Authoring Prompt → LLM → Validate → (repair loop,
     capped) → Render Many → destination. This is the flagship — it demos the whole point.
   - Optional third: Telegram/newsletter variant of the first.
5. **Community forum Show & Tell post** at launch — leads with the funnel template, not the node.
6. **spintax.net obvyazka** (hub side, already queued): `/spintax-for-n8n/` article EN+RU (angle:
   the LLM-authoring funnel the node operationalizes — Build Authoring Prompt / Validate / Build
   Repair Prompt as the loop n8n users otherwise hand-roll), docs-hub card, `/spintax-engines/`
   and landing mentions, `llms.txt` entry — **plus a section in `/spintax-for-cold-email/`**
   ("or automate the bridge") pointing at the cold-email gallery template, and a line in the
   landing's vendor-ask context: until a vendor adopts the syntax, the node *is* the no-code
   route. Both gated on the node shipping, tracked in the hub's `docs/TODO.md`.
7. **Social queue** (`spintax-social` worker, editorial order): TG RU + Bluesky/Mastodon EN.
   Ecosystem angle over feature angle — "the Spintax contract already ships on npm, Packagist and
   PyPI, with a Pascal implementation, a Windows Store editor and a Telegram bot; now its
   JavaScript engine plugs into n8n" (the copy respects the independent-implementations framing,
   same as step 1).
8. **Then the ports** (ADR 0007): Activepieces piece + Node-RED node reusing the same operation
   logic; Pipedream gets a guide (their code steps import npm natively — `@spintax/core` already
   works there). Marginal cost is the SDK wrapper, not the design. **Two tracks, so #44's two
   ordering decisions don't collide:** the *engine track* keeps its earlier #44 order — #47 (the
   prompt-conformance quality gate) follows the node and must not block its skeleton, then M6,
   then the runtime ports (#43) — while this *channel track* (Activepieces / Node-RED / Pipedream)
   follows the node per the later #44 decision (ADR 0007) and does not gate on #47/M6.

## 7. Build plan

- **N0 — skeleton + Render + Validate; pre-publication gates only.** Package scaffolding per §4,
  the two mechanical operations, `eslint-plugin-n8n-nodes-base` green in CI, `npm pack` +
  manifest inspection + clean-install CJS smoke test, vitest coverage for context mapping /
  per-tier neutralize / clean-model-output / two-output validate. The scanner does **not** run
  here — it needs a published release (§4).
- **N1 — Build Authoring Prompt + Build Repair Prompt + Render Many.** The funnel is complete;
  README + icon land *before* the publish; `0.1.0` released, then the exact-version scan
  (§6 steps 1–3).
- **N2 — templates + submission.** Gallery templates, verification submission (eligibility
  feedback per R1 first), forum post; hub obvyazka unblocks on its own gate.

## 8. Adjacent surfaces (same argument, not yet filed)

- **VS Code extension** — syntax highlighting + inline `validate()`. The 0.1.3 diagnostic positions
  were built for this.
- **Google Sheets / Apps Script add-on** — marketers live in spreadsheets.

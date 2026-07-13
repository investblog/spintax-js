# n8n community node — `n8n-nodes-spintax` (spec draft)

Status: **DRAFT / pre-code — but UNBLOCKED and NEXT UP.** The prerequisite (the canonical authoring
prompt) shipped in [#46](https://github.com/investblog/spintax-js/pull/46), so this is the agreed
next product step. Nothing is written yet.
Owner: 301st
Tracking issue: [#44](https://github.com/investblog/spintax-js/issues/44).

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

The node imports `@spintax/core` **only**. A consumer *proves* the API; it must not *pollute* it.
If building the node turns out to need something the core genuinely lacks, that is a
**consumer-driven reason** to revisit §9.2 — and surfacing exactly that kind of feedback is the
point of building it. What must **not** happen is convenience creep back into the engine.

## 3. Operations

> **The node is not a renderer — it is an authoring funnel.** Render/Validate alone make a utility;
> the prompt operations below are what make an n8n user able to *produce* a good template without
> learning spintax theory. **Prerequisite: [`spec-llm-authoring-prompt.md`](./spec-llm-authoring-prompt.md)
> (#45) ships first** — the node consumes the canonical prompt, it does not invent its own. That is
> the whole point: today the bot has its own ad-hoc prompt, and a second one here is exactly the
> drift we are fixing.

### Build Authoring Prompt
We do **not** embed an LLM provider or ship credentials — the node emits a prompt, the user wires
their own LLM node (OpenAI / Anthropic / Gemini / local). Provider-agnostic by construction.

Inputs: `brief` / source text · `targetLanguage` · `allowedVariables` (derived from the current
item's fields — e.g. `first_name`, `company`, `plan`) · `channel` (email / SMS / push / landing) ·
`variationLevel` (conservative / balanced / aggressive — see the prompt spec for the operational
definition; without one it is unreproducible).

Output:

```json
{
  "systemPrompt": "…",
  "userPrompt": "…",
  "allowedVariables": ["first_name", "company"],
  "promptVersion": "1",
  "nextStep": "Send this to your LLM node, then run Validate on the returned template"
}
```

### Build Repair Prompt
`(template, Diagnostic[]) → a fix-it prompt.` Without this the workflow **dead-ends** the first
time the model returns something invalid — and it will. The precise spans from 0.1.3
(`line`/`column`/`endLine`/`endColumn` + structured `data`) let the repair prompt point at the exact
offending token rather than saying "something is wrong".

The loop must be **capped** (e.g. 2 repair attempts), and the node must **defensively strip code
fences/quotes** from the model's reply before validating — the prompt forbids them, models emit
them anyway. Contract in the prompt, tolerant parsing in the host.

Resulting workflow:

```
Sheets/CRM item → Build Authoring Prompt → LLM node → Validate ──ok──→ Render samples → Email/TG/CRM
                                                          │
                                                        errors
                                                          ↓
                                              Build Repair Prompt → LLM node ──┘ (capped)
```

### Render
Inputs: `template`, `context` (mapped from the incoming item's fields), `seed` (optional,
expression-friendly), `locale`, `postProcess` (default **on**, matching the engine).
Output: the rendered string on the item.

### Validate
Output: diagnostics as items — `severity`, `code`, `message`, `line`, `column`, `endLine`,
`endColumn`, `data`.

The precise positions and structured `data` shipped in **0.1.3** are what make a usable node UI
possible **without parsing `message`** — which matters, because `message` is explicitly *not*
parity-gated and may change.

### N variants
The host-level convenience the core deliberately does **not** ship (§9.3 — batching is a host
concern). Implement it *here*: render N times with different seeds, dedupe, and **cap the
retries**.

> **Carry the honest caveat from the README into the node's UI copy.** Distinct seeds are
> *independent draws, not distinct results* — a low-cardinality template will repeat, and may
> simply not have N combinations to give. The node must degrade gracefully (return what exists,
> say how many) rather than spin forever. The competing npm package hides exactly this behind a
> `Set` + retry loop that silently returns fewer than asked; we say so out loud.

## 4. Packaging

- npm name **`n8n-nodes-spintax`**, keyword **`n8n-community-node-package`** (this is what n8n's
  in-product search indexes — without it the node is invisible).
- Peer dependency on `n8n-workflow`; no credentials needed (the engine is offline and stateless).
- Lint with `eslint-plugin-n8n-nodes-base` — n8n's community-node review checks it.
- **Publishing needs its own npm Trusted Publisher entry** pointing at its workflow (see
  `RELEASING.md`: each package needs one; the `@spintax/core` entry does not cover it).

## 5. Open questions

- **Q1 — one node with an operation selector, or three nodes?** n8n convention leans to one node
  with `operation` (Render / Validate / N Variants). *Recommendation: one node.*
- **Q2 — how is `context` supplied?** Fixed key/value pairs in the node UI, or "use the incoming
  item's JSON as the context"? The second is what makes it useful in a real workflow (a lead list
  in, personalized copy out). *Recommendation: support both; default to the item's JSON.*
- **Q3 — does the node call `neutralize()` on context values?** Data-derived values (a scraped
  lead name containing `{`) would otherwise be re-interpreted as markup. The engine does **not**
  auto-shield; the host must. *Recommendation: yes, with an "advanced" toggle to turn it off —
  and this is exactly the sort of question that only building a consumer surfaces.*

## 6. Adjacent surfaces (same argument, not yet filed)

- **VS Code extension** — syntax highlighting + inline `validate()`. The 0.1.3 diagnostic positions
  were built for this.
- **Google Sheets / Apps Script add-on** — marketers live in spreadsheets.

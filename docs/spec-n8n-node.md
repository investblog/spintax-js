# n8n community node — `n8n-nodes-spintax` (spec)

Status: **RELEASED; 0.2.6 on npm, gallery submission 18308 under review (2026-08-16).**

> **Read [§6.1](#61-where-it-actually-stands--2026-08-16-and-how-to-resume) first.** It carries the
> current state and everything needed to resume — what is published, what is submitted where, which
> portal behaviours were measured rather than documented, and what comes next. The rest of this file
> is design and plan, and the dated status blocks below are history: where they disagree with §6.1,
> §6.1 wins.

The draft's open questions are resolved (§5), n8n's live verification constraints are folded into
the packaging design (§4), and the launch/marketing plan is pinned (§6). Codex review (10 findings) is applied:
the funnel carries `spintaxMeta` end-to-end, cleanup writes `cleanedTemplate` so spans match,
neutralize follows the trust tier, Render Many has an implementable contract, the scanner runs
post-publish, and R1 assumes verification unavailable until n8n confirms eligibility.

> **Build status (2026-08-07, same day):** `packages/n8n-node/` is BUILT — N0 and the code half of
> N1 are done (five operations at the time — eight since 0.2.0 — two-output Validate via a
> dynamic `outputs` expression, 27 tests, lint/typecheck/smokes green; the smoke proved it can
> see breakage via a control mutation).
> **Live-verified in a local n8n 2.33.7** (npm-linked via `~/.n8n/custom`): the node registers
> with all five actions, Render executed (`{Dr|Prof} Ada` T1 markup drew correctly under seed),
> and Validate's dynamic two-output routing sent a broken template to the Invalid branch with
> the full structured payload (cleanedTemplate, diagnostics with spans + data, counts, locale).
> **RELEASED: `n8n-nodes-spintax@0.1.1` is on npm** (0.1.0 bootstrapped via a one-off token —
> a Trusted Publisher entry cannot precede the first publish; 0.1.1 fixed the scanner's two
> author-field findings; the Trusted Publisher entry is live and the workflow is back to
> OIDC-only). n8n's official scanner passes ALL checks — run it via the
> `scan-n8n.yml` workflow (Linux; the scanner's tar breaks on Windows paths).
>
> **N2 status (2026-08-09):** current release is **`0.1.4`** (scanner green). Both gallery
> templates live in `packages/n8n-node/templates/`; the *cold-email bridge* was **submitted to
> the n8n gallery 2026-08-08** (manual review, 3–5 business days — the second template waits for
> the first to clear, the Creator Portal would not accept it earlier). Demo assets for the AI
> authoring funnel are in `temp/marketing/` (gitignored): `spintax-ai-funnel-result.png` is a
> real end-to-end run through `claude-opus-5` (valid on the first attempt, repair branch unused —
> consistent with the 100% prompt-conformance baseline in
> `packages/authoring-prompt/conformance/reports/`). Remaining N2 order: template 1 clears
> moderation → submit template 2 → forum Show & Tell post + verification submission via the
> Creator Portal (drafts in `temp/marketing/`). Hub obvyazka tracks separately.
>
> **0.2.0 — the four field-report issues (2026-08-14).** Building a 1000-article pool on top of
> the node produced four issues, all now closed in code: **#60** Render Many emits `attemptSeed`
> (the seed that produced a variant is not derivable from its index after a collision), and three
> new operations — **#61 Lint** (defects in the combination of choices; 2% → 100% clean on a real
> pool), **#62 Uniqueness** (near-dup drop + shared-skeleton footprint; one template 0.962, six
> 0.017), **#63 Protect Placeholders** (foreign `%macros%` survive the parser AND the typographer).
> Reference implementations came from `admin/content-gen` (zero-dep CJS, 141 tests, green on a real
> campaign); ported here with their measurements kept as the rationale. New gallery template
> `templates/product-copy-pool.json` runs the whole lane. Node suite: 101 tests.
>
> **Gallery status (2026-08-14) — SUPERSEDED by §6.1**, which has 17930 open again and awaiting
> changes, not closed: the cold-email bridge (17930) was
> **rejected** — "too basic",
> after a first round about sticky-note overlap. The layout fix never reached the reviewer (the
> Creator Portal locked the submission with the old JSON), but the verdict is about substance, not
> layout, so that submission stays closed. The product-copy-pool template is the answer to it and
> is submitted **after** 0.2.0 is published, since it uses operations that do not exist before it.

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
Sheets/CRM item → Build Authoring Prompt → LLM node → Validate ──Valid──→ Render / Render Many
                                                          │                        │
                                                       Invalid                     ↓
                                                          ↓                Lint ──Defective──→ drop, draw again
                                              Build Repair Prompt                  │ Clean
                                                          ↓                        ↓
                                                      LLM node ──┘         Uniqueness ──Dropped──→ near-dups out
                                              (capped, e.g. 2 attempts)            │ Kept
                                                                                   ↓
                                                                            Email / TG / CRM / files
```

**Validate judges the template, Lint judges the render, Uniqueness judges the pool.** Three
different questions, and only the first one is answerable from the source — which is why the
second and third had to become operations rather than advice (#61, #62). `Protect Placeholders`
sits outside this lane: it wraps the render when the text has a *second* engine downstream (#63).

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
variant — `{ rendered, variantIndex, attemptSeed?, requested, produced }` — **with `pairedItem` set
to the source input index** on every emitted item (n8n's item-linking requirement; unlinked fan-out
breaks downstream field access to the source row). Never claim exact cardinality.

> **`attemptSeed` is the accepted variant's own seed, and it is not derivable from the index**
> (#60). The seed counts *attempts*, `variantIndex` counts *accepted variants*; while nothing
> collides the two numbers agree, and after the first collision they diverge permanently. Emitting
> only the index means a persisted pool cannot rebuild one document — cannot repair a torn file,
> cannot top up without re-rendering everything, cannot prove it is reproducible at all. Since
> reproducibility is what spintax offers over "ask the model again", the batching operation is the
> last place to lose it. The field is present only when a `baseSeed` was given: an unseeded draw
> has no seed, and inventing one would be a lie.

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

### Operation: Lint (#61)

`validate()` judges the **template**. Lint judges the **render** — because a template can be
flawless and still emit broken text: two adjacent slots pick the same word, a noun from one slot
meets a relative pronoun from another and they disagree in gender, an unlucky join leaves a space
before a comma. None of that is visible in the source and none of it survives a human reading of
the source; it appears only in *some* renders. Measured on a real pool: the first lint run over
200 renders came out **2% clean**, and 100% after the slots the lint pointed at were fixed — while
one defect that shipped before the linter existed ("сюжет, в которой") sat in **18% of the pool**
and was caught by a human noticing a screenshot. That last number is the argument: a thousand
articles cannot be proofread, so the failure mode is not "we make mistakes" but "we cannot see
them".

- **Two outputs, `Clean` / `Defective`** — same reasoning as Validate: the corrective loop (drop
  the render, draw another) is one wire. An operational failure under `continueOnFail` rides
  **Defective**, never Clean.
- **Two sources.** `Rendered Text` lints one document from the item (default field `rendered`,
  so it drops straight onto Render / Render Many). `Template Sample` renders `sampleSize`
  documents itself and reports `checked` / `cleanCount` / `cleanRatio` / `issues[]` (tallied,
  worst first) — the authoring-time loop that produced the 2% → 100% numbers. Attempt *i* uses
  the Render Many seed derivation `` `${baseSeed}:${i}` ``, so a report is reproducible.
- **Findings are structured** — `{ code, message, fragment, data }` with codes `repeat.word`,
  `agreement.relative`, `punctuation.{double-space,space-before,duplicated,empty-pair}`. As
  everywhere else in this node, `message` is *not* a contract; branch on `code`/`data`.
- **The repeat window is a tuning knob, and 6 is the measured number.** At 9, 82% of the hits
  were ordinary cohesion — a heading saying "Обучение и стратегии" followed by "ветка стратегий"
  in the body is not a defect. Configurable, conservative by default.
- **Rules are locale-scoped, and a locale we have not studied gets only the neutral rules.** The
  gender/relative-pronoun rule is Russian (a closed pronoun class, high precision); repeats and
  punctuation are language-neutral. Two consequences worth stating: a locale with no stop-word
  table falls back to the length filter alone rather than inheriting another language's function
  words, and `fr` is exempt from *space-before-punctuation* for `; : ! ?`, where that spacing is
  correct typography — complaining about correct text is how a linter gets ignored.
- **Skip what cannot be judged.** Russian gender is guessed from the ending, and a soft sign is
  ambiguous (`путь` masculine, `тень` feminine), so those words are skipped, not guessed. Same
  reasoning retires the reference implementation's `..`-run rule for `...`: an ellipsis is
  something an author means, `..` is debris.
- **Honest boundary, in the docs and the UI:** case agreement *inside* a slot is not
  machine-checkable and stays the author's job (grammar-safe synonymization). Lint removes the
  mechanical half, not the craft.

> **Not ported from the reference implementation:** its noun+participle agreement rule
> ("раздел посвящена") drew its precision from a campaign-specific noun list. A generic version
> would need a lexicon to tell a short-form participle from a feminine noun in `-ена` (`цена`,
> `смена`, `страна`), and guessing there produces exactly the wrong complaints this operation is
> built to avoid. Filed here so it is not silently rediscovered as an omission.

### Operation: Uniqueness (#62)

Render Many answers "are these variants different?" with exact-string dedupe. Necessary, not
sufficient: a pool can contain zero duplicates and still be trivially clusterable, because every
document shares one sentence skeleton. Measured on real pools of the same size — **1 template →
0.962**, 5 templates → 0.103, 6 templates → **0.017**, where the footprint is the share of the
pool's unique 5-word shingles that appear in more than 20% of its documents after normalisation.

- **The one POOL operation.** "Are these actually different?" is not answerable per item, so this
  operation consumes the whole input before the per-item loop and reads its settings from row 0.
  Every incoming item is one document; the same items come back out, each carrying a `uniqueness`
  verdict, routed **`Kept` / `Dropped`**. The drop list is *applied*, not reported as indices —
  handing back `drop: [3, 7]` would push the mechanical half into a Code node. It carries the
  same `continueOnFail` contract as the per-item loop: a failure routes the whole pool to
  `Dropped` with `pairedItem` intact, never aborting a workflow that asked to carry on.
- **`Kept` means publishable, which is per-document AND pool-level.** A document that duplicates
  nothing can still belong to a pool that shares one skeleton, and shipping it is exactly what the
  footprint exists to catch — so when the footprint is exceeded, *nothing* is kept. The routing
  flag is `footprintExceeded`, deliberately **not** `ok`: `ok` is also false when a single
  near-duplicate was dropped, and routing on that would empty the Kept branch every time the
  operation did its ordinary job. `Footprint Limit = 1` makes the pool verdict advisory.
- **Documents are dropped greedily, in input order, against what is still RETAINED** — not
  pairwise. On a chain `A≈B`, `B≈C`, `A≉C`, dropping the later member of every pair discards both
  B and C, though once B is gone C duplicates nothing that remains; and the reported `nearDupOf`
  would point at a document that is no longer in the pool. The greedy pass keeps A and C, and
  every `nearDupOf` names a survivor.
- **A document is a non-empty STRING, and nothing is coerced.** An item with no value there is not
  an empty document, and an object stringified to `"[object Object]"` is not a document at all —
  either would add itself to `poolSize` and shift every other item's footprint cutoff. Both leave on
  `Dropped` with `measured: false`, so the measured pool is exactly the items that carried text.
- **The normalisation is an ordered algorithm, not a description**: exact macro strings out
  (longest first, so a nested macro cannot eat the one enclosing it) → tags with attributes →
  NFC → locale-aware lowercase → punctuation and symbols to **space** → whitespace collapse →
  words → 5-word shingle set. Every skipped choice makes the metric irreproducible: deleting a
  hyphen joins two words, replacing it with a space splits them — different shingles, different
  number. The locale-aware lowercase is the shared funnel `locale` (the Turkish dotless ı).
- **Refuses to report on a tiny pool.** With share 0.2 and three documents, "appears in more than
  0.6 documents" means "appears at all" and the value is 1 by construction, so below
  `minPoolForFootprint` (default 5) the footprint comes back `null` with a `footprintReason`.
  "Not measured" beats an impressive number that means nothing.
- **Near-dup candidates come from an inverted index over shingles**, not an O(n²) scan: at
  J ≥ threshold a shared shingle is guaranteed, so nothing is lost — asserted against a
  brute-force pass in the tests rather than argued. That guarantee holds only for a *positive*
  threshold and *non-empty* documents (two empty sets score 1 while sharing nothing, and at
  threshold 0 every pair qualifies), so both cases fall back to the full scan instead of quietly
  losing pairs the docstring promises are kept.
- **The failure text says what will not work.** The intuitive reaction to "not unique enough" is
  to ask for more variants, and that is precisely the one move that cannot help: the skeleton is
  fixed by the template, so re-rendering dilutes nothing. Only new templates — or denser
  variation — move the number. Related and worth knowing at the same moment: **seeds do not
  guarantee uniqueness** either; 30 independent seeds on a template of ~108 outputs gave 25
  distinct documents, ordinary birthday collisions that users read as a bug.

### Operation: Protect Placeholders (#63)

A rendered template is often not the final consumer of its own text: it goes on to Mailchimp merge
tags, Shopify Liquid, a CRM, GSA Search Engine Ranker. Those systems have their own `%placeholder%`
vocabulary, and the two syntaxes collide — whoever reaches the string first consumes it. Three
failure modes, all measured against `@spintax/core` and pinned by tests that call the real engine:

1. **A variable silently eats the recipient's macro.** Our lookup is case-INsensitive; the
   recipient may treat case as *meaning* (`%random_anchor_text%` as-is, `%Random_Anchor_Text%`
   capitalised, `%RANDOM_ANCHOR_TEXT%` upper). One `#set %Random_Anchor_Text%` hijacks the whole
   family. Names overlap unexpectedly too — `%link%` is a GSA built-in, so a variable named `link`
   breaks both engines at once and produces plausible-looking output.
2. **Brackets are destroyed.** `[…]` is permutation syntax here, so `#file_links[D:\path,1,S]#`
   comes out without them and `[URL='%url%']x[/URL]` renders as `URL='%url%'x/URL`. There is no
   author-level escape.
3. **The cosmetic pass edits macro parameters.** With `postProcess: true`, `D:` becomes `D: ` and
   `,1,S` becomes `,1, S` inside what is supposed to be an opaque token. `neutralize()` shields a
   value against the *parser*, not against the *typographer* — the distinction the conformance
   fixture `neutralize/postprocess-off-roundtrips-byte-exact` already documents.

The operation is the **post-injection** mechanism, generalised away from any one recipient: the
registry of what a given platform's macros *are* stays with the user, what ships here is the
mechanism and the checks. One operation, two modes:

- **Protect (before render)** — replaces each listed placeholder with a marker, longest first so a
  nested placeholder cannot eat the enclosing one, and emits `protectedTemplate` + `placeholderMap`
  onto the item. It also runs the collision check for free, because this is where the template is
  in hand: the names it declares via `#set`/`#def` (read with the engine's own `extract()`, not a
  private regex) **plus the incoming item's scalar field names** — which is exactly what Render
  turns into `%variables%` — are compared case-insensitively against the foreign names.
- **Restore (after render)** — puts the placeholders back and verifies: case-mangled markers,
  orphaned markers, typographer damage inside a restored macro, leftover braces, and stray `%…%`
  that are neither restored nor allow-listed. `Fail on Problems` defaults **on**; refusing loudly
  rather than corrupting quietly is the whole stance. An **empty** placeholder map is refused
  outright, because a custom marker is unrecognisable once its mapping is gone: "nothing to
  restore" and "the map was lost" look identical from the document, and only one of them is safe.

Two implementation points that are contract, not detail:

- **The marker grammar is `^[A-Z0-9_]+$`** because a lowercase marker at a sentence start gets
  capitalised (`spxtoken0` → `Spxtoken0`) and the exact-match restore then misses **silently**,
  shipping raw markers to the platform. A marker that violates the grammar, repeats, or already
  occurs in the template prose is refused before anything is rendered — and that last check is
  **case-insensitive**, because the render is what creates the collision: a marker `I` is absent
  from "i agree" as typed and present in "I agree." after the cosmetic pass, at which point the
  restore would rewrite a word of real copy and report success. (In the node UI the field is called
  *Marker*: n8n's community-node lint reads a parameter named `token` as a credential.)
- **Matching is plain substring, deliberately not `\b`-anchored, and BOTH directions are ONE pass.**
  A placeholder sitting right before a word leaves the marker glued to it (`SPXTOKEN0click`), which
  a boundary-anchored restore skips — and a boundary-sharing check would not see the miss either. A
  *key-at-a-time loop* has the mirror-image hole in both directions: restoring `TAG` before `TAG1`
  eats the prefix of the second and leaves no whole marker behind to flag; protecting `[LONG]`
  before `SPX` writes `SPXTOKEN0` and then rewrites the marker it just inserted. So each direction
  is a single alternation pass ordered longest-first — what it writes, it never reads again. A
  corollary worth stating because it looks like a missing check: there is **no `residual` field**.
  A marker "left behind" is not a state a single pass can produce, and a naive after-the-fact scan
  reports the marker-shaped text *inside a substituted value* as residual, failing a restore that
  was correct. Both divergences from the reference implementation are deliberate.
- **The exact-string lists are one entry PER LINE, not comma-separated** (Shared Strings on
  Uniqueness, Allowed Placeholders on Restore). They carry literal foreign strings, and a real macro
  contains commas — `#file_links[D:\path,1,S]#` comma-split becomes three entries, one of which is
  the string `1`, and the normalisation then strips every standalone `1` from every document.
- **Two things that must not fail open**: a document still carrying auto-assigned markers with no
  map entry is a lost map, not a clean document (reported by the reserved prefix, scanned on the
  ORIGINAL text so a restored value that happens to be marker-shaped is not mistaken for one); and
  the leftover-brace check covers the fullwidth `｛ ｝` the engine emits for markup it could not
  parse, not only the ASCII pair a recipient might re-spin.
- **A marker is checked against the DATA as well as the template.** The rendered document is
  template plus substituted values, so a marker `VIP` is nowhere in `%segment% *|CODE|*` and is in
  the output the moment `segment` is `"VIP"` — the node passes the incoming item's scalar values in
  alongside its field names. And because the map arrives as item JSON, its keys are validated
  against the marker grammar before use: an empty key would contribute an empty regex alternative,
  which matches between every pair of characters and rewrites the whole document.

> **The boundary this mechanism cannot cross: a PARTIALLY lost map with custom markers.** Auto-
> assigned markers are recoverable by their reserved prefix, and a wholly missing map is refused —
> but if a map arrives naming some markers and not others, a custom marker left raw in the text is
> indistinguishable from ordinary uppercase copy, and Restore will report success. Detecting it
> would need a marker manifest travelling beside the map. Until there is a consumer-driven reason
> to add one, the answer is the default: leave the markers auto-assigned, and treat a hand-edited
> map as the unverifiable thing it is.

> Prior art worth reusing on the import side: `spintax-win`'s `SpGsaToSpintax` solves the opposite
> direction with the right contract — it lifts unconvertible constructs into variables the caller
> **must** merge, and refuses what it cannot express. Its v0.4.0 defect is instructive for exactly
> this operation: lifted values were keyed case-**insensitively**, so `#file[A.txt]` and
> `#file[a.txt]` collapsed into one variable and a template pulling from two lists silently pulled
> twice from one.

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
nodes (both re-verified against the live guidelines 2026-08-09); a bundled local library is
**not** a third-party service, and framing it as *the* integration for the Spintax ecosystem
changes positioning, not the technical category. **There is no pre-submission ask channel
anymore** — the original "ask n8n for eligibility feedback first" step died when submission
moved to the Creator Portal (`creators.n8n.io/nodes`), which has no contact for questions. So
the verdict is obtained *by submitting through the portal*; a rejection there is cheap and comes
with a stated reason (the submission text should pre-empt the category question — draft in
`temp/marketing/verification-eligibility.md`). If refused, distribution is npm + the self-hosted
instances *whose admin policy permits unverified community packages* (not "every instance"), and
discovery shifts to the gallery templates, the article and the forum post (§6) rather than the
Cloud node picker. Cloud verification is upside, not the load-bearing floor.

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
3. **Run the exact-version scan, then submit for n8n Cloud verification via the Creator Portal**
   (`creators.n8n.io/nodes`) — there is no pre-submission ask channel (§4 risk R1); the portal
   verdict *is* the eligibility answer. Re-read the live guidelines at submission time.
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

### 6.1 Where it actually stands — 2026-08-16, and how to resume

The plan above is the intent; this is the state, written to survive a lost session. Anything not
listed here is unchanged from the plan.

**Published.** `n8n-nodes-spintax@0.2.6` on npm (provenance via OIDC; the release workflow's own
`scan` job reports "passed all security checks", so no separate scanner dispatch is needed since
0.1.4). 0.2.0 closed #60–#63; 0.2.1 added Lint's **Ignored Strings**, which a live run turned up —
see below. The node is at eight operations; `docs` and the site say so.

**0.2.2–0.2.6 are engine catch-up plus one node-side fix.** 0.2.3 corrected Validate, which read
the raw `locale` parameter while Render resolved it through the node's helper — one item, two
answers, and a workflow branching on the Validate outputs can route differently after it. The rest
carry `@spintax/core` 0.5.0 → 0.5.3: plural forms counted after expansion (#66), a conditional in a
plural's count slot no longer deleting the block, and two expansion bombs where a 62-character
template ended the Node process. A Render node fed author-supplied templates took the workflow
down with it, so treat 0.2.6 as the floor.

**Gallery — 18308 resubmitted 2026-08-20, 17930 blocked behind it.**

- **17930** (cold-email bridge) — bounced 2026-08-14 as "too basic". The record was measured stuck
  at the time (`PUT https://api.n8n.io/api/workflows/17930` answered **400** on *Upload new
  version*, and *Delete* failed too), and that is no longer the state: the Creator hub now lists it
  **Pending** with an **Implement changes** action. It is a live record to fix, not a dead slot.
- **18308** (product-copy pool), submitted 2026-08-16 — was also Pending / Implement changes; the
  reviewer's mail names one thing: sticky notes. The rebuilt JSON went up 2026-08-20 and it is
  **Under review** again.
- **17930 could not follow it the same day.** The portal enforces *one template under review at a
  time*: with 18308 in, Submit greys out and the tooltip reads "You've reached the maximum number of
  templates under review. Wait for a review to complete before resubmitting." Its rebuilt JSON is
  ready in the repo and goes up the moment 18308 clears. Note this is a different rule from the one
  measured on 2026-08-16 — a *new* submission (POST) went through while 17930 sat pending, because
  pending-with-changes does not count as under review.

**The resubmission flow, since the old route is gone.** `creators.n8n.io/workflows/<id>/edit` now
redirects to the dashboard; the way in is the **Implement changes** badge on the card itself, which
opens a modal with a JSON dropzone, a "Copy your last submitted JSON" link and **Submit for human
review**. There is no description form on this path — title and the structured description survive
from the original submission, so a resubmission is JSON-only. Two traps worth avoiding: the top-right
"Share new template" button opens a *new* submission dialog that looks almost identical, and closing
the modal with a file staged raises a Discard prompt (discarding loses only the staged file).

**The sticky-note rules, taken from n8n's own generator rather than inferred.** The reviewer's mail
points at their template **13868** ("Auto-generate sticky notes and rename nodes"). Its description
links a Notion page that is JS-rendered and unreadable to a fetcher, but the workflow itself is
readable — `https://api.n8n.io/api/templates/workflows/13868` — and it *is* the specification,
because it is the thing that produces conforming templates:

- **At least `ceil(nodeCount / 3)` groups**, each a spatially tight cluster, titled in sentence case
  in 3–6 words (`AI Groups Logically`). Three tall column stickies over sixteen nodes is the shape
  that gets bounced; six small ones is the shape that passes.
- **Geometry is arithmetic, not taste** (`Compute Bounding Boxes`): pad a cluster's bounding box by
  48 either side and 64 below, reserve a computed text height above it (minimum 80), snap everything
  to a 16px grid, floor at 240×180. Group stickies are `color: 7`; the overview carries no colour key.
- **The overview sticky is 480 wide, placed at `minX − 480 − 80`**, height clamped to **420–900** —
  and their own height estimator is the check: content over 900px is silently clipped in the canvas,
  so the copy is written to fit the box rather than the box stretched to the copy.
- **Its shape is fixed**: `## <workflow name>`, `### How it works` as a **numbered list of 2–6
  items**, `### Setup steps` as `- [ ]` checkboxes, optional `### Customization`. Our earlier
  recorded rule said `### Setup` and free prose — that came from reading finished templates, and
  this supersedes it.

All three templates in `templates/` were rebuilt to this on 2026-08-20 by a faithful port of those
two Code nodes, with two assertions their pipeline does not need because it resolves collisions
iteratively and we do not: **no two stickies overlap**, and the group count clears the ceiling. The
port also flagged the real trap — a single-node group is floored at 240 wide, which is wider than
the node's own padded box, so it reaches further right than the cluster does and can collide with
the next group. In the funnel that forced Validate and Repair into one group.

**How the portal actually behaves** (measured, because the documented rules are not the whole
story):

- Submitting is a POST and it **worked while 17930 was still pending**, despite the Creator hub's
  "one template at a time" rule. With two pending, the *Share new template* button then greys out —
  the limit is enforced on the button, after the fact.
- The flow is now: upload JSON → **instant AI review** → a `/workflows/<id>/edit` "Finalize your
  submission" page. The description there is a **structured form** (Quick overview 10–50 words,
  How it works 50+, Setup 50+, then optional Requirements / Customization / Additional info lists) —
  the free-form Markdown description is gone, so a prepared Markdown blob no longer pastes in as
  one piece. The workflow image goes in Additional info.
- The whole AI verdict — `suggestedTitle`, `suggestedDescription`, `suggestedJson`, scores — is
  readable from `window.__NUXT__.data['workflow-edit-<id>'].workflow.aiFeedback` (a JSON string).
  Faster and more complete than reading the DOM.
- **We declined the AI's suggested JSON, deliberately.** It leaves the graph and every operation
  setting untouched and renames all sixteen nodes (updating the expression references correctly),
  but: it calls the model node "OpenAI GPT-4 Model" while the node runs `gpt-4o-mini`; its own
  Setup text still references *our* node name ("Your brief and product"), so adopting the JSON
  would break the description it wrote; and our layout is verified on a live canvas while its is
  not. Sticky-note overlap is what got the first template bounced, so that last point decides it.

**Template rules that were paid for and now hold.** A template using a community node must carry a
**workflow image at the top of the description** — the gallery preview does not render for one, so
without it a reviewer never sees the canvas (the likeliest reason 17930 read as "too basic" — that
submission has no image at all, so its canvas has never been seen). The image lives in this repo at
`templates/product-copy-pool.png` and is referenced by its raw GitHub URL, which means replacing the
file in `main` updates the live listing without re-editing the submission. 17930 needs one shot for
itself; the pool's needs re-shooting, because the canvas changed under it. The sticky rules are above, from their generator; the word budgets we had measured still hold
inside it (overview 100–300 words, each group sticky under 50). And n8n renders a lone newline
inside a sticky paragraph as a line break, so each paragraph is emitted on one physical line by the
generator.

**Live verification (2026-08-15/16).** n8n 2.34.6 installed under `temp/n8n-local` (removed
afterwards), the published node installed into `~/.n8n/nodes`, the workflow imported with
`n8n import:workflow` (a UI-saved workflow is lost on restart) and executed headless with
`n8n execute --id …`; when a server is already up, the CLI needs
`N8N_RUNNERS_BROKER_PORT=5681` or it dies on the busy broker port. The final run: valid on the
first attempt → 12 variants → 11 clean, 1 genuine defect ("place" twice, one word apart) → 11 kept,
footprint 0.347. Two measurements from those runs shaped the template and the node:

- a pool from ONE template about one product scores a footprint near **0.49**, so a 0.15 gate
  condemns it wholesale — the demo therefore ships `Footprint Limit = 1` (report, not gate) and the
  sticky says so;
- the same twelve documents score **0.209** with the product name, brand and feature phrase inside
  the measurement and **0.107** with them excluded — which is why Lint gained Ignored Strings and
  why both checks are fed the configured values from the one Set node.

**Site.** spintax.net carries the 0.2.0 facts and is deployed (`8030ed2`): `/spintax-for-n8n/` in
EN/RU/ZH gained the Lint / Uniqueness / Protect sections and `attemptSeed`, and `llms.ts` plus the
engines SKILL say eight operations. Two follow-ups are deliberately open there and tracked in that
repo's `docs/TODO.md`: the third template is not linked yet (the two that are carry a "verified
against a live n8n" claim), and the template links still point at raw GitHub until gallery URLs
exist.

**Next, in order.** 18308 verdict → on publish, submit `ai-authoring-funnel` → a third template
(three approved = verified creator: batches of four, a badge, paid templates) → forum Show & Tell,
which needs live gallery pages → node verification. The verification form is only an npm URL plus
two checkboxes (no notes field, so a prepared cover letter has nowhere to go); `npx @n8n/node-cli
lint` passes on the package (a control mutation makes it fail, so the check is real). Two risks
there stay human-judged: the "exactly one third-party service" rule against a node that integrates
none, and "n8n isn't accepting Logic or Flow control nodes at the moment" against our three
two-output routing operations.

## 7. Build plan

- **N0 — skeleton + Render + Validate; pre-publication gates only.** Package scaffolding per §4,
  the two mechanical operations, `eslint-plugin-n8n-nodes-base` green in CI, `npm pack` +
  manifest inspection + clean-install CJS smoke test, vitest coverage for context mapping /
  per-tier neutralize / clean-model-output / two-output validate. The scanner does **not** run
  here — it needs a published release (§4).
- **N1 — Build Authoring Prompt + Build Repair Prompt + Render Many.** The funnel is complete;
  README + icon land *before* the publish; `0.1.0` released, then the exact-version scan
  (§6 steps 1–3).
- **N2 — templates + submission.** Gallery templates, verification submission via the Creator
  Portal (no pre-ask exists — R1), forum post; hub obvyazka unblocks on its own gate.

## 8. Adjacent surfaces (same argument, not yet filed)

- **VS Code extension** — syntax highlighting + inline `validate()`. The 0.1.3 diagnostic positions
  were built for this.
- **Google Sheets / Apps Script add-on** — marketers live in spreadsheets.

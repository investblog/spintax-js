# Workflow templates

Importable n8n workflows for `n8n-nodes-spintax`, verified end-to-end against a live n8n
instance before shipping. Import via **⋯ → Import from URL…** using the raw GitHub URL of a
JSON file here, or download and use **Import from File…**.

The texts below double as the n8n workflow-gallery listing copy (submission is manual, via a
creator account).

Each file has a canvas image beside it (`*.png`), shot from a live n8n after the last change.
A gallery listing for a community node gets no rendered preview, so that image is the only way a
reviewer sees the canvas — it belongs at the top of the description.

Sticky notes in all three files are generated to n8n's own rules — the ones their template 13868
implements, not the ones we inferred from finished templates. See `docs/spec-n8n-node.md` §6.1 for
the constants; the short version is at least `ceil(nodes / 3)` tight groups, an overview sticky 480
wide whose content must fit 900px, and `### How it works` as a numbered list with `### Setup steps`
as checkboxes.

## cold-email-bridge.json

**Title:** Generate unique cold-email copy per lead with Spintax (works for product catalogs too)

**Description:** Sending platforms parse flat `{a|b|c}` at best. This workflow renders
full-syntax spintax *before* sending: every row's fields become `%variables%` automatically, a
per-lead seed keeps output stable across re-runs, conditionals switch copy on data fields
(`{?has_discount?…|…}`), and `{plural %in_stock%: unit|units}` keeps counts grammatical.
Replace the sample Code node with Google Sheets or your CRM, and the last node with your
ESP/Gmail/SMTP node. Feed it a product list instead of leads and the same pattern writes a
unique product description per product per storefront — no duplicate content across sites.
No credentials required by the Spintax node; everything runs locally in your n8n.

**Gallery:** workflow 17930 — **Pending, awaiting changes from us.**

## product-copy-pool.json

**Title:** Generate a pool of unique product descriptions from one AI-written spintax template

**Description:** The full pipeline, including the half that usually gets skipped: an LLM writes
ONE spintax template from your brief (validated, with a single capped repair round), Render Many
turns it into 12 documents, and then two checks say whether they are any good. **Lint** reads
each rendered document for the defects that live in the *combination of choices* and never in the
template — two adjacent slots picking the same word, a noun and a pronoun disagreeing, punctuation
debris from an unlucky join — and routes defective drafts away. **Uniqueness** reads the surviving
pool as a whole: it drops near-duplicates and reports the shared-shingle footprint, the number
that distinguishes "twelve different documents" from "one skeleton wearing twelve hats" (measured
on real pools: one template 0.962, six templates 0.017). The LLM runs once; every future run of
the pool costs nothing. No credentials on the Spintax side.

**Requires:** `n8n-nodes-spintax` ≥ 0.2.1 (Lint, Uniqueness, and Lint's Ignored Strings). Submitted to the gallery 2026-08-16 as workflow 18308 — **Pending, awaiting changes from us**; the canvas image the gallery description needs is `product-copy-pool.png` beside this file.

## ai-authoring-funnel.json

**Title:** AI writes the spintax template once — validate, repair, render N variants

**Description:** The full authoring loop with no credentials on our side: Build Authoring
Prompt emits a `systemPrompt`/`userPrompt` pair for *your* LLM node (OpenAI included, any model
works); Validate routes the draft to Valid/Invalid with structured diagnostics
(line/column/code); on Invalid, Build Repair Prompt turns those diagnostics into a fix-it
prompt pointing at the exact offending token — the loop is capped at one repair round by
wiring; on Valid, Render Many produces 5 distinct variants and reports honestly
(`produced` vs `requested`). `Clean Model Output` strips the code fences models add no matter
what the prompt says, and `spintaxMeta` carries one locale + one allowed-variable list through
the whole funnel.

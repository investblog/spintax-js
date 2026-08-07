# Workflow templates

Importable n8n workflows for `n8n-nodes-spintax`, verified end-to-end against a live n8n
instance before shipping. Import via **⋯ → Import from URL…** using the raw GitHub URL of a
JSON file here, or download and use **Import from File…**.

The texts below double as the n8n workflow-gallery listing copy (submission is manual, via a
creator account).

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

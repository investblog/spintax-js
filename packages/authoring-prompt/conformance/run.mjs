#!/usr/bin/env node
// Prompt-conformance runner (#47): measures what a REAL model produces from the
// canonical authoring prompt. Opt-in, needs an Anthropic credential — never part
// of unit CI (LLM output is nondeterministic; this gate is statistical, not exact).
//
//   node conformance/run.mjs [--model claude-opus-5] [--samples 3]
//                            [--briefs id1,id2] [--threshold 0.95]
//
// Per brief × sample: buildAuthoringPrompt() → model → cleanModelTemplate() →
// validate() under the brief's OWN locale (zero error-severity diagnostics) →
// render() seeded samples with the brief's context (no fullwidth ｛ fallback).
// Secondary metrics check whether the prompt taught the hard parts: {plural …}
// when a count is present, lastsep on prose lists, {?…} for optional variables,
// and Russian case discipline (declared case beats what the name suggests).
// The report lands in conformance/reports/ keyed by PROMPT_VERSION + model.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Anthropic from '@anthropic-ai/sdk';
import { buildAuthoringPrompt, cleanModelTemplate, PROMPT_VERSION } from '@spintax/authoring-prompt';
import { validate, render } from '@spintax/core';

const here = dirname(fileURLToPath(import.meta.url));

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const MODEL = flag('model', 'claude-opus-5');
const SAMPLES = Number(flag('samples', '3'));
// On Claude Opus 5 thinking is on by default and max_tokens caps thinking +
// response TOGETHER — 2048 truncated the richer Russian drafts mid-{plural}.
const MAX_TOKENS = Number(flag('max-tokens', '8192'));
const THRESHOLD = flag('threshold', null);
const ONLY = flag('briefs', null)?.split(',');
const CONCURRENCY = 4;
const RENDER_SEEDS = [1, 2, 3];

const { briefs } = JSON.parse(readFileSync(join(here, 'briefs.json'), 'utf8'));
const selected = ONLY ? briefs.filter((b) => ONLY.includes(b.id)) : briefs;
if (selected.length === 0) {
  console.error('no briefs matched --briefs filter');
  process.exit(2);
}

const client = new Anthropic(); // credentials from env / `ant auth login` profile

// ── one sample ───────────────────────────────────────────────────────────────
async function runSample(brief, sampleIndex) {
  const built = buildAuthoringPrompt({
    brief: brief.brief,
    locale: brief.locale,
    allowedVariables: brief.allowedVariables,
    channel: brief.channel,
    variationLevel: brief.variationLevel,
  });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: built.systemPrompt,
    messages: [{ role: 'user', content: built.userPrompt }],
  });

  const result = {
    brief: brief.id,
    sample: sampleIndex,
    valid: false,
    reasons: [],
    metrics: {},
  };

  // Claude Opus 5 / Fable 5 classifiers can decline with HTTP 200 — check
  // stop_reason before touching content (an unconditional content[0] breaks).
  if (response.stop_reason === 'refusal') {
    result.reasons.push('model refusal (classifier) — harness-level, not a prompt verdict');
    return result;
  }
  if (response.stop_reason === 'max_tokens') {
    result.reasons.push('output truncated at max_tokens');
  }

  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const template = cleanModelTemplate(text);
  result.template = template;

  // An empty draft validates trivially (zero diagnostics) — that is a failure,
  // not a pass; the first run let one through exactly this way.
  if (template.trim() === '') {
    result.reasons.push('empty template after cleaning');
    return result;
  }

  // Primary gate 1: zero error-severity diagnostics under the brief's locale.
  const knownVariables = brief.allowedVariables.map((v) => v.name);
  const diagnostics = validate(template, {
    locale: brief.locale,
    ...(knownVariables.length > 0 ? { knownVariables } : {}),
  });
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    result.reasons.push(
      ...errors.map((e) => `validate: [${e.code}] line ${e.line}:${e.column}`),
    );
  }

  // Primary gate 2: seeded renders produce no fullwidth-brace fallback.
  for (const seed of RENDER_SEEDS) {
    const rendered = render(template, { seed, locale: brief.locale, context: brief.sampleContext });
    if (rendered.includes('｛')) {
      result.reasons.push(`render(seed ${seed}): fullwidth fallback in output`);
      break;
    }
  }

  result.valid = result.reasons.length === 0 ||
    (result.reasons.length === 1 && result.reasons[0].startsWith('output truncated') && errors.length === 0);
  if (!result.valid && result.reasons.length === 0) result.reasons.push('unknown');

  // Secondary metrics — only where the brief expects the construct.
  const ex = brief.expects ?? {};
  if (ex.plural) result.metrics.plural = /\{plural\s/.test(template);
  if (ex.lastsep) result.metrics.lastsep = /lastsep=/.test(template);
  if (ex.conditional) result.metrics.conditional = /\{\?/.test(template);
  if (ex.caseRules) {
    result.metrics.caseDiscipline = ex.caseRules.every((rule) => {
      // Violation: the bare (nominative) variable right after a case-governing
      // preposition — the declared-case sibling should have been used.
      const violation = new RegExp(
        `(^|[^%\\p{L}])${rule.trigger}\\s+%${rule.bare}%`,
        'iu',
      );
      return !violation.test(template);
    });
  }

  return result;
}

// ── pool ─────────────────────────────────────────────────────────────────────
const jobs = selected.flatMap((brief) =>
  Array.from({ length: SAMPLES }, (_, i) => ({ brief, i })),
);
const results = [];
let cursor = 0;
async function worker() {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    try {
      const r = await runSample(job.brief, job.i);
      results.push(r);
      console.log(
        `${r.valid ? 'ok  ' : 'FAIL'} ${job.brief.id} #${job.i}` +
          (r.valid ? '' : `  — ${r.reasons[0]}`),
      );
    } catch (error) {
      results.push({
        brief: job.brief.id,
        sample: job.i,
        valid: false,
        reasons: [`harness: ${error?.message ?? error}`],
        metrics: {},
      });
      console.log(`ERR  ${job.brief.id} #${job.i} — ${error?.message ?? error}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// ── aggregate ────────────────────────────────────────────────────────────────
const validCount = results.filter((r) => r.valid).length;
const validRate = validCount / results.length;
const perBrief = {};
for (const brief of selected) {
  const rs = results.filter((r) => r.brief === brief.id);
  perBrief[brief.id] = {
    valid: rs.filter((r) => r.valid).length,
    total: rs.length,
  };
}
const metricRate = (key) => {
  const rs = results.filter((r) => key in r.metrics);
  return rs.length === 0 ? null : rs.filter((r) => r.metrics[key]).length / rs.length;
};

const report = {
  promptVersion: PROMPT_VERSION,
  model: MODEL,
  samplesPerBrief: SAMPLES,
  ranAt: new Date().toISOString(),
  validRate,
  valid: validCount,
  total: results.length,
  metrics: {
    plural: metricRate('plural'),
    lastsep: metricRate('lastsep'),
    conditional: metricRate('conditional'),
    caseDiscipline: metricRate('caseDiscipline'),
  },
  perBrief,
  samples: results,
};

mkdirSync(join(here, 'reports'), { recursive: true });
const stamp = report.ranAt.slice(0, 10);
const file = join(here, 'reports', `v${PROMPT_VERSION}-${MODEL}-${stamp}.json`);
writeFileSync(file, JSON.stringify(report, null, 2) + '\n');

console.log('\n── prompt conformance ──────────────────────────');
console.log(`prompt v${PROMPT_VERSION} × ${MODEL} × ${SAMPLES} samples/brief`);
console.log(`valid-rate: ${(validRate * 100).toFixed(1)}%  (${validCount}/${results.length})`);
for (const [id, s] of Object.entries(perBrief)) {
  console.log(`  ${s.valid === s.total ? ' ' : '!'} ${id}: ${s.valid}/${s.total}`);
}
console.log('metrics (share of applicable samples):');
for (const [k, v] of Object.entries(report.metrics)) {
  if (v !== null) console.log(`  ${k}: ${(v * 100).toFixed(0)}%`);
}
console.log(`report: ${file}`);

if (THRESHOLD !== null && validRate < Number(THRESHOLD)) {
  console.error(`\nvalid-rate ${(validRate * 100).toFixed(1)}% below threshold ${Number(THRESHOLD) * 100}%`);
  process.exit(1);
}

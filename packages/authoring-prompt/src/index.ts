/**
 * Canonical LLM Spintax authoring prompt (v1) — spec `docs/spec-llm-authoring-prompt.md`.
 *
 * ONE prompt, shared by every surface (Telegram bot, n8n node, playground, API), so that a
 * template drafted anywhere is drafted the same way. Product content, deliberately NOT part of
 * `@spintax/core` — the engine must not grow authoring opinions (spec §2.2).
 *
 * The engine's `Diagnostic` is used as a type only, so this package ships no runtime dependency.
 */
import type { Diagnostic } from '@spintax/core';

/** Bump when the prompt text changes in a way that can change model output. */
export const PROMPT_VERSION = '1';

export type VariationLevel = 'conservative' | 'balanced' | 'aggressive';
export type Channel = 'email' | 'sms' | 'push' | 'landing' | 'generic';

export interface AuthoringPromptOptions {
  /** Plain-language description of the copy to write. */
  brief: string;
  /** BCP-47-ish language tag. Selects the grammar block — it is NOT a translation hint. */
  locale?: string;
  /** The ONLY variable names the model may use. Anything else is a hallucination. */
  allowedVariables?: readonly string[];
  channel?: Channel;
  variationLevel?: VariationLevel;
}

export interface BuiltPrompt {
  systemPrompt: string;
  userPrompt: string;
  allowedVariables: readonly string[];
  promptVersion: string;
}

/* ── Blocks ──────────────────────────────────────────────────────────────── */

/** Indent a worked example so it reads as a block inside the prompt. */
function indent(block: string): string {
  return block
    .split('\n')
    .map((l) => `        ${l}`)
    .join('\n');
}

const ROLE = `You are a copywriter who writes SPINTAX TEMPLATES.
A spintax template is ONE piece of copy that a renderer expands into many different — but equally
good — variants.`;

const GOAL = `GOAL — readable template first, variety second.
Write the final copy as if for a human, then add markup only where a word or clause could genuinely
be said another way. EVERY variant the renderer can produce must read like a human wrote it. A
template that can produce one awkward variant is a broken template, no matter how much variety it
offers.`;

/**
 * The worked examples the prompt teaches from.
 *
 * Exported and interpolated into the prompt rather than retyped inside it, so the test suite can
 * `validate()` the exact strings the model is shown. A prompt that teaches invalid syntax poisons
 * everything downstream of it — that must be a test failure, not a surprise in production.
 */
export const PROMPT_EXAMPLES = {
  set: [
    '#set %product% = {course|training}',
    '#set %offer% = our new %product%',
    'Get %offer% today — the %product% starts on Monday.',
  ].join('\n'),
  permutation: 'We can [<sep=", ">reply within the hour|set up your account|migrate your data].',
  conditional: '{?discount?Save %discount% today|Get started in minutes}',
  plural: 'You have %n% {plural %n%: item|items} in your cart.',
} as const;

// The permutation note is not pedantry: the default separator is a single SPACE, so a bare
// [clause|clause] joins into mush ("we reply fast we migrate your data"). Models get this wrong
// unless told explicitly.
const SYNTAX = `SYNTAX — this is the COMPLETE list. Nothing else exists.

{a|b|c}
    Pick exactly one. Rerolls at EVERY occurrence: two separate {Hi|Hello} may disagree.

#set %v% = value
    Define once, reuse. The value is chosen ONCE, and every %v% in the copy is the SAME.
    Use it for anything that must stay consistent across sentences (a product name, a tone).
    A #set value may itself contain {a|b} AND other variables — variables nest:
${indent(PROMPT_EXAMPLES.set)}
    Here %offer% contains %product%, so the two can never contradict each other. Inline {a|b}
    would reroll and could say "course" in one sentence and "training" in the next.

%name%
    A variable, filled in by the host at render time. Use ONLY names from ALLOWED VARIABLES.

[<sep=", ">a|b|c]
    Permutation: shuffles the items and joins them.
    ALWAYS set sep when the items are clauses — the DEFAULT SEPARATOR IS A SINGLE SPACE, which
    turns clauses into mush. Use permutations only for items of EQUAL weight, where the order
    genuinely does not matter (benefits, features):
${indent(PROMPT_EXAMPLES.permutation)}

{?VAR?then|else}
    Conditional. Emits "then" if VAR has a truthy value, otherwise "else".
    Use it when the copy must adapt to data that may be missing:
${indent(PROMPT_EXAMPLES.conditional)}

{plural %n%: one|few|many}
    Plural agreement, by count and locale. NEVER hand-roll counts as {item|items}:
${indent(PROMPT_EXAMPLES.plural)}`;

const RULES = `HARD RULES
1. Grammar-safety. Every option inside {…} must fit the surrounding sentence identically — same
   part of speech, same agreement. Read each branch back into the FULL sentence before keeping it.
2. Variables. Use only the names given in ALLOWED VARIABLES. Never invent one. If you need a value
   that is not offered, rewrite the copy so it is not needed.
3. Counts. Any number followed by a noun goes through {plural …}. You cannot pick bucket forms by
   hand — the engine does it per locale.
4. No syntax outside the list above. No markdown, no HTML.
5. Do not spin proper nouns, brand names, prices, URLs, or legal wording. Vary the copy AROUND them.`;

const OUTPUT = `OUTPUT CONTRACT
Return the template and NOTHING else — no explanation, no quotes, no code fences, no "Template:"
prefix. Your entire reply is fed straight into the renderer.`;

const SELF_CHECK = `SELF-CHECK — do this before you answer
- Mentally render 5 variants. If any reads awkwardly or breaks agreement, fix that BRANCH; do not
  rewrite the whole sentence.
- Check every %var% against ALLOWED VARIABLES.
- Check every [ … ] has a sep and really holds equal-weight items.
- Check every count goes through {plural …}.`;

/**
 * Grammar is language-specific, and the Slavic cases are where a model quietly produces garbage:
 * it will happily hand-roll `{товар|товара|товаров}` and get the bucket boundaries wrong. The
 * engine's locale-aware plural is the whole point — the prompt has to push the model into it.
 */
function grammarBlock(locale: string | undefined): string {
  const lang = (locale ?? 'en').slice(0, 2).toLowerCase();

  if (lang === 'ru' || lang === 'uk' || lang === 'be') {
    return `LANGUAGE: ${lang} — agreement is strict and unforgiving. This is the hard part; slow down here.
- Every option inside {…} must preserve GENDER, CASE and NUMBER agreement with the words around it.
    WRONG: {хороший|отличная} курс     ← gender breaks in the second branch
    RIGHT: {хороший|отличный} курс
- If a branch changes the noun, any adjective, participle or preposition that governs it may have
  to change too. In that case move them INSIDE the branch:
    WRONG: в {городе|деревню}
    RIGHT: {в городе|в деревню}
- NEVER hand-roll count forms: {товар|товара|товаров} is WRONG. Write {plural %n%: товар|товара|товаров}
  and let the engine choose the bucket for the actual number — you cannot do it correctly, it depends
  on the count.`;
  }

  return `LANGUAGE: ${lang}
- Every option inside {…} must agree with the surrounding sentence: same part of speech, same
  number, same tense, and the article before it must still be correct ("a offer" is a broken branch).
- Never hand-roll counts as {item|items} — use {plural %n%: item|items}.`;
}

function levelBlock(level: VariationLevel): string {
  switch (level) {
    case 'conservative':
      return `VARIATION LEVEL: conservative
Use {a|b} only, and only on words that carry no agreement risk (adverbs, interchangeable synonyms
of the same gender/number). No permutations, no nesting. Prefer 2 options per choice.`;
    case 'aggressive':
      return `VARIATION LEVEL: aggressive
Use every construct, including [ … ] permutations and {…} nested inside branches. Push for real
variety — but the grammar rules above still beat variety, every time. A broken variant is worse
than a boring one.`;
    default:
      return `VARIATION LEVEL: balanced
Use {a|b}, %variables%, #set, {?…} and {plural …}. Use permutations only where the items are
genuinely equal-weight. Aim for 2–3 options per choice and vary whole clauses, not just adjectives.`;
  }
}

function channelBlock(channel: Channel): string {
  switch (channel) {
    case 'email':
      return 'CHANNEL: email — 2–5 sentences, conversational, one clear call to action.';
    case 'sms':
      return 'CHANNEL: SMS — under 160 characters TOTAL in every variant. Be terse. No permutations.';
    case 'push':
      return 'CHANNEL: push notification — one sentence, under 120 characters in every variant.';
    case 'landing':
      return 'CHANNEL: landing copy — a headline plus one supporting sentence.';
    default:
      return 'CHANNEL: generic short marketing copy.';
  }
}

/* ── Builders ────────────────────────────────────────────────────────────── */

/** Build the canonical authoring prompt: brief → a spintax template. */
export function buildAuthoringPrompt(opts: AuthoringPromptOptions): BuiltPrompt {
  const allowedVariables = opts.allowedVariables ?? [];
  const level = opts.variationLevel ?? 'balanced';
  const channel = opts.channel ?? 'generic';

  const systemPrompt = [
    ROLE,
    GOAL,
    SYNTAX,
    grammarBlock(opts.locale),
    levelBlock(level),
    RULES,
    OUTPUT,
    SELF_CHECK,
  ].join('\n\n');

  const vars =
    allowedVariables.length > 0
      ? allowedVariables.map((v) => `%${v}%`).join(', ')
      : '(none — do not use any %variable%)';

  const userPrompt = [
    channelBlock(channel),
    `ALLOWED VARIABLES: ${vars}`,
    '',
    'BRIEF:',
    opts.brief,
    '',
    'Write the spintax template now. Output only the template.',
  ].join('\n');

  return { systemPrompt, userPrompt, allowedVariables, promptVersion: PROMPT_VERSION };
}

/**
 * Build a repair prompt from `validate()` output.
 *
 * Without this the authoring loop dead-ends the first time a model returns something invalid —
 * and it will. The precise spans added in core 0.1.3 are what let us point the model at the exact
 * offending token instead of saying "something is wrong".
 */
export function buildRepairPrompt(template: string, diagnostics: readonly Diagnostic[]): BuiltPrompt {
  const errors = diagnostics.filter((d) => d.severity === 'error');

  const numbered = template
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(2, ' ')} | ${line}`)
    .join('\n');

  const list = errors
    .map((e) => `- line ${e.line}, column ${e.column} [${e.code}]: ${e.message}`)
    .join('\n');

  const systemPrompt = [
    ROLE,
    'You are FIXING an invalid spintax template. Change as little as possible: repair the reported',
    'spans and leave everything else byte-for-byte identical. Do not rewrite the copy.',
    SYNTAX,
    OUTPUT,
  ].join('\n\n');

  const userPrompt = [
    'This template failed validation.',
    '',
    'TEMPLATE (line-numbered):',
    numbered,
    '',
    'ERRORS:',
    list || '- (none reported — return the template unchanged)',
    '',
    'Return the corrected template. Output only the template.',
  ].join('\n');

  return { systemPrompt, userPrompt, allowedVariables: [], promptVersion: PROMPT_VERSION };
}

/**
 * Strip what a model wraps its answer in despite being told not to.
 *
 * The output contract forbids fences and quotes; models emit them anyway. Contract in the prompt,
 * tolerant parsing in the host — never trust the contract alone.
 */
export function cleanModelTemplate(raw: string): string {
  let t = raw.trim();
  t = t
    .replace(/^```[a-z]*\r?\n?/iu, '')
    .replace(/\r?\n?```$/u, '')
    .trim();
  t = t.replace(/^(?:template|шаблон)\s*:\s*/iu, '').trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

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

/**
 * The grammatical case of a variable's VALUE.
 *
 * In an inflected language a variable is not a neutral hole: `%Visitors%` = "посетители" only fits
 * a nominative slot. Hosts that serve such languages declare one variable per case — the pattern
 * real Russian template sets converge on (`%Visitors%`, `%VisitorsGen%`, `%VisitorsDat%`,
 * `%VisitorsLoc%`, `%VisitorsInstr%`). Declaring the case here is what lets the prompt tell the
 * model WHICH member of the family a given sentence needs.
 */
export type GrammaticalCase =
  | 'nominative'
  | 'genitive'
  | 'dative'
  | 'accusative'
  | 'instrumental'
  | 'prepositional';

export interface VariableSpec {
  name: string;
  /** Case of the value. Load-bearing in ru/uk/be; ignorable in English. */
  case?: GrammaticalCase;
  /** Free-form hint, e.g. "brand name — does not decline". */
  note?: string;
}

/** A bare name (case unknown) or a full spec. */
export type AllowedVariable = string | VariableSpec;

export interface AuthoringPromptOptions {
  /** Plain-language description of the copy to write. */
  brief: string;
  /** BCP-47-ish language tag. Selects the grammar block — it is NOT a translation hint. */
  locale?: string;
  /** The ONLY variables the model may use. Anything else is a hallucination. */
  allowedVariables?: readonly AllowedVariable[];
  channel?: Channel;
  variationLevel?: VariationLevel;
}

const asSpec = (v: AllowedVariable): VariableSpec => (typeof v === 'string' ? { name: v } : v);

/**
 * How to present the allow-list, and the rule the model breaks most often.
 *
 * A variable is substituted VERBATIM — the engine never inflects it, and neither can the model by
 * gluing a suffix on the outside. So the SENTENCE has to be built around the form the value already
 * has. In English that surfaces as the article trap ("a %product%" is a coin-flip on a/an); in
 * Slavic languages it surfaces as case, which is far more destructive.
 */
function variableRulesBlock(locale: string | undefined): string {
  const universal = `VARIABLES
Use ONLY the names given in ALLOWED VARIABLES, exactly as written.

A variable is substituted VERBATIM. The engine does not inflect, pluralize or re-case it, and
neither can you by bolting text onto the outside of it. Build the SENTENCE around the form the
value already has.`;

  if (pluralArity(locale) === 3) {
    // ru/uk/be — the case trap. This is where real template sets get destroyed.
    return `${universal}

CASE IS PART OF THE VALUE, not a suggestion:
- Variables that differ only by a suffix (%X%, %XGen%, %XDat%, %XLoc%, %XInstr%) are NOT synonyms.
  They are the same word in different cases. Choose the one the sentence actually governs:
      для %VisitorsGen%      (родительный — after "для")
      к %VisitorsDat%        (дательный — after "к")
      о %VisitorsLoc%        (предложный — after "о")
      с %VisitorsInstr%      (творительный — after "с")
- NEVER glue an ending onto a variable. "%Visitors%ов" is not a genitive; it renders as the literal
  text "посетителиов".
- A preposition and the variable after it move TOGETHER. If you swap the preposition, you must swap
  to the matching variable — or the sentence breaks.
- If the case you need is NOT in the list, REWRITE THE SENTENCE so it needs a case that is. Never
  approximate with the wrong one: a wrong case reads as broken Russian, which is worse than plainer
  copy.
- A brand or proper name does not decline: write "в %CasinoName%", never "%CasinoName%а".`;
  }

  return `${universal}

- Do not assume the shape of a value you have not seen. "a %product%" is a coin-flip between "a"
  and "an"; write "our %product%" or restructure the sentence.
- Do not pluralize or possessivize a variable by hand — if you need a count, use {plural …}.`;
}

/**
 * The per-request allow-list.
 *
 * Deliberately NOT part of the system prompt: the rules above are stable and cacheable, while this
 * list changes with every item a host processes (in n8n it comes from the current row). Mixing them
 * would defeat prompt caching and blur what is policy versus what is data.
 */
function variableListBlock(vars: readonly VariableSpec[]): string {
  if (vars.length === 0) {
    return 'ALLOWED VARIABLES: (none — do not use any %variable%)';
  }

  const lines = vars.map((v) => {
    const bits = [v.case, v.note].filter(Boolean).join('; ');
    return bits ? `  %${v.name}% — ${bits}` : `  %${v.name}%`;
  });

  return ['ALLOWED VARIABLES (the case is part of the value, not a suggestion):', ...lines].join(
    '\n',
  );
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

/** Locales whose plural buckets are 3-form. Everything else the engine treats as 2-form. */
const THREE_FORM_LANGS = new Set(['ru', 'uk', 'be', 'sr', 'hr', 'bs']);

const langOf = (locale: string | undefined): string => (locale ?? 'en').slice(0, 2).toLowerCase();

/**
 * How many buckets `{plural …}` must have for this locale.
 *
 * This is NOT cosmetic. The engine validates plural arity against the locale, so a 3-form plural
 * under `en` is a hard `plural.arity` error and renders as the fullwidth fallback ｛…｝. Teaching
 * the model the wrong arity produces templates that pass a locale-less `validate()` and then
 * render as garbage — so the prompt's plural shape MUST follow the locale it is built for.
 */
export function pluralArity(locale: string | undefined): 2 | 3 {
  return THREE_FORM_LANGS.has(langOf(locale)) ? 3 : 2;
}

export interface PromptExamples {
  set: string;
  permutation: string;
  optional: string;
  conditional: string;
  plural: string;
}

/**
 * The worked examples the prompt teaches from, for a given locale.
 *
 * Exported and interpolated into the prompt rather than retyped inside it, so the test suite can
 * `validate()` the exact strings the model is shown — under the same locale. A prompt that teaches
 * invalid syntax poisons everything downstream of it; that must be a test failure, not a surprise
 * in production.
 */
export function promptExamples(locale?: string): PromptExamples {
  return {
    set: [
      '#set %product% = {course|training}',
      '#set %offer% = our new %product%',
      'Get %offer% today — the %product% starts on Monday.',
    ].join('\n'),
    permutation:
      pluralArity(locale) === 3
        ? 'Мы [<minsize=2;maxsize=3;sep=", ";lastsep=" и ">перезвоним за час|подберём тариф|перенесём данные].'
        : 'We can [<minsize=2;maxsize=3;sep=", ";lastsep=" and ">reply within the hour|set up your account|migrate your data].',
    optional: 'Get our {|brand new }{course|training} today.',
    conditional: '{?discount?Save %discount% today|Get started in minutes}',
    plural:
      pluralArity(locale) === 3
        ? 'У вас %n% {plural %n%: товар|товара|товаров} в корзине.'
        : 'You have %n% {plural %n%: item|items} in your cart.',
  };
}

// The permutation note is not pedantry: the default separator is a single SPACE, so a bare
// [clause|clause] joins into mush ("we reply fast we migrate your data"). Models get this wrong
// unless told explicitly.
function syntaxBlock(locale: string | undefined): string {
  const ex = promptExamples(locale);
  const pluralForm =
    pluralArity(locale) === 3 ? '{plural %n%: one|few|many}' : '{plural %n%: one|many}';

  return `SYNTAX — this is the COMPLETE list. Nothing else exists.

{a|b|c}
    Pick exactly one. Rerolls at EVERY occurrence: two separate {Hi|Hello} may disagree.
    An EMPTY branch makes a word optional — deliberate and useful:
${indent(ex.optional)}
    But a stray double pipe is an ACCIDENTAL empty branch: {a|b||c} silently renders nothing one
    time in four. Re-read every {…} for a doubled "|".

#set %v% = value
    Define once, reuse. The value is chosen ONCE, and every %v% in the copy is the SAME.
    Use it for anything that must stay consistent across sentences (a product name, a tone).
    A #set value may itself contain {a|b} AND other variables — variables nest:
${indent(ex.set)}
    Here %offer% contains %product%, so the two can never contradict each other. Inline {a|b}
    would reroll and could say "course" in one sentence and "training" in the next.

%name%
    A variable, filled in by the host at render time. Use ONLY names from ALLOWED VARIABLES.

[<minsize=2;maxsize=3;sep=", ";lastsep=" ${pluralArity(locale) === 3 ? 'и' : 'and'} ">a|b|c]
    Permutation: shuffles the items and joins them.
    ALWAYS set sep when the items are clauses — the DEFAULT SEPARATOR IS A SINGLE SPACE, which
    turns clauses into mush.
    ALWAYS set lastsep for a human-readable list: "a, b ${pluralArity(locale) === 3 ? 'и' : 'and'} c"
    instead of the robotic "a, b, c".
    minsize/maxsize pick a SUBSET, so the list itself varies in length.
    Use permutations only for items of EQUAL weight, where the order genuinely does not matter
    (benefits, features, providers):
${indent(ex.permutation)}

{?VAR?then|else}
    Conditional. Emits "then" if VAR has a truthy value, otherwise "else".
    Use it when the copy must adapt to data that may be missing:
${indent(ex.conditional)}

${pluralForm}
    Plural agreement by count. This target language takes EXACTLY ${pluralArity(locale)} forms —
    writing any other number of forms is a hard error, not a style choice. NEVER hand-roll counts
    as {item|items}:
${indent(ex.plural)}`;
}

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

  if (lang === 'sr' || lang === 'hr' || lang === 'bs') {
    return `LANGUAGE: ${lang} — agreement is strict and unforgiving. This is the hard part; slow down here.
- Every option inside {…} must preserve GENDER, CASE and NUMBER agreement with the words around it.
    WRONG: {dobar|odlična} kurs      ← gender breaks in the second branch
    RIGHT: {dobar|odličan} kurs
- If a branch changes the noun, any adjective or preposition that governs it may have to change too.
  In that case move them INSIDE the branch:
    WRONG: u {gradu|selo}
    RIGHT: {u gradu|u selo}
- Counts take THREE buckets, same boundaries as Russian. NEVER hand-roll them:
  {bonus|bonusa|bonusa} is WRONG. Write {plural %n%: bonus|bonusa|bonusa} and let the engine pick.
- Write the WHOLE template in ONE script. Do not mix Latin and Cyrillic inside a template or, worse,
  inside a single {…} — every branch must be the same script as the text around it.`;
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
  const specs = (opts.allowedVariables ?? []).map(asSpec);
  const level = opts.variationLevel ?? 'balanced';
  const channel = opts.channel ?? 'generic';

  const systemPrompt = [
    ROLE,
    GOAL,
    syntaxBlock(opts.locale),
    grammarBlock(opts.locale),
    variableRulesBlock(opts.locale),
    levelBlock(level),
    RULES,
    OUTPUT,
    SELF_CHECK,
  ].join('\n\n');

  const userPrompt = [
    channelBlock(channel),
    variableListBlock(specs),
    '',
    'BRIEF:',
    opts.brief,
    '',
    'Write the spintax template now. Output only the template.',
  ].join('\n');

  return {
    systemPrompt,
    userPrompt,
    allowedVariables: specs.map((v) => v.name),
    promptVersion: PROMPT_VERSION,
  };
}

export interface RepairPromptOptions {
  /**
   * MUST be the same locale the template was authored under and will be rendered with — the
   * plural arity the model is told to produce depends on it, and a mismatch is the very bug the
   * repair is supposed to fix.
   */
  locale?: string;
  /** Restated so a repair cannot smuggle in a variable the host does not have. */
  allowedVariables?: readonly AllowedVariable[];
}

/**
 * Build a repair prompt from `validate()` output.
 *
 * Without this the authoring loop dead-ends the first time a model returns something invalid —
 * and it will. The precise spans added in core 0.1.3 are what let us point the model at the exact
 * offending token instead of saying "something is wrong".
 *
 * It carries the SAME authoring constraints as the draft prompt (locale, allowed variables): a
 * repair that fixes a bracket while inventing a `%variable%` or the wrong plural arity is not a
 * repair.
 */
export function buildRepairPrompt(
  template: string,
  diagnostics: readonly Diagnostic[],
  opts: RepairPromptOptions = {},
): BuiltPrompt {
  const specs = (opts.allowedVariables ?? []).map(asSpec);
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
    syntaxBlock(opts.locale),
    grammarBlock(opts.locale),
    variableRulesBlock(opts.locale),
    OUTPUT,
  ].join('\n\n');

  const userPrompt = [
    'This template failed validation.',
    '',
    variableListBlock(specs),
    '',
    'TEMPLATE (line-numbered):',
    numbered,
    '',
    'ERRORS:',
    list || '- (none reported — return the template unchanged)',
    '',
    'Return the corrected template. Output only the template.',
  ].join('\n');

  return {
    systemPrompt,
    userPrompt,
    allowedVariables: specs.map((v) => v.name),
    promptVersion: PROMPT_VERSION,
  };
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

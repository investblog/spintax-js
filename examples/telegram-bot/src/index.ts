/**
 * Reference Telegram bot for @spintax/core (spec §8, M5).
 *
 * A stateless Cloudflare Worker webhook: paste a spintax template, it validates it and replies
 * with a few random variations; `/draft` has an LLM write one from a plain-language brief.
 *
 * It imports the engine (`@spintax/core`) and the shared authoring prompt
 * (`@spintax/authoring-prompt`) — and contributes nothing back to either. The purity boundary
 * (spec §8) is about DIRECTION, not import count: a consumer proves the API, it must not pollute
 * it. The prompt lives in its own package precisely so that this bot cannot grow a private dialect
 * of it (see `docs/spec-llm-authoring-prompt.md`).
 */
import { render, validate, extract, parse, type Diagnostic } from '@spintax/core';
import { buildAuthoringPrompt, buildRepairPrompt, cleanModelTemplate } from '@spintax/authoring-prompt';

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  /** Optional: Telegram sends this header when a webhook secret is configured. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Cloudflare Workers AI binding (for /draft). */
  AI: Ai;
}

const DRAFT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/**
 * The ONE locale this bot speaks — threaded through the prompt, `validate()` AND `render()`.
 *
 * They must agree. `validate()` skips plural-arity checks when no locale is given, while `render()`
 * defaults to 2-form (en): validate a 3-form `{plural %n%: a|b|c}` with no locale and it passes,
 * then renders as the fullwidth fallback ｛…｝ — "valid" markup that emits garbage. Locale is not a
 * cosmetic argument; it is what makes validation agree with rendering.
 */
export const LOCALE = 'en';

/**
 * The demo data `/draft` renders with — and, therefore, the ONLY variables the model is allowed to
 * use. The two must be the same list, or the prompt and the render disagree.
 *
 * An empty allow-list looks safer and is worse: the prompt then forbids variables outright, the
 * model uses one anyway, and `variable.undefined` is only a *warning* — so the draft was accepted
 * and rendered with the placeholder still in it. Worse still for a plural: an unresolved count
 * makes the whole `{plural …}` block render to nothing, silently eating the noun.
 *
 * `n` is here so the model can actually use `{plural %n%: …}` — the construct the canonical prompt
 * now teaches.
 */
const DRAFT_CONTEXT: Record<string, string> = { name: 'Ada', company: 'Acme', n: '3' };
const DRAFT_VARS = Object.keys(DRAFT_CONTEXT);

/** Notes handed to the model alongside the names. Keys must exist in DRAFT_CONTEXT. */
const DRAFT_NOTES: Record<string, string> = { n: 'a count — pair it with {plural …}' };
const DRAFT_SPECS = DRAFT_VARS.map((name) => {
  const note = DRAFT_NOTES[name];
  return note === undefined ? { name } : { name, note };
});

const DRAFT_NOTE =
  '\n\n💡 Heads up: this demo runs a small, low-cost model, so drafts are rough. ' +
  'Modern LLMs write far better spintax when you prompt them with authoring intent, ' +
  'not a one-line ask — see the guide: https://spintax.net/docs/authoring-mindset/';

const DRAFT_USAGE =
  'Usage: /draft <describe the copy>\ne.g. /draft a friendly welcome for new SaaS signups';

/** Shown when the state channel is gone — an old, deleted or inaccessible message (spec §1.2). */
const STALE = 'That message is too old to reroll — send the template again.';

const VARIANTS = 5;
const TG_LIMIT = 4000; // Telegram hard-caps messages at 4096 chars.

const EXAMPLE_BASIC = '{Hi|Hello|Hey} %name%! Our {deal|offer} ends {today|tonight}.';

// Shows the three things the old help never did: #def picks ONCE (so the copy can't contradict
// itself), variables nest inside other variables, and a permutation shuffles clauses of EQUAL
// weight — with an explicit sep, because the default separator is a space and would run the
// clauses together.
//
// %product% must be #def, not #set: it is mentioned twice, and a #set is re-picked at every
// mention, so the copy could offer a "course" in one sentence and start a "training" in the next.
export const EXAMPLE_POWER = [
  '#def %product% = {course|training}',
  '#set %offer% = our new %product%',
  '{Hi|Hello} %name%! Get %offer% — we can [<sep=", ";lastsep=" and ">enrol you today|answer any question|refund within 14 days]. The %product% starts on Monday.',
].join('\n');

/**
 * The syntax cheat-sheet: raw spintax on the left, prose on the right.
 *
 * Kept as DATA, not as hand-escaped HTML, so the test suite can push every snippet through the
 * engine under this bot's LOCALE. The plural entry is the reason this matters: the help used to
 * advertise the 3-form `{plural %n%: one|few|many}` while the bot renders 2-form `en`, i.e. it
 * documented a shape that this bot rejects.
 */
const SYNTAX_ROWS: readonly (readonly [code: string, note: string])[] = [
  ['{a|b|c}', 'pick one <i>(rerolls at every occurrence)</i>'],
  ['#set %v% = {a|b}', 'a macro — re-picked at <b>every</b> use'],
  ['#def %v% = {a|b}', 'pick <b>once</b> per message, reuse everywhere'],
  ['%name%', 'variable <i>(can nest inside another variable)</i>'],
  ['[<sep=", ";lastsep=" and ">a|b|c]', 'shuffle &amp; join equal-weight parts — <i>lastsep gives “a, b and c”</i>'],
  ['{?flag?yes|no}', 'conditional'],
  ['{plural %n%: item|items}', `plural agreement <i>(${LOCALE} takes 2 forms; ru/uk/be and sr/hr/bs take 3)</i>`],
];

/** Every spintax snippet the help shows. The test suite runs each one through the engine. */
export const HELP_EXAMPLES = [
  ...SYNTAX_ROWS.map(([code]) => code),
  EXAMPLE_BASIC,
  EXAMPLE_POWER,
] as const;

/** Telegram HTML mode: the raw templates contain `<`, `>` and `&`, which must be escaped. */
const esc = (s: string): string =>
  s.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

const HELP = [
  '👋 <b>Spintax bot</b>',
  '',
  'Turn one template into many text variations — great for SEO copy, outreach, and',
  'ad/subject-line testing. Send me a spintax template and I’ll validate it and reply',
  'with a few random variations.',
  '',
  '<b>Syntax</b>',
  ...SYNTAX_ROWS.map(([code, note]) => `<code>${esc(code)}</code> — ${note}`),
  '',
  '<b>Example</b> (send this):',
  `<code>${esc(EXAMPLE_BASIC)}</code>`,
  '',
  '<b>Putting it together</b> — <code>#def</code> picks once, <code>#set</code> expands as a',
  'macro, variables nest, and the permutation reorders three clauses of equal weight:',
  `<code>${esc(EXAMPLE_POWER)}</code>`,
  'Every variant names the same product twice — never “course … training”.',
  '',
  '<b>AI draft</b> (beta)',
  '<code>/draft &lt;brief&gt;</code> — describe the copy in plain words and an AI writes the template.',
  '',
  '<b>Docs &amp; source</b>',
  '📦 <a href="https://www.npmjs.com/package/@spintax/core">npm — @spintax/core</a>',
  '💻 <a href="https://github.com/investblog/spintax-js">GitHub — source &amp; examples</a>',
  '🌐 <a href="https://spintax.net">spintax.net</a>',
  '',
  'Powered by the open-source <code>@spintax/core</code> engine · by 301.st',
].join('\n');

/**
 * The variables a HOST would have to supply — references minus the ones the template defines itself.
 *
 * `extract().refs` is not that list: it strips only the `#set`/`#def` definition LHS, so every
 * *reference* to a locally-defined name is still a ref. Calling that "filled at runtime" tells the
 * author their own `#def` is missing. `defs` is 0.3.0-new; a consumer subtracting `sets` alone —
 * which is exactly what this bot did — now under-reports by every `#def` in the template.
 */
function runtimeRefs(src: string): string[] {
  const { refs, sets, defs } = extract(src);
  const defined = new Set([...sets, ...defs]);
  return refs.filter((r) => !defined.has(r));
}

/**
 * Walk the seed space collecting DISTINCT renders, and report where to resume.
 *
 * Resuming matters: a second batch started from seed 1 again would redraw the same window and
 * present it as new. `nextSeed` is where this batch stopped, so "more" genuinely means more.
 * Distinct seeds are independent draws, not distinct results, so a low-cardinality template
 * runs out — hence the bounded walk and a batch that may be short.
 */
function walk(
  ast: ReturnType<typeof parse>,
  startSeed: number,
  count: number,
  context?: Record<string, string>,
): { variants: string[]; nextSeed: number } {
  const seen = new Set<string>();
  const variants: string[] = [];
  let seed = startSeed;
  const limit = startSeed + count * 6;
  for (; variants.length < count && seed < limit; seed += 1) {
    const out = render(ast, { seed, locale: LOCALE, ...(context ? { context } : {}) });
    if (!seen.has(out)) {
      seen.add(out);
      variants.push(out);
    }
  }
  return { variants, nextSeed: seed };
}

/** Callback payloads — `namespace:verb[:arg]`, task_center's convention (spec §3). */
const CB_HELP = 'help';
const CB_BRIEF = 'brief';
const cbMore = (seed: number): string => `v:m:${seed}`;
const CB_RESTART = 'v:r';
/**
 * The draft reroll carries the template's LENGTH as well as the seed.
 *
 * Without it, extraction has to find the end of the template by searching for the samples
 * marker — and a template is free to contain that marker itself, so the search truncates and
 * hands back a fragment. Re-validating the fragment does not save you: `{Hi|Hello}` cut out of
 * a longer template is perfectly valid spintax, so the guard passes and the bot renders part
 * of the template as though it were the whole one. A length comes from the sender, which the
 * message content cannot forge.
 */
const cbDraftMore = (seed: number, len: number): string => `d:m:${seed}:${len}`;

/** A seed off the wire is untrusted: a stale or hostile value must not become a huge walk. */
const parseSeed = (raw: string | undefined): number =>
  raw !== undefined && /^\d{1,6}$/u.test(raw) ? Number(raw) : 1;

/** Same, but 0 (not 1) on garbage, so a malformed length fails `templateOf` instead of shifting it. */
const parseCount = (raw: string | undefined): number =>
  raw !== undefined && /^\d{1,6}$/u.test(raw) ? Number(raw) : 0;

const templateKeyboard = (nextSeed: number): Keyboard => [
  [
    { text: `🎲 Ещё ${VARIANTS}`, callback_data: cbMore(nextSeed) },
    { text: '🔁 Заново', callback_data: CB_RESTART },
  ],
  [{ text: '📋 Синтаксис', callback_data: CB_HELP }],
];

const draftKeyboard = (nextSeed: number, templateLen: number): Keyboard => [
  [
    { text: '🎲 Ещё варианты', callback_data: cbDraftMore(nextSeed, templateLen) },
    { text: '✏️ Новый бриф', callback_data: CB_BRIEF },
  ],
];

/** Validate a template and render up to VARIANTS distinct variations. */
function handleTemplate(src: string, startSeed = 1): { text: string; nextSeed?: number } {
  const diagnostics = validate(src, { locale: LOCALE });
  const errors = diagnostics.filter((d: Diagnostic) => d.severity === 'error');
  if (errors.length > 0) {
    const lines = errors.slice(0, 8).map((e) => `• ${e.message} (line ${e.line})`);
    let reply = `⚠️ Not valid yet:\n${lines.join('\n')}`;
    // The commonest way to trip this is a Slavic 3-form plural: correct spintax, wrong locale for
    // THIS bot. Say so, instead of leaving the author staring at an arity error.
    // NB: this reply is sent as PLAIN TEXT (no parse_mode), so no HTML here.
    if (errors.some((e) => e.code === 'plural.arity')) {
      reply +=
        `\n\nℹ️ This bot renders with locale “${LOCALE}”, which takes 2 plural forms — ` +
        '{plural %n%: item|items}. Languages like ru/uk/be and sr/hr/bs take 3.';
    }
    // The 0.3.0 trap: a plural counter defined with #set is re-picked at every reference, so the
    // printed number and the form it agrees with are two independent draws. #def rolls it once.
    if (errors.some((e) => e.code === 'plural.count-macro')) {
      reply +=
        '\n\nℹ️ A {plural …} count cannot come from a #set — a macro is re-picked at every use, ' +
        'so the number and its noun would disagree. Use #def instead: #def %n% = {1|4|9}.';
    }
    // No keyboard on an error: there is nothing to reroll.
    return { text: reply };
  }

  const { variants, nextSeed } = walk(parse(src), startSeed, VARIANTS);

  let reply = `✅ Valid! ${variants.length} variation${variants.length === 1 ? '' : 's'}:\n`;
  reply += variants.map((v, i) => `${i + 1}. ${v}`).join('\n');

  if (diagnostics.some((d) => d.code === 'variable.undefined')) {
    const runtime = runtimeRefs(src);
    if (runtime.length > 0) {
      reply += `\n\nℹ️ Variables (filled at runtime): ${runtime.map((r) => `%${r}%`).join(', ')}`;
    }
  }
  const text = reply.length > TG_LIMIT ? `${reply.slice(0, TG_LIMIT)}\n…` : reply;
  return { text, nextSeed };
}

/** One round-trip to the model, with the model's habitual fences/quotes stripped off. */
async function askModel(env: Env, systemPrompt: string, userPrompt: string): Promise<string> {
  const res = (await env.AI.run(DRAFT_MODEL, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  })) as { response?: string };
  return cleanModelTemplate(res.response ?? '');
}

/**
 * /draft: an LLM writes a spintax template from a plain-language brief.
 *
 * Uses the CANONICAL authoring prompt (`@spintax/authoring-prompt`) — the bot must not carry its
 * own dialect of it, or every surface drifts. If the draft comes back invalid, we close the loop
 * once with a repair prompt built from the diagnostics, rather than handing the user broken markup.
 */
async function draftTemplate(
  env: Env,
  brief: string,
): Promise<{ text: string; nextSeed?: number; templateLen?: number }> {
  if (!brief) {
    return { text: DRAFT_USAGE };
  }

  let template: string;
  try {
    const prompt = buildAuthoringPrompt({
      brief,
      locale: LOCALE,
      allowedVariables: DRAFT_SPECS,
      variationLevel: 'balanced',
    });
    template = await askModel(env, prompt.systemPrompt, prompt.userPrompt);

    // Repair loop, capped at one attempt — the whole point of precise diagnostics is that we can
    // hand the model the exact offending span instead of "something is wrong". Validate under the
    // SAME locale we render with, or a wrong-arity plural sails through and renders as ｛…｝.
    if (template) {
      const bad = validate(template, { locale: LOCALE, knownVariables: DRAFT_VARS });
      if (bad.some((d) => d.severity === 'error')) {
        const repair = buildRepairPrompt(template, bad, {
          locale: LOCALE,
          allowedVariables: DRAFT_SPECS,
        });
        const fixed = await askModel(env, repair.systemPrompt, repair.userPrompt);
        const stillBad = validate(fixed, { locale: LOCALE, knownVariables: DRAFT_VARS });
        if (fixed && !stillBad.some((d) => d.severity === 'error')) {
          template = fixed;
        }
      }
    }
  } catch (e) {
    console.error('draft: AI error =', e instanceof Error ? e.message : String(e));
    return {
      text:
        '⚠️ AI drafting isn’t available on this bot yet (Workers AI not enabled).\n' +
        'You can still send a spintax template directly — e.g. {Hi|Hello} %name%! — and I’ll validate + preview it.',
    };
  }
  if (!template) {
    return { text: '⚠️ The model returned nothing usable. Try rephrasing the brief.' };
  }

  const errors = validate(template, { locale: LOCALE, knownVariables: DRAFT_VARS }).filter(
    (d) => d.severity === 'error',
  );
  let reply = `${DRAFT_PREFIX}${template}`;

  if (errors.length > 0) {
    // Still invalid after the repair attempt. Rendering it now would only produce fullwidth
    // fallback markup — so show the diagnostics instead of dressing ｛garbage｝ up as "variations".
    const lines = errors.slice(0, 5).map((e) => `• ${e.message} (line ${e.line})`);
    reply +=
      `\n\n⚠️ ${errors.length} syntax issue${errors.length === 1 ? '' : 's'} the model could not fix:\n` +
      lines.join('\n');
    // No keyboard and no nextSeed: there is nothing renderable to reroll, and offering a
    // reroll on ｛garbage｝ would present it as usable.
    return {
      text:
        reply.length + DRAFT_NOTE.length > TG_LIMIT
          ? `${reply.slice(0, TG_LIMIT - DRAFT_NOTE.length - 1)}…${DRAFT_NOTE}`
          : reply + DRAFT_NOTE,
    };
  }

  return { ...draftReply(template, 1), templateLen: template.length };
}

/**
 * Format a VALID draft — template, samples, caveats — and report where the seed walk stopped.
 *
 * Split out because the `🎲 Ещё варианты` button re-enters here without going near the model.
 * The two markers below are the message's structure AND its state channel (`templateOf`), so
 * they are format, not decoration.
 */
export const DRAFT_PREFIX = '📝 Template:\n';
export const DRAFT_SAMPLES = '\n\n✨ Sample variations:\n';

function draftReply(template: string, startSeed: number): { text: string; nextSeed: number } {
  const { variants, nextSeed } = walk(parse(template), startSeed, 3, DRAFT_CONTEXT);

  let reply = `${DRAFT_PREFIX}${template}`;
  reply += `${DRAFT_SAMPLES}${variants.map((v, i) => `${i + 1}. ${v}`).join('\n')}`;
  reply += `\n\nℹ️ Rendered with demo data: ${DRAFT_VARS.map((v) => `%${v}%=${DRAFT_CONTEXT[v] ?? ''}`).join(', ')}`;

  // The prompt allows exactly DRAFT_VARS. If the model reached for another name it is only a
  // `variable.undefined` WARNING, so the draft is still usable — but the samples above will carry
  // a raw %placeholder% (or, for a count, silently drop the {plural …} block). Say so.
  const invented = runtimeRefs(template).filter((r) => !DRAFT_VARS.includes(r));
  if (invented.length > 0) {
    reply +=
      `\n⚠️ The draft also used ${invented.map((v) => `%${v}%`).join(', ')} — outside the demo set, ` +
      'so they stay unfilled above. Your app would supply them.';
  }
  // Always keep the note; trim the body if the whole thing would overflow.
  if (reply.length + DRAFT_NOTE.length > TG_LIMIT) {
    reply = `${reply.slice(0, TG_LIMIT - DRAFT_NOTE.length - 1)}…`;
  }
  return { text: reply + DRAFT_NOTE, nextSeed };
}

/**
 * Read a draft's template back out of the bot's own message — the `d:m:` state channel (spec §1).
 *
 * `len` comes from the button, not from the text, so the boundary cannot be forged by a template
 * that happens to contain the samples marker. Everything else is a consistency check: the prefix,
 * the length fitting the message (a body trimmed at TG_LIMIT will not), the marker landing exactly
 * where the length says it should, and the recovered template still validating. Any mismatch
 * returns null and the caller degrades to "send it again" — never a render of a fragment.
 */
export function templateOf(messageText: string | undefined, len: number): string | null {
  if (messageText === undefined || !messageText.startsWith(DRAFT_PREFIX) || len <= 0) return null;
  const end = DRAFT_PREFIX.length + len;
  if (!messageText.startsWith(DRAFT_SAMPLES, end)) return null;
  const template = messageText.slice(DRAFT_PREFIX.length, end);
  const bad = validate(template, { locale: LOCALE, knownVariables: DRAFT_VARS });
  return bad.some((d) => d.severity === 'error') ? null : template;
}

/** One inline button row set. `undefined` means "no keyboard"; `[]` means "strip the keyboard". */
type Keyboard = readonly (readonly { text: string; callback_data: string }[])[];

async function callApi(token: string, method: string, body: unknown): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface SendOptions {
  parseMode?: 'HTML' | 'Markdown';
  /** Set this and the reply carries the template forward — see `templateOf`. */
  replyTo?: number;
  keyboard?: Keyboard;
}

async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  opts: SendOptions = {},
): Promise<void> {
  await callApi(token, 'sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
    ...(opts.replyTo === undefined ? {} : { reply_to_message_id: opts.replyTo }),
    ...(opts.keyboard ? { reply_markup: { inline_keyboard: opts.keyboard } } : {}),
  });
}

async function editMessageText(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  keyboard?: Keyboard,
): Promise<void> {
  await callApi(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

/**
 * Retire a keyboard WITHOUT touching the message it belongs to (spec §1.5).
 *
 * Deliberately not `deleteMessage`: that is capped at 48 hours for a bot's own outgoing
 * messages, so a user returning to a template days later would press a button and the sweep
 * would fail silently, leaving the stale keyboard exactly where it was meant to be removed.
 * Editing markup carries no such limit. The messages here are also the generated copy — the
 * thing the user came for — not disposable chrome.
 *
 * Soft, like task_center's `safeDelete`: an orphaned keyboard is a cosmetic defect, a handler
 * that throws on one is an outage.
 */
async function stripKeyboard(token: string, chatId: number, messageId: number): Promise<void> {
  try {
    await callApi(token, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId });
  } catch (e) {
    console.error('stripKeyboard failed =', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Mandatory on EVERY callback, including the ones that change nothing: "Telegram clients will
 * display a progress bar until you call answerCallbackQuery." Note *until* — there is no
 * documented timeout, so an unanswered query spins indefinitely rather than recovering.
 */
async function answerCallback(token: string, id: string, text?: string): Promise<void> {
  await callApi(token, 'answerCallbackQuery', {
    callback_query_id: id,
    ...(text === undefined ? {} : { text }),
  });
}

/**
 * A pressed button. `message` is a MaybeInaccessibleMessage: the docs say content "will not be
 * available if the message is too old", with `date === 0` as the documented discriminator and no
 * stated age threshold. It is also absent entirely for inline-mode buttons. Three-way, not two.
 */
interface CallbackQuery {
  id: string;
  data?: string;
  message?: {
    message_id: number;
    date?: number;
    text?: string;
    chat?: { id?: number };
    reply_to_message?: { message_id: number; text?: string };
  };
}

async function handleCallback(env: Env, q: CallbackQuery): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const msg = q.message;
  const chatId = msg?.chat?.id;

  // Absent message (inline-mode) or an inaccessible one (date === 0) — nothing to read, nothing
  // to edit. Answer anyway: an unanswered query spins forever.
  if (msg === undefined || chatId === undefined || msg.date === 0) {
    await answerCallback(token, q.id, STALE);
    return;
  }

  const [ns, verb, arg, arg2] = (q.data ?? '').split(':');

  if (q.data === CB_HELP) {
    // Deliberately does NOT strip the batch above: the user asked to read the cheat-sheet, not
    // to end the session, so taking their buttons away for a lookup would be a trap.
    await answerCallback(token, q.id);
    await sendMessage(token, chatId, HELP, { parseMode: 'HTML' });
    return;
  }

  if (q.data === CB_BRIEF) {
    await answerCallback(token, q.id, DRAFT_USAGE);
    return;
  }

  // Draft reroll: the template lives in THIS message, so it is edited in place. Superseding it
  // would retire the state channel along with the message (spec §1.5).
  if (ns === 'd' && verb === 'm') {
    const template = templateOf(msg.text, parseCount(arg2));
    if (template === null) {
      await answerCallback(token, q.id, STALE);
      return;
    }
    const { text, nextSeed } = draftReply(template, parseSeed(arg));
    await answerCallback(token, q.id);
    await editMessageText(
      token,
      chatId,
      msg.message_id,
      text,
      draftKeyboard(nextSeed, template.length),
    );
    return;
  }

  if (ns === 'v') {
    // The template is the user's own message, reached through reply_to_message. Note this is
    // inference from the Bot API's typing rather than a documented guarantee (spec §1.1) —
    // hence the explicit null check rather than an assumption.
    const origin = msg.reply_to_message;
    if (origin?.text === undefined) {
      await answerCallback(token, q.id, STALE);
      return;
    }

    const { text, nextSeed } = handleTemplate(origin.text, verb === 'r' ? 1 : parseSeed(arg));
    const keyboard = nextSeed === undefined ? undefined : templateKeyboard(nextSeed);
    await answerCallback(token, q.id);

    if (verb === 'r') {
      await editMessageText(token, chatId, msg.message_id, text, keyboard);
      return;
    }
    // A new batch, so the user keeps the earlier copy to compare against. Reply to the ORIGINAL
    // user message, never to this batch — reply_to_message does not nest, so a chain of
    // replies-to-replies would lose the template at depth 2.
    await sendMessage(token, chatId, text, {
      replyTo: origin.message_id,
      ...(keyboard === undefined ? {} : { keyboard }),
    });
    // send → strip, in that order: if the send fails, stripping first would have left the user
    // with no working keyboard at all.
    await stripKeyboard(token, chatId, msg.message_id);
    return;
  }

  await answerCallback(token, q.id);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Telegram only POSTs updates; anything else is a health check.
    if (request.method !== 'POST') {
      return new Response('spintax-bot: ok');
    }
    if (env.TELEGRAM_WEBHOOK_SECRET) {
      const got = request.headers.get('x-telegram-bot-api-secret-token');
      if (got !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
    }

    let update: {
      message?: { message_id?: number; text?: string; chat?: { id?: number } };
      callback_query?: CallbackQuery;
    };
    try {
      update = await request.json();
    } catch {
      return new Response('bad request', { status: 400 });
    }

    // Before the message branch: a callback is not a message, and the old handler would have
    // acked it into silence.
    if (update.callback_query) {
      await handleCallback(env, update.callback_query);
      return new Response('ok');
    }

    const message = update.message;
    const chatId = message?.chat?.id;
    const text = message?.text;
    if (typeof chatId !== 'number' || typeof text !== 'string') {
      return new Response('ok'); // non-text update — ignore, ack so Telegram stops retrying.
    }

    const token = env.TELEGRAM_BOT_TOKEN;
    const trimmed = text.trim();
    if (trimmed === '/start' || trimmed === '/help') {
      await sendMessage(token, chatId, HELP, { parseMode: 'HTML' });
    } else if (trimmed === '/draft' || trimmed.startsWith('/draft ')) {
      const { text: reply, nextSeed, templateLen } = await draftTemplate(
        env,
        trimmed.slice('/draft'.length).trim(),
      );
      await sendMessage(token, chatId, reply, {
        ...(nextSeed === undefined || templateLen === undefined
          ? {}
          : { keyboard: draftKeyboard(nextSeed, templateLen) }),
      });
    } else {
      const { text: reply, nextSeed } = handleTemplate(trimmed);
      // Reply to the user's message: that is what puts the template within reach of the
      // buttons (spec §1), and it is the only state this bot keeps.
      const originId = message?.message_id;
      await sendMessage(token, chatId, reply, {
        ...(originId === undefined ? {} : { replyTo: originId }),
        ...(nextSeed === undefined ? {} : { keyboard: templateKeyboard(nextSeed) }),
      });
    }
    return new Response('ok');
  },
} satisfies ExportedHandler<Env>;

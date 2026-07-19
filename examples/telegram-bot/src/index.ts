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
  '<b>Putting it together</b> — <code>#set</code> picks once, variables nest, and the',
  'permutation reorders three clauses that carry equal weight:',
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

/** Validate a template and render up to VARIANTS distinct variations. */
function handleTemplate(src: string): string {
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
    return reply;
  }

  const ast = parse(src);
  const seen = new Set<string>();
  const variants: string[] = [];
  for (let seed = 1; variants.length < VARIANTS && seed <= VARIANTS * 6; seed += 1) {
    const out = render(ast, { seed, locale: LOCALE });
    if (!seen.has(out)) {
      seen.add(out);
      variants.push(out);
    }
  }

  let reply = `✅ Valid! ${variants.length} variation${variants.length === 1 ? '' : 's'}:\n`;
  reply += variants.map((v, i) => `${i + 1}. ${v}`).join('\n');

  if (diagnostics.some((d) => d.code === 'variable.undefined')) {
    const refs = extract(src).refs;
    if (refs.length > 0) {
      reply += `\n\nℹ️ Variables (filled at runtime): ${refs.map((r) => `%${r}%`).join(', ')}`;
    }
  }
  return reply.length > TG_LIMIT ? `${reply.slice(0, TG_LIMIT)}\n…` : reply;
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
async function draftTemplate(env: Env, brief: string): Promise<string> {
  if (!brief) {
    return 'Usage: /draft <describe the copy>\ne.g. /draft a friendly welcome for new SaaS signups';
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
    return (
      '⚠️ AI drafting isn’t available on this bot yet (Workers AI not enabled).\n' +
      'You can still send a spintax template directly — e.g. {Hi|Hello} %name%! — and I’ll validate + preview it.'
    );
  }
  if (!template) {
    return '⚠️ The model returned nothing usable. Try rephrasing the brief.';
  }

  const errors = validate(template, { locale: LOCALE, knownVariables: DRAFT_VARS }).filter(
    (d) => d.severity === 'error',
  );
  let reply = `📝 Template:\n${template}`;

  if (errors.length > 0) {
    // Still invalid after the repair attempt. Rendering it now would only produce fullwidth
    // fallback markup — so show the diagnostics instead of dressing ｛garbage｝ up as "variations".
    const lines = errors.slice(0, 5).map((e) => `• ${e.message} (line ${e.line})`);
    reply +=
      `\n\n⚠️ ${errors.length} syntax issue${errors.length === 1 ? '' : 's'} the model could not fix:\n` +
      lines.join('\n');
    return reply.length + DRAFT_NOTE.length > TG_LIMIT
      ? `${reply.slice(0, TG_LIMIT - DRAFT_NOTE.length - 1)}…${DRAFT_NOTE}`
      : reply + DRAFT_NOTE;
  }

  const seen = new Set<string>();
  const variants: string[] = [];
  const ast = parse(template);
  for (let seed = 1; variants.length < 3 && seed <= 18; seed += 1) {
    const out = render(ast, { seed, locale: LOCALE, context: DRAFT_CONTEXT });
    if (!seen.has(out)) {
      seen.add(out);
      variants.push(out);
    }
  }
  reply += `\n\n✨ Sample variations:\n${variants.map((v, i) => `${i + 1}. ${v}`).join('\n')}`;
  reply += `\n\nℹ️ Rendered with demo data: ${DRAFT_VARS.map((v) => `%${v}%=${DRAFT_CONTEXT[v] ?? ''}`).join(', ')}`;

  // The prompt allows exactly DRAFT_VARS. If the model reached for another name it is only a
  // `variable.undefined` WARNING, so the draft is still usable — but the samples above will carry
  // a raw %placeholder% (or, for a count, silently drop the {plural …} block). Say so.
  const invented = extract(template).refs.filter((r) => !DRAFT_VARS.includes(r));
  if (invented.length > 0) {
    reply +=
      `\n⚠️ The draft also used ${invented.map((v) => `%${v}%`).join(', ')} — outside the demo set, ` +
      'so they stay unfilled above. Your app would supply them.';
  }
  // Always keep the note; trim the body if the whole thing would overflow.
  if (reply.length + DRAFT_NOTE.length > TG_LIMIT) {
    reply = `${reply.slice(0, TG_LIMIT - DRAFT_NOTE.length - 1)}…`;
  }
  return reply + DRAFT_NOTE;
}

async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  parseMode?: 'HTML' | 'Markdown',
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(parseMode ? { parse_mode: parseMode } : {}),
    }),
  });
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

    let update: { message?: { text?: string; chat?: { id?: number } } };
    try {
      update = await request.json();
    } catch {
      return new Response('bad request', { status: 400 });
    }

    const message = update.message;
    const chatId = message?.chat?.id;
    const text = message?.text;
    if (typeof chatId !== 'number' || typeof text !== 'string') {
      return new Response('ok'); // non-text update — ignore, ack so Telegram stops retrying.
    }

    const trimmed = text.trim();
    if (trimmed === '/start' || trimmed === '/help') {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, HELP, 'HTML');
    } else if (trimmed === '/draft' || trimmed.startsWith('/draft ')) {
      const reply = await draftTemplate(env, trimmed.slice('/draft'.length).trim());
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, reply);
    } else {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, handleTemplate(trimmed));
    }
    return new Response('ok');
  },
} satisfies ExportedHandler<Env>;

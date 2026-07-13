/**
 * Reference Telegram bot for @spintax/core (spec §8, M5).
 *
 * A stateless Cloudflare Worker webhook: paste a spintax template, it validates
 * it and replies with a few random variations. A second, interactive dogfood of
 * the public API — imports `@spintax/core` ONLY (purity boundary §8), nothing
 * bot-side leaks back into the engine.
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

const DRAFT_NOTE =
  '\n\n💡 Heads up: this demo runs a small, low-cost model, so drafts are rough. ' +
  'Modern LLMs write far better spintax when you prompt them with authoring intent, ' +
  'not a one-line ask — see the guide: https://spintax.net/docs/authoring-mindset/';

const VARIANTS = 5;
const TG_LIMIT = 4000; // Telegram hard-caps messages at 4096 chars.

const EXAMPLE_BASIC = '{Hi|Hello|Hey} %name%! Our {deal|offer} ends {today|tonight}.';

// Shows the three things the old help never did: #set picks ONCE (so the copy can't contradict
// itself), variables nest inside other variables, and a permutation shuffles clauses of EQUAL
// weight — with an explicit sep, because the default separator is a space and would run the
// clauses together.
const EXAMPLE_POWER = [
  '#set %product% = {course|training}',
  '#set %offer% = our new %product%',
  '{Hi|Hello} %name%! Get %offer% — we can [<sep=", ">enrol you today|answer any question|refund within 14 days]. The %product% starts on Monday.',
].join('\n');

/** Every spintax snippet the help shows. The test suite runs each one through the engine. */
export const HELP_EXAMPLES = [EXAMPLE_BASIC, EXAMPLE_POWER] as const;

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
  `<code>{a|b|c}</code> — pick one <i>(rerolls at every occurrence)</i>`,
  `<code>#set %v% = …</code> — pick <b>once</b>, reuse everywhere`,
  `<code>%name%</code> — variable <i>(can nest inside a #set)</i>`,
  `<code>${esc('[<sep=", ">a|b|c]')}</code> — shuffle &amp; join equal-weight parts`,
  '<code>{?flag?yes|no}</code> — conditional',
  '<code>{plural %n%: one|few|many}</code> — plural agreement',
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
  const diagnostics = validate(src);
  const errors = diagnostics.filter((d: Diagnostic) => d.severity === 'error');
  if (errors.length > 0) {
    const lines = errors.slice(0, 8).map((e) => `• ${e.message} (line ${e.line})`);
    return `⚠️ Not valid yet:\n${lines.join('\n')}`;
  }

  const ast = parse(src);
  const seen = new Set<string>();
  const variants: string[] = [];
  for (let seed = 1; variants.length < VARIANTS && seed <= VARIANTS * 6; seed += 1) {
    const out = render(ast, { seed });
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
    const prompt = buildAuthoringPrompt({ brief, locale: 'en', variationLevel: 'balanced' });
    template = await askModel(env, prompt.systemPrompt, prompt.userPrompt);

    // Repair loop, capped at one attempt — the whole point of precise diagnostics is that we can
    // hand the model the exact offending span instead of "something is wrong".
    if (template) {
      const bad = validate(template);
      if (bad.some((d) => d.severity === 'error')) {
        const repair = buildRepairPrompt(template, bad);
        const fixed = await askModel(env, repair.systemPrompt, repair.userPrompt);
        if (fixed && !validate(fixed).some((d) => d.severity === 'error')) {
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

  const errors = validate(template).filter((d) => d.severity === 'error');
  const seen = new Set<string>();
  const variants: string[] = [];
  const ast = parse(template);
  for (let seed = 1; variants.length < 3 && seed <= 18; seed += 1) {
    const out = render(ast, { seed });
    if (!seen.has(out)) {
      seen.add(out);
      variants.push(out);
    }
  }

  let reply = `📝 Template:\n${template}`;
  if (errors.length > 0) {
    reply += `\n\n⚠️ (${errors.length} syntax issue${errors.length === 1 ? '' : 's'} — tweak before use)`;
  }
  reply += `\n\n✨ Sample variations:\n${variants.map((v, i) => `${i + 1}. ${v}`).join('\n')}`;
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

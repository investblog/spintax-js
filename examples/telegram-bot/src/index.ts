/**
 * Reference Telegram bot for @spintax/core (spec §8, M5).
 *
 * A stateless Cloudflare Worker webhook: paste a spintax template, it validates
 * it and replies with a few random variations. A second, interactive dogfood of
 * the public API — imports `@spintax/core` ONLY (purity boundary §8), nothing
 * bot-side leaks back into the engine.
 */
import { render, validate, extract, parse, type Diagnostic } from '@spintax/core';

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  /** Optional: Telegram sends this header when a webhook secret is configured. */
  TELEGRAM_WEBHOOK_SECRET?: string;
}

const VARIANTS = 5;
const TG_LIMIT = 4000; // Telegram hard-caps messages at 4096 chars.

const HELP = [
  '👋 *Spintax bot*',
  '',
  "Send me a spintax template — I'll validate it and show a few random variations.",
  '',
  'Example:',
  '`{Hi|Hello|Hey} %name%! Check out our [great|amazing] {deal|offer}.`',
  '',
  'Syntax:',
  '• `{a|b|c}` — pick one   • `[a|b|c]` — shuffle',
  '• `%var%` — variable   • `{?flag?yes|no}` — conditional',
  '• `{plural %n%: one|many}` — plural agreement',
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

async function sendMessage(token: string, chatId: number, text: string, markdown = false): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(markdown ? { parse_mode: 'Markdown' } : {}),
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
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, HELP, true);
    } else {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, handleTemplate(trimmed));
    }
    return new Response('ok');
  },
} satisfies ExportedHandler<Env>;

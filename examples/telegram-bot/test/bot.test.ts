import { describe, test, expect, vi, beforeEach } from 'vitest';
import bot from '../src/index';

const aiRun = vi.fn(async () => ({ response: '{Hi|Hello} there, %name%!' }));
const ENV = {
  TELEGRAM_BOT_TOKEN: 'test-token',
  TELEGRAM_WEBHOOK_SECRET: 'sekret',
  AI: { run: aiRun },
} as unknown as Parameters<typeof bot.fetch>[1];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sent: any[];

beforeEach(() => {
  sent = [];
  aiRun.mockClear();
  vi.stubGlobal(
    'fetch',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.fn(async (_url: string, init: any) => {
      sent.push(JSON.parse(init.body));
      return new Response('{"ok":true}');
    }),
  );
});

const update = (text: string): Request =>
  new Request('https://bot.dev', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'sekret' },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 42 }, text } }),
  });

describe('telegram bot', () => {
  test('rejects spoofed updates (missing secret) with 403', async () => {
    const res = await bot.fetch(new Request('https://bot.dev', { method: 'POST', body: '{}' }), ENV);
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  test('/start replies with help to the right chat', async () => {
    await bot.fetch(update('/start'), ENV);
    expect(sent[0].chat_id).toBe(42);
    expect(sent[0].text).toContain('Spintax bot');
  });

  test('a valid template yields numbered variations', async () => {
    await bot.fetch(update('{Hi|Hello} World'), ENV);
    expect(sent[0].text).toMatch(/Valid/);
    expect(sent[0].text).toMatch(/1\. (Hi|Hello) World/);
  });

  test('an invalid template yields a validation message', async () => {
    await bot.fetch(update('{a|b'), ENV);
    expect(sent[0].text).toContain('Not valid');
  });

  test('undefined variables are noted as runtime-filled', async () => {
    await bot.fetch(update('Hello %name%'), ENV);
    expect(sent[0].text).toContain('%name%');
  });

  test('/draft asks the model, then returns the template + variations', async () => {
    await bot.fetch(update('/draft a friendly welcome'), ENV);
    expect(aiRun).toHaveBeenCalledOnce();
    expect(sent[0].text).toContain('Template:');
    expect(sent[0].text).toContain('there');
    expect(sent[0].text).toContain('Sample variations');
    expect(sent[0].text).toContain('spintax.net/docs/authoring-mindset');
  });

  test('/draft with no brief shows usage (no model call)', async () => {
    await bot.fetch(update('/draft'), ENV);
    expect(aiRun).not.toHaveBeenCalled();
    expect(sent[0].text).toContain('Usage');
  });

  test('GET is a health check (200, no message sent)', async () => {
    const res = await bot.fetch(new Request('https://bot.dev'), ENV);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });
});

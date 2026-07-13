import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, validate } from '@spintax/core';
import bot, { HELP_EXAMPLES } from '../src/index';

interface AiMessages {
  messages: { role: string; content: string }[];
}

// Typed with the real call signature (model, { messages }) so the tests can assert on the prompt
// the bot actually sends, not just that a call happened.
const aiRun = vi.fn(async (_model: string, _opts: AiMessages) => ({
  response: '{Hi|Hello} there, %name%!',
}));

/** The system/user prompt the bot sent on AI call #n. */
const promptOf = (n: number): { system: string; user: string } => {
  const [, opts] = aiRun.mock.calls[n] ?? [];
  const messages = opts?.messages ?? [];
  return { system: messages[0]?.content ?? '', user: messages[1]?.content ?? '' };
};
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

// The help used to ship an example the engine would have scoffed at ([great|amazing] joins with a
// SPACE). Teaching-by-example only works if the examples are run, so run them.
describe('the help must not teach anything the engine rejects', () => {
  test.each(HELP_EXAMPLES)('example %#: validates clean and renders', (example) => {
    expect(validate(example).filter((d) => d.severity === 'error')).toEqual([]);
    const out = render(example, { seed: 1, context: { name: 'Ada' } });
    expect(out).not.toContain('｛'); // fullwidth braces = the engine rejected a block
    expect(out).not.toContain('#set'); // the directive must be consumed, never printed
  });

  test('the power example proves #set collapses once — one product name, twice', () => {
    for (let seed = 1; seed <= 6; seed += 1) {
      const out = render(HELP_EXAMPLES[1], { seed, context: { name: 'Ada' } });
      const course = (out.match(/course/gu) ?? []).length;
      const training = (out.match(/training/gu) ?? []).length;
      // Both mentions resolve to the SAME word — never one of each.
      expect(course === 2 || training === 2).toBe(true);
      expect(course === 1 && training === 1).toBe(false);
    }
  });

  test('the permutation example sets a separator, so clauses do not run together', () => {
    const out = render(HELP_EXAMPLES[1], { seed: 1, context: { name: 'Ada' } });
    expect(out).toMatch(/(enrol you today|answer any question|refund within 14 days), /u);
  });

  test('help lists every construct, including #set', async () => {
    await bot.fetch(update('/help'), ENV);
    const help: string = sent[0].text;
    for (const construct of ['#set', '%name%', '{?flag?', '{plural', 'sep=']) {
      expect(help).toContain(construct);
    }
  });
});

describe('/draft speaks the canonical prompt, not its own dialect', () => {
  test('the system prompt teaches the constructs the old bot prompt omitted', async () => {
    await bot.fetch(update('/draft a welcome email'), ENV);
    const { system } = promptOf(0);
    for (const construct of ['#set', '{?VAR?', '{plural', 'DEFAULT SEPARATOR IS A SINGLE SPACE']) {
      expect(system).toContain(construct);
    }
  });

  test('an invalid draft is repaired in one extra round-trip, not handed over broken', async () => {
    aiRun
      .mockResolvedValueOnce({ response: '{Hi|Hello there, %name%!' }) // unbalanced brace
      .mockResolvedValueOnce({ response: '{Hi|Hello} there, %name%!' }); // the repair

    await bot.fetch(update('/draft a friendly welcome'), ENV);

    expect(aiRun).toHaveBeenCalledTimes(2);
    const repair = promptOf(1);
    expect(repair.system).toContain('Change as little as possible');
    expect(repair.user).toMatch(/line 1, column \d+ \[bracket\./u); // the exact span, not "it's broken"

    expect(sent[0].text).toContain('{Hi|Hello} there, %name%!');
    expect(sent[0].text).not.toContain('syntax issue');
  });
});

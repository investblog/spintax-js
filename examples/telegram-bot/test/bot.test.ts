import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, validate } from '@spintax/core';
import bot, { EXAMPLE_POWER, HELP_EXAMPLES, LOCALE } from '../src/index';

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
/** Same calls as `sent`, but keeping the Bot API method — needed to assert WHICH call was made. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let calls: { method: string; body: any }[];

/** Bot API methods the mocked Telegram should reject, and how. Set per test. */
let failing: Map<string, 'http' | 'ok-false'>;

beforeEach(() => {
  sent = [];
  calls = [];
  failing = new Map();
  aiRun.mockClear();
  vi.stubGlobal(
    'fetch',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      const method = url.split('/').pop() ?? '';
      sent.push(body);
      calls.push({ method, body });
      // Telegram signals failure two ways, and a bot that checks only the status misses half:
      // ok:false arrives under a 200 routinely.
      const mode = failing.get(method);
      if (mode === 'http') return new Response('{"ok":false}', { status: 400 });
      if (mode === 'ok-false') return new Response('{"ok":false,"description":"nope"}');
      return new Response('{"ok":true}');
    }),
  );
});

const methods = (): string[] => calls.map((c) => c.method);
/** The callback_data of every button on a sent/edited payload, flattened — "" when there is none. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const kbOf = (payload: any): string =>
  (payload?.reply_markup?.inline_keyboard ?? [])
    .flat()
    .map((b: { callback_data: string }) => b.callback_data)
    .join(' ');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const callTo = (method: string): any => calls.find((c) => c.method === method)?.body;

const post = (payload: unknown): Request =>
  new Request('https://bot.dev', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'sekret' },
    body: JSON.stringify(payload),
  });

const update = (text: string): Request =>
  post({ update_id: 1, message: { message_id: 1, chat: { id: 42 }, text } });

/** A button press. `message` is the bot's own message that carried the keyboard. */
const press = (
  data: string,
  message: Record<string, unknown> = { message_id: 7, chat: { id: 42 }, date: 100 },
): Request => post({ update_id: 2, callback_query: { id: 'cb1', data, message } });

/** The bot's reply to a template, as the callback would see it: a reply to the user's message. */
const batchMessage = (template: string): Record<string, unknown> => ({
  message_id: 7,
  chat: { id: 42 },
  date: 100,
  text: '✅ Valid! …',
  reply_to_message: { message_id: 1, text: template },
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

  // Same locale trap on the paste path, not just /draft: a 3-form plural is perfectly good spintax
  // in ru, but this bot renders in en. Reporting it beats silently emitting ｛…｝.
  test('a pasted 3-form plural is reported against the bot locale, never rendered as mush', async () => {
    await bot.fetch(update('You have 3 {plural 3: товар|товара|товаров} in cart.'), ENV);
    const text: string = sent[0].text;
    expect(text).toContain('Not valid');
    expect(text).toContain('2 plural forms');
    expect(text).not.toContain('｛');
    expect(text).not.toContain('<code>'); // plain-text reply — no HTML may leak through
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
    expect(validate(example, { locale: LOCALE }).filter((d) => d.severity === 'error')).toEqual([]);
    const out = render(example, { seed: 1, locale: LOCALE, context: { name: 'Ada' } });
    expect(out).not.toContain('｛'); // fullwidth braces = the engine rejected a block
    expect(out).not.toContain('#set'); // the directive must be consumed, never printed
    expect(out).not.toContain('#def');
  });

  test('the power example proves #def picks once — one product name, twice', () => {
    for (let seed = 1; seed <= 6; seed += 1) {
      const out = render(EXAMPLE_POWER, { seed, locale: LOCALE, context: { name: 'Ada' } });
      const course = (out.match(/course/gu) ?? []).length;
      const training = (out.match(/training/gu) ?? []).length;
      // Both mentions resolve to the SAME word — never one of each. Under #set they would be
      // two independent picks, which is exactly the contradiction this example warns against.
      expect(course === 2 || training === 2).toBe(true);
      expect(course === 1 && training === 1).toBe(false);
    }
  });

  test('the permutation example sets a separator, so clauses do not run together', () => {
    const out = render(EXAMPLE_POWER, { seed: 1, locale: LOCALE, context: { name: 'Ada' } });
    expect(out).toMatch(/(enrol you today|answer any question|refund within 14 days), /u);
  });

  test('help lists every construct, including both directives', async () => {
    await bot.fetch(update('/help'), ENV);
    const help: string = sent[0].text;
    for (const construct of ['#set', '#def', '%name%', '{?flag?', '{plural', 'sep=']) {
      expect(help).toContain(construct);
    }
  });

  // The help once said "#set picks once" two lines below a cheat-sheet row saying the opposite —
  // 0.3.0 swapped the semantics and the prose was left behind. Pin the attribution, not the wording.
  test('roll-once is attributed to #def, never to #set', async () => {
    await bot.fetch(update('/help'), ENV);
    const help: string = sent[0].text;
    expect(help).not.toMatch(/#set<\/code> picks once/u);
    expect(help).toMatch(/#def<\/code> picks once/u);
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

  // The bug this suite exists for: the prompt was built with locale 'en' but validate()/render()
  // were called without one. validate() skips plural-arity checks with no locale, render() defaults
  // to 2-form — so a 3-form English plural was pronounced "valid" and then rendered as ｛…｝ mush.
  // Locale must be the SAME in the prompt, the validation and the render.
  test('a wrong-arity plural is never shown as a sample — it is repaired or reported', async () => {
    aiRun
      .mockResolvedValueOnce({ response: 'You have 3 {plural 3: item|few|items} in cart.' })
      .mockResolvedValueOnce({ response: 'You have 3 {plural 3: item|items} in cart.' });

    await bot.fetch(update('/draft cart reminder'), ENV);

    const text: string = sent[0].text;
    expect(text).not.toContain('｛'); // never hand the user a fullwidth fallback
    expect(aiRun).toHaveBeenCalledTimes(2); // the arity error was CAUGHT, so a repair was attempted
    expect(promptOf(1).user).toMatch(/\[plural\.arity\]/u); // …and the model was told exactly that
    expect(text).toContain('You have 3 items in cart.'); // repaired, then rendered for real
  });

  test('if the repair also fails, the user is told — not handed fullwidth mush', async () => {
    aiRun
      .mockResolvedValueOnce({ response: 'You have 3 {plural 3: item|few|items} in cart.' })
      .mockResolvedValueOnce({ response: 'You have 3 {plural 3: still|three|forms} in cart.' });

    await bot.fetch(update('/draft cart reminder'), ENV);

    const text: string = sent[0].text;
    expect(text).toContain("could not fix"); // reported honestly…
    expect(text).not.toMatch(/^\d+\. .*｛plural/mu); // …and never dressed up as a sample variation
  });

  test('the prompt is given the demo variables, so the model may actually use them', async () => {
    await bot.fetch(update('/draft a welcome email'), ENV);
    const { user } = promptOf(0);
    expect(user).toContain('%name%');
    expect(user).toContain('%company%');
    expect(user).toContain('%n% — a count — pair it with {plural …}');
    expect(user).not.toContain('do not use any %variable%');
  });

  test('samples are rendered with demo data, not left full of raw placeholders', async () => {
    aiRun.mockResolvedValueOnce({ response: '{Hi|Hello} %name%, welcome to %company%!' });
    await bot.fetch(update('/draft a welcome'), ENV);

    const text: string = sent[0].text;
    expect(text).toMatch(/\d\. (Hi|Hello) Ada, welcome to Acme!/u); // filled in
    expect(text).toContain('Rendered with demo data');
    // The template itself still shows the variables — only the SAMPLES are filled.
    expect(text).toContain('📝 Template:\n{Hi|Hello} %name%, welcome to %company%!');
  });

  // An unresolved count does not merely print a placeholder — the whole {plural …} block renders
  // to NOTHING, silently eating the noun. That is why `n` is in the demo set.
  test('a drafted plural renders for real instead of vanishing', async () => {
    aiRun.mockResolvedValueOnce({ response: 'You have %n% {plural %n%: item|items} waiting.' });
    await bot.fetch(update('/draft cart reminder'), ENV);

    const text: string = sent[0].text;
    expect(text).toMatch(/\d\. You have 3 items waiting\./u);
    expect(text).not.toMatch(/\d\. You have %n% {2}waiting\./u); // the noun did not disappear
  });

  test('a variable outside the demo set is reported, not silently left raw', async () => {
    aiRun.mockResolvedValueOnce({ response: 'Hi %name%, your %plan% plan is ready.' });
    await bot.fetch(update('/draft a plan upgrade'), ENV);

    const text: string = sent[0].text;
    expect(text).toContain('%plan%');
    expect(text).toContain('outside the demo set');
    expect(text).toMatch(/\d\. Hi Ada, your %plan% plan is ready\./u); // honest about what rendered
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

// The keyboard contract (docs/spec-bot-keyboard.md). These assert TRANSPORT decisions — which Bot
// API method fires, and in what order — because that is where the spec's reasoning lives and none
// of it shows up in the reply text.
describe('inline keyboard: exactly one live keyboard, and it is never deleted', () => {
  // Reported from production as "Заново only works after Ещё 5" — which reads like a race and was
  // pure determinism: a first batch is rendered from seed 1, so restarting redraws byte-identical
  // text and markup, and Telegram rejects an edit that changes nothing. Ten HTTP 400s in the tail
  // log, one per press. The button is now simply not offered where it cannot act.
  test('a first batch offers no "Заново" — it would only redraw itself', async () => {
    await bot.fetch(update('{Hi|Hello} World'), ENV);
    expect(sent[0].reply_to_message_id).toBe(1); // the state channel (spec §1)
    expect(kbOf(sent[0])).toMatch(/^v:m:\d+ help$/u);
    expect(kbOf(sent[0])).not.toContain('v:r');
  });

  test('a later batch DOES offer "Заново" — there it changes something', async () => {
    await bot.fetch(press('v:m:31', batchMessage('{Hi|Hello} World')), ENV);
    expect(kbOf(callTo('sendMessage'))).toMatch(/^v:m:\d+ v:r help$/u);
  });

  test('an invalid template gets NO keyboard — there is nothing to reroll', async () => {
    await bot.fetch(update('{a|b'), ENV);
    expect(sent[0].reply_markup).toBeUndefined();
  });

  test('"Ещё" sends a new batch AND strips the previous keyboard — in that order', async () => {
    await bot.fetch(press('v:m:31', batchMessage('{Hi|Hello} World')), ENV);

    // send → strip. Stripping first would leave the user with nothing if the send failed.
    expect(methods()).toEqual(['answerCallbackQuery', 'sendMessage', 'editMessageReplyMarkup']);
    const strip = callTo('editMessageReplyMarkup');
    expect(strip.message_id).toBe(7); // the OLD batch
    expect(strip.reply_markup).toBeUndefined(); // markup removed, text untouched
  });

  // The whole point of §1.5: deleteMessage is capped at 48h for a bot's own messages, so a sweep
  // fails silently on exactly the stale keyboard it was meant to remove. Editing has no such limit.
  test('deleteMessage is never called, on any path', async () => {
    await bot.fetch(update('{Hi|Hello} World'), ENV);
    await bot.fetch(press('v:m:31', batchMessage('{Hi|Hello} World')), ENV);
    await bot.fetch(press('v:r', batchMessage('{Hi|Hello} World')), ENV);
    await bot.fetch(press('help'), ENV);
    expect(methods()).not.toContain('deleteMessage');
  });

  test('a second "Ещё" replies to the ORIGINAL user message, not to the batch above it', async () => {
    await bot.fetch(press('v:m:31', batchMessage('{Hi|Hello} World')), ENV);
    // reply_to_message does not nest — a chain of replies-to-replies loses the template at depth 2.
    expect(callTo('sendMessage').reply_to_message_id).toBe(1);
  });

  test('"Ещё" resumes the seed walk instead of redrawing the same window', async () => {
    await bot.fetch(update('{a|b|c|d|e|f|g|h}'), ENV);
    const firstBatch: string = sent[0].text;
    const resume = Number(/v:m:(\d+)/u.exec(kbOf(sent[0]))?.[1]);
    expect(resume).toBeGreaterThan(1);

    calls = [];
    sent = [];
    await bot.fetch(press(`v:m:${resume}`, batchMessage('{a|b|c|d|e|f|g|h}')), ENV);
    expect(callTo('sendMessage').text).not.toBe(firstBatch);
  });

  test('"Заново" edits in place — no new message, nothing left to strip', async () => {
    await bot.fetch(press('v:r', batchMessage('{Hi|Hello} World')), ENV);
    expect(methods()).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(callTo('editMessageText').message_id).toBe(7);
  });

  // The safety net behind the fix above. Distinct seeds are independent draws, not distinct
  // results, so a low-cardinality template exhausts itself and a reroll legitimately reproduces
  // what is already on screen. Telegram would reject that edit; say so instead of going quiet.
  test('a reroll that reproduces the current text explains itself instead of failing', async () => {
    // Render what the first batch would be, then present it as the message being rerolled.
    await bot.fetch(update('{Hi|Hello} World'), ENV);
    const current: string = sent[0].text;
    calls = [];
    sent = [];

    const message = { ...batchMessage('{Hi|Hello} World'), text: current };
    await bot.fetch(press('v:r', message), ENV);

    expect(methods()).toEqual(['answerCallbackQuery']); // no doomed editMessageText
    expect(sent[0].text).toMatch(/run out of distinct combinations/u);
  });

  test('"Синтаксис" does NOT strip the batch above it — a lookup is not the end of the session', async () => {
    await bot.fetch(press('help'), ENV);
    expect(methods()).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(sent[1].text).toContain('Spintax bot');
  });
});

// Found in review. The send→strip ORDER was correct and the invariant was still unenforced,
// because callApi ignored the response: a failed send resolved, the strip ran anyway, and the
// user was left with neither the batch nor a keyboard. Ordering without error detection is
// decoration — so these tests assert the failure path, which is where the invariant actually lives.
describe('inline keyboard: a failed send must leave the old keyboard usable', () => {
  test.each([
    ['an HTTP error', 'http'],
    ['ok:false under a 200', 'ok-false'],
  ] as const)('%s on sendMessage does NOT strip the previous keyboard', async (_name, mode) => {
    failing.set('sendMessage', mode);
    const res = await bot.fetch(press('v:m:31', batchMessage('{Hi|Hello} World')), ENV);

    expect(res.status).toBe(200); // acked: a redelivery could send the batch twice
    expect(methods()).toEqual(['answerCallbackQuery', 'sendMessage']);
    expect(methods()).not.toContain('editMessageReplyMarkup');
  });

  // The tail log said `editMessageText: HTTP 400` ten times for a bug whose cause Telegram had
  // spelled out in the response body the old code discarded. Errors carry the description now.
  test('a Bot API error reports Telegram’s description, not just the status', async () => {
    failing.set('sendMessage', 'ok-false');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await bot.fetch(press('v:m:31', batchMessage('{Hi|Hello} World')), ENV);
    expect(spy.mock.calls.flat().join(' ')).toContain('nope'); // the mocked description
    spy.mockRestore();
  });

  test('a failed strip is soft — the batch was sent, so the callback still succeeded', async () => {
    failing.set('editMessageReplyMarkup', 'http');
    const res = await bot.fetch(press('v:m:31', batchMessage('{Hi|Hello} World')), ENV);
    expect(res.status).toBe(200);
    expect(methods()).toEqual(['answerCallbackQuery', 'sendMessage', 'editMessageReplyMarkup']);
  });

  test('a rejected answerCallbackQuery does not abandon the work it was acknowledging', async () => {
    // The one call that must stay soft: a stale query id is exactly what Telegram rejects, and
    // exactly when the user is still waiting for the render.
    failing.set('answerCallbackQuery', 'http');
    await bot.fetch(press('v:m:31', batchMessage('{Hi|Hello} World')), ENV);
    expect(callTo('sendMessage').text).toMatch(/Valid/u);
  });

  test('a failed reply to a plain template is logged, not retried into a duplicate', async () => {
    failing.set('sendMessage', 'http');
    const res = await bot.fetch(update('{Hi|Hello} World'), ENV);
    expect(res.status).toBe(200);
    expect(methods()).toEqual(['sendMessage']);
  });
});

describe('inline keyboard: every callback is answered, and stale state degrades to a toast', () => {
  test('an unknown callback is still answered — an unanswered query spins forever', async () => {
    await bot.fetch(press('nonsense:verb'), ENV);
    expect(methods()).toEqual(['answerCallbackQuery']);
  });

  // Also from review: `v:` used to accept ANY verb as "more", so a button left over from an older
  // deploy would render and strip instead of answering, and a future verb rename would silently
  // alias itself to this branch rather than failing where someone would notice.
  test('an unknown verb in a known namespace is answered, not treated as "more"', async () => {
    await bot.fetch(press('v:x:31', batchMessage('{Hi|Hello} World')), ENV);
    expect(methods()).toEqual(['answerCallbackQuery']);
  });

  test.each([
    ['inaccessible (date === 0)', { message_id: 7, chat: { id: 42 }, date: 0 }],
    ['no reply_to_message', { message_id: 7, chat: { id: 42 }, date: 100 }],
  ])('%s degrades to the "send it again" toast, not a crash', async (_name, message) => {
    const res = await bot.fetch(press('v:m:31', message), ENV);
    expect(res.status).toBe(200);
    expect(methods()).toEqual(['answerCallbackQuery']);
    expect(sent[0].text).toMatch(/send the template again/iu);
  });

  test('an absent message (inline-mode button) is the third branch, not a crash', async () => {
    const res = await bot.fetch(
      post({ update_id: 2, callback_query: { id: 'cb1', data: 'v:m:31' } }),
      ENV,
    );
    expect(res.status).toBe(200);
    expect(methods()).toEqual(['answerCallbackQuery']);
  });

  test('a hostile seed is clamped, not walked', async () => {
    await bot.fetch(press('v:m:999999999999', batchMessage('{Hi|Hello} World')), ENV);
    expect(callTo('sendMessage').text).toMatch(/Valid/u); // fell back to seed 1, did not hang
  });
});

describe('inline keyboard: the draft rerolls in place, because it IS the state channel', () => {
  const draftMessage = (text: string): Record<string, unknown> => ({
    message_id: 9,
    chat: { id: 42 },
    date: 100,
    text,
  });

  test('a valid draft carries the reroll keyboard, and its reply is its own state', async () => {
    await bot.fetch(update('/draft a friendly welcome'), ENV);
    // seed AND template length — the length is what makes extraction unforgeable.
    expect(kbOf(sent[0])).toMatch(/^d:m:\d+:\d+ brief$/u);
    expect(sent[0].text).toContain('📝 Template:\n');
  });

  test('an unfixable draft gets NO keyboard — a reroll on ｛garbage｝ would look usable', async () => {
    aiRun
      .mockResolvedValueOnce({ response: '{Hi|Hello there, %name%!' })
      .mockResolvedValueOnce({ response: '{still|broken' });
    await bot.fetch(update('/draft a friendly welcome'), ENV);
    expect(sent[0].text).toContain('syntax issue');
    expect(sent[0].reply_markup).toBeUndefined();
  });

  test('the reroll edits in place and never calls the model again', async () => {
    await bot.fetch(update('/draft a friendly welcome'), ENV);
    const draft: string = sent[0].text;
    const reroll = kbOf(sent[0]).split(' ')[0] ?? '';
    calls = [];
    sent = [];
    aiRun.mockClear();

    await bot.fetch(press(reroll, draftMessage(draft)), ENV);
    expect(methods()).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(callTo('editMessageText').message_id).toBe(9); // the SAME message — the template lives here
    expect(aiRun).not.toHaveBeenCalled();
  });

  // This is the bug the length channel exists for. Searching for the samples marker truncated at
  // the template's OWN copy of it and recovered `{Hi|Hello}` — valid spintax, so re-validation
  // waved it through and the bot rendered a fragment as if it were the whole template.
  test('a template containing the samples marker still rerolls in full', async () => {
    const nasty = '{Hi|Hello}\n\n✨ Sample variations:\n{a|b}';
    const body = `📝 Template:\n${nasty}\n\n✨ Sample variations:\n1. x`;
    await bot.fetch(press(`d:m:1:${nasty.length}`, draftMessage(body)), ENV);
    expect(callTo('editMessageText').text).toContain(nasty);
  });

  test('a length that does not line up degrades to the toast, never to a fragment', async () => {
    const body = '📝 Template:\n{Hi|Hello} World\n\n✨ Sample variations:\n1. x';
    await bot.fetch(press('d:m:1:10', draftMessage(body)), ENV); // 10 lands mid-template
    expect(methods()).toEqual(['answerCallbackQuery']);
    expect(sent[0].text).toMatch(/send the template again/iu);
  });

  test('"Новый бриф" toasts the usage line without changing anything', async () => {
    await bot.fetch(press('brief'), ENV);
    expect(methods()).toEqual(['answerCallbackQuery']);
    expect(sent[0].text).toContain('/draft <describe the copy>');
  });
});

# Spec — inline keyboard for `examples/telegram-bot`

Status: **implemented and live** 2026-07-20 (`examples/telegram-bot/src/index.ts`). §1.1's
assumption is **confirmed against the live bot** — see the verdict there.

## 0. What this is, and what it deliberately is not

The bot gains inline buttons under its replies: reroll variations, ask for more, open the
syntax cheat-sheet. Nothing else changes.

It does **not** adopt the `W:\projects\task_center` architecture, even though that project is
where the idea comes from. That bot runs grammY over a `ChatSession` Durable Object with a
`Nav` class managing a persistent ReplyKeyboard anchor and a swept list of inline messages
(`task_center/docs/tg-kbrd.md`). It needs all of it: a multi-step task-creation FSM
(`assignee → title → description → deadline → confirm`) with no meaningful state outside the
conversation.

This bot's entire interaction is one message in, one message out. Its most valuable property
is that it is a **stateless** Worker with **zero** storage — that is what makes it a credible
reference consumer of `@spintax/core` (spec §8: a consumer proves the API, it must not
pollute it). Adding a Durable Object to hang three buttons off a reply would trade the thing
being demonstrated for the decoration.

So: borrow task_center's *conventions* (namespaced `callback_data`, fixed-width button rows,
edit-in-place) and its *invariants* (one live keyboard, send-before-retire), not its
*machinery*. Where the mechanism has to differ — it retires keyboards by deleting messages,
this bot by stripping markup — §1.5 gives the reason, which turns out to be a documented Bot
API limit rather than a matter of taste.

## 1. The state problem, and why there is no store

Every button needs to answer "more variations **of what?**". `callback_data` caps at 64 bytes
and cannot carry a template. The usual answer is a session store. The proposal is that this
bot does not need one, because the chat already holds the state.

**The bot replies with `reply_to_message_id` set to the user's message.** A `callback_query`
then arrives carrying `callback_query.message.reply_to_message.text` — the original template,
verbatim, from Telegram's own storage. The state lives in the chat, where the user can see it
too.

For `/draft` the source is different: the template is in the bot's *own* reply
(`📝 Template:\n…`), read back from `callback_query.message.text`. That makes the
`📝 Template:` prefix and the blank line after the template **load-bearing format, not
decoration** — pin them in a test, or a cosmetic edit to the reply silently breaks the buttons.

### 1.1 The assumption this rests on — CONFIRMED 2026-07-20

**Verdict: `callback_query.message.reply_to_message.text` is delivered.** Confirmed on the live
bot, and not by a test written to pass: a production report that "Заново only works after Ещё 5"
proved it incidentally. For that button to fail the way it did, it had to reach
`editMessageText` — which is downstream of the `reply_to_message` check. The design's one
undocumented dependency held.

The checks below stay in the code regardless. The field is still undocumented, so it is a
behaviour that happens to be true, not a contract; and the inaccessible-message case (§1.2) is
documented and will eventually happen on its own.

The original reasoning follows, kept because it explains why the fallbacks exist.

---

**`callback_query.message` carrying a populated `reply_to_message` is not documented.** The
Bot API describes no field-stripping for the callback-embedded `Message`, so it should be
there, but that is inference from the type, not a guarantee — no sentence in the official docs
says so either way.

So **step one of implementation is an empirical check against a real bot**, before any of §4 is
written: send a reply with `reply_to_message_id`, press a button, log the update. If
`reply_to_message` is absent, the `v:` flow in §2.1 has no state source and the design changes
— the honest fallbacks are then echoing the template into the bot's own reply (making both
flows work like `/draft`), or accepting a store. Do not discover this after writing the
handlers.

### 1.3 A control that cannot act must not be rendered

"Заново" restarts the seed walk. On a first batch — already rendered from seed 1 — it produced
byte-identical text and, since `nextSeed` was unchanged, identical markup. Telegram rejects an
edit that changes neither, so the button did nothing, and only worked once "Ещё" had moved the
message to a later window. It looked like a race; it was determinism.

The button is therefore offered **only when `startSeed > 1`**, which is task_center's pagination
rule (hide the nav row at one page) applied to a different control.

Separately, and not made redundant by that: **a reroll can legitimately reproduce the current
text**, because distinct seeds are independent draws rather than distinct results and a
low-cardinality template exhausts its combinations. So the handler compares against
`message.text` and answers with an explanation rather than attempting a doomed edit. The
comparison must happen **before** `answerCallbackQuery` — a query is answerable once, so
discovering the no-op afterwards leaves no channel to explain it in.

### 1.2 Documented limits, all of which must be handled

- **`callback_query.message` is a `MaybeInaccessibleMessage`, not a `Message`.** Verbatim:
  *"Note that message content and message date will not be available if the message is too
  old."* No age threshold is documented — do not write a number. The runtime discriminator is
  `date === 0`, which is what `InaccessibleMessage` exists to signal.
- **`message` may be absent entirely** (inline-mode buttons, where `inline_message_id` comes
  instead). Not a flow this bot has, but the branch is three-way — absent / inaccessible /
  readable — and collapsing it to two is how you get a crash on the one update you did not
  imagine.
- **`reply_to_message` does not nest.** Verbatim: *"the Message object in this field will not
  contain further reply_to_message fields even if it itself is a reply."* §2.1 depends on this
  and stays at depth 1 deliberately — see the reply-target rule there.

Every one of these degrades to the same place: `answerCallbackQuery` with *"Send the template
again"*, and stop. Never a crash, never a render of `''` dressed up as variations.

## 1.5 Keyboard lifecycle — exactly one live keyboard, and it is never deleted

task_center's §4 invariant is *"ровно 0/1 якорь на чат"*, enforced by tracking every inline
message id in `nav:inline` and sweeping them with `safeDelete`. The **invariant** is right and
this bot adopts it. The **mechanism** does not survive the move, for two independent reasons.

**Deleting is time-limited and stripping is not.** `deleteMessage`: *"A message can only be
deleted if it was sent less than 48 hours ago."* That bullet is unconditional — the
"Bots can delete outgoing messages in private chats" bullet grants permission, not an
exemption, and there is no carve-out for a bot's own messages. Meanwhile the only documented
edit time limit reads: *"business messages that were not sent by the bot and do not contain an
inline keyboard can only be edited within 48 hours"* — three conditions, and an ordinary bot
message with an inline keyboard fails all three. **Editing a bot's own message has no
documented time limit.**

task_center never feels this because its inline messages are pickers and calendars that live
for minutes. Here a user comes back to a template a week later and presses a button; a
delete-based sweep fails silently and the stale keyboard stays exactly where it was not
supposed to.

**And the messages are content, not chrome.** task_center's inline messages are transient UI.
This bot's are the generated copy — the deliverable. Deleting a batch to tidy up throws away
what the user came for, and for `/draft` it also destroys the message the next reroll reads
its template from (§1).

**The rule:**

> When a button produces a new message, the previous message's keyboard is removed with
> `editMessageReplyMarkup` (empty markup — text untouched). `deleteMessage` is not used
> anywhere in this bot.

Order is **send → strip**, matching task_center §4. The reason differs — there is no
ReplyKeyboard here and so no Android IME concern — but the ordering earns its keep anyway: if
the send fails, stripping first would have left the user with no working keyboard at all.
Stripping is soft, exactly like `safeDelete`: wrapped, failure logged, never fatal. A keyboard
that outlived its message is a cosmetic defect; a handler that throws on it is an outage.

**The ordering only enforces anything if a failed send is detectable.** The first implementation
got the order right and the invariant wrong: `callApi` ignored the response, so a 400, a 429 or
a `{ok:false}` all resolved, the strip ran regardless, and the user was left with neither the new
batch nor a working keyboard — the precise outcome the ordering exists to prevent. Caught in
review, not by the suite, because every test mocked a successful Bot API.

So the failure model is explicit, and it is not uniform:

| Call | On failure | Why |
|---|---|---|
| `sendMessage` / `editMessageText` | **throws** | The next step must not run as if it had worked |
| `editMessageReplyMarkup` (strip) | soft | The batch already landed; an orphaned keyboard is cosmetic |
| `answerCallbackQuery` | soft | A stale query id is what Telegram rejects, and exactly when the user is still owed the render — never abandon work because its acknowledgement failed |

Telegram reports failure two ways and checking only the HTTP status catches half of them:
`ok:false` arrives under a 200 routinely.

At the handler boundary the throw is caught, logged, and still answered `200`. A non-2xx makes
Telegram redeliver the update, and a redelivered "more" that partly succeeded would send the
batch twice — a logged miss beats a duplicate.

Two consequences worth stating, because both are only visible at the second button press:

- **A new batch must reply to the ORIGINAL user message**, never to the previous batch —
  `reply_to_message` does not nest (§1.2), so a chain of replies-to-replies loses the template
  at depth 2. The original id is available as
  `callback_query.message.reply_to_message.message_id`; thread it through unchanged.
- **Where a flow reads its state out of the bot's own message, that message must be edited in
  place, not superseded** — otherwise the state source is the thing being retired. This is why
  `/draft` rerolls edit and template rerolls send new (§2), and it is a principled split, not
  an inconsistency: the two flows keep their state in different places.

## 2. Screens

Only two replies grow buttons. Errors and help do not — there is nothing to reroll.

### 2.1 Valid template (`handleTemplate`)

```
✅ Valid! 5 variations:
1. Hi Ada! Our deal ends today.
…

[🎲 Ещё 5]  [🔁 Заново]
[📋 Синтаксис]
```

- **🎲 Ещё 5** — `v:<next>`. Continues the seed walk from where the last batch stopped, so
  batch 2 is genuinely new draws rather than a reshuffle of the same window. Sent as a **new
  message**, replying to the original user message (§1.5), and the previous batch is
  **stripped of its keyboard**. The user keeps the earlier copy to compare against — that is
  the point of the tool — but only the newest batch has buttons.
- **🔁 Заново** — `v:1`. Restarts the walk. **Edits in place**, so there is nothing to strip.
- **📋 Синтаксис** — `help`. Sends the existing `HELP` text, no keyboard. Does **not** strip
  the batch above it: the user asked to read the cheat-sheet, not to end the session, and
  taking the buttons away for a lookup would be a trap.

### 2.2 Draft (`draftTemplate`)

```
📝 Template:
…

✨ Sample variations:
…

[🎲 Ещё варианты]  [✏️ Новый бриф]
```

- **🎲 Ещё варианты** — `dv:<next>`, re-renders the template from the bot's own message with
  `DRAFT_CONTEXT`. **Edits in place**, necessarily: this message *is* the state source, so
  superseding it would retire the template along with it (§1.5). One message, one keyboard,
  nothing to strip and nothing left hanging.
- **✏️ Новый бриф** — `answerCallbackQuery` showing the `/draft` usage line. Not a state
  transition; the bot stays stateless and the user just types.

A draft that came back **invalid** gets no buttons: there is nothing to render, and offering
a reroll on `｛garbage｝` would misrepresent it as usable.

## 3. `callback_data`

task_center's convention — `namespace:verb[:args]`, colon-delimited, matched by regex
(`nt:cancel`, `ntPick:<id>`, `task:<id>:<verb>`).

| Data | Meaning | Source of template |
|---|---|---|
| `v:m:<seed>` | Render `VARIANTS` variations from `<seed>`, as a new message | `message.reply_to_message.text` |
| `v:r` | Restart the walk, editing in place | same |
| `d:m:<seed>:<len>` | Same, with `DRAFT_CONTEXT`, editing in place | `message.text`, `<len>` chars after `📝 Template:` |
| `help` | Send `HELP` | — |
| `brief` | Toast the `/draft` usage line | — |

`<seed>` is an integer, bounded on parse. A hostile or stale value must not become an
unbounded loop: reject anything not matching `/^\d{1,6}$/` and fall back to `1`.

**Verbs are enumerated, never defaulted.** Dispatching on the namespace alone and treating
every unrecognised verb as the common case means a button from an older deploy silently does
work instead of answering, and a future verb rename aliases itself onto an existing branch
rather than failing where someone would see it. Unknown data gets an `answerCallbackQuery` and
nothing else.

### 3.1 Why `d:m:` carries a length — a bug the tests caught

The first implementation found the end of the template by searching for the samples marker.
A template is free to **contain that marker itself**, so the search truncated and returned a
fragment. The re-validation guard did not save it: `{Hi|Hello}` cut out of a longer template
is perfectly valid spintax, so the guard passed and the bot rendered part of the template as
though it were the whole one — exactly the silently-wrong reroll §5 forbids.

Neither "first occurrence" nor "last occurrence" is sound; the failure is structural, because
an unescaped text channel can be forged by its own payload. **The length comes from the
sender**, which the message content cannot influence. `templateOf` then checks that the marker
lands exactly where the length says, and a mismatch degrades to the toast.

The general lesson, worth keeping: a delimiter you search for is attacker-controlled when the
attacker writes the body. A length or an escape is not.

**Every** `callback_query` gets an `answerCallbackQuery`, including the ones that do nothing.
Verbatim from the docs: *"Telegram clients will display a progress bar until you call
answerCallbackQuery. It is, therefore, necessary to react by calling answerCallbackQuery even
if no notification to the user is needed."* Note **"until"** — the docs state no timeout, and
the widely repeated "callback queries expire after 10 seconds" is third-party lore with no
official source. Unanswered means spinning, not spinning-then-recovering. This is the single
most common inline-keyboard bug and it is invisible in tests unless asserted.

## 4. What changes in the code

Still one file, still no dependencies. `examples/telegram-bot/src/index.ts`:

1. `sendMessage` gains optional `replyTo` and `keyboard` params; new `editMessageText`,
   `editMessageReplyMarkup` and `answerCallbackQuery` alongside it. Four `fetch` calls to the
   same Bot API shape. No `deleteMessage` — see §1.5.
2. The `fetch` handler learns a second update kind. Today it reads `update.message` and acks
   everything else (`:325-330`); it gains an `update.callback_query` branch **before** that.
3. `handleTemplate(src)` becomes `handleTemplate(src, startSeed)` and returns
   `{ text, nextSeed }` — the button needs to know where the walk stopped. Same for the draft
   render loop.
4. The webhook registration must allow the new update type:
   `"allowed_updates":["message","callback_query"]`. The README currently registers
   `["message"]` only (`README.md:36`) — **without this the buttons are dead** and nothing in
   the code will tell you. Update the README in the same change.

## 5. Tests

The existing suite mocks `fetch` and inspects the sent payloads, so this extends naturally.
Beyond the obvious render assertions:

- Every button's `callback_data` round-trips to a handler — no dead buttons.
- A `callback_query` **always** produces an `answerCallbackQuery`, on every branch.
- **At most one live keyboard per chain**: `🎲 Ещё 5` both sends the new batch *and* strips the
  previous message's markup, in that order. Assert the strip call, not just the send — this is
  the whole point of the change and it is otherwise invisible.
- **No `deleteMessage` call is ever issued.** A blunt assertion over the mocked `fetch` URLs,
  because the 48h failure it guards against (§1.5) cannot be reproduced in a test.
- A second `🎲 Ещё 5` press replies to the **original** user message, not to batch 1 — the
  depth-2 trap from §1.2.
- The three-way `callback_query.message` branch: readable / `date === 0` / absent. The latter
  two produce the "send it again" toast, not a crash and not a render of `''`.
- The `📝 Template:` extraction survives a template containing the samples marker itself (§3.1),
  and a length that does not line up degrades to the toast rather than to a fragment.
- `d:m:` on an invalid draft is unreachable (no keyboard was attached).

- **A failed `sendMessage` does not strip the previous keyboard** — asserted for both an HTTP
  error and an `ok:false` under a 200. A failed *strip* is soft, and a rejected
  `answerCallbackQuery` still leaves the render done.
- An unknown verb inside a known namespace is answered and nothing else.

All of the above are implemented in `test/bot.test.ts` (55 tests). The transport assertions
check *which Bot API method fired and in what order* — `methods()` / `callTo()` over the mocked
`fetch` — because none of the §1.5 reasoning is observable in the reply text.

## 6. Non-goals

- No ReplyKeyboard. It would occupy the input area permanently in a bot whose entire input is
  free text, and task_center's contract bans `remove_keyboard` for IME reasons — so once
  shown it is hard to take back.
- No pagination row. task_center's `[prev | n/total | next]` standard exists for finite
  ordered lists; a seed walk has no total and no meaningful "back".
- No Durable Object, no grammY. See §0. If §1.1's check fails, revisit this — a store becomes
  a real option rather than an indulgence, and that is a decision to take deliberately, not to
  slide into.
- No message deletion, including a `/clear`-style sweep. See §1.5.
- No per-user locale switching. `LOCALE` is a single value threaded through the prompt,
  `validate()` and `render()` (`index.ts:34`), and making it per-chat *is* per-chat state —
  it belongs to the full-Nav option, if that is ever wanted.

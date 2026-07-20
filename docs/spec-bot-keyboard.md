# Spec — inline keyboard for `examples/telegram-bot`

Status: **proposed**, not implemented. Scope decided 2026-07-20.

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
edit-in-place), not its *machinery*.

## 1. The state problem, and why there is no store

Every button needs to answer "more variations **of what?**". `callback_data` caps at 64 bytes
and cannot carry a template. The usual answer is a session store. This bot does not need one,
because Telegram already carries the state.

**The bot replies with `reply_to_message_id` set to the user's message.** A `callback_query`
then arrives carrying `callback_query.message.reply_to_message.text` — the original template,
verbatim, from Telegram's own storage. The state lives in the chat, where the user can also
see it.

`callback_data` therefore carries only what the message cannot: which action, and the seed
window.

Two limits, both handled rather than ignored:

- **`reply_to_message` can be absent** — the user deleted their message, or the chat was
  cleared. Detected, never assumed: `answerCallbackQuery` with `"Send the template again"`
  and stop. No crash, no silent wrong render.
- **One level only.** Telegram does not nest `reply_to_message`. We never need a second level;
  do not design a flow that would.

For `/draft`, the template is not the user's message — it is inside the bot's *own* reply
(`📝 Template:\n…`). Same trick, different source: parse it back out of
`callback_query.message.text`. This makes the `📝 Template:` prefix and the blank line after
the template **load-bearing format, not decoration** — pin them in a test, or a cosmetic edit
to the reply silently breaks the buttons.

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
  message** (the user keeps the earlier batch — they are comparing copy, that is the point).
- **🔁 Заново** — `v:1`. Restarts the walk. **Edits in place.**
- **📋 Синтаксис** — `help`. Sends the existing `HELP` text. No new content to write.

### 2.2 Draft (`draftTemplate`)

```
📝 Template:
…

✨ Sample variations:
…

[🎲 Ещё варианты]  [✏️ Новый бриф]
```

- **🎲 Ещё варианты** — `dv:<next>`, re-renders the template from the bot's own message with
  `DRAFT_CONTEXT`.
- **✏️ Новый бриф** — `answerCallbackQuery` showing the `/draft` usage line. Not a state
  transition; the bot stays stateless and the user just types.

A draft that came back **invalid** gets no buttons: there is nothing to render, and offering
a reroll on `｛garbage｝` would misrepresent it as usable.

## 3. `callback_data`

task_center's convention — `namespace:verb[:args]`, colon-delimited, matched by regex
(`nt:cancel`, `ntPick:<id>`, `task:<id>:<verb>`).

| Data | Meaning | Source of template |
|---|---|---|
| `v:<seed>` | Render `VARIANTS` variations from `<seed>` | `message.reply_to_message.text` |
| `dv:<seed>` | Same, with `DRAFT_CONTEXT` | `message.text`, after `📝 Template:` |
| `help` | Send `HELP` | — |
| `brief` | Toast the `/draft` usage line | — |

`<seed>` is an integer, bounded on parse. A hostile or stale value must not become an
unbounded loop: reject anything not matching `/^\d{1,6}$/` and fall back to `1`.

**Every** `callback_query` gets an `answerCallbackQuery`, including the ones that do nothing —
otherwise the client spins its loading indicator for ~30s. This is the single most common
inline-keyboard bug and it is invisible in tests unless asserted.

## 4. What changes in the code

Still one file, still no dependencies. `examples/telegram-bot/src/index.ts`:

1. `sendMessage` gains optional `replyTo` and `keyboard` params; a new `editMessageText` and
   `answerCallbackQuery` alongside it. Three `fetch` calls to the same Bot API shape.
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
- Missing `reply_to_message` → the "send it again" toast, not a crash and not a render of `''`.
- The `📝 Template:` extraction survives a template containing that literal string itself.
- `dv:` on an invalid draft is unreachable (no keyboard was attached).

## 6. Non-goals

- No ReplyKeyboard. It would occupy the input area permanently in a bot whose entire input is
  free text, and task_center's contract bans `remove_keyboard` for IME reasons — so once
  shown it is hard to take back.
- No pagination row. task_center's `[prev | n/total | next]` standard exists for finite
  ordered lists; a seed walk has no total and no meaningful "back".
- No Durable Object, no grammY. See §0.
- No per-user locale switching. `LOCALE` is a single value threaded through the prompt,
  `validate()` and `render()` (`index.ts:34`), and making it per-chat *is* per-chat state —
  it belongs to the full-Nav option, if that is ever wanted.

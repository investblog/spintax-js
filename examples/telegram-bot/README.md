# @spintax/example-telegram-bot

Reference **Telegram bot** for [`@spintax/core`](../../packages/core) — a second, interactive
dogfood of the public API (spec §8, M5). Paste a spintax template; the bot validates it and
replies with a few random variations.

A stateless Cloudflare Worker webhook. It imports `@spintax/core` and the shared authoring prompt
`@spintax/authoring-prompt`, and contributes back to neither — the §8 purity boundary is about
DIRECTION, not import count. The prompt lives in its own package precisely so this bot cannot grow
a private dialect of it.

**Stateless is a feature, not an omission.** There is no KV, no Durable Object and no session: the
inline buttons keep their state in the chat itself (see `docs/spec-bot-keyboard.md`).

## What it does

- `/start`, `/help` — usage + syntax cheatsheet.
- `/draft <brief>` — an LLM writes a spintax template from a plain-language brief, via Workers AI.
  Invalid drafts get one automatic repair round-trip built from the engine's diagnostics.
- Any message → treated as a spintax template:
  - invalid → the validation errors (message + line), plus a hint for the two verdicts authors
    actually trip over: a wrong-arity plural, and a `{plural …}` counter defined with `#set`;
  - valid → up to 5 distinct rendered variations, plus a note listing `%variables%` that would be
    filled at runtime (its own `#set`/`#def` names excluded — those are not the host's to supply).
- Inline buttons under both replies — reroll, ask for more, open the cheat-sheet. A new batch
  retires the previous keyboard by editing its markup away; no message is ever deleted.

## Deploy

```sh
cd examples/telegram-bot
npm install

# 1) deploy the Worker
npx wrangler deploy

# 2) set the bot token (from @BotFather) as a secret
printf '%s' "$TELEGRAM_BOT_TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN

# 3) (recommended) a webhook secret so only Telegram can call the Worker
printf '%s' "$SECRET" | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET

# 4) point Telegram's webhook at the deployed Worker
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"https://spintax-bot.<subdomain>.workers.dev\",\"secret_token\":\"$SECRET\",\"allowed_updates\":[\"message\",\"callback_query\"]}"
```

For local development, copy `.dev.vars.example` → `.dev.vars` (gitignored) and run `wrangler dev`.

`/draft` additionally needs the Workers AI binding (`[ai]` in `wrangler.toml`). Without it the
command degrades to an explanatory reply rather than an error — everything else keeps working.

**`allowed_updates` must include `callback_query`** (step 4 above). Register `["message"]` alone
and every inline button is dead, with nothing in the logs to say why.

## Roadmap

WordPress-ready export. The browser playground (M6) is tracked in the root spec, not here.

# @spintax/example-telegram-bot

Reference **Telegram bot** for [`@spintax/core`](../../packages/core) — a second, interactive
dogfood of the public API (spec §8, M5). Paste a spintax template; the bot validates it and
replies with a few random variations.

A stateless Cloudflare Worker webhook that imports `@spintax/core` **only** (the §8 purity
boundary) — nothing bot-side leaks back into the engine.

## What it does

- `/start`, `/help` — usage + syntax cheatsheet.
- Any message → treated as a spintax template:
  - invalid → the validation errors (message + line);
  - valid → up to 5 distinct rendered variations, plus a note listing `%variables%` that would be
    filled at runtime.

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
  -d "{\"url\":\"https://spintax-bot.<subdomain>.workers.dev\",\"secret_token\":\"$SECRET\",\"allowed_updates\":[\"message\"]}"
```

For local development, copy `.dev.vars.example` → `.dev.vars` (gitignored) and run `wrangler dev`.

## Roadmap

v1 (this) is deterministic — validate + preview, no external services. Next: an
**LLM draft-from-brief** command (describe the copy in plain language → the model writes a spintax
template → the engine renders variations), and WordPress-ready export.

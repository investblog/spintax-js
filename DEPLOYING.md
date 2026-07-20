# Deploying the reference consumers

`RELEASING.md` covers publishing `@spintax/core` to npm. This file covers the two Cloudflare
Workers in `examples/` — the HTTP API and the Telegram bot. They are **reference consumers**, not
products: they exist to prove the §9.2 API surface is usable. But both are live and public, so
deploying them is a production change.

## The deployment map

| What | Worker | URL | Secrets it needs |
|---|---|---|---|
| HTTP API (`examples/worker`) | `spintax-worker` | `spintax-worker.spintax-site.workers.dev` | — |
| Telegram bot (`examples/telegram-bot`) | `spintax-bot` | `spintax-bot.spintax-site.workers.dev` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` |

Both live on the Cloudflare account **`Admin@spintax.site`**, whose id is pinned as `account_id`
in each `wrangler.toml`. The bot additionally needs the Workers AI binding (`[ai]`, already in
`wrangler.toml`) for `/draft`; without it that one command degrades to an explanatory reply and
everything else keeps working.

### The account trap — read this before your first deploy

**`wrangler` being logged in is not the same as being logged into the right account.** On
2026-07-20 a session was authenticated as `investblog.io@gmail.com` while both Workers live on
`Admin@spintax.site`. `wrangler deploy` would not have failed. It would have created a *second*
`spintax-bot` on the wrong account — no secrets, no webhook pointing at it, therefore dead —
while the live bot carried on serving the old code. The command reports success either way.

Two guards, both cheap:

- `account_id` is pinned in both `wrangler.toml` files, so wrangler refuses an account the
  credentials cannot reach.
- `npm run deploy` runs `predeploy` → `scripts/check-cf-account.mjs`, which compares
  `wrangler whoami` against that pin and says which account you are on and which you need.

Check before deploying, not after: `npx wrangler whoami`.

### Authenticate per project — do NOT `wrangler login`

`wrangler login` is **global**: it replaces the OAuth token in `~/.wrangler/config/default.toml`
for every project on the machine. This machine's default login (`investblog.io@gmail.com`) does
not own these Workers and is used by other projects, so switching it would fix this repo by
breaking those.

Use a scoped API token instead, which the Cloudflare docs call the recommended per-project
approach. Create the token in the **`Admin@spintax.site`** account (My Profile → API Tokens →
*Edit Cloudflare Workers* template, scoped to that account), then in `examples/telegram-bot/`:

```sh
# .env — gitignored (.gitignore covers .env and .env.*); see .env.example
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=2a8133f810cef6eff8f7bba2cfd2a09c
```

Then confirm it actually took effect before trusting it:

```sh
npx wrangler whoami   # must show 2a8133f810cef6eff8f7bba2cfd2a09c
```

That check is not ceremony. The docs describe `CLOUDFLARE_API_TOKEN` as the mechanism for CI/CD
and automation, but they do **not** explicitly state that it overrides an existing OAuth login —
so verify the precedence on this machine rather than assuming it. `predeploy` performs the same
check, so a wrong-account deploy is refused either way.

## Deploying the bot

```sh
cd examples/telegram-bot
npm run deploy            # predeploy verifies the account first
```

Secrets are set once per Worker and are **not readable back** — that is the point of a secret, and
it means neither this file nor an agent session can recover the bot token. Setting them again is
harmless if you have the values:

```sh
printf '%s' "$TELEGRAM_BOT_TOKEN" | npx wrangler secret put TELEGRAM_BOT_TOKEN
printf '%s' "$SECRET"             | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret list          # names only — confirms what is set without exposing values
```

### The webhook, and the flag that silently kills every button

Telegram only delivers the update types the webhook is registered for. The inline keyboard needs
`callback_query`, and a webhook registered for `["message"]` alone leaves **every button dead with
nothing in the logs to explain it** — the update simply never arrives.

```sh
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d "{\"url\":\"https://spintax-bot.spintax-site.workers.dev\",\"secret_token\":\"$SECRET\",\"allowed_updates\":[\"message\",\"callback_query\"]}"

# verify what Telegram actually recorded
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

`getWebhookInfo` echoes `allowed_updates` and any `last_error_message`. Check it — it is the only
place a rejected webhook or a wrong URL shows up.

## Live verification after a bot deploy

The suite mocks the Bot API, so a green suite says nothing about Telegram's real payloads. One
thing genuinely cannot be verified any other way:

**`docs/spec-bot-keyboard.md` §1.1** — the inline keyboard keeps its state in the chat, reading the
template from `callback_query.message.reply_to_message.text`. The Bot API does **not** document
that this field is populated; it is inference from the type. The bot degrades to a "send the
template again" toast if it is missing, so the failure is safe but silent.

So, once, after the first deploy carrying the keyboard:

```sh
npx wrangler tail --format pretty
```

Send a template, press **🎲 Ещё**. Expected: a second batch arrives and the first message loses its
buttons. If instead you get the "send the template again" toast, `reply_to_message` is not being
delivered and §1.1's fallbacks apply — the `v:` flow needs a different state channel. `/draft`
does not depend on it; it reads its own message.

Also worth one look: pressing a button must never leave the client's progress spinner running.
That means an `answerCallbackQuery` was missed.

## Rollback

```sh
npx wrangler deployments list          # find the previous version id
npx wrangler rollback [version-id]
```

A rollback restores code only. Secrets and the webhook registration are separate state and are
unaffected — which also means a rollback will **not** undo an `allowed_updates` change.

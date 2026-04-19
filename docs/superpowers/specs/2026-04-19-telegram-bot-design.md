# Telegram bot — design

**Date:** 2026-04-19
**Status:** Approved, ready for implementation plan
**Bot username:** `@chainlinkmemebot`

## Goal

Summon any Chainlink meme in Telegram — mirroring the existing Discord bot,
plus inline mode which is the native Telegram way to send media.

Two user-facing entry points:

1. **Inline** — `@chainlinkmemebot sergey` in any chat (DM, group, channel
   comment). A picker pops up; tapping a thumbnail sends the meme.
2. **Command** — `/clmeme sergey` in DMs or in any group the bot has been
   added to. Same behavior as Discord's `/clmeme`.

## Architecture

```
Telegram ─► POST /telegram/webhook  (Cloudflare Worker)
              │ X-Telegram-Bot-Api-Secret-Token header
              ▼
          telegram.ts  ─► picker.ts  ─► manifest.json  (jsDelivr-cached)
              │
              ▼
          Webhook-reply JSON (sendPhoto / sendAnimation / answerInlineQuery)
```

- Same Worker (`chainlinkmeme-api`) that already serves `/discord/interactions`
  and `/api/*`. New endpoint: `POST /telegram/webhook`.
- No new services, no gateway, no polling. Telegram POSTs each update;
  the Worker replies with the bot action as the HTTP response body
  ([webhook reply](https://core.telegram.org/bots/api#making-requests-when-getting-updates))
  so there's no second round-trip to `api.telegram.org`.
- Reuses the existing manifest + scoring code from `discord.ts` by
  extracting shared helpers into `worker/src/picker.ts`.
- No D1 schema changes, no per-user state.

## Secrets

Added as wrangler secrets (not `[vars]`):

- `TELEGRAM_BOT_TOKEN` — the bot API token from BotFather.
- `TELEGRAM_WEBHOOK_SECRET` — random string chosen at webhook registration;
  Telegram echoes it in the `X-Telegram-Bot-Api-Secret-Token` header on
  every POST. The Worker rejects mismatches (timing-safe compare).

## Entry points — update handling

Telegram POSTs an [Update](https://core.telegram.org/bots/api#update)
object. The Worker branches on four cases:

### 1. `inline_query` (`@chainlinkmemebot <q>`)

- Score the manifest against `<q>`, take top 20.
- Empty `<q>` → 20 random memes.
- Build results:
  - Animated → `InlineQueryResultGif` (`gif_url`, `thumbnail_url` = CDN URL).
  - Static   → `InlineQueryResultPhoto` (`photo_url`, `thumbnail_url` = CDN URL).
  - Each result's `caption` = `displayTitle(meme)` + `\n` + permalink.
- Respond via `answerInlineQuery` with `cache_time: 60`.

### 2. `message` with `/clmeme <q>`

- Strip a `@chainlinkmemebot` suffix from the command token (Telegram adds it
  in group chats to disambiguate between bots).
- `pickMeme(manifest, q)` — identical logic to Discord.
- If match:
  - Animated → `sendAnimation` with `animation` = CDN URL.
  - Static   → `sendPhoto` with `photo` = CDN URL.
  - `caption` = title + tag hashes + permalink; `reply_to_message_id` = the
    user's message id; `chat_id` = incoming chat id.
- If no match: `sendMessage` — `"no match for **X** — try \`sergey\`, \`moon\`, \`wagmi\`…"`

### 3. `message` with `/start` or `/help`

Short intro text:

> Type `/clmeme <tag>` to pull a meme here, or `@chainlinkmemebot <tag>` in
> any chat. Full archive: https://chainlinkme.me

### 4. Everything else

Channel posts, edits, non-command messages, unknown types — return 200 empty.

## Files

### New

- **`worker/src/telegram.ts`** (~150 lines)
  - `handleTelegramUpdate(request, env)` — verify secret header, parse update,
    dispatch.
  - `handleInlineQuery`, `handleCommandMessage`, `handleStart`.
  - `tgError(chat_id, text)` — `sendMessage` helper for user-visible errors.
- **`worker/src/picker.ts`**
  - Lifted from `discord.ts`: `loadManifest`, `pickMeme`, `scoreMeme`,
    `expandTokens`, `displayTitle`, `memeCdnUrl`, `Manifest`,
    `ManifestMeme`, `HASH_RE`.
  - New: `pickMemes(manifest, query, n)` — top-N for inline results.
- **`scripts/register-telegram-webhook.ts`**
  - Calls `setWebhook` with `url=<worker>/telegram/webhook` and the secret.
  - Calls `setMyCommands` for `clmeme` + `help`.
  - Prints reminder: "Inline mode must be enabled via @BotFather (`/setinline`)
    — there is no API for it."

### Changed

- **`worker/src/discord.ts`** — imports picker helpers from `picker.ts`;
  behavior unchanged.
- **`worker/src/index.ts`** — new route dispatch to `handleTelegramUpdate`;
  `Env` gains `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET`.
- **`package.json` (root)** — new script `telegram:register`.
- **`README.md`** — new "Telegram bot" section mirroring "Discord bot":
  install link `https://t.me/chainlinkmemebot`, inline/command usage, no
  permissions needed.

### Not changed

D1 schema, site, any build step, Discord behavior.

## Error handling

| Situation | Response |
|---|---|
| Missing/mismatched `X-Telegram-Bot-Api-Secret-Token` | 401, no body |
| Malformed JSON body | 200 empty (do not let Telegram retry-storm us) |
| Manifest fetch fails (command path) | `sendMessage` "archive unreachable — try again in a minute" |
| Manifest fetch fails (inline path) | Empty results (nothing useful to show) |
| No matching meme (command) | `sendMessage` "no match for **X** …" (matches Discord copy) |
| Caption > 1024 chars | Slice defensively (in practice ours are ~100) |

## Edge cases

- **Group-chat command suffix** — `/clmeme@chainlinkmemebot sergey` must
  strip the suffix before parsing the query.
- **Empty inline query** — return 20 random memes, not an error.
- **Channel posts** — no user to reply to; ignore.
- **Inline query > 256 chars** — Telegram truncates; no handling needed.
- **Animated memes** — use `sendAnimation`, not `sendPhoto`; jsDelivr's
  direct GIF URL works as-is.

## Testing

- **Local**: `pnpm --filter worker dev`, then curl the webhook with fixture
  updates — inline query, `/clmeme sergey`, `/clmeme` empty, `/start`, junk.
  Fixtures inline in a `worker/test/telegram.fixtures.ts` or doc comments.
- **Staging**: deploy, point `setWebhook` at the `*.workers.dev` preview URL,
  test with the real bot in a throwaway chat.
- **Acceptance**:
  - Inline `@chainlinkmemebot sergey` → gallery of sergey memes; tapping sends.
  - Inline `@chainlinkmemebot ` (empty) → 20 random memes.
  - DM `/clmeme sergey` → photo/GIF with caption + permalink.
  - DM `/clmeme zzznomatch` → no-match message.
  - DM `/start` → intro text.

## Deploy

1. `pnpm wrangler secret put TELEGRAM_BOT_TOKEN` (paste the token).
2. Generate a random string; `pnpm wrangler secret put TELEGRAM_WEBHOOK_SECRET`.
3. Push branch to `main` → existing `deploy.yml` ships the Worker.
4. `pnpm telegram:register` once — registers the webhook URL + secret and
   sets the command list.
5. In @BotFather: `/setinline` on `@chainlinkmemebot`, enable inline mode,
   set placeholder text (e.g., "search memes: sergey, moon, wagmi").

## Out of scope for v1

- `chosen_inline_result` tracking (analytics on which meme got picked).
- Per-chat rate limiting. Telegram has its own abuse protection; revisit if
  spam becomes a problem.
- Reaction bumps when a meme is sent from Telegram. Discord doesn't do this
  either; keeping parity.

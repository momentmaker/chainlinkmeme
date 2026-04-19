# Telegram Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@chainlinkmemebot` — a Telegram bot mirroring the existing Discord bot, with inline mode (`@chainlinkmemebot sergey` in any chat) and a `/clmeme <tag>` command.

**Architecture:** Add a `POST /telegram/webhook` route to the existing `chainlinkmeme-api` Cloudflare Worker. Authenticate each webhook with Telegram's `X-Telegram-Bot-Api-Secret-Token` header. Reply with the bot action as the HTTP response body (Telegram's [webhook reply](https://core.telegram.org/bots/api#making-requests-when-getting-updates) optimization — skips a round-trip to `api.telegram.org`). Share picker/scoring code with the Discord handler via a new `worker/src/picker.ts` module.

**Tech Stack:** TypeScript, Cloudflare Workers, wrangler, Telegram Bot API, `tsx` for the register script.

**Spec:** `docs/superpowers/specs/2026-04-19-telegram-bot-design.md`

---

## File Map

Files created:
- `worker/src/picker.ts` — shared manifest + scoring helpers (extracted from `discord.ts`).
- `worker/src/telegram.ts` — Telegram webhook handler.
- `worker/test/telegram.fixtures.json` — sample Telegram `Update` payloads for curl-based smoke tests.
- `scripts/register-telegram-webhook.ts` — one-shot webhook registration + `setMyCommands`.

Files modified:
- `worker/src/discord.ts` — imports helpers from `picker.ts`; no behavior change.
- `worker/src/index.ts` — new route, new `Env` fields.
- `package.json` (root) — new `telegram:register` script.
- `README.md` — new "Telegram bot" section.

No DB / schema / site / build-step changes.

---

## Task 1: Extract shared picker helpers from `discord.ts` into `picker.ts`

This is a pure refactor. Behavior must not change. We run the Discord handler through `wrangler dev` after the refactor and verify `/discord/interactions` still type-checks and boots.

**Files:**
- Create: `worker/src/picker.ts`
- Modify: `worker/src/discord.ts` (replace helpers with imports)

- [ ] **Step 1: Create `worker/src/picker.ts`**

```ts
// Shared manifest loader + meme-picker logic used by the Discord and
// Telegram bot handlers. Kept behavior-identical to the inline helpers
// that used to live in discord.ts.

export interface ManifestMeme {
  slug: string;
  filename: string;
  title: string;
  tags: string[];
  animated: boolean;
}

export interface Manifest {
  memes: ManifestMeme[];
  synonyms: Record<string, string[]>;
  related: Record<string, string[]>;
}

const HASH_RE = /^[0-9a-f]{10,}$/i;

const MANIFEST_TTL_MS = 5 * 60 * 1000;
let cachedManifest: Manifest | null = null;
let cachedAt = 0;

export async function loadManifest(origin: string): Promise<Manifest> {
  const now = Date.now();
  if (cachedManifest && now - cachedAt < MANIFEST_TTL_MS) return cachedManifest;
  const res = await fetch(`${origin}/manifest.json`, { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
  cachedManifest = (await res.json()) as Manifest;
  cachedAt = now;
  return cachedManifest;
}

export function displayTitle(m: ManifestMeme): string {
  if (m.title && !HASH_RE.test(m.title)) return m.title;
  return m.tags[0] ? `#${m.tags[0]}` : m.slug;
}

export function memeCdnUrl(filename: string): string {
  return `https://cdn.jsdelivr.net/gh/momentmaker/chainlinkmeme@main/memes/${filename}`;
}

export function scoreMeme(m: ManifestMeme, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  let score = 0;
  const tagSet = new Set(m.tags);
  const titleLower = (m.title ?? '').toLowerCase();
  for (const needle of tokens) {
    if (tagSet.has(needle)) { score += 10; continue; }
    let tagHit = false;
    for (const t of m.tags) {
      if (t.includes(needle)) { score += 6; tagHit = true; break; }
    }
    if (tagHit) continue;
    if (titleLower.includes(needle)) { score += 3; }
  }
  return score;
}

export function expandTokens(
  raw: string[],
  synonyms: Record<string, string[]>,
  related: Record<string, string[]>,
): string[] {
  const expanded = new Set<string>();
  for (const t of raw) {
    const norm = t.trim().toLowerCase();
    if (!norm) continue;
    const canonical = synonyms[norm];
    if (canonical) for (const c of canonical) expanded.add(c);
    else expanded.add(norm);
  }
  const withRelated = new Set(expanded);
  for (const t of expanded) {
    const rel = related[t];
    if (rel) for (const r of rel) withRelated.add(r);
  }
  return [...withRelated];
}

export function pickMeme(manifest: Manifest, query: string): ManifestMeme | null {
  const memes = manifest.memes;
  if (memes.length === 0) return null;
  const q = query.trim().toLowerCase();
  if (!q) return memes[Math.floor(Math.random() * memes.length)] ?? null;
  const tokens = expandTokens(q.split(/[\s,]+/), manifest.synonyms ?? {}, manifest.related ?? {});
  if (tokens.length === 0) return memes[Math.floor(Math.random() * memes.length)] ?? null;
  const scored = memes
    .map((m) => ({ m, s: scoreMeme(m, tokens) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s);
  if (scored.length === 0) return null;
  const topScore = scored[0].s;
  const ties = scored.filter(({ s }) => s === topScore);
  return ties[Math.floor(Math.random() * ties.length)].m;
}

// Return up to `n` memes for the given query, ordered by score desc with
// random tie-breaking. Empty query => `n` random memes. Used by Telegram
// inline mode to populate a gallery of results.
export function pickMemes(manifest: Manifest, query: string, n: number): ManifestMeme[] {
  const memes = manifest.memes;
  if (memes.length === 0 || n <= 0) return [];
  const q = query.trim().toLowerCase();
  if (!q) {
    const shuffled = [...memes].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
  }
  const tokens = expandTokens(q.split(/[\s,]+/), manifest.synonyms ?? {}, manifest.related ?? {});
  if (tokens.length === 0) {
    const shuffled = [...memes].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
  }
  const scored = memes
    .map((m) => ({ m, s: scoreMeme(m, tokens), r: Math.random() }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => (b.s - a.s) || (a.r - b.r));
  return scored.slice(0, n).map(({ m }) => m);
}
```

- [ ] **Step 2: Rewrite `worker/src/discord.ts` to import from `picker.ts`**

Full new file contents:

```ts
// Discord slash-command handler. Runs inside the Worker, verifies the
// Ed25519 signature Discord sends on every interaction POST, and returns a
// random meme matching the user's query as an embed with the image
// inlined and the permalink as the click-through.

import {
  type ManifestMeme,
  type Manifest,
  displayTitle,
  loadManifest,
  memeCdnUrl,
  pickMeme,
} from './picker';

interface DiscordEnv {
  DISCORD_PUBLIC_KEY: string;
  SITE_ORIGIN: string;
}

interface Interaction {
  type: number;
  data?: {
    name?: string;
    options?: Array<{ name: string; value: string }>;
  };
}

const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;
const RESPONSE_PONG = 1;
const RESPONSE_CHANNEL_MESSAGE = 4;

// Explicit ArrayBuffer (not ArrayBufferLike) so the result is assignable to
// BufferSource. TS 5.7+ made Uint8Array generic over its backing buffer and
// defaults to ArrayBufferLike (ArrayBuffer | SharedArrayBuffer), which
// crypto.subtle.importKey/verify reject. Constructing over a fresh
// ArrayBuffer pins the generic parameter.
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function verifySignature(publicKeyHex: string, signatureHex: string, timestamp: string, body: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const sig = hexToBytes(signatureHex);
    const encoded = new TextEncoder().encode(timestamp + body);
    const msg = new Uint8Array(new ArrayBuffer(encoded.byteLength));
    msg.set(encoded);
    return await crypto.subtle.verify('Ed25519', key, sig, msg);
  } catch {
    return false;
  }
}

function errorEmbed(message: string): unknown {
  return {
    type: RESPONSE_CHANNEL_MESSAGE,
    data: {
      content: message,
      flags: 64, // EPHEMERAL — only the caller sees the error
    },
  };
}

export async function handleDiscordInteraction(request: Request, env: DiscordEnv): Promise<Response> {
  const sig = request.headers.get('x-signature-ed25519');
  const ts = request.headers.get('x-signature-timestamp');
  if (!sig || !ts) return new Response('missing signature', { status: 401 });

  const body = await request.text();
  const valid = await verifySignature(env.DISCORD_PUBLIC_KEY, sig, ts, body);
  if (!valid) return new Response('invalid signature', { status: 401 });

  const interaction = JSON.parse(body) as Interaction;

  if (interaction.type === INTERACTION_PING) {
    return Response.json({ type: RESPONSE_PONG });
  }

  if (interaction.type !== INTERACTION_APPLICATION_COMMAND || interaction.data?.name !== 'clmeme') {
    return Response.json(errorEmbed('unknown command'));
  }

  const queryOpt = interaction.data.options?.find((o) => o.name === 'query');
  const query = queryOpt?.value ?? '';

  let manifest: Manifest;
  try {
    manifest = await loadManifest(env.SITE_ORIGIN);
  } catch {
    return Response.json(errorEmbed('archive unreachable — try again in a minute'));
  }

  const meme: ManifestMeme | null = pickMeme(manifest, query);
  if (!meme) {
    return Response.json(errorEmbed(`no match for **${query}**. try \`sergey\`, \`moon\`, \`wagmi\`…`));
  }

  const permalink = `${env.SITE_ORIGIN}/m/${meme.slug}/`;
  return Response.json({
    type: RESPONSE_CHANNEL_MESSAGE,
    data: {
      embeds: [{
        title: displayTitle(meme),
        url: permalink,
        color: 0x2f62df,
        image: { url: memeCdnUrl(meme.filename) },
        footer: { text: meme.tags.slice(0, 6).map((t) => '#' + t).join(' ') || 'chainlinkme.me' },
      }],
    },
  });
}
```

- [ ] **Step 3: Verify the worker still type-checks + boots**

Run:
```bash
pnpm --filter worker exec wrangler deploy --dry-run --outdir /tmp/wrangler-dryrun
```

Expected: exits 0, prints a build summary including `src/picker.ts` and `src/discord.ts`. No TypeScript errors.

If the command fails because `wrangler deploy --dry-run` isn't available in the installed wrangler version, fall back to:
```bash
pnpm --filter worker exec wrangler dev --local --port 8787 &
sleep 3 ; curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8787/ ; kill %1
```
Expected: `404` (no root route). Confirms the worker booted with no TS errors.

- [ ] **Step 4: Commit the refactor**

```bash
git add worker/src/picker.ts worker/src/discord.ts
git commit -m "$(cat <<'EOF'
refactor: extract picker helpers into worker/src/picker.ts

Behavior-identical. Enables the upcoming Telegram bot to share manifest
loading and meme scoring with the Discord handler. Also adds pickMemes()
for top-N retrieval (used by Telegram inline mode).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add Telegram env vars + route stub

Wire the new endpoint into `index.ts` first, returning a 200 empty response. No logic yet — this lets Task 3 land with a focused diff and keeps the route registration isolated in history.

**Files:**
- Modify: `worker/src/index.ts` (add env fields + route dispatch)

- [ ] **Step 1: Add env fields + route dispatch to `worker/src/index.ts`**

Replace the `Env` interface (currently lines 3–11):

```ts
interface Env {
  DB: D1Database;
  LIKES_CACHE_TTL: string;
  LIKES_RATE_PER_MIN: string;
  DISCORD_APP_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  SITE_ORIGIN: string;
}
```

Add a new import at the top of the file (next to the Discord import):

```ts
import { handleDiscordInteraction } from './discord';
import { handleTelegramUpdate } from './telegram';
```

Add the new route immediately after the existing Discord route block (currently around lines 168–170):

```ts
// Telegram webhook endpoint — auth via the X-Telegram-Bot-Api-Secret-Token
// header, echoes a bot action as the HTTP response body.
if (path === '/telegram/webhook' && request.method === 'POST') {
  return handleTelegramUpdate(request, env);
}
```

- [ ] **Step 2: Create a placeholder `worker/src/telegram.ts` so the import resolves**

```ts
// Telegram webhook handler. Filled out in subsequent tasks.

interface TelegramEnv {
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  SITE_ORIGIN: string;
}

export async function handleTelegramUpdate(_request: Request, _env: TelegramEnv): Promise<Response> {
  return new Response(null, { status: 200 });
}
```

- [ ] **Step 3: Verify the worker boots with the new route**

Run:
```bash
pnpm --filter worker exec wrangler dev --local --port 8787 &
WRANGLER_PID=$!
sleep 3
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8787/telegram/webhook
kill $WRANGLER_PID
```

Expected output: `200`

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.ts worker/src/telegram.ts
git commit -m "$(cat <<'EOF'
feat(telegram): add /telegram/webhook route stub

Env gains TELEGRAM_BOT_TOKEN + TELEGRAM_WEBHOOK_SECRET. Handler is a
200-empty placeholder; real logic lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Secret-header verification + update dispatch skeleton

Implement the auth gate and the `Update` dispatcher. Not handling any specific update types yet — every authenticated request returns `200 null` (Telegram-speak for "ignore this update"). We cover `/start`, `/clmeme`, and `inline_query` in later tasks.

**Files:**
- Modify: `worker/src/telegram.ts`
- Create: `worker/test/telegram.fixtures.json`

- [ ] **Step 1: Create fixture payloads at `worker/test/telegram.fixtures.json`**

```json
{
  "inline_sergey": {
    "update_id": 1,
    "inline_query": {
      "id": "qid1",
      "from": { "id": 42, "is_bot": false, "first_name": "u" },
      "query": "sergey",
      "offset": ""
    }
  },
  "inline_empty": {
    "update_id": 2,
    "inline_query": {
      "id": "qid2",
      "from": { "id": 42, "is_bot": false, "first_name": "u" },
      "query": "",
      "offset": ""
    }
  },
  "command_clmeme_sergey": {
    "update_id": 3,
    "message": {
      "message_id": 100,
      "from": { "id": 42, "is_bot": false, "first_name": "u" },
      "chat": { "id": 777, "type": "private" },
      "date": 1712000000,
      "text": "/clmeme sergey",
      "entities": [{ "type": "bot_command", "offset": 0, "length": 8 }]
    }
  },
  "command_clmeme_group_suffix": {
    "update_id": 4,
    "message": {
      "message_id": 101,
      "from": { "id": 42, "is_bot": false, "first_name": "u" },
      "chat": { "id": -1001, "type": "supergroup" },
      "date": 1712000000,
      "text": "/clmeme@chainlinkmemebot sergey",
      "entities": [{ "type": "bot_command", "offset": 0, "length": 24 }]
    }
  },
  "command_clmeme_empty": {
    "update_id": 5,
    "message": {
      "message_id": 102,
      "from": { "id": 42, "is_bot": false, "first_name": "u" },
      "chat": { "id": 777, "type": "private" },
      "date": 1712000000,
      "text": "/clmeme",
      "entities": [{ "type": "bot_command", "offset": 0, "length": 7 }]
    }
  },
  "command_start": {
    "update_id": 6,
    "message": {
      "message_id": 103,
      "from": { "id": 42, "is_bot": false, "first_name": "u" },
      "chat": { "id": 777, "type": "private" },
      "date": 1712000000,
      "text": "/start",
      "entities": [{ "type": "bot_command", "offset": 0, "length": 6 }]
    }
  },
  "channel_post": {
    "update_id": 7,
    "channel_post": {
      "message_id": 1,
      "chat": { "id": -100, "type": "channel" },
      "date": 1712000000,
      "text": "hello"
    }
  },
  "command_clmeme_nomatch": {
    "update_id": 8,
    "message": {
      "message_id": 104,
      "from": { "id": 42, "is_bot": false, "first_name": "u" },
      "chat": { "id": 777, "type": "private" },
      "date": 1712000000,
      "text": "/clmeme zzznomatchxyz",
      "entities": [{ "type": "bot_command", "offset": 0, "length": 8 }]
    }
  }
}
```

- [ ] **Step 2: Replace `worker/src/telegram.ts` with the dispatcher skeleton**

```ts
// Telegram webhook handler. Verifies Telegram's secret-token header,
// parses the Update, and dispatches to handlers per update type.
// Responses are emitted as webhook-reply JSON (the HTTP response body
// carries the bot method + params), which avoids a second round-trip
// to api.telegram.org.

interface TelegramEnv {
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  SITE_ORIGIN: string;
}

interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
}

interface TgMessageEntity {
  type: string;
  offset: number;
  length: number;
}

interface TgMessage {
  message_id: number;
  chat: TgChat;
  text?: string;
  entities?: TgMessageEntity[];
}

interface TgInlineQuery {
  id: string;
  query: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  inline_query?: TgInlineQuery;
  channel_post?: unknown;
  edited_message?: unknown;
}

// Ignore an update without side effects. Telegram treats a 200 with an
// empty body (or `null`) as acknowledgement.
function ignore(): Response {
  return new Response(null, { status: 200 });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function handleTelegramUpdate(request: Request, env: TelegramEnv): Promise<Response> {
  const secret = request.headers.get('x-telegram-bot-api-secret-token');
  if (!secret || !timingSafeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response('unauthorized', { status: 401 });
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    // Malformed body from Telegram is unexpected; returning 200 prevents a
    // retry-storm if something upstream ever corrupts a body.
    return ignore();
  }

  if (update.inline_query) {
    // Filled in Task 5.
    return ignore();
  }

  if (update.message?.text && update.message.entities?.some((e) => e.type === 'bot_command' && e.offset === 0)) {
    // Filled in Task 4.
    return ignore();
  }

  return ignore();
}
```

- [ ] **Step 3: Smoke-test the secret-header gate + dispatcher**

Before running, set the dev secret via a `.dev.vars` file (this file is wrangler's local-secrets convention and must NOT be committed — add it to `.gitignore` if the repo doesn't already cover `worker/.dev.vars`).

```bash
cat > worker/.dev.vars <<'EOF'
TELEGRAM_BOT_TOKEN=dev-token
TELEGRAM_WEBHOOK_SECRET=dev-secret
EOF
```

Check `.gitignore` covers it:
```bash
grep -q '^worker/.dev.vars$\|^\.dev\.vars$\|^\*\*/.dev.vars$' .gitignore || echo 'worker/.dev.vars' >> .gitignore
```

Run:
```bash
pnpm --filter worker exec wrangler dev --local --port 8787 &
WRANGLER_PID=$!
sleep 3

# Missing secret → 401
echo -n 'missing-secret: '
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8787/telegram/webhook \
  -H 'Content-Type: application/json' \
  --data-binary "$(jq -c .inline_sergey worker/test/telegram.fixtures.json)"

# Wrong secret → 401
echo -n 'wrong-secret:   '
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8787/telegram/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: nope' \
  --data-binary "$(jq -c .inline_sergey worker/test/telegram.fixtures.json)"

# Correct secret → 200
echo -n 'correct-secret: '
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8787/telegram/webhook \
  -H 'Content-Type: application/json' \
  -H 'X-Telegram-Bot-Api-Secret-Token: dev-secret' \
  --data-binary "$(jq -c .inline_sergey worker/test/telegram.fixtures.json)"

kill $WRANGLER_PID
```

Expected output:
```
missing-secret: 401
wrong-secret:   401
correct-secret: 200
```

- [ ] **Step 4: Commit**

```bash
git add worker/src/telegram.ts worker/test/telegram.fixtures.json .gitignore
git commit -m "$(cat <<'EOF'
feat(telegram): secret-header auth + update dispatcher skeleton

Gates /telegram/webhook on X-Telegram-Bot-Api-Secret-Token with a
timing-safe compare. Dispatches to per-update-type handlers (stubs for
now). Fixtures added for curl-based smoke tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `/clmeme`, `/start`, `/help` command handlers

Webhook-reply with `sendPhoto` / `sendAnimation` / `sendMessage` method calls. In-chat reply to the user's command message.

**Files:**
- Modify: `worker/src/telegram.ts`

- [ ] **Step 1: Update `worker/src/telegram.ts` — add command handler + wiring**

Add imports at the top (after the file comment):

```ts
import {
  type Manifest,
  type ManifestMeme,
  displayTitle,
  loadManifest,
  memeCdnUrl,
  pickMeme,
} from './picker';
```

Add the helpers and handlers (place above `handleTelegramUpdate`):

```ts
const BOT_USERNAME_SUFFIX_RE = /@[A-Za-z0-9_]+$/;

// Parse a /command line into (command, remainder). Strips the optional
// @botusername suffix that Telegram appends in group chats.
function parseCommand(text: string): { command: string; rest: string } {
  const space = text.indexOf(' ');
  const head = space === -1 ? text : text.slice(0, space);
  const rest = space === -1 ? '' : text.slice(space + 1).trim();
  const command = head.replace(BOT_USERNAME_SUFFIX_RE, '');
  return { command, rest };
}

function captionFor(meme: ManifestMeme, permalink: string): string {
  const tags = meme.tags.slice(0, 6).map((t) => '#' + t).join(' ');
  const title = displayTitle(meme);
  const parts = [title, tags, permalink].filter(Boolean);
  const caption = parts.join('\n');
  return caption.length > 1024 ? caption.slice(0, 1021) + '...' : caption;
}

// Webhook-reply for sendPhoto / sendAnimation / sendMessage. Telegram
// accepts one method call as the HTTP response body when the `method`
// field is set — saves a round-trip to api.telegram.org.
function tgReply(method: string, params: Record<string, unknown>): Response {
  return Response.json({ method, ...params });
}

function handleStart(chatId: number, siteOrigin: string): Response {
  return tgReply('sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
    text:
      `Type <code>/clmeme &lt;tag&gt;</code> here to summon a meme, or ` +
      `<code>@chainlinkmemebot &lt;tag&gt;</code> in any chat for an inline picker.\n\n` +
      `Full archive: ${siteOrigin}`,
  });
}

async function handleClmeme(
  chatId: number,
  replyTo: number,
  query: string,
  env: TelegramEnv,
): Promise<Response> {
  let manifest: Manifest;
  try {
    manifest = await loadManifest(env.SITE_ORIGIN);
  } catch {
    return tgReply('sendMessage', {
      chat_id: chatId,
      reply_parameters: { message_id: replyTo },
      text: 'archive unreachable — try again in a minute',
    });
  }

  const meme = pickMeme(manifest, query);
  if (!meme) {
    return tgReply('sendMessage', {
      chat_id: chatId,
      reply_parameters: { message_id: replyTo },
      parse_mode: 'Markdown',
      text: `no match for **${query}**. try \`sergey\`, \`moon\`, \`wagmi\`…`,
    });
  }

  const permalink = `${env.SITE_ORIGIN}/m/${meme.slug}/`;
  const caption = captionFor(meme, permalink);
  const media = memeCdnUrl(meme.filename);

  if (meme.animated) {
    return tgReply('sendAnimation', {
      chat_id: chatId,
      reply_parameters: { message_id: replyTo },
      animation: media,
      caption,
    });
  }
  return tgReply('sendPhoto', {
    chat_id: chatId,
    reply_parameters: { message_id: replyTo },
    photo: media,
    caption,
  });
}
```

Replace the command-dispatch branch inside `handleTelegramUpdate` (the block currently labeled "Filled in Task 4"):

```ts
if (update.message?.text && update.message.entities?.some((e) => e.type === 'bot_command' && e.offset === 0)) {
  const msg = update.message;
  const { command, rest } = parseCommand(msg.text!);
  if (command === '/clmeme') {
    return handleClmeme(msg.chat.id, msg.message_id, rest, env);
  }
  if (command === '/start' || command === '/help') {
    return handleStart(msg.chat.id, env.SITE_ORIGIN);
  }
  return ignore();
}
```

- [ ] **Step 2: Smoke-test every command fixture**

```bash
pnpm --filter worker exec wrangler dev --local --port 8787 &
WRANGLER_PID=$!
sleep 3

post() {
  curl -s -X POST http://localhost:8787/telegram/webhook \
    -H 'Content-Type: application/json' \
    -H 'X-Telegram-Bot-Api-Secret-Token: dev-secret' \
    --data-binary "$(jq -c ".$1" worker/test/telegram.fixtures.json)"
  echo
}

echo '== /clmeme sergey =='
post command_clmeme_sergey

echo '== /clmeme@chainlinkmemebot sergey =='
post command_clmeme_group_suffix

echo '== /clmeme (empty) =='
post command_clmeme_empty

echo '== /clmeme zzznomatchxyz =='
post command_clmeme_nomatch

echo '== /start =='
post command_start

echo '== channel_post (should be empty) =='
post channel_post

kill $WRANGLER_PID
```

Expected behavior:
- `command_clmeme_sergey` → JSON with `"method":"sendPhoto"` (or `sendAnimation` if a sergey GIF gets picked); `chat_id: 777`; `reply_parameters.message_id: 100`; `caption` contains a permalink starting with `https://chainlinkme.me/m/`.
- `command_clmeme_group_suffix` → same shape, `chat_id: -1001`, `reply_parameters.message_id: 101`.
- `command_clmeme_empty` → `sendPhoto`/`sendAnimation` for a random meme.
- `command_clmeme_nomatch` → `sendMessage` with `text` starting with `"no match for"`.
- `command_start` → `sendMessage` with `text` including `/clmeme` usage hint.
- `channel_post` → empty body (`null` printed by curl).

- [ ] **Step 3: Commit**

```bash
git add worker/src/telegram.ts
git commit -m "$(cat <<'EOF'
feat(telegram): /clmeme, /start, /help command handlers

Webhook-replies with sendPhoto / sendAnimation / sendMessage so responses
don't require a second call to api.telegram.org. Uses reply_parameters
to thread responses under the user's command in groups. Strips the
@chainlinkmemebot suffix that Telegram adds to commands in groups.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Inline mode (`@chainlinkmemebot <query>`)

Responds to `inline_query` updates with `answerInlineQuery`. Animated memes → `InlineQueryResultGif`, static → `InlineQueryResultPhoto`. Gallery of up to 20 results. Empty query → 20 random memes.

**Files:**
- Modify: `worker/src/telegram.ts`

- [ ] **Step 1: Add inline handler + result builders to `worker/src/telegram.ts`**

Update the `pickMeme`-related import at the top of the file to also pull in `pickMemes`:

```ts
import {
  type Manifest,
  type ManifestMeme,
  displayTitle,
  loadManifest,
  memeCdnUrl,
  pickMeme,
  pickMemes,
} from './picker';
```

Add the inline handler (place next to `handleClmeme`):

```ts
const INLINE_RESULT_LIMIT = 20;
const INLINE_CACHE_SECONDS = 60;

interface InlineResult {
  type: 'photo' | 'gif';
  id: string;
  caption: string;
  title: string;
  thumbnail_url: string;
  photo_url?: string;
  gif_url?: string;
}

function buildInlineResult(meme: ManifestMeme, siteOrigin: string): InlineResult {
  const permalink = `${siteOrigin}/m/${meme.slug}/`;
  const caption = captionFor(meme, permalink);
  const title = displayTitle(meme);
  const url = memeCdnUrl(meme.filename);
  if (meme.animated) {
    return { type: 'gif', id: meme.slug, gif_url: url, thumbnail_url: url, title, caption };
  }
  return { type: 'photo', id: meme.slug, photo_url: url, thumbnail_url: url, title, caption };
}

async function handleInline(inlineQueryId: string, query: string, env: TelegramEnv): Promise<Response> {
  let manifest: Manifest;
  try {
    manifest = await loadManifest(env.SITE_ORIGIN);
  } catch {
    // No usable results; reply with an empty gallery rather than an error.
    return tgReply('answerInlineQuery', {
      inline_query_id: inlineQueryId,
      results: [],
      cache_time: 5,
      is_personal: true,
    });
  }

  const memes = pickMemes(manifest, query, INLINE_RESULT_LIMIT);
  const results = memes.map((m) => buildInlineResult(m, env.SITE_ORIGIN));
  return tgReply('answerInlineQuery', {
    inline_query_id: inlineQueryId,
    results,
    cache_time: INLINE_CACHE_SECONDS,
    is_personal: false,
  });
}
```

Replace the inline-query branch inside `handleTelegramUpdate`:

```ts
if (update.inline_query) {
  return handleInline(update.inline_query.id, update.inline_query.query, env);
}
```

- [ ] **Step 2: Smoke-test inline fixtures**

```bash
pnpm --filter worker exec wrangler dev --local --port 8787 &
WRANGLER_PID=$!
sleep 3

post() {
  curl -s -X POST http://localhost:8787/telegram/webhook \
    -H 'Content-Type: application/json' \
    -H 'X-Telegram-Bot-Api-Secret-Token: dev-secret' \
    --data-binary "$(jq -c ".$1" worker/test/telegram.fixtures.json)" | jq '.method, (.results | length), (.results[0] | {type, id, thumbnail_url})'
  echo
}

echo '== inline sergey =='
post inline_sergey

echo '== inline empty =='
post inline_empty

kill $WRANGLER_PID
```

Expected behavior:
- `inline_sergey` → `"method"` is `"answerInlineQuery"`, `results` length is 1–20, first result has a `type` of `"photo"` or `"gif"`, `id` is a meme slug, `thumbnail_url` is a jsDelivr URL.
- `inline_empty` → same, but length is 20 (random sample of full archive).

- [ ] **Step 3: Commit**

```bash
git add worker/src/telegram.ts
git commit -m "$(cat <<'EOF'
feat(telegram): inline mode — @chainlinkmemebot <query>

Returns a gallery of up to 20 InlineQueryResultPhoto/Gif per query via
answerInlineQuery. Empty query => 20 random memes. 60s cache_time so
repeated queries don't re-hit the manifest.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Webhook registration script + pnpm alias

One-shot script that calls `setWebhook` + `setMyCommands` against the Telegram Bot API. Mirrors `scripts/register-discord-command.ts`.

**Files:**
- Create: `scripts/register-telegram-webhook.ts`
- Modify: `package.json` (root)

- [ ] **Step 1: Create `scripts/register-telegram-webhook.ts`**

```ts
// One-shot: point Telegram's webhook at our Worker and register the
// bot's visible command list. Re-run after changing the webhook URL
// or the /clmeme command description.
//
// Expects in the environment:
//   TELEGRAM_BOT_TOKEN       — from @BotFather
//   TELEGRAM_WEBHOOK_SECRET  — random string; Telegram echoes it in the
//                              X-Telegram-Bot-Api-Secret-Token header
//   TELEGRAM_WEBHOOK_URL     — e.g. https://chainlinkmeme-api.pilgrim.workers.dev/telegram/webhook

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const URL = process.env.TELEGRAM_WEBHOOK_URL;

if (!TOKEN || !SECRET || !URL) {
  console.error(
    'usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... TELEGRAM_WEBHOOK_URL=... pnpm telegram:register',
  );
  process.exit(1);
}

async function callApi(method: string, body: unknown): Promise<unknown> {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`[telegram] ${method} → HTTP ${res.status}: ${text}`);
    process.exit(1);
  }
  return JSON.parse(text);
}

async function main(): Promise<void> {
  console.log(`[telegram] setWebhook url=${URL}`);
  await callApi('setWebhook', {
    url: URL,
    secret_token: SECRET,
    allowed_updates: ['message', 'inline_query'],
    drop_pending_updates: true,
  });
  console.log('[telegram] setWebhook ok');

  await callApi('setMyCommands', {
    commands: [
      { command: 'clmeme', description: 'Summon a chainlink meme — e.g. /clmeme sergey' },
      { command: 'help', description: 'How to use this bot' },
    ],
  });
  console.log('[telegram] setMyCommands ok');

  console.log('');
  console.log('[telegram] NEXT STEP — inline mode cannot be enabled via the API.');
  console.log('[telegram] Open @BotFather in Telegram and run:');
  console.log('[telegram]   /setinline  → pick @chainlinkmemebot → placeholder text:');
  console.log('[telegram]   "search memes: sergey, moon, wagmi…"');
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Register the script in root `package.json`**

Add a line to the `scripts` block (preserving alphabetical/grouped order — slot next to `discord:register`):

```json
    "discord:register": "tsx scripts/register-discord-command.ts",
    "telegram:register": "tsx scripts/register-telegram-webhook.ts",
```

- [ ] **Step 3: Dry-run the script locally (no real API call)**

Don't actually register yet — verify the usage message prints cleanly:

```bash
pnpm telegram:register
```

Expected: exits 1 with the `usage:` line printed to stderr. (No env vars set = usage message.)

- [ ] **Step 4: Commit**

```bash
git add scripts/register-telegram-webhook.ts package.json
git commit -m "$(cat <<'EOF'
feat(telegram): register-telegram-webhook.ts

setWebhook + setMyCommands in one shot. Prints a BotFather reminder for
the one piece of setup that isn't API-automatable: enabling inline mode.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: README section

Document the new bot the same way Discord is documented.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a "Telegram bot" section to `README.md`**

Insert this block immediately after the existing "Discord bot" section (between the end of the Discord section and the start of "X (Twitter) bot"):

```markdown
### Telegram bot
Summon any meme in Telegram with either entry point:

- **Inline** — `@chainlinkmemebot sergey` in any chat. A picker appears; tap a thumbnail to send the meme. Works in DMs, groups, channels, and comment threads — no install step, no bot permissions.
- **Command** — DM the bot or add it to a group and run `/clmeme sergey`. Empty query returns a random meme.

**[Open @chainlinkmemebot →](https://t.me/chainlinkmemebot)**

Like the Discord bot, there's no gateway or polling — Telegram POSTs each update to the Cloudflare Worker (`/telegram/webhook`), which verifies the secret-token header and replies with the send-photo action inline.
```

- [ ] **Step 2: Add `telegram:register` to the "useful workspace scripts" block**

In the "Develop locally" section, add a line after `discord:register`:

```sh
pnpm telegram:register           # (re)register Telegram webhook + bot commands
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: add Telegram bot section to README

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: End-to-end staging deploy + real-bot acceptance

Deploy to the existing `*.workers.dev` preview URL, register the webhook against it, and run the acceptance checklist from the spec. Only after this passes do we point the bot at production.

**Files:**
- None (operational task)

- [ ] **Step 1: Set the Worker secrets**

```bash
cd worker
pnpm wrangler secret put TELEGRAM_BOT_TOKEN   # paste the token from BotFather
pnpm wrangler secret put TELEGRAM_WEBHOOK_SECRET   # paste a freshly generated random string (save it — you need it in step 3)
cd ..
```

Generate a secret with:
```bash
openssl rand -hex 32
```

- [ ] **Step 2: Deploy the Worker**

Let the existing CI ship it:
```bash
git push origin main
```

Or manually:
```bash
pnpm worker:deploy
```

Capture the deployed URL (it's `https://chainlinkmeme-api.pilgrim.workers.dev` per current wrangler config).

- [ ] **Step 3: Register the webhook**

```bash
TELEGRAM_BOT_TOKEN=<token> \
TELEGRAM_WEBHOOK_SECRET=<same secret from step 1> \
TELEGRAM_WEBHOOK_URL=https://chainlinkmeme-api.pilgrim.workers.dev/telegram/webhook \
pnpm telegram:register
```

Expected: `setWebhook ok` + `setMyCommands ok`, followed by the BotFather reminder.

- [ ] **Step 4: Enable inline mode via @BotFather**

In Telegram, DM `@BotFather`:
1. `/setinline`
2. Pick `@chainlinkmemebot`
3. Placeholder: `search memes: sergey, moon, wagmi…`

- [ ] **Step 5: Run acceptance checklist**

From `docs/superpowers/specs/2026-04-19-telegram-bot-design.md`:

- [ ] DM `/start` → intro text appears.
- [ ] DM `/clmeme sergey` → photo/GIF with caption including a `/m/<slug>/` permalink, replying under the command.
- [ ] DM `/clmeme` → random meme.
- [ ] DM `/clmeme zzznomatchxyz` → "no match for …" message.
- [ ] In any chat, type `@chainlinkmemebot sergey` → gallery of sergey memes; tapping sends the meme.
- [ ] In any chat, type `@chainlinkmemebot ` (with trailing space, empty query) → 20 random memes.
- [ ] Tap a permalink in a bot message → opens `https://chainlinkme.me/m/<slug>/`.
- [ ] Add the bot to a group, run `/clmeme@chainlinkmemebot sergey` → works, replies threaded under the command.

- [ ] **Step 6: Watch observability for 5 minutes**

```bash
pnpm --filter worker exec wrangler tail --format pretty
```

Expected: every webhook POST logs a 200 (or 401 for misrouted traffic, which should be zero). No uncaught exceptions.

- [ ] **Step 7: Final commit only if anything changed during acceptance**

If acceptance turned up any fixes, commit them with `fix(telegram): ...` messages and redeploy. Otherwise, the bot is live.

---

## Done

At this point:
- Inline mode works in every chat.
- `/clmeme`, `/start`, `/help` work in DMs and groups.
- The webhook is secret-gated and replies inline (no second round-trip).
- The Discord bot is unchanged.
- The new code is ~200 extra lines of Worker source plus a ~50-line register script.

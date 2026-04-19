// Telegram webhook handler. Verifies Telegram's secret-token header,
// parses the Update, and dispatches to handlers per update type.
// Responses are emitted as webhook-reply JSON (the HTTP response body
// carries the bot method + params), which avoids a second round-trip
// to api.telegram.org.

import {
  type Manifest,
  type ManifestMeme,
  displayTitle,
  loadManifest,
  memeCdnUrl,
  pickMeme,
  pickMemes,
} from './picker';

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
  let mismatch = a.length ^ b.length;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

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
  const firstTagHash = meme.tags[0] ? '#' + meme.tags[0] : '';
  const titleLine = title === firstTagHash ? '' : title;
  // Permalink first so it survives the 1024-char truncation — title + tags
  // are nice-to-have, but losing the click-through URL is a silent UX bug.
  const parts = [permalink, titleLine, tags].filter(Boolean);
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
    // Plain text, no parse_mode — the user's query is interpolated here, and
    // Markdown metachars (`*`, `_`, `` ` ``, `[`) in a query like `/clmeme *`
    // would produce malformed Markdown and get the whole message silently
    // rejected by Telegram.
    return tgReply('sendMessage', {
      chat_id: chatId,
      reply_parameters: { message_id: replyTo },
      text: `no match for "${query}". try sergey, moon, wagmi…`,
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

const INLINE_RESULT_LIMIT = 20;
// Specific queries are deterministic-ish — safe for Telegram's global cache.
// Empty queries are random-per-call, so a 60s global cache would pin all
// users to the same 20 memes for a minute at a time. Shorter + per-user.
const INLINE_CACHE_SECONDS_QUERIED = 60;
const INLINE_CACHE_SECONDS_RANDOM = 5;

interface InlinePhotoResult {
  type: 'photo';
  id: string;
  caption: string;
  title: string;
  thumbnail_url: string;
  photo_url: string;
}

// Telegram's inline API is strict about media in ways sendPhoto/sendAnimation
// aren't. InlineQueryResultPhoto.photo_url must be JPEG (PNGs crash some
// macOS clients outright), and InlineQueryResultGif caps gif_url at 1MB
// (60% of our archive's GIFs exceed this and also crash the macOS client).
// Until the manifest records file sizes we skip animated memes entirely
// from inline results — /clmeme still serves GIFs via sendAnimation, which
// has no 1MB limit.
// PNG memes have JPEG siblings pre-generated into memes/inline/ (see
// scripts/build-inline-jpegs.ts); the manifest records them as
// inline_filename. Callers of buildInlineResult must pre-filter with this.
function inlineFilename(m: ManifestMeme): string {
  return m.inline_filename ?? m.filename;
}

function inlineSafe(m: ManifestMeme): boolean {
  if (m.animated) return false;
  const ext = inlineFilename(m).toLowerCase().split('.').pop() ?? '';
  return ext === 'jpg' || ext === 'jpeg';
}

// Precondition: caller has filtered with inlineSafe (photo-only, JPEG URL).
function buildInlineResult(meme: ManifestMeme, siteOrigin: string): InlinePhotoResult {
  const permalink = `${siteOrigin}/m/${meme.slug}/`;
  const caption = captionFor(meme, permalink);
  const title = displayTitle(meme);
  const url = memeCdnUrl(inlineFilename(meme));
  return { type: 'photo', id: meme.slug, photo_url: url, thumbnail_url: url, title, caption };
}

async function handleInline(inlineQueryId: string, query: string, env: TelegramEnv): Promise<Response> {
  let manifest: Manifest;
  try {
    manifest = await loadManifest(env.SITE_ORIGIN);
  } catch {
    return tgReply('answerInlineQuery', {
      inline_query_id: inlineQueryId,
      results: [],
      cache_time: 5,
      is_personal: true,
    });
  }

  const safeManifest: Manifest = { ...manifest, memes: manifest.memes.filter(inlineSafe) };
  const memes = pickMemes(safeManifest, query, INLINE_RESULT_LIMIT);
  const results = memes.map((m) => buildInlineResult(m, env.SITE_ORIGIN));
  const isRandom = query.trim() === '';
  return tgReply('answerInlineQuery', {
    inline_query_id: inlineQueryId,
    results,
    cache_time: isRandom ? INLINE_CACHE_SECONDS_RANDOM : INLINE_CACHE_SECONDS_QUERIED,
    is_personal: isRandom,
  });
}

async function dispatchTelegramUpdate(request: Request, env: TelegramEnv): Promise<Response> {
  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    // Malformed body from Telegram is unexpected; returning 200 prevents a
    // retry-storm if something upstream ever corrupts a body.
    return ignore();
  }

  if (update.inline_query) {
    return handleInline(update.inline_query.id, update.inline_query.query, env);
  }

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

  return ignore();
}

export async function handleTelegramUpdate(request: Request, env: TelegramEnv): Promise<Response> {
  const secret = request.headers.get('x-telegram-bot-api-secret-token');
  if (!secret || !timingSafeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response('unauthorized', { status: 401 });
  }
  try {
    return await dispatchTelegramUpdate(request, env);
  } catch (err) {
    // Any uncaught throw here would bubble to a 500, which Telegram retries
    // up to 3 times over 24 hours — replaying the same command to the same
    // chat. Swallowing to 200-null breaks that feedback loop. Workers Logs
    // still captures the stack (observability is enabled in wrangler.toml).
    console.error('[telegram] uncaught:', err);
    return ignore();
  }
}

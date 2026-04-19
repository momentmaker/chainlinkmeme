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
  const parts = [titleLine, tags, permalink].filter(Boolean);
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

const INLINE_RESULT_LIMIT = 20;
const INLINE_CACHE_SECONDS = 60;

type InlineResult =
  | { type: 'photo'; id: string; caption: string; title: string; thumbnail_url: string; photo_url: string }
  | { type: 'gif';   id: string; caption: string; title: string; thumbnail_url: string; gif_url: string };

// Telegram's inline API is strict about media formats in ways sendPhoto/
// sendAnimation are not: InlineQueryResultPhoto.photo_url must point to a
// JPEG, and some macOS clients crash outright when given a PNG. We skip
// non-JPEG statics here so the picker stays safe. Animated memes must be
// actual .gif to satisfy InlineQueryResultGif.
function inlineSafe(m: ManifestMeme): boolean {
  const ext = m.filename.toLowerCase().split('.').pop() ?? '';
  return m.animated ? ext === 'gif' : (ext === 'jpg' || ext === 'jpeg');
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
  return tgReply('answerInlineQuery', {
    inline_query_id: inlineQueryId,
    results,
    cache_time: INLINE_CACHE_SECONDS,
    is_personal: false,
  });
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

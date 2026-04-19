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

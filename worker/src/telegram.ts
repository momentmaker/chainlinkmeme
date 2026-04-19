// Telegram webhook handler. Filled out in subsequent tasks.

interface TelegramEnv {
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  SITE_ORIGIN: string;
}

export async function handleTelegramUpdate(_request: Request, _env: TelegramEnv): Promise<Response> {
  return new Response(null, { status: 200 });
}

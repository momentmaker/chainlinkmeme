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

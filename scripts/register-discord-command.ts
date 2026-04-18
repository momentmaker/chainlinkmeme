// One-shot: register the /clmeme global slash command against Discord's API.
// Re-run after editing the command's name, description, or options.
// Expects DISCORD_APP_ID + DISCORD_BOT_TOKEN in the environment.

const APP_ID = process.env.DISCORD_APP_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!APP_ID || !BOT_TOKEN) {
  console.error('usage: DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... pnpm tsx scripts/register-discord-command.ts');
  process.exit(1);
}

const command = {
  name: 'clmeme',
  description: 'Summon a chainlink meme from the archive',
  options: [
    {
      // type 3 = STRING
      type: 3,
      name: 'query',
      description: 'Tags to search — e.g. sergey, moon, wagmi. Blank for a random meme.',
      required: false,
    },
  ],
};

async function main() {
  const res = await fetch(`https://discord.com/api/v10/applications/${APP_ID}/commands`, {
    method: 'POST',
    headers: {
      'Authorization': `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`[discord] HTTP ${res.status}: ${body}`);
    process.exit(1);
  }
  console.log(`[discord] registered /clmeme — ${body}`);
  console.log('[discord] allow up to 1 hour for the command to appear in every server');
}

main().catch((err) => { console.error(err); process.exit(1); });

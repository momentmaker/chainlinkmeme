// Smoke test for the X bot credentials. Calls v2/users/me — the one read
// endpoint available on the Free tier — and prints who we're authenticated
// as. Optionally posts a real "bot online" tweet if --post is given, so the
// full write path can be verified once before wiring up the cron jobs.
//
// No arguments: verify auth only (zero posts).
// --post: verify auth AND post one "⬢ bot online" tweet.

import { makeClient } from './lib/tweet';

async function main() {
  const postReal = process.argv.includes('--post');

  const client = makeClient();
  const me = await client.v2.me();
  if (!me.data) {
    console.error('[tweet-hello] v2.me() returned no data — check credentials');
    process.exit(1);
  }
  console.log(`[tweet-hello] ✅ authenticated as @${me.data.username} (id ${me.data.id})`);

  if (!postReal) {
    console.log('[tweet-hello] --post not set, skipping the live write test');
    return;
  }

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const text = `⬢ bot online — ${stamp}`;
  const tweet = await client.v2.tweet(text);
  console.log(`[tweet-hello] posted ${tweet.data.id}: ${text}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

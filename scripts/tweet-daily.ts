// Daily meme-of-the-day tweet. Deterministic by date — same meme the site's
// hero shows that day. Static images post as a bare permalink so X unfurls
// the per-meme OG card (more branded than a raw attachment); animated
// memes upload the GIF directly so they play in-feed.

import fs from 'node:fs';
import path from 'node:path';
import { memeOfDay } from '../site/src/lib/meme-of-day';
import type { Manifest } from '../site/src/lib/manifest';
import { ROOT, makeClient, permalinkUrl, titleOrTag, uploadAnimatedGif } from './lib/tweet';

const MANIFEST_PATH = path.join(ROOT, 'site', 'public', 'manifest.json');

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('[tweet-daily] no manifest.json — run `pnpm manifest` first');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  const meme = memeOfDay(manifest.memes, new Date());
  if (!meme) {
    console.error('[tweet-daily] manifest has no memes');
    process.exit(1);
  }

  const title = titleOrTag(meme);
  const url = permalinkUrl(meme.slug);
  const text = `⬢ meme of the day — ${title}\n${url}`;

  console.log(`[tweet-daily] ${meme.slug} (${meme.animated ? 'animated' : 'static'})`);
  console.log(`[tweet-daily] text:\n${text}`);

  if (dryRun) {
    console.log('[tweet-daily] --dry-run set, not posting');
    return;
  }

  const client = makeClient();
  if (meme.animated) {
    const filepath = path.join(ROOT, 'memes', meme.filename);
    if (!fs.existsSync(filepath)) {
      console.error(`[tweet-daily] missing local file: ${filepath}`);
      process.exit(1);
    }
    const mediaId = await uploadAnimatedGif(client, filepath);
    const tweet = await client.v2.tweet(text, { media: { media_ids: [mediaId] } });
    console.log(`[tweet-daily] posted ${tweet.data.id} with media ${mediaId}`);
  } else {
    const tweet = await client.v2.tweet(text);
    console.log(`[tweet-daily] posted ${tweet.data.id} (link-only, OG card will unfurl)`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

// Daily meme-of-the-day post. Deterministic by date — same meme the site's
// hero shows that day. Posts the meme itself as native media with its tags
// and no link: a URL-free post bills at X's $0.015 "Post: Create" rate rather
// than the $0.200 "Content: Create with URL" rate, and native images
// out-reach link posts on X anyway.

import fs from 'node:fs';
import path from 'node:path';
import { memeOfDay } from '../site/src/lib/meme-of-day';
import type { Manifest } from '../site/src/lib/manifest';
import { ROOT, makeClient, humanTitle, hashtagLine, uploadAnimatedGif, uploadImage } from './lib/tweet';

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

  const title = humanTitle(meme);
  const tags = hashtagLine(meme.tags);
  const text = title ? `⬢ meme of the day — ${title}\n${tags}` : `⬢ meme of the day\n${tags}`;

  const filepath = path.join(ROOT, 'memes', meme.filename);
  if (!fs.existsSync(filepath)) {
    console.error(`[tweet-daily] missing local file: ${filepath}`);
    process.exit(1);
  }

  console.log(`[tweet-daily] ${meme.slug} (${meme.animated ? 'animated' : 'static'})`);
  console.log(`[tweet-daily] media: ${meme.filename}`);
  console.log(`[tweet-daily] text:\n${text}`);

  if (dryRun) {
    console.log('[tweet-daily] --dry-run set, not posting');
    return;
  }

  const client = makeClient();
  const mediaId = meme.animated
    ? await uploadAnimatedGif(client, filepath)
    : await uploadImage(client, filepath, meme.ext);
  const tweet = await client.v2.tweet(text, { media: { media_ids: [mediaId] } });
  console.log(`[tweet-daily] posted ${tweet.data.id} with media ${mediaId}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

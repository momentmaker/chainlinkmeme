// Shared helpers for the X (Twitter) bot scripts. Posting uses OAuth 1.0a
// user context as @chainlinkmeme — the four secrets live in GitHub Actions
// env, never in the repo.

import path from 'node:path';
import { TwitterApi } from 'twitter-api-v2';
import type { MemeEntry } from '../../site/src/lib/manifest';

export const SITE_URL = process.env.SITE_URL ?? 'https://chainlinkme.me';
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

export function makeClient(): TwitterApi {
  const appKey = process.env.X_API_KEY;
  const appSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;
  if (!appKey || !appSecret || !accessToken || !accessSecret) {
    throw new Error('missing one of X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET');
  }
  return new TwitterApi({ appKey, appSecret, accessToken, accessSecret });
}

export function permalinkUrl(slug: string): string {
  return `${SITE_URL}/m/${slug}/`;
}

// Same title-fallback the site + OG images use: md5-looking legacy filenames
// get replaced with #firsttag so nobody sees a 32-hex string in a tweet.
const HASH_RE = /^[0-9a-f]{10,}$/i;
export function titleOrTag(meme: Pick<MemeEntry, 'title' | 'tags' | 'slug'>): string {
  if (meme.title && !HASH_RE.test(meme.title)) return meme.title;
  if (meme.tags[0]) return `#${meme.tags[0]}`;
  // Shouldn't reach here — every meme is required to have ≥1 tag by the
  // validate script — but keep a legible fallback rather than posting a
  // raw hex slug fragment if a schema drift ever slips past CI.
  return '#unknown';
}

// GIFs upload as native GIF media with tweet_gif category so X auto-plays
// them in the feed. All our GIFs are under the 15MB upload cap, so no
// pre-conversion to MP4 is needed at the moment.
export async function uploadAnimatedGif(client: TwitterApi, absPath: string): Promise<string> {
  return await client.v1.uploadMedia(absPath, {
    mimeType: 'image/gif',
    target: 'tweet',
    mediaCategory: 'tweet_gif',
  });
}

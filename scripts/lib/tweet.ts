// Shared helpers for the X (Twitter) bot scripts. Posting uses OAuth 1.0a
// user context as @chainlinkmeme — the four secrets live in GitHub Actions
// env, never in the repo.

import path from 'node:path';
import { TwitterApi } from 'twitter-api-v2';
import type { MemeEntry } from '../../site/src/lib/manifest';

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

// md5-looking legacy slugs sometimes leak into the title field; treat those
// as "no title" so a 32-hex string never shows up in a post.
const HASH_RE = /^[0-9a-f]{10,}$/i;
export function humanTitle(meme: Pick<MemeEntry, 'title'>): string | null {
  if (meme.title && !HASH_RE.test(meme.title)) return meme.title;
  return null;
}

const MAX_HASHTAGS = 5;
export function hashtagLine(tags: string[]): string {
  return tags.slice(0, MAX_HASHTAGS).map((t) => `#${t}`).join(' ');
}

// GIFs upload as native GIF media so X auto-plays them in the feed. The
// upload helper derives the tweet_gif media category from the image/gif
// mimeType. All our GIFs are under the 15MB upload cap, so no pre-conversion
// to MP4 is needed at the moment.
export async function uploadAnimatedGif(client: TwitterApi, absPath: string): Promise<string> {
  return await client.v1.uploadMedia(absPath, { mimeType: 'image/gif', target: 'tweet' });
}

const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

// Static memes upload as native image media so the meme shows in-feed with no
// permalink — a URL-free post bills at X's $0.015 "Post: Create" rate instead
// of the $0.200 "Content: Create with URL" rate.
export async function uploadImage(client: TwitterApi, absPath: string, ext: string): Promise<string> {
  return await client.v1.uploadMedia(absPath, { mimeType: IMAGE_MIME[ext] ?? 'image/jpeg', target: 'tweet' });
}

// Weekly "top N" tweet. Reads the newest snapshot from
// site/src/data/weekly/ and posts one tweet linking to the week's page,
// which unfurls a per-week OG card (honeycomb of the top memes) built
// by scripts/build-og-images.ts.
//
// Deliberately a single tweet, not a thread:
//   - 1/500 monthly-quota vs 8/500 for the old thread shape
//   - a visual unfurl beats a scroll-me-please thread
//   - drives traffic to /week/<key>, a permalink artifact people can
//     bookmark and re-share
// Quiet weeks (zero entries) skip posting — gaps are honest.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SITE_URL, makeClient } from './lib/tweet';

const WEEKLY_DIR = path.join(ROOT, 'site', 'src', 'data', 'weekly');

interface WeeklyTopEntry { slug: string; total: number; counts: { heart: number; laugh: number; bolt: number; diamond: number }; }
interface WeeklySnapshot { week: string; start: string; end: string; generated_at: string; top: WeeklyTopEntry[]; }

function latestWeeklySnapshot(): WeeklySnapshot | null {
  if (!fs.existsSync(WEEKLY_DIR)) return null;
  const files = fs.readdirSync(WEEKLY_DIR).filter((f) => f.endsWith('.json')).sort();
  const latest = files[files.length - 1];
  if (!latest) return null;
  return JSON.parse(fs.readFileSync(path.join(WEEKLY_DIR, latest), 'utf8')) as WeeklySnapshot;
}

function buildText(snap: WeeklySnapshot, count: number): string {
  const phrase = count === 1 ? 'the top meme' : `the ${count} most reacted memes`;
  return `⬢ last week on the archive — ${phrase}\n${SITE_URL}/week/${snap.week}/`;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const snap = latestWeeklySnapshot();
  if (!snap) {
    console.log('[tweet-weekly] no weekly snapshot found — nothing to tweet');
    return;
  }
  if (snap.top.length === 0) {
    console.log(`[tweet-weekly] ${snap.week} is quiet (0 entries) — skipping`);
    return;
  }

  const text = buildText(snap, snap.top.length);
  console.log(`[tweet-weekly] ${snap.week} — ${snap.top.length} entries`);
  console.log(`[tweet-weekly] text:\n${text}`);

  if (dryRun) {
    console.log('[tweet-weekly] --dry-run set, not posting');
    return;
  }

  const client = makeClient();
  const tweet = await client.v2.tweet(text);
  console.log(`[tweet-weekly] posted ${tweet.data.id} — OG card will unfurl from /week/${snap.week}/`);
}

main().catch((err) => { console.error(err); process.exit(1); });

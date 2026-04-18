// Weekly top-7 tweet thread. Reads the newest weekly snapshot from
// site/src/data/weekly/ and posts an opener + one reply per meme. Skips
// posting entirely if the latest snapshot has zero entries (gaps are
// honest — we don't tweet nothing).

import fs from 'node:fs';
import path from 'node:path';
import type { Manifest, MemeEntry } from '../site/src/lib/manifest';
import { ROOT, makeClient, permalinkUrl, titleOrTag } from './lib/tweet';

const MANIFEST_PATH = path.join(ROOT, 'site', 'public', 'manifest.json');
const WEEKLY_DIR = path.join(ROOT, 'site', 'src', 'data', 'weekly');

interface WeeklyTopEntry {
  slug: string;
  total: number;
  counts: { heart: number; laugh: number; bolt: number; diamond: number };
}
interface WeeklySnapshot {
  week: string;
  start: string;
  end: string;
  generated_at: string;
  top: WeeklyTopEntry[];
}

function latestWeeklySnapshot(): WeeklySnapshot | null {
  if (!fs.existsSync(WEEKLY_DIR)) return null;
  const files = fs.readdirSync(WEEKLY_DIR).filter((f) => f.endsWith('.json')).sort();
  const latest = files[files.length - 1];
  if (!latest) return null;
  return JSON.parse(fs.readFileSync(path.join(WEEKLY_DIR, latest), 'utf8')) as WeeklySnapshot;
}

function buildOpener(snap: WeeklySnapshot, count: number): string {
  return `⬢ last week on the archive (${snap.start} — ${snap.end})\nthe ${count} most reacted memes 🧵`;
}

function buildReply(rank: number, total: number, meme: MemeEntry, entry: WeeklyTopEntry): string {
  const title = titleOrTag(meme);
  return `${rank}/${total} · ${title} · ${entry.total} reactions\n${permalinkUrl(meme.slug)}`;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const snap = latestWeeklySnapshot();
  if (!snap) {
    // Not an error — the weekly cron may run before the first snapshot
    // exists, or a contributor could prune the folder. Quiet exit so we
    // don't spam workflow-failure notifications.
    console.log('[tweet-weekly] no weekly snapshot found — nothing to tweet');
    return;
  }
  if (snap.top.length === 0) {
    console.log(`[tweet-weekly] ${snap.week} has zero entries — skipping (quiet week)`);
    return;
  }

  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('[tweet-weekly] no manifest.json — run `pnpm manifest` first');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  const bySlug = new Map(manifest.memes.map((m) => [m.slug, m]));

  // Drop any snapshot entry whose meme was removed from the archive between
  // snapshot time and now. Filter *before* numbering so the thread reads as
  // a clean "1/6, 2/6 … 6/6" rather than an alarming "1/7, 2/7, 5/7 …".
  const validEntries = snap.top.filter((e) => bySlug.has(e.slug));
  if (validEntries.length === 0) {
    console.log(`[tweet-weekly] ${snap.week}: every top entry is missing from the current manifest — skipping`);
    return;
  }
  if (validEntries.length < snap.top.length) {
    const dropped = snap.top.filter((e) => !bySlug.has(e.slug)).map((e) => e.slug);
    console.warn(`[tweet-weekly] dropped ${dropped.length} entries missing from manifest: ${dropped.join(', ')}`);
  }

  const opener = buildOpener(snap, validEntries.length);
  const replies = validEntries.map((entry, i) => {
    const meme = bySlug.get(entry.slug)!;
    return buildReply(i + 1, validEntries.length, meme, entry);
  });

  console.log(`[tweet-weekly] ${snap.week} — opener + ${replies.length} replies`);
  console.log(`[tweet-weekly] opener:\n${opener}`);
  for (const r of replies) console.log(`[tweet-weekly] reply:\n${r}\n---`);

  if (dryRun) {
    console.log('[tweet-weekly] --dry-run set, not posting');
    return;
  }

  const client = makeClient();
  const opened = await client.v2.tweet(opener);
  let prevId = opened.data.id;
  console.log(`[tweet-weekly] posted opener ${prevId}`);

  for (const body of replies) {
    const posted = await client.v2.reply(body, prevId);
    prevId = posted.data.id;
    console.log(`[tweet-weekly] posted reply ${prevId}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

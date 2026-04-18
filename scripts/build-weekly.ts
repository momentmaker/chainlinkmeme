// Weekly "top 7" snapshot. Run on Mondays (cron) to freeze last week's
// winners by total reactions. Each snapshot is a committed JSON file so the
// history lives in git — no external DB, the site re-renders each week's
// page from disk at build time.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA_DIR = path.join(ROOT, 'site', 'src', 'data', 'weekly');
const MANIFEST_PATH = path.join(ROOT, 'site', 'public', 'manifest.json');
const WORKER_URL = process.env.WORKER_URL ?? 'https://chainlinkmeme-api.pilgrim.workers.dev';

interface ManifestMeme { slug: string; filename: string; title: string; tags: string[]; animated: boolean; }
interface Manifest { memes: ManifestMeme[]; generated_at: string; }
type ReactionCounts = { heart: number; laugh: number; bolt: number; diamond: number };
type ReactionsMap = Record<string, ReactionCounts>;

interface WeeklySnapshot {
  week: string;
  start: string;
  end: string;
  generated_at: string;
  top: Array<{ slug: string; total: number; counts: ReactionCounts }>;
}

// ISO 8601 week — Monday-started week, week 1 is the one containing Jan 4th.
function isoWeek(d: Date): { year: number; week: number; start: Date; end: Date } {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7; // Mon=0
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstThursdayDay = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDay + 3);
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86400_000));
  const start = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate() - 3));
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { year: target.getUTCFullYear(), week, start, end };
}

async function fetchReactions(): Promise<ReactionsMap> {
  const res = await fetch(`${WORKER_URL}/api/reactions`);
  if (!res.ok) throw new Error(`worker /api/reactions HTTP ${res.status}`);
  return (await res.json()) as ReactionsMap;
}

async function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('[weekly] no manifest.json — run build-manifest.ts first');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const now = new Date();

  let reactions: ReactionsMap;
  try {
    reactions = await fetchReactions();
  } catch (err) {
    console.warn(`[weekly] can't reach worker (${(err as Error).message}); emitting empty snapshot`);
    reactions = {};
  }

  const slugsInArchive = new Set(manifest.memes.map((m) => m.slug));
  const rankedAll = Object.entries(reactions)
    .filter(([slug]) => slugsInArchive.has(slug))
    .map(([slug, counts]) => ({
      slug,
      counts,
      total: counts.heart + counts.laugh + counts.bolt + counts.diamond,
    }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 7);

  // Catch up any missing weeks since the last committed snapshot. GH Actions
  // cron can miss Mondays during outages; rather than silently skip them,
  // back-fill with the same current top-7 (the best approximation we have
  // without per-week reaction deltas). Gapless history > correct history.
  const existing = new Set(
    fs.readdirSync(DATA_DIR)
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.replace(/\.json$/, '')),
  );
  const weeksToWrite = enumerateMissingWeeks(existing, now);
  if (weeksToWrite.length === 0) {
    const current = isoWeek(now);
    const currentKey = `${current.year}-W${String(current.week).padStart(2, '0')}`;
    if (existing.has(currentKey) && !process.env.FORCE) {
      console.log(`[weekly] ${currentKey} already snapshotted — skipping`);
      return;
    }
    weeksToWrite.push(current);
  }

  for (const w of weeksToWrite) {
    const weekKey = `${w.year}-W${String(w.week).padStart(2, '0')}`;
    const outPath = path.join(DATA_DIR, `${weekKey}.json`);
    if (fs.existsSync(outPath) && !process.env.FORCE) continue;
    const snapshot: WeeklySnapshot = {
      week: weekKey,
      start: w.start.toISOString().slice(0, 10),
      end: w.end.toISOString().slice(0, 10),
      generated_at: now.toISOString(),
      top: rankedAll,
    };
    fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`[weekly] wrote ${weekKey} — ${rankedAll.length} memes, top score ${rankedAll[0]?.total ?? 0}`);
  }
}

// Returns every ISO week from the most recent committed snapshot through the
// current week that doesn't already have a file. Caps at 8 weeks to bound
// the cost of a long outage and so we never produce an absurd backlog.
function enumerateMissingWeeks(existing: Set<string>, now: Date): Array<ReturnType<typeof isoWeek>> {
  const current = isoWeek(now);
  const result: Array<ReturnType<typeof isoWeek>> = [];
  // Walk backwards up to 8 weeks, collecting missing ones. Reverse so we
  // write oldest → newest (makes log output read chronologically).
  const MAX_BACKFILL = 8;
  const cursor = new Date(current.start);
  for (let i = 0; i < MAX_BACKFILL; i++) {
    const w = isoWeek(cursor);
    const key = `${w.year}-W${String(w.week).padStart(2, '0')}`;
    if (!existing.has(key)) result.unshift(w);
    cursor.setUTCDate(cursor.getUTCDate() - 7);
  }
  return result;
}

main().catch((err) => { console.error(err); process.exit(1); });

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
  const { year, week, start, end } = isoWeek(now);
  const weekKey = `${year}-W${String(week).padStart(2, '0')}`;
  const outPath = path.join(DATA_DIR, `${weekKey}.json`);

  // Frozen-after-first-write semantics: once Monday's snapshot lands, later
  // builds during the same week don't overwrite it. Override with FORCE=1.
  if (fs.existsSync(outPath) && !process.env.FORCE) {
    console.log(`[weekly] ${weekKey} already snapshotted — skipping`);
    return;
  }

  let reactions: ReactionsMap;
  try {
    reactions = await fetchReactions();
  } catch (err) {
    console.warn(`[weekly] can't reach worker (${(err as Error).message}); emitting empty snapshot`);
    reactions = {};
  }

  const slugsInArchive = new Set(manifest.memes.map((m) => m.slug));
  const ranked = Object.entries(reactions)
    .filter(([slug]) => slugsInArchive.has(slug))
    .map(([slug, counts]) => ({
      slug,
      counts,
      total: counts.heart + counts.laugh + counts.bolt + counts.diamond,
    }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 7);

  const snapshot: WeeklySnapshot = {
    week: weekKey,
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    generated_at: now.toISOString(),
    top: ranked,
  };

  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`[weekly] wrote ${weekKey} — ${ranked.length} memes, top score ${ranked[0]?.total ?? 0}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

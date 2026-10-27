// "Browse by vibe": the archive's biggest tags, each fronted by its most
// colourful meme. Built at render time from the manifest and, when the
// memeverse atlas has been built, its colour features — server-side only
// (it reads public/atlas from disk), the result is passed to the gallery
// as plain data.

import fs from 'node:fs';
import path from 'node:path';
import { colorfulness, dequantizeFeatures, FEAT_DIM, type AtlasMeta } from './atlas-format';
import type { MemeEntry } from './manifest';

export interface TagCover {
  tag: string;
  count: number;
  slug: string;
  filename: string;
  animated: boolean;
}

export const RAIL_SIZE = 24;

export function buildTagRail(memes: MemeEntry[], atlasDir: string, size = RAIL_SIZE): TagCover[] {
  const counts = new Map<string, number>();
  for (const m of memes) for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, size);

  // Colour score per meme, when the atlas is there to ask. Without it every
  // meme scores 0 and the first still meme carrying the tag fronts it.
  const score = new Map<string, number>();
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(atlasDir, 'atlas.json'), 'utf8')) as AtlasMeta;
    const feats = dequantizeFeatures(new Uint8Array(fs.readFileSync(path.join(atlasDir, 'features.bin'))));
    meta.slugs.forEach((slug, i) => {
      if ((i + 1) * FEAT_DIM <= feats.length) score.set(slug, colorfulness(feats, i));
    });
  } catch { /* no atlas yet (a dev checkout before `pnpm atlas`) */ }

  // Each cover is used once, so a meme tagged both #sergey and #linkpilled
  // can't front both.
  const used = new Set<string>();
  const out: TagCover[] = [];
  for (const [tag, count] of top) {
    let best: MemeEntry | undefined;
    let bestScore = -Infinity;
    for (const m of memes) {
      if (m.animated || m.nsfw || used.has(m.slug) || !m.tags.includes(tag)) continue;
      // Memes whose *first* tag is this one are the most on-topic.
      const s = (score.get(m.slug) ?? 0) + (m.tags[0] === tag ? 25 : 0);
      if (s > bestScore) { bestScore = s; best = m; }
    }
    if (!best) continue;
    used.add(best.slug);
    out.push({ tag, count, slug: best.slug, filename: best.filename, animated: best.animated });
  }
  return out;
}

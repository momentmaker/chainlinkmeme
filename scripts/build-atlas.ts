// Packs every meme into 64px tiles on 2048×2048 WebP sheets for the
// memeverse (/verse) and assemble, plus the per-tile colour features the
// mosaic matcher searches. Output lands in site/public/atlas/:
//
//   atlas.json      slugs in tile order, sheet geometry, mean colour per tile
//   tiles-<n>.webp  the sheets — 1,024 tiles each, row-major
//   features.bin    FEAT_DIM bytes per tile (see site/src/lib/atlas-format.ts)
//
// Runs after build-manifest.ts. Skips the work when atlas.json's signature
// (every meme's filename + byte size, in manifest order) still matches, so a
// second call in the same build — or a CI cache hit — costs nothing.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  ATLAS_VERSION,
  COLS,
  FEAT_DIM,
  PAGE,
  PER_PAGE,
  TILE,
  hexFeatures,
  quantizeFeatures,
  tileOrigin,
  type AtlasMeta,
} from '../site/src/lib/atlas-format';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MEMES_DIR = path.join(ROOT, 'memes');
const MANIFEST_PATH = path.join(ROOT, 'site', 'public', 'manifest.json');
const OUT_DIR = path.join(ROOT, 'site', 'public', 'atlas');
const META_PATH = path.join(OUT_DIR, 'atlas.json');
const WEBP_QUALITY = 78;

interface Meme { slug: string; filename: string }

function signature(memes: Meme[]): string {
  const h = crypto.createHash('sha1');
  h.update(`v${ATLAS_VERSION}:${TILE}:${PAGE}\n`);
  for (const m of memes) {
    const size = fs.statSync(path.join(MEMES_DIR, m.filename)).size;
    h.update(`${m.filename}:${size}\n`);
  }
  return h.digest('hex');
}

// A flat mid-grey tile stands in for anything sharp can't decode, so one bad
// file never sinks the build (validate.ts is where bad files get caught).
async function loadTile(file: string): Promise<Buffer> {
  try {
    return await sharp(file, { animated: false, failOn: 'none' })
      .rotate()
      .flatten({ background: '#ffffff' })
      .resize(TILE, TILE, { fit: 'cover', position: sharp.strategy.attention })
      .removeAlpha()
      .raw()
      .toBuffer();
  } catch (err) {
    console.warn(`  [atlas] could not read ${path.basename(file)}: ${(err as Error).message}`);
    return Buffer.alloc(TILE * TILE * 3, 0x80);
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`[atlas] ${MANIFEST_PATH} missing — run build-manifest.ts first`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as { memes: Meme[] };
  const memes = manifest.memes;
  const sig = signature(memes);

  if (fs.existsSync(META_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(META_PATH, 'utf8')) as AtlasMeta;
      const pagesPresent = Array.from({ length: prev.pages }, (_, i) =>
        fs.existsSync(path.join(OUT_DIR, `tiles-${i}.webp`)),
      ).every(Boolean);
      if (prev.signature === sig && pagesPresent && fs.existsSync(path.join(OUT_DIR, 'features.bin'))) {
        console.log(`[atlas] up to date (${prev.count} tiles) — skipping`);
        return;
      }
    } catch { /* rebuild */ }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pages = Math.ceil(memes.length / PER_PAGE);
  const sheets = Array.from({ length: pages }, () => Buffer.alloc(PAGE * PAGE * 3));
  const features = new Float32Array(memes.length * FEAT_DIM);
  const colors: string[] = new Array(memes.length);
  const rgb = new Float32Array(3);
  const started = Date.now();

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < memes.length) {
      const i = next++;
      const m = memes[i]!;
      const tile = await loadTile(path.join(MEMES_DIR, m.filename));
      const { page, x, y } = tileOrigin(i);
      const sheet = sheets[page]!;
      for (let row = 0; row < TILE; row++) {
        tile.copy(sheet, ((y + row) * PAGE + x) * 3, row * TILE * 3, (row + 1) * TILE * 3);
      }
      hexFeatures(
        { data: tile, width: TILE, height: TILE, channels: 3 },
        TILE / 2, TILE / 2, TILE / 2,
        features, i * FEAT_DIM, rgb,
      );
      colors[i] = '#' + Array.from(rgb, (c) => Math.round(c).toString(16).padStart(2, '0')).join('');
      done++;
      if (done % 200 === 0) console.log(`  [atlas] ${done}/${memes.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(2, os.cpus().length) }, worker));

  for (let p = 0; p < pages; p++) {
    // The last sheet only needs as many rows as it has tiles — trims a
    // mostly-empty 2048² page down to the occupied band.
    const tilesOnPage = Math.min(PER_PAGE, memes.length - p * PER_PAGE);
    const rows = Math.ceil(tilesOnPage / COLS);
    const height = p === pages - 1 ? rows * TILE : PAGE;
    await sharp(sheets[p]!, { raw: { width: PAGE, height: PAGE, channels: 3 } })
      .extract({ left: 0, top: 0, width: PAGE, height })
      .webp({ quality: WEBP_QUALITY, effort: 5 })
      .toFile(path.join(OUT_DIR, `tiles-${p}.webp`));
  }
  fs.writeFileSync(path.join(OUT_DIR, 'features.bin'), quantizeFeatures(features));

  const meta: AtlasMeta = {
    version: ATLAS_VERSION,
    generated_at: new Date().toISOString(),
    signature: sig,
    tile: TILE,
    page: PAGE,
    cols: COLS,
    pages,
    count: memes.length,
    slugs: memes.map((m) => m.slug),
    colors,
  };
  fs.writeFileSync(META_PATH, JSON.stringify(meta));

  const bytes = fs.readdirSync(OUT_DIR).reduce((n, f) => n + fs.statSync(path.join(OUT_DIR, f)).size, 0);
  console.log(
    `[atlas] wrote ${memes.length} tiles on ${pages} sheet(s), ${(bytes / 1024 / 1024).toFixed(2)} MB, in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
}

main().catch((err) => { console.error(err); process.exit(1); });

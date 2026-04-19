// Emits a JPEG sibling for every PNG meme into memes/inline/<slug>.jpg.
// The sibling exists purely so Telegram's InlineQueryResultPhoto (which
// requires JPEG) can surface PNG memes — sendPhoto and the site continue
// to use the PNG original. Commit the output: jsDelivr serves directly
// from the repo.
//
// Idempotent: skips memes whose sibling is already up-to-date relative
// to the source PNG.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MEMES_DIR = path.join(ROOT, 'memes');
const INLINE_DIR = path.join(MEMES_DIR, 'inline');
const JPEG_QUALITY = 85;

async function main(): Promise<void> {
  fs.mkdirSync(INLINE_DIR, { recursive: true });

  const entries = fs.readdirSync(MEMES_DIR);
  const pngs = entries.filter((n) => /\.png$/i.test(n));
  console.log(`[inline-jpegs] found ${pngs.length} PNG memes`);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const name of pngs) {
    const slug = path.basename(name, path.extname(name));
    const src = path.join(MEMES_DIR, name);
    const dest = path.join(INLINE_DIR, `${slug}.jpg`);

    if (fs.existsSync(dest)) {
      const s = fs.statSync(src);
      const d = fs.statSync(dest);
      if (d.mtimeMs >= s.mtimeMs) { skipped++; continue; }
    }

    try {
      // PNG transparency flattens onto white — best default for memes.
      await sharp(src)
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
        .toFile(dest);
      created++;
      console.log(`  ${name} -> inline/${slug}.jpg`);
    } catch (err) {
      failed++;
      console.error(`  FAILED ${name}: ${(err as Error).message}`);
    }
  }

  console.log(`[inline-jpegs] created ${created}, skipped ${skipped} (up-to-date)${failed ? `, failed ${failed}` : ''}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });

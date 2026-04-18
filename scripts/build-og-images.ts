// Pre-renders one OG image per meme to site/public/og/<slug>.png
// Uses satori (HTML -> SVG) + @resvg/resvg-js (SVG -> PNG).
// Skips memes whose OG is already up to date (by mtime of the source image).

import fs from 'node:fs';
import path from 'node:path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MEMES_DIR = path.join(ROOT, 'memes');
const MANIFEST_PATH = path.join(ROOT, 'site', 'public', 'manifest.json');
const OG_DIR = path.join(ROOT, 'site', 'public', 'og');

interface Meme {
  slug: string;
  filename: string;
  title: string;
  tags: string[];
  width: number;
  height: number;
}

async function loadFont(): Promise<ArrayBuffer> {
  const res = await fetch('https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMa1ZL7.woff2');
  if (!res.ok) throw new Error('font fetch failed');
  return res.arrayBuffer();
}

function readImageAsDataUrl(filename: string): string {
  const buf = fs.readFileSync(path.join(MEMES_DIR, filename));
  const ext = path.extname(filename).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function renderCard(meme: Meme, font: ArrayBuffer): Promise<Buffer> {
  const imgData = readImageAsDataUrl(meme.filename);
  const tree = {
    type: 'div',
    props: {
      style: {
        width: 1200, height: 630, display: 'flex', background: 'white',
        fontFamily: 'Inter', padding: 40,
      },
      children: [
        {
          type: 'div',
          props: {
            style: { flex: '0 0 auto', width: 520, height: 550, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f6f7fa', borderRadius: 12, overflow: 'hidden' },
            children: [{ type: 'img', props: { src: imgData, style: { maxWidth: '100%', maxHeight: '100%' } } }],
          },
        },
        {
          type: 'div',
          props: {
            style: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', paddingLeft: 40 },
            children: [
              {
                type: 'div', props: {
                  style: { display: 'flex', flexDirection: 'column' },
                  children: [
                    { type: 'div', props: { style: { fontSize: 20, color: '#2f62df', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 2 }, children: '⬡⏣⬢ chainlink meme' } },
                    { type: 'div', props: { style: { fontSize: 48, fontWeight: 700, color: '#222', marginTop: 16, lineHeight: 1.15, maxWidth: 560 }, children: meme.title || meme.slug } },
                  ],
                },
              },
              {
                type: 'div', props: {
                  style: { display: 'flex', flexWrap: 'wrap', gap: 8 },
                  children: meme.tags.slice(0, 5).map((t) => ({
                    type: 'div',
                    props: { style: { background: 'rgba(47,98,223,0.1)', color: '#2f62df', padding: '6px 14px', borderRadius: 999, fontSize: 20, fontWeight: 600 }, children: `#${t}` },
                  })),
                },
              },
            ],
          },
        },
      ],
    },
  };

  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: 1200,
    height: 630,
    fonts: [{ name: 'Inter', data: font, style: 'normal', weight: 400 }],
  });
  const png = new Resvg(svg, { background: 'white' }).render().asPng();
  return Buffer.from(png);
}

async function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('[og] no manifest.json — run build-manifest.ts first');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as { memes: Meme[] };
  fs.mkdirSync(OG_DIR, { recursive: true });
  const font = await loadFont();

  let rendered = 0;
  let skipped = 0;
  for (const meme of manifest.memes) {
    const out = path.join(OG_DIR, `${meme.slug}.png`);
    const src = path.join(MEMES_DIR, meme.filename);
    if (fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(src).mtimeMs) { skipped++; continue; }
    try {
      const png = await renderCard(meme, font);
      fs.writeFileSync(out, png);
      rendered++;
      if (rendered % 50 === 0) console.log(`[og] ${rendered}/${manifest.memes.length - skipped}...`);
    } catch (err) {
      console.error(`[og] ${meme.slug}: ${(err as Error).message}`);
    }
  }
  console.log(`[og] done — rendered ${rendered}, skipped ${skipped}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

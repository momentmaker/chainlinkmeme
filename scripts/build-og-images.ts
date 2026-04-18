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

// Satori wants TTF/OTF (not WOFF2). Rather than rely on a network round-trip
// that can fail in CI, the font is vendored into the repo (~880 KB one-time
// commit) and read from disk.
const FONT_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), 'assets', 'Inter-Bold.ttf');

async function loadFont(): Promise<ArrayBuffer> {
  if (!fs.existsSync(FONT_PATH)) throw new Error(`missing vendored font at ${FONT_PATH}`);
  const buf = fs.readFileSync(FONT_PATH);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function readImageAsDataUrl(filename: string): string {
  const buf = fs.readFileSync(path.join(MEMES_DIR, filename));
  const ext = path.extname(filename).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function renderCard(meme: Meme, font: ArrayBuffer): Promise<Buffer> {
  const imgData = readImageAsDataUrl(meme.filename);
  const title = meme.title || meme.slug;
  // Titles default to filename hash when contributors haven't set one; swap
  // those ugly mdsums for the primary tag to keep the card human-readable.
  const looksLikeHash = /^[0-9a-f]{10,}$/i.test(title);
  const displayTitle = looksLikeHash ? (meme.tags[0] ?? 'chainlink meme') : title;

  const tree = {
    type: 'div',
    props: {
      style: {
        width: 1200, height: 630, display: 'flex', flexDirection: 'column',
        fontFamily: 'Inter',
        background: 'linear-gradient(135deg, #2f62df 0%, #1a3ba7 60%, #0d2270 100%)',
        color: 'white',
        padding: 48,
      },
      children: [
        // --- Header row: brand + count pill -------------------------------
        {
          type: 'div',
          props: {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 32 },
            children: [
              { type: 'div', props: {
                style: { fontSize: 22, fontWeight: 700, letterSpacing: 4, textTransform: 'uppercase', opacity: 0.95 },
                children: '⬡⏣⬢  chainlink meme  ⬢⏣⬡',
              } },
              { type: 'div', props: {
                style: { fontSize: 18, fontWeight: 600, letterSpacing: 1, opacity: 0.6, padding: '8px 16px', border: '2px solid rgba(255,255,255,0.25)', borderRadius: 999 },
                children: 'chainlinkme.me',
              } },
            ],
          },
        },

        // --- Main row: image (left) + title/tags (right) -------------------
        {
          type: 'div',
          props: {
            style: { flex: 1, display: 'flex', alignItems: 'center', gap: 48 },
            children: [
              // Meme "polaroid" card
              {
                type: 'div', props: {
                  style: {
                    width: 460, height: 460, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'white', padding: 14, paddingBottom: 44, borderRadius: 8,
                    boxShadow: '0 20px 40px rgba(0,0,0,0.4)', transform: 'rotate(-2deg)',
                    flexShrink: 0,
                  },
                  children: [{ type: 'img', props: {
                    src: imgData,
                    style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' },
                  } }],
                },
              },
              // Text column
              {
                type: 'div', props: {
                  style: { flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 0 },
                  children: [
                    // Eyebrow
                    { type: 'div', props: {
                      style: { fontSize: 16, fontWeight: 700, letterSpacing: 3, textTransform: 'uppercase', opacity: 0.55, marginBottom: 16 },
                      children: meme.animated ? '⬢ animated meme' : '⬢ meme',
                    } },
                    // Title
                    { type: 'div', props: {
                      style: {
                        fontSize: displayTitle.length > 40 ? 44 : displayTitle.length > 24 ? 56 : 68,
                        fontWeight: 800, lineHeight: 1.05, letterSpacing: -1,
                        marginBottom: 28, display: 'flex',
                      },
                      children: displayTitle,
                    } },
                    // Tag strip
                    { type: 'div', props: {
                      style: { display: 'flex', flexWrap: 'wrap', gap: 10 },
                      children: meme.tags.slice(0, 6).map((t, i) => ({
                        type: 'div',
                        props: {
                          style: {
                            fontSize: 22, fontWeight: 600,
                            padding: '8px 16px', borderRadius: 999,
                            background: i === 0 ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.12)',
                            color: i === 0 ? '#1a3ba7' : 'white',
                            border: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.25)',
                            display: 'flex',
                          },
                          children: `⬡ ${t}`,
                        },
                      })),
                    } },
                  ],
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
    fonts: [{ name: 'Inter', data: font, style: 'normal', weight: 800 }],
  });
  const png = new Resvg(svg).render().asPng();
  return Buffer.from(png);
}

async function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('[og] no manifest.json — run build-manifest.ts first');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as { memes: Meme[] };
  fs.mkdirSync(OG_DIR, { recursive: true });

  // OG images unfurl permalinks in Discord/Twitter. A broken font source
  // shouldn't block a deploy; degrade gracefully and pick up fresh OGs on the
  // next successful build.
  let font: ArrayBuffer;
  try {
    font = await loadFont();
  } catch (err) {
    console.warn(`[og] skipping OG generation: ${(err as Error).message}`);
    return;
  }

  // Skip on existence rather than mtime: `actions/cache` restores files with
  // fresh mtimes, so the old "out newer than src" check would force a full
  // re-render every CI run. The cache key already invalidates when design or
  // content changes.
  let rendered = 0;
  let skipped = 0;
  for (const meme of manifest.memes) {
    const out = path.join(OG_DIR, `${meme.slug}.png`);
    if (fs.existsSync(out)) { skipped++; continue; }
    try {
      const png = await renderCard(meme, font);
      fs.writeFileSync(out, png);
      rendered++;
      if (rendered % 50 === 0) console.log(`[og] ${rendered} rendered...`);
    } catch (err) {
      console.error(`[og] ${meme.slug}: ${(err as Error).message}`);
    }
  }
  console.log(`[og] done — rendered ${rendered}, skipped ${skipped}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

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
  animated: boolean;
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

// Pre-thumbnail by running the image through resvg once inside a tiny SVG
// wrapper. Drops 1-5 MB JPGs down to ~10 KB PNGs before embedding them in
// the home-OG mosaic — keeps Satori's tree small and Resvg's final parse
// fast. Without this, rendering 77 full-res images in one SVG takes
// minutes and sometimes OOMs.
const thumbCache = new Map<string, string>();
function thumbnailDataUrl(filename: string, w: number, h: number): string {
  const key = `${filename}@${w}x${h}`;
  const hit = thumbCache.get(key);
  if (hit) return hit;
  const srcDataUrl = readImageAsDataUrl(filename);
  const wrapperSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><image href="${srcDataUrl}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/></svg>`;
  const png = new Resvg(wrapperSvg).render().asPng();
  const dataUrl = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  thumbCache.set(key, dataUrl);
  return dataUrl;
}

// Inter-Bold (the vendored OG font) has no glyphs for ⬡ ⬢ ⏣, so they would
// render as tofu in the card. Render the hex marks as inline SVG images
// instead — always visually correct regardless of the active font.
function hexImg(size: number, fill: string, opacity = 1, filled = true) {
  const stroke = filled ? 'none' : fill;
  const fillAttr = filled ? fill : 'none';
  const strokeWidth = filled ? 0 : 5;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 115"><polygon points="50,0 100,28.75 100,86.25 50,115 0,86.25 0,28.75" fill="${fillAttr}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/></svg>`;
  return {
    type: 'img',
    props: {
      src: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`,
      width: size,
      height: Math.round(size * 1.155),
      style: { opacity },
    },
  };
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
                style: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 22, fontWeight: 700, letterSpacing: 4, textTransform: 'uppercase', opacity: 0.95 },
                children: [
                  hexImg(18, 'white', 0.95, false),
                  hexImg(18, 'white', 0.95, true),
                  hexImg(18, 'white', 0.95, false),
                  { type: 'span', props: { style: { display: 'flex', margin: '0 6px' }, children: 'chainlink meme' } },
                  hexImg(18, 'white', 0.95, false),
                  hexImg(18, 'white', 0.95, true),
                  hexImg(18, 'white', 0.95, false),
                ],
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
                      style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 16, fontWeight: 700, letterSpacing: 3, textTransform: 'uppercase', opacity: 0.55, marginBottom: 16 },
                      children: [
                        hexImg(14, 'white', 0.9, true),
                        { type: 'span', props: { style: { display: 'flex' }, children: meme.animated ? 'animated meme' : 'meme' } },
                      ],
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
                            alignItems: 'center',
                            gap: 8,
                          },
                          children: [
                            hexImg(14, i === 0 ? '#1a3ba7' : 'white', 0.95, false),
                            { type: 'span', props: { style: { display: 'flex' }, children: t } },
                          ],
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

// Home OG: a honeycomb mosaic of 77 memes sampled evenly across the archive,
// dark cosmic vignette, center glass strip with brand + stats. Rebuilt every
// deploy; the home page cache-busts the URL with manifest.generated_at so
// unfurls refresh naturally without a dynamic runtime.
async function renderHomeCard(memes: Meme[], tagCount: number, manifestTime: string, font: ArrayBuffer): Promise<Buffer> {
  const CANVAS_W = 1200, CANVAS_H = 630;
  const COUNT = 77;
  // Sample evenly across the sorted archive so the mosaic reads as "breadth
  // of the collection" rather than "most recent 77".
  const step = Math.max(1, memes.length / COUNT);
  const picked: Meme[] = [];
  for (let i = 0; picked.length < COUNT && Math.floor(i * step) < memes.length; i++) {
    picked.push(memes[Math.floor(i * step)]);
  }

  // Pointy-top hex packing. W/H chosen to fill 1200×630 with 11 cols × 7 rows,
  // odd rows offset by W/2 for the honeycomb offset. Some tiles bleed past
  // the right edge of odd rows — the crop reads as organic.
  const W = 108, H = 125;
  const HSTEP = W;
  const VSTEP = Math.round(H * 0.75); // 94
  const ROWS = 7, COLS = 11;
  const gridW = COLS * HSTEP + HSTEP / 2;
  const gridH = (ROWS - 1) * VSTEP + H;
  const xOrigin = Math.round((CANVAS_W - gridW) / 2);
  const yOrigin = Math.round((CANVAS_H - gridH) / 2);

  const cells: unknown[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      if (i >= picked.length) break;
      const m = picked[i];
      const xShift = r % 2 === 0 ? 0 : HSTEP / 2;
      const x = xOrigin + c * HSTEP + xShift;
      const y = yOrigin + r * VSTEP;
      cells.push({
        type: 'div',
        props: {
          style: {
            position: 'absolute',
            left: x,
            top: y,
            width: W,
            height: H,
            display: 'flex',
            overflow: 'hidden',
            clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
          },
          children: [{
            type: 'img',
            props: {
              src: thumbnailDataUrl(m.filename, W, H),
              style: { width: '100%', height: '100%', objectFit: 'cover' },
            },
          }],
        },
      });
    }
  }

  const tree = {
    type: 'div',
    props: {
      style: {
        width: CANVAS_W,
        height: CANVAS_H,
        display: 'flex',
        position: 'relative',
        fontFamily: 'Inter',
        background: 'linear-gradient(135deg, #2f62df 0%, #1a3ba7 55%, #0d2270 100%)',
        color: 'white',
        overflow: 'hidden',
      },
      children: [
        ...cells,
        // Edge vignette — darkens the hex grid toward the edges, guides the
        // eye to the brand strip in the middle.
        { type: 'div', props: {
          style: {
            position: 'absolute', inset: 0,
            background: 'radial-gradient(ellipse 70% 60% at 50% 50%, rgba(13,34,112,0.05) 0%, rgba(13,34,112,0.55) 55%, rgba(13,34,112,0.9) 100%)',
          },
        } },
        // Horizontal "letterbox" band behind the brand mark.
        { type: 'div', props: {
          style: {
            position: 'absolute', left: 0, right: 0, top: 215, height: 200,
            background: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.65) 15%, rgba(0,0,0,0.78) 50%, rgba(0,0,0,0.65) 85%, transparent 100%)',
          },
        } },
        // Brand mark
        { type: 'div', props: {
          style: {
            position: 'absolute', left: 0, right: 0, top: 235,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 14,
            fontSize: 24, fontWeight: 700, letterSpacing: 6, textTransform: 'uppercase',
            opacity: 0.95,
          },
          children: [
            hexImg(20, 'white', 0.9, false),
            hexImg(20, 'white', 0.9, true),
            hexImg(20, 'white', 0.9, false),
            { type: 'span', props: { style: { display: 'flex', margin: '0 8px' }, children: 'chainlink meme' } },
            hexImg(20, 'white', 0.9, false),
            hexImg(20, 'white', 0.9, true),
            hexImg(20, 'white', 0.9, false),
          ],
        } },
        // Wordmark — chainlinkme.me in a huge weight with a negative letter
        // spacing for that condensed display-type vibe.
        { type: 'div', props: {
          style: {
            position: 'absolute', left: 0, right: 0, top: 275,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 96, fontWeight: 900, letterSpacing: -3, lineHeight: 1,
          },
          children: 'chainlinkme.me',
        } },
        // Tagline + stats — monospace-ish feel via letter spacing.
        { type: 'div', props: {
          style: {
            position: 'absolute', left: 0, right: 0, top: 385,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 18,
            fontSize: 18, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase',
            opacity: 0.85,
          },
          children: [
            { type: 'span', props: { style: { display: 'flex' }, children: `${memes.length.toLocaleString()} memes` } },
            { type: 'span', props: { style: { display: 'flex', opacity: 0.5 }, children: '·' } },
            { type: 'span', props: { style: { display: 'flex' }, children: `${tagCount} tags` } },
            { type: 'span', props: { style: { display: 'flex', opacity: 0.5 }, children: '·' } },
            { type: 'span', props: { style: { display: 'flex' }, children: `updated ${manifestTime.slice(0, 10)}` } },
          ],
        } },
      ],
    },
  };

  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: CANVAS_W,
    height: CANVAS_H,
    fonts: [{ name: 'Inter', data: font, style: 'normal', weight: 800 }],
  });
  return Buffer.from(new Resvg(svg).render().asPng());
}

// Weekly top-N OG card. One image per committed snapshot in
// site/src/data/weekly/*.json. Responsive row: 1 big tile through 7
// narrow tiles, centered horizontally, with a cap so the N=1 case
// doesn't sprawl.
interface WeeklyTopEntry { slug: string; total: number; }
interface WeeklySnapshot { week: string; start: string; end: string; top: WeeklyTopEntry[]; }

async function renderWeeklyCard(snap: WeeklySnapshot, memesBySlug: Map<string, Meme>, font: ArrayBuffer): Promise<Buffer | null> {
  const CANVAS_W = 1200, CANVAS_H = 630;
  const usable = snap.top
    .map((e) => ({ entry: e, meme: memesBySlug.get(e.slug) }))
    .filter((r): r is { entry: WeeklyTopEntry; meme: Meme } => !!r.meme);
  if (usable.length === 0) return null;

  const N = usable.length;
  const gap = 16;
  const padX = 48;
  const usableW = CANVAS_W - padX * 2;
  const maxTile = 280;
  const tileW = Math.min(maxTile, Math.floor((usableW - gap * (N - 1)) / N));
  const tileH = tileW;
  const rowW = tileW * N + gap * (N - 1);
  const rowX = Math.round((CANVAS_W - rowW) / 2);
  const rowY = 210;

  const tiles = usable.map((r, i) => {
    const thumb = thumbnailDataUrl(r.meme.filename, tileW, tileH);
    return {
      type: 'div', props: {
        style: {
          position: 'absolute', left: rowX + i * (tileW + gap), top: rowY,
          width: tileW, height: tileH, display: 'flex',
          borderRadius: 10, overflow: 'hidden',
          border: '2px solid rgba(255,255,255,0.2)',
          boxShadow: '0 10px 24px rgba(0,0,0,0.35)',
        },
        children: [
          { type: 'img', props: { src: thumb, width: tileW, height: tileH, style: { objectFit: 'cover' } } },
          // rank badge (top-left)
          {
            type: 'div', props: {
              style: {
                position: 'absolute', top: 8, left: 8, padding: '4px 8px',
                background: 'rgba(15, 23, 42, 0.85)', color: 'white',
                fontSize: 14, fontWeight: 700, borderRadius: 6,
                display: 'flex', alignItems: 'center',
              },
              children: String(i + 1),
            },
          },
          // reaction total (bottom-right)
          {
            type: 'div', props: {
              style: {
                position: 'absolute', bottom: 8, right: 8, padding: '3px 8px',
                background: 'rgba(47, 98, 223, 0.9)', color: 'white',
                fontSize: 13, fontWeight: 700, borderRadius: 6,
                display: 'flex', alignItems: 'center', gap: 4,
              },
              children: `${r.entry.total}`,
            },
          },
        ],
      },
    };
  });

  const subtitle = N === 1 ? 'the top meme' : `the ${N} most reacted memes`;

  const tree = {
    type: 'div', props: {
      style: {
        width: CANVAS_W, height: CANVAS_H, position: 'relative', display: 'flex',
        fontFamily: 'Inter', color: 'white',
        background: 'linear-gradient(135deg, #2f62df 0%, #1a3ba7 60%, #0d2270 100%)',
      },
      children: [
        // Eyebrow
        {
          type: 'div', props: {
            style: {
              position: 'absolute', top: 48, left: 0, right: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 10, fontSize: 22, fontWeight: 700, letterSpacing: 4,
              textTransform: 'uppercase', opacity: 0.9,
            },
            children: [
              hexImg(16, 'white', 0.95, false),
              hexImg(16, 'white', 0.95, true),
              hexImg(16, 'white', 0.95, false),
              { type: 'span', props: { style: { display: 'flex', margin: '0 6px' }, children: 'weekly stack' } },
              hexImg(16, 'white', 0.95, false),
              hexImg(16, 'white', 0.95, true),
              hexImg(16, 'white', 0.95, false),
            ],
          },
        },
        // Title
        {
          type: 'div', props: {
            style: {
              position: 'absolute', top: 100, left: 0, right: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 72, fontWeight: 800, letterSpacing: -2,
            },
            children: snap.week,
          },
        },
        // Subtitle (date range + count)
        {
          type: 'div', props: {
            style: {
              position: 'absolute', top: 180, left: 0, right: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 16, fontSize: 18, fontWeight: 600, opacity: 0.7,
            },
            children: `${snap.start} → ${snap.end} · ${subtitle}`,
          },
        },
        // Tiles row
        ...tiles,
        // Footer permalink
        {
          type: 'div', props: {
            style: {
              position: 'absolute', bottom: 40, left: 0, right: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 20, fontWeight: 600, opacity: 0.55, letterSpacing: 1,
            },
            children: `chainlinkme.me/week/${snap.week}`,
          },
        },
      ],
    },
  };

  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: CANVAS_W,
    height: CANVAS_H,
    fonts: [{ name: 'Inter', data: font, style: 'normal', weight: 800 }],
  });
  return Buffer.from(new Resvg(svg).render().asPng());
}

async function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('[og] no manifest.json — run build-manifest.ts first');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as { memes: Meme[]; tags?: string[]; generated_at?: string };
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
  //
  // ⚠ If you change the visual design of renderCard (layout, colors, fonts,
  // hexImg, anything that alters existing PNGs), you MUST bump the cache-key
  // prefix in .github/workflows/deploy.yml (currently og-v2-). Otherwise
  // restore-keys will pull in pre-change PNGs, this skip-on-exists check
  // will short-circuit every meme, and the new design won't reach
  // production for any meme whose TOML wasn't also edited. Ask me how I
  // know.
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

  // Home OG — always re-rendered because the sample shifts when new memes
  // arrive. Cheap vs. the per-meme loop (one image instead of 1,798).
  try {
    const homePng = await renderHomeCard(
      manifest.memes,
      manifest.tags?.length ?? 0,
      manifest.generated_at ?? new Date().toISOString(),
      font,
    );
    fs.writeFileSync(path.join(OG_DIR, '_home.png'), homePng);
    console.log('[og] _home.png rendered');
  } catch (err) {
    console.error(`[og] home card: ${(err as Error).message}`);
  }

  // Discord / social banner — 680×240 (17:6). Same visual language as the
  // home OG (hex mosaic + dark brand strip), just letterboxed.
  try {
    const bannerPng = await renderBanner(manifest.memes, font);
    fs.writeFileSync(path.join(OG_DIR, '_discord-banner.png'), bannerPng);
    console.log('[og] _discord-banner.png rendered');
  } catch (err) {
    console.error(`[og] discord banner: ${(err as Error).message}`);
  }

  // X / Twitter banner — 1500×500 (3:1). Wider canvas = more hexes, bigger
  // wordmark. Same visual language as the other banners.
  try {
    const xBannerPng = await renderXBanner(manifest.memes, font);
    fs.writeFileSync(path.join(OG_DIR, '_x-banner.png'), xBannerPng);
    console.log('[og] _x-banner.png rendered');
  } catch (err) {
    console.error(`[og] x banner: ${(err as Error).message}`);
  }

  // Weekly snapshot OGs — one per committed week in site/src/data/weekly/.
  // Cheap: only 1 tiny PNG per week, and it's what the Monday cron shares
  // to X as a single-tweet link. Always re-render so a meme's thumbnail
  // reflects its current file (e.g. someone re-uploads a higher-res copy).
  const WEEKLY_DIR = path.join(ROOT, 'site', 'src', 'data', 'weekly');
  if (fs.existsSync(WEEKLY_DIR)) {
    const memesBySlug = new Map<string, Meme>(manifest.memes.map((m) => [m.slug, m]));
    const snapFiles = fs.readdirSync(WEEKLY_DIR).filter((f) => f.endsWith('.json')).sort();
    for (const file of snapFiles) {
      try {
        const snap = JSON.parse(fs.readFileSync(path.join(WEEKLY_DIR, file), 'utf8')) as WeeklySnapshot;
        const png = await renderWeeklyCard(snap, memesBySlug, font);
        if (!png) {
          console.log(`[og] weekly ${snap.week}: empty snapshot, skipping`);
          continue;
        }
        fs.writeFileSync(path.join(OG_DIR, `week-${snap.week}.png`), png);
        console.log(`[og] week-${snap.week}.png rendered`);
      } catch (err) {
        console.error(`[og] weekly ${file}: ${(err as Error).message}`);
      }
    }
  }
}

async function renderXBanner(memes: Meme[], font: ArrayBuffer): Promise<Buffer> {
  const CANVAS_W = 1500, CANVAS_H = 500;
  const COUNT = 75;
  const step = Math.max(1, memes.length / COUNT);
  const picked: Meme[] = [];
  for (let i = 0; picked.length < COUNT && Math.floor(i * step) < memes.length; i++) {
    picked.push(memes[Math.floor(i * step)]);
  }

  const W = 95, H = 110;
  const HSTEP = W;
  const VSTEP = Math.round(H * 0.75);
  const ROWS = 5, COLS = 15;
  const gridW = COLS * HSTEP + HSTEP / 2;
  const gridH = (ROWS - 1) * VSTEP + H;
  const xOrigin = Math.round((CANVAS_W - gridW) / 2);
  const yOrigin = Math.round((CANVAS_H - gridH) / 2);

  const cells: unknown[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      if (i >= picked.length) break;
      const m = picked[i];
      const xShift = r % 2 === 0 ? 0 : HSTEP / 2;
      const x = xOrigin + c * HSTEP + xShift;
      const y = yOrigin + r * VSTEP;
      cells.push({
        type: 'div',
        props: {
          style: {
            position: 'absolute',
            left: x, top: y, width: W, height: H,
            display: 'flex', overflow: 'hidden',
            clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
          },
          children: [{
            type: 'img',
            props: {
              src: thumbnailDataUrl(m.filename, W, H),
              style: { width: '100%', height: '100%', objectFit: 'cover' },
            },
          }],
        },
      });
    }
  }

  const tree = {
    type: 'div',
    props: {
      style: {
        width: CANVAS_W, height: CANVAS_H,
        display: 'flex', position: 'relative',
        fontFamily: 'Inter',
        background: 'linear-gradient(135deg, #2f62df 0%, #1a3ba7 55%, #0d2270 100%)',
        color: 'white',
        overflow: 'hidden',
      },
      children: [
        ...cells,
        { type: 'div', props: {
          style: {
            position: 'absolute', inset: 0,
            background: 'radial-gradient(ellipse 70% 65% at 50% 50%, rgba(13,34,112,0.05) 0%, rgba(13,34,112,0.55) 55%, rgba(13,34,112,0.9) 100%)',
          },
        } },
        { type: 'div', props: {
          style: {
            position: 'absolute', left: 0, right: 0, top: 160, height: 180,
            background: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.7) 20%, rgba(0,0,0,0.82) 50%, rgba(0,0,0,0.7) 80%, transparent 100%)',
          },
        } },
        { type: 'div', props: {
          style: {
            position: 'absolute', left: 0, right: 0, top: 180,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 16, fontSize: 26, fontWeight: 700, letterSpacing: 7,
            textTransform: 'uppercase', opacity: 0.95,
          },
          children: [
            hexImg(22, 'white', 0.9, false),
            hexImg(22, 'white', 0.9, true),
            hexImg(22, 'white', 0.9, false),
            { type: 'span', props: { style: { display: 'flex', margin: '0 10px' }, children: 'chainlink meme' } },
            hexImg(22, 'white', 0.9, false),
            hexImg(22, 'white', 0.9, true),
            hexImg(22, 'white', 0.9, false),
          ],
        } },
        { type: 'div', props: {
          style: {
            position: 'absolute', left: 0, right: 0, top: 222,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 112, fontWeight: 900, letterSpacing: -4, lineHeight: 1,
          },
          children: 'chainlinkme.me',
        } },
        { type: 'div', props: {
          style: {
            position: 'absolute', left: 0, right: 0, top: 355,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20, fontWeight: 600, letterSpacing: 4,
            textTransform: 'uppercase', opacity: 0.8,
          },
          children: 'cosmic memes by linkmarines · /clmeme in your discord',
        } },
      ],
    },
  };

  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: CANVAS_W, height: CANVAS_H,
    fonts: [{ name: 'Inter', data: font, style: 'normal', weight: 800 }],
  });
  return Buffer.from(new Resvg(svg).render().asPng());
}

// Discord bot banner: 680×240, hex-packed meme mosaic with a centered
// brand strip. Same pattern as the home OG, different proportions.
async function renderBanner(memes: Meme[], font: ArrayBuffer): Promise<Buffer> {
  const CANVAS_W = 680, CANVAS_H = 240;
  const COUNT = 48;
  const step = Math.max(1, memes.length / COUNT);
  const picked: Meme[] = [];
  for (let i = 0; picked.length < COUNT && Math.floor(i * step) < memes.length; i++) {
    picked.push(memes[Math.floor(i * step)]);
  }

  const W = 62, H = 72;
  const HSTEP = W;
  const VSTEP = Math.round(H * 0.75); // 54
  const ROWS = 4, COLS = 12;
  const gridW = COLS * HSTEP + HSTEP / 2;
  const gridH = (ROWS - 1) * VSTEP + H;
  const xOrigin = Math.round((CANVAS_W - gridW) / 2);
  const yOrigin = Math.round((CANVAS_H - gridH) / 2);

  const cells: unknown[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      if (i >= picked.length) break;
      const m = picked[i];
      const xShift = r % 2 === 0 ? 0 : HSTEP / 2;
      const x = xOrigin + c * HSTEP + xShift;
      const y = yOrigin + r * VSTEP;
      cells.push({
        type: 'div',
        props: {
          style: {
            position: 'absolute',
            left: x, top: y, width: W, height: H,
            display: 'flex', overflow: 'hidden',
            clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)',
          },
          children: [{
            type: 'img',
            props: {
              src: thumbnailDataUrl(m.filename, W, H),
              style: { width: '100%', height: '100%', objectFit: 'cover' },
            },
          }],
        },
      });
    }
  }

  const tree = {
    type: 'div',
    props: {
      style: {
        width: CANVAS_W, height: CANVAS_H,
        display: 'flex', position: 'relative',
        fontFamily: 'Inter',
        background: 'linear-gradient(135deg, #2f62df 0%, #1a3ba7 55%, #0d2270 100%)',
        color: 'white',
        overflow: 'hidden',
      },
      children: [
        ...cells,
        { type: 'div', props: {
          style: {
            position: 'absolute', inset: 0,
            background: 'radial-gradient(ellipse 70% 70% at 50% 50%, rgba(13,34,112,0.1) 0%, rgba(13,34,112,0.65) 60%, rgba(13,34,112,0.9) 100%)',
          },
        } },
        { type: 'div', props: {
          style: {
            position: 'absolute', left: 0, right: 0, top: 70, height: 100,
            background: 'linear-gradient(180deg, transparent 0%, rgba(0,0,0,0.7) 20%, rgba(0,0,0,0.8) 50%, rgba(0,0,0,0.7) 80%, transparent 100%)',
          },
        } },
        // Brand hex marks + "chainlinkme.me" wordmark centered.
        { type: 'div', props: {
          style: {
            position: 'absolute', left: 0, right: 0, top: 80,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: 10, fontSize: 15, fontWeight: 700, letterSpacing: 5,
            textTransform: 'uppercase', opacity: 0.95,
          },
          children: [
            hexImg(13, 'white', 0.9, false),
            hexImg(13, 'white', 0.9, true),
            hexImg(13, 'white', 0.9, false),
            { type: 'span', props: { style: { display: 'flex', margin: '0 6px' }, children: 'chainlink meme' } },
            hexImg(13, 'white', 0.9, false),
            hexImg(13, 'white', 0.9, true),
            hexImg(13, 'white', 0.9, false),
          ],
        } },
        { type: 'div', props: {
          style: {
            position: 'absolute', left: 0, right: 0, top: 108,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 52, fontWeight: 900, letterSpacing: -2, lineHeight: 1,
          },
          children: 'chainlinkme.me',
        } },
        { type: 'div', props: {
          style: {
            position: 'absolute', left: 0, right: 0, top: 168,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 12, fontWeight: 600, letterSpacing: 3,
            textTransform: 'uppercase', opacity: 0.75,
          },
          children: '/clmeme · cosmic memes by linkmarines',
        } },
      ],
    },
  };

  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: CANVAS_W, height: CANVAS_H,
    fonts: [{ name: 'Inter', data: font, style: 'normal', weight: 800 }],
  });
  return Buffer.from(new Resvg(svg).render().asPng());
}

main().catch((err) => { console.error(err); process.exit(1); });

// Renders the memeverse as still images for places WebGL can't go:
//
//   site/public/og/_verse.png        1200×630 unfurl card for /verse
//   site/public/atlas/banner.webp    the home page's portal into it
//
// Same layout, same tiles, same camera angle as the live page — projected
// on the CPU and composited with sharp, with the type set by resvg in the
// vendored Inter. Runs after build-atlas.ts; cheap enough to run every build.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { Resvg } from '@resvg/resvg-js';
import { TILE, tileOrigin, type AtlasMeta } from '../site/src/lib/atlas-format';
import { buildLayout, positionAt } from '../site/src/verse/layout';
import { lookAt, multiply, perspective, type Vec3 } from '../site/src/verse/math';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MANIFEST_PATH = path.join(ROOT, 'site', 'public', 'manifest.json');
const ATLAS_DIR = path.join(ROOT, 'site', 'public', 'atlas');
const OG_DIR = path.join(ROOT, 'site', 'public', 'og');
const FONT_PATH = path.join(ROOT, 'scripts', 'assets', 'Inter-Bold.ttf');
// Bump when the look of either image changes.
const STAMP_VERSION = 1;

interface Meme { slug: string; tags: string[] }

interface Shot {
  width: number;
  height: number;
  yaw: number;
  pitch: number;
  dist: number; // × galaxy extent
  shift: [number, number]; // where the galaxy centre lands, as a fraction of the frame
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexPoints(cx: number, cy: number, r: number): string {
  const hw = (r * Math.sqrt(3)) / 2;
  return [
    [cx, cy - r], [cx + hw, cy - r / 2], [cx + hw, cy + r / 2],
    [cx, cy + r], [cx - hw, cy + r / 2], [cx - hw, cy - r / 2],
  ].map(([x, y]) => `${x!.toFixed(1)},${y!.toFixed(1)}`).join(' ');
}

async function render(
  shot: Shot,
  memes: Meme[],
  atlas: AtlasMeta,
  sheets: { data: Buffer; width: number }[],
): Promise<sharp.Sharp> {
  const { width: W, height: H } = shot;
  const layout = buildLayout(memes, atlas.colors);
  const ext = layout.extent;
  const dist = ext * shot.dist;
  const cp = Math.cos(shot.pitch);
  const eye: Vec3 = [dist * cp * Math.sin(shot.yaw), dist * Math.sin(shot.pitch), dist * cp * Math.cos(shot.yaw)];
  const fov = (55 * Math.PI) / 180;
  const view = lookAt(eye, [0, 0, 0], [0, 1, 0]);
  const proj = perspective(fov, W / H, 1, 6000);
  const vp = multiply(proj, view);
  const k = proj[5]! * (H / 2);
  const ox = (shot.shift[0] - 0.5) * W, oy = (shot.shift[1] - 0.5) * H;
  const toScreen = (p: Vec3) => {
    const cx = vp[0]! * p[0] + vp[4]! * p[1] + vp[8]! * p[2] + vp[12]!;
    const cy = vp[1]! * p[0] + vp[5]! * p[1] + vp[9]! * p[2] + vp[13]!;
    const cw = vp[3]! * p[0] + vp[7]! * p[1] + vp[11]! * p[2] + vp[15]!;
    return { x: (cx / cw + 1) * (W / 2) + ox, y: (1 - cy / cw) * (H / 2) + oy, w: cw };
  };

  const rand = rng(42);
  // Sky, stars and the dust disc as one SVG underlay.
  let sky = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="bg" cx="${shot.shift[0] * 100}%" cy="${shot.shift[1] * 100}%" r="85%">
      <stop offset="0" stop-color="#101c44"/><stop offset="0.55" stop-color="#070b1c"/><stop offset="1" stop-color="#03050c"/>
    </radialGradient>
    <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(W / 90).toFixed(1)}"/></filter>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(W / 240).toFixed(1)}"/></filter>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>`;
  for (let i = 0; i < 5; i++) {
    const cx = rand() * W, cy = rand() * H, rx = W * (0.15 + rand() * 0.25), ry = rx * (0.4 + rand() * 0.4);
    const col = i % 2 ? '#3b1d6e' : '#16307a';
    sky += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${col}" opacity="0.35" filter="url(#blur)"/>`;
  }
  for (let i = 0; i < W * H / 2600; i++) {
    sky += `<circle cx="${(rand() * W).toFixed(1)}" cy="${(rand() * H).toFixed(1)}" r="${(0.4 + rand() * 1.1).toFixed(2)}" fill="#dfe8ff" opacity="${(0.25 + rand() * 0.6).toFixed(2)}"/>`;
  }
  // Disc glow and the two arms, projected from the galactic plane.
  const core = layout.systems.find((s) => s.arm === -1);
  const r0 = (core?.radius ?? 20) + 7;
  const c0 = toScreen([0, 0, 0]);
  let ring = '';
  for (let a = 0; a <= 64; a++) {
    const t = (a / 64) * Math.PI * 2;
    const p = toScreen([Math.cos(t) * ext * 0.62, 0, Math.sin(t) * ext * 0.62]);
    ring += `${a ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  }
  sky += `<path d="${ring}Z" fill="#2a4fc0" opacity="0.28" filter="url(#blur)"/>`;
  for (let arm = 0; arm < 2; arm++) {
    let d = '';
    for (let s = 0; s <= 160; s++) {
      const th = s * 0.04;
      const r = r0 * Math.exp(0.2 * th) + 8;
      if (r > ext * 0.95) break;
      const p = toScreen([Math.cos(th + arm * Math.PI) * r, 0, Math.sin(th + arm * Math.PI) * r]);
      d += `${s ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    }
    sky += `<path d="${d}" fill="none" stroke="#5b86ff" stroke-width="${(W / 45).toFixed(1)}" stroke-linecap="round" opacity="0.32" filter="url(#blur)"/>`;
  }
  sky += `<circle cx="${c0.x}" cy="${c0.y}" r="${(W / 22).toFixed(1)}" fill="#cfdcff" opacity="0.55" filter="url(#blur)"/>`;
  sky += '</svg>';

  // Tiles, far to near. Tiny ones become coloured stars in one SVG layer;
  // anything bigger than a few pixels gets its real hex-cropped tile.
  const placed = memes.map((_, i) => ({ i, s: toScreen(positionAt(layout, i, 0, 0)) }))
    .filter((t) => t.s.w > 1)
    .sort((a, b) => b.s.w - a.s.w);
  let stars = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><filter id="g" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="1.6"/></filter></defs>`;
  const composites: sharp.OverlayOptions[] = [];
  const U0 = Math.round(TILE * (1 - Math.sqrt(3) / 2) / 2);
  for (const { i, s } of placed) {
    const pr = k / s.w; // tile circumradius in px
    if (pr < 3.2) {
      const c = atlas.colors[i] ?? '#9ab';
      stars += `<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${Math.max(0.9, pr * 1.4).toFixed(2)}" fill="${c}" opacity="0.9" filter="url(#g)"/>`;
      stars += `<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${Math.max(0.6, pr * 0.7).toFixed(2)}" fill="#ffffff" opacity="0.8"/>`;
      continue;
    }
    const h = Math.max(4, Math.round(pr * 2));
    const w = Math.max(4, Math.round(pr * Math.sqrt(3)));
    const left = Math.round(s.x - w / 2), top = Math.round(s.y - h / 2);
    if (left + w < 0 || top + h < 0 || left >= W || top >= H) continue;
    const { page, x, y } = tileOrigin(i);
    const sheet = sheets[page];
    if (!sheet) continue;
    const raw = Buffer.alloc(TILE * TILE * 3);
    for (let row = 0; row < TILE; row++) {
      sheet.data.copy(raw, row * TILE * 3, ((y + row) * sheet.width + x) * 3, ((y + row) * sheet.width + x + TILE) * 3);
    }
    const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><polygon points="${hexPoints(w / 2, h / 2, h / 2)}" fill="#fff"/></svg>`);
    const tile = await sharp(raw, { raw: { width: TILE, height: TILE, channels: 3 } })
      .extract({ left: U0, top: 0, width: TILE - U0 * 2, height: TILE })
      .resize(w, h, { fit: 'fill' })
      .ensureAlpha()
      .composite([{ input: mask, blend: 'dest-in' }])
      .png()
      .toBuffer();
    // Clip to the frame — sharp refuses overlays that hang off the edge.
    const cl = Math.max(0, -left), ct = Math.max(0, -top);
    const cw = Math.min(w - cl, W - Math.max(0, left)), ch = Math.min(h - ct, H - Math.max(0, top));
    if (cw <= 0 || ch <= 0) continue;
    const input = cl || ct || cw < w || ch < h
      ? await sharp(tile).extract({ left: cl, top: ct, width: cw, height: ch }).toBuffer()
      : tile;
    composites.push({ input, left: Math.max(0, left), top: Math.max(0, top) });
  }
  stars += '</svg>';
  const ringR = Math.max(6, (k / c0.w) * 6.5);
  const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><filter id="l" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="${(ringR * 0.35).toFixed(1)}"/></filter></defs>
    <polygon points="${hexPoints(c0.x, c0.y, ringR)}" fill="none" stroke="#4a8eff" stroke-width="${(ringR * 0.5).toFixed(1)}" filter="url(#l)" opacity="0.9"/>
    <polygon points="${hexPoints(c0.x, c0.y, ringR)}" fill="none" stroke="#f2f6ff" stroke-width="${(ringR * 0.28).toFixed(1)}" stroke-linejoin="round"/></svg>`;

  return sharp(Buffer.from(sky))
    .composite([
      { input: Buffer.from(stars) },
      { input: Buffer.from(logo) },
      ...composites,
    ]);
}

function text(svg: string, width: number): Buffer {
  return Buffer.from(new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { fontFiles: [FONT_PATH], loadSystemFonts: false, defaultFontFamily: 'Inter' },
  }).render().asPng());
}

async function main(): Promise<void> {
  const metaPath = path.join(ATLAS_DIR, 'atlas.json');
  if (!fs.existsSync(metaPath) || !fs.existsSync(MANIFEST_PATH)) {
    console.warn('[verse-og] no atlas or manifest — run build-atlas.ts first; skipping');
    return;
  }
  const atlas = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as AtlasMeta;
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as { memes: Meme[] };
  const bySlug = new Map(manifest.memes.map((m) => [m.slug, m]));
  const memes = atlas.slugs.map((slug) => bySlug.get(slug) ?? { slug, tags: [] });
  const sheets = await Promise.all(Array.from({ length: atlas.pages }, async (_, p) => {
    const { data, info } = await sharp(path.join(ATLAS_DIR, `tiles-${p}.webp`)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width };
  }));
  const systems = buildLayout(memes, atlas.colors).systems.length;
  fs.mkdirSync(OG_DIR, { recursive: true });

  // Skip when the atlas hasn't changed since the last render and both
  // outputs are still on disk (CI restores og/ and atlas/ from separate caches).
  const stamp = path.join(ATLAS_DIR, 'verse-og.stamp');
  const want = `${STAMP_VERSION}:${atlas.signature}`;
  if (
    fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want
    && fs.existsSync(path.join(OG_DIR, '_verse.png')) && fs.existsSync(path.join(ATLAS_DIR, 'banner.webp'))
  ) {
    console.log('[verse-og] up to date — skipping');
    return;
  }

  // Unfurl card: galaxy on the right, title on the left.
  const og = await render({ width: 1200, height: 630, yaw: 0.35, pitch: 0.6, dist: 1.02, shift: [0.66, 0.55] }, memes, atlas, sheets);
  const ogBase = await og.png().toBuffer();
  const ogText = text(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
    <defs>
      <linearGradient id="fade" x1="0" x2="1"><stop offset="0" stop-color="#03050c" stop-opacity="0.92"/><stop offset="0.55" stop-color="#03050c" stop-opacity="0"/></linearGradient>
      <filter id="glow" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>
    </defs>
    <rect width="1200" height="630" fill="url(#fade)"/>
    <text x="64" y="118" font-family="Inter" font-size="22" fill="#6fa0ff" letter-spacing="5">CHAINLINKME.ME PRESENTS</text>
    <text x="60" y="226" font-family="Inter" font-size="86" fill="#4a8eff" filter="url(#glow)" opacity="0.8">THE</text>
    <text x="60" y="226" font-family="Inter" font-size="86" fill="#ffffff">THE</text>
    <text x="60" y="318" font-family="Inter" font-size="86" fill="#4a8eff" filter="url(#glow)" opacity="0.8">MEMEVERSE</text>
    <text x="60" y="318" font-family="Inter" font-size="86" fill="#ffffff">MEMEVERSE</text>
    <text x="64" y="378" font-family="Inter" font-size="27" fill="#c3d0f5">every chainlink meme, one galaxy</text>
    <text x="64" y="470" font-family="Inter" font-size="22" fill="#8fa4d8">${atlas.count.toLocaleString('en-US')} memes · ${systems} star systems</text>
    <text x="64" y="506" font-family="Inter" font-size="22" fill="#8fa4d8">fly through it · assemble yourself</text>
    <text x="64" y="572" font-family="Inter" font-size="20" fill="#5f79b8" letter-spacing="2">chainlinkme.me/verse</text>
  </svg>`, 1200);
  await sharp(ogBase).composite([{ input: ogText }]).png({ compressionLevel: 9 }).toFile(path.join(OG_DIR, '_verse.png'));

  // Home banner: wider, no type (the page sets it in HTML).
  const banner = await render({ width: 1600, height: 520, yaw: 0.3, pitch: 0.5, dist: 0.9, shift: [0.68, 0.56] }, memes, atlas, sheets);
  await banner.webp({ quality: 80 }).toFile(path.join(ATLAS_DIR, 'banner.webp'));
  fs.writeFileSync(stamp, want);
  console.log('[verse-og] wrote og/_verse.png and atlas/banner.webp');
}

main().catch((err) => { console.error(err); process.exit(1); });

// Shared between scripts/build-atlas.ts (Node, build time) and the browser
// (the memeverse + assemble). Both sides must agree byte-for-byte on how a
// hex cell is described, or the mosaic matcher compares apples to pears — so
// the geometry and the colour maths live here, once.
//
// A tile is a square TILE×TILE crop of a meme. The memeverse draws it as a
// pointy-top hexagon inscribed in that square: height = TILE, width =
// TILE·√3/2, so ~6.7% is trimmed off the left and right edges.

export const TILE = 64;
export const PAGE = 2048;
export const COLS = PAGE / TILE; // 32 tiles per row
export const PER_PAGE = COLS * COLS; // 1,024 tiles per sheet
export const ATLAS_VERSION = 1;

// Each hex is described by the mean CIE Lab colour of a GRID×GRID set of
// bins laid over its bounding box (pixels outside the hex are ignored).
// 4×4 is enough to match edges and faces, and keeps a brute-force search
// over ~1,800 candidates well under a second in the browser.
export const GRID = 4;
export const BINS = GRID * GRID;
export const FEAT_DIM = BINS * 3;

export const SQRT3 = Math.sqrt(3);

// The home page's living honeycomb draws from a smaller sheet of its own:
// the HERO_COUNT most colourful memes, HERO_TILE px each, HERO_COLS across,
// in atlas tile order (see build-verse-og.ts).
export const HERO_TILE = 48;
export const HERO_COLS = 16;
export const HERO_COUNT = 224;

// Fraction of the square tile the hex spans horizontally; the shader maps the
// hex's bounding box to [HEX_U0, 1 - HEX_U0] × [0, 1] of the tile.
export const HEX_U0 = (1 - SQRT3 / 2) / 2;

export interface AtlasMeta {
  version: number;
  generated_at: string;
  signature: string;
  tile: number;
  page: number;
  cols: number;
  pages: number;
  count: number;
  slugs: string[];
  // Mean sRGB colour of each tile's hex, as #rrggbb. Paints the galaxy while
  // the sheets stream in, and colours far-away tiles that render as stars.
  colors: string[];
}

// Pointy-top hex centred on (cx, cy) with circumradius r.
export function insideHex(px: number, py: number, cx: number, cy: number, r: number): boolean {
  const dx = Math.abs(px - cx);
  const dy = Math.abs(py - cy);
  const hw = (r * SQRT3) / 2;
  if (dx > hw || dy > r) return false;
  // The slanted edges: r - dy ≥ dx / √3.
  return r * hw - hw * dy - (r / 2) * dx >= 0;
}

function lin(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function labF(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
}

// sRGB (0–255) → CIE Lab (D65). Writes into out[o..o+2].
export function rgbToLab(r: number, g: number, b: number, out: Float32Array | number[], o = 0): void {
  const R = lin(r), G = lin(g), B = lin(b);
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const fx = labF(x), fy = labF(y), fz = labF(z);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

// A 256-entry sRGB→linear table makes the per-pixel conversion cheap enough
// to run over a whole photo in the browser.
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) LIN[i] = lin(i);

function rgbToLabFast(r: number, g: number, b: number, out: Float32Array, o: number): void {
  const R = LIN[r]!, G = LIN[g]!, B = LIN[b]!;
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const y = R * 0.2126729 + G * 0.7151522 + B * 0.072175;
  const z = (R * 0.0193339 + G * 0.119192 + B * 0.9503041) / 1.08883;
  const fx = labF(x), fy = labF(y), fz = labF(z);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

export interface PixelSource {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: number; // 3 (raw RGB from sharp) or 4 (canvas RGBA)
}

const lab = new Float32Array(3);

// Mean Lab per bin for the hex centred on (cx, cy) with radius r, in pixel
// space of `src`. Bins with no pixels inside the hex (only possible for tiny
// hexes) borrow the hex's overall mean so they never pull matches to black.
// Also returns the mean sRGB of the whole hex through `rgbOut`.
export function hexFeatures(
  src: PixelSource,
  cx: number,
  cy: number,
  r: number,
  out: Float32Array,
  o: number,
  rgbOut?: Float32Array,
): void {
  const hw = (r * SQRT3) / 2;
  const x0 = Math.max(0, Math.floor(cx - hw));
  const x1 = Math.min(src.width - 1, Math.ceil(cx + hw));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(src.height - 1, Math.ceil(cy + r));
  const sums = new Float64Array(BINS * 3);
  const counts = new Uint32Array(BINS);
  let tr = 0, tg = 0, tb = 0, tn = 0;
  const { data, width, channels } = src;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    const by = Math.min(GRID - 1, Math.max(0, Math.floor(((py - (cy - r)) / (2 * r)) * GRID)));
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      if (!insideHex(px, py, cx, cy, r)) continue;
      const bx = Math.min(GRID - 1, Math.max(0, Math.floor(((px - (cx - hw)) / (2 * hw)) * GRID)));
      const i = (y * width + x) * channels;
      const R = data[i]!, G = data[i + 1]!, B = data[i + 2]!;
      rgbToLabFast(R, G, B, lab, 0);
      const bin = by * GRID + bx;
      sums[bin * 3] += lab[0]!;
      sums[bin * 3 + 1] += lab[1]!;
      sums[bin * 3 + 2] += lab[2]!;
      counts[bin]!++;
      tr += R; tg += G; tb += B; tn++;
    }
  }
  let mL = 0, mA = 0, mB = 0, mN = 0;
  for (let b = 0; b < BINS; b++) {
    mL += sums[b * 3]!; mA += sums[b * 3 + 1]!; mB += sums[b * 3 + 2]!; mN += counts[b]!;
  }
  const fallback = mN > 0 ? [mL / mN, mA / mN, mB / mN] : [50, 0, 0];
  for (let b = 0; b < BINS; b++) {
    const n = counts[b]!;
    out[o + b * 3] = n ? sums[b * 3]! / n : fallback[0]!;
    out[o + b * 3 + 1] = n ? sums[b * 3 + 1]! / n : fallback[1]!;
    out[o + b * 3 + 2] = n ? sums[b * 3 + 2]! / n : fallback[2]!;
  }
  if (rgbOut) {
    rgbOut[0] = tn ? tr / tn : 128;
    rgbOut[1] = tn ? tg / tn : 128;
    rgbOut[2] = tn ? tb / tn : 128;
  }
}

// features.bin stores each dimension as one byte: L 0–100 → 0–250, a/b
// shifted by +128. ~1,800 memes × 48 dims ≈ 87 KB on the wire.
export function quantizeFeatures(f: Float32Array): Uint8Array {
  const q = new Uint8Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = f[i]!;
    q[i] = i % 3 === 0
      ? Math.max(0, Math.min(255, Math.round(v * 2.5)))
      : Math.max(0, Math.min(255, Math.round(v + 128)));
  }
  return q;
}

export function dequantizeFeatures(q: Uint8Array): Float32Array {
  const f = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) f[i] = i % 3 === 0 ? q[i]! / 2.5 : q[i]! - 128;
  return f;
}

// How much a tile has going on: mean chroma across its bins plus the spread
// of its brightness. High for colourful, contrasty memes; low for screenshots
// of text. Picks the hero honeycomb's tiles and each tag's cover.
export function colorfulness(features: Float32Array, i: number): number {
  let chroma = 0, mean = 0, sq = 0;
  for (let b = 0; b < BINS; b++) {
    const o = i * FEAT_DIM + b * 3;
    const L = features[o]!, A = features[o + 1]!, B = features[o + 2]!;
    chroma += Math.hypot(A, B);
    mean += L;
    sq += L * L;
  }
  mean /= BINS;
  return chroma / BINS + Math.sqrt(Math.max(0, sq / BINS - mean * mean)) * 0.8;
}

export function tileOrigin(index: number): { page: number; x: number; y: number } {
  const page = Math.floor(index / PER_PAGE);
  const cell = index % PER_PAGE;
  return { page, x: (cell % COLS) * TILE, y: Math.floor(cell / COLS) * TILE };
}

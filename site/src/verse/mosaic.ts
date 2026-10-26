// Assemble: rebuild a picture out of the archive.
//
// The picture is cut into a honeycomb (pointy-top hexes, odd rows shifted
// half a hex), every cell is described exactly the way build-atlas.ts
// described every meme (mean Lab colour over a 4×4 grid of bins inside the
// hex), and each cell gets the meme whose description is closest — with a
// penalty for reusing a meme and a ban on repeating one inside the same
// neighbourhood, so a face comes out of hundreds of different memes rather
// than the same three beige ones.
//
// Everything runs in the browser: the photo never leaves the device.

import { BINS, FEAT_DIM, SQRT3, TILE, hexFeatures, insideHex, tileOrigin } from '../lib/atlas-format';
import { mulberry32 } from './math';

export type MosaicShape = 'hex' | 'square';

export interface MosaicCell {
  tile: number;
  col: number;
  row: number;
  u: number; // plane coords, world units, centred on the portrait
  v: number;
  relief: number;
  tint: [number, number, number];
  delay: number;
  rgb: [number, number, number]; // the source photo's mean colour here
}

export interface MosaicResult {
  cols: number;
  rows: number;
  r: number; // cell circumradius, world units
  width: number;
  height: number;
  shape: MosaicShape;
  cells: MosaicCell[];
  distinct: number;
  cellAt(u: number, v: number): number;
}

export const PORTRAIT_SIZE = 96; // world units, side of the square the honeycomb fills

interface Grid {
  cols: number;
  rows: number;
  r: number; // in units where the portrait is `size` wide
  w: number;
  size: number;
  centers: { col: number; row: number; x: number; y: number }[]; // y down, origin top-left
}

// The honeycomb covering a size×size square: hex (col, row) sits at
// x = w·(col + (row odd ? ½ : 0)), y = r + 1.5·r·row, so even rows start
// half-off the left edge and odd rows end half-off the right. Anything that
// misses the square — or, for the hex shape, the big hex inscribed in it — is
// dropped.
function honeycomb(cols: number, size: number, shape: MosaicShape): Grid {
  const w = size / cols;
  const r = w / SQRT3;
  const rows = Math.ceil((size - r) / (1.5 * r)) + 1;
  const centers: Grid['centers'] = [];
  const c = size / 2;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col <= cols; col++) {
      const x = w * (col + (row & 1) / 2);
      const y = r + row * 1.5 * r;
      if (x + w / 2 <= 0 || x - w / 2 >= size || y - r >= size) continue;
      if (shape === 'hex' && !insideHex(x, y, c, c, c - r * 0.25)) continue;
      centers.push({ col, row, x, y });
    }
  }
  return { cols: cols + 1, rows, r, w, size, centers };
}

export interface PreparedSource {
  grid: Grid;
  features: Float32Array;
  rgb: Float32Array;
}

// Draws the cropped picture to a working canvas sized so each hex covers
// roughly 14px, and describes every cell of the honeycomb.
export function describeSource(
  source: CanvasImageSource,
  crop: { x: number; y: number; size: number },
  cols: number,
  shape: MosaicShape,
): PreparedSource {
  const px = Math.min(1400, Math.max(320, cols * 14));
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, px, px);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, crop.x, crop.y, crop.size, crop.size, 0, 0, px, px);
  const img = ctx.getImageData(0, 0, px, px);
  const grid = honeycomb(cols, px, shape);
  const n = grid.centers.length;
  const features = new Float32Array(n * FEAT_DIM);
  const rgb = new Float32Array(n * 3);
  const tmp = new Float32Array(3);
  grid.centers.forEach((c, i) => {
    hexFeatures({ data: img.data, width: px, height: px, channels: 4 }, c.x, c.y, grid.r, features, i * FEAT_DIM, tmp);
    rgb[i * 3] = tmp[0]!;
    rgb[i * 3 + 1] = tmp[1]!;
    rgb[i * 3 + 2] = tmp[2]!;
  });
  return { grid, features, rgb };
}

function meanLab(f: Float32Array, i: number, out: Float32Array, o: number): void {
  let L = 0, A = 0, B = 0;
  const base = i * FEAT_DIM;
  for (let b = 0; b < BINS; b++) {
    L += f[base + b * 3]!;
    A += f[base + b * 3 + 1]!;
    B += f[base + b * 3 + 2]!;
  }
  out[o] = L / BINS;
  out[o + 1] = A / BINS;
  out[o + 2] = B / BINS;
}

const K = 56;

export async function matchMosaic(
  src: PreparedSource,
  tileFeatures: Float32Array,
  tileColors: [number, number, number][],
  opts: { exclude?: Set<number>; onProgress?: (p: number) => void; seed?: number } = {},
): Promise<{ assign: Int32Array; distinct: number }> {
  const nTiles = tileColors.length;
  const nCells = src.grid.centers.length;
  const tMean = new Float32Array(nTiles * 3);
  for (let t = 0; t < nTiles; t++) meanLab(tileFeatures, t, tMean, t * 3);
  const cMean = new Float32Array(nCells * 3);
  for (let c = 0; c < nCells; c++) meanLab(src.features, c, cMean, c * 3);

  // Neighbourhood lookup by (row, col).
  const at = new Map<number, number>();
  const key = (row: number, col: number) => row * 4096 + col;
  src.grid.centers.forEach((c, i) => at.set(key(c.row, c.col), i));
  const neighbours = (i: number): number[] => {
    const c = src.grid.centers[i]!;
    const out: number[] = [];
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        if (!dr && !dc) continue;
        const j = at.get(key(c.row + dr, c.col + dc));
        if (j !== undefined) out.push(j);
      }
    }
    return out;
  };

  const rand = mulberry32(opts.seed ?? 1);
  const order = Array.from({ length: nCells }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }

  const assign = new Int32Array(nCells).fill(-1);
  const uses = new Uint16Array(nTiles);
  const candIdx = new Int32Array(K);
  const candD = new Float32Array(K);
  const usable = new Uint8Array(nTiles).fill(1);
  if (opts.exclude) for (const t of opts.exclude) usable[t] = 0;
  // Reuse costs climb with the square of a meme's use count, in both passes,
  // so once the best match for "beige" has been used a couple of times the
  // search widens to the next beige meme instead of stamping the same one.
  const reuse = Math.max(1, nCells / nTiles);
  const PENALTY = 220 / reuse;
  const COARSE_PENALTY = 90 / reuse;

  for (let step = 0; step < nCells; step++) {
    const c = order[step]!;
    const cl = cMean[c * 3]!, ca = cMean[c * 3 + 1]!, cb = cMean[c * 3 + 2]!;
    // Coarse pass on mean colour; keep the K closest.
    let filled = 0;
    let worst = 0;
    const argmax = () => {
      let w = 0;
      for (let k = 1; k < K; k++) if (candD[k]! > candD[w]!) w = k;
      return w;
    };
    for (let t = 0; t < nTiles; t++) {
      if (!usable[t]) continue;
      const dl = tMean[t * 3]! - cl, da = tMean[t * 3 + 1]! - ca, db = tMean[t * 3 + 2]! - cb;
      const u = uses[t]!;
      const d = dl * dl + da * da + db * db + u * u * COARSE_PENALTY;
      if (filled < K) {
        candIdx[filled] = t;
        candD[filled] = d;
        filled++;
        if (filled === K) worst = argmax();
      } else if (d < candD[worst]!) {
        candIdx[worst] = t;
        candD[worst] = d;
        worst = argmax();
      }
    }
    const banned = new Set<number>();
    for (const j of neighbours(c)) if (assign[j]! >= 0) banned.add(assign[j]!);
    // Fine pass on the full 4×4 description.
    let best = -1;
    let bestScore = Infinity;
    const fo = c * FEAT_DIM;
    for (let k = 0; k < filled; k++) {
      const t = candIdx[k]!;
      if (banned.has(t)) continue;
      const to = t * FEAT_DIM;
      let d = 0;
      for (let q = 0; q < FEAT_DIM; q++) {
        const e = tileFeatures[to + q]! - src.features[fo + q]!;
        d += e * e;
      }
      d = d / BINS + uses[t]! * uses[t]! * PENALTY;
      if (d < bestScore) { bestScore = d; best = t; }
    }
    if (best < 0) best = candIdx[0]!;
    assign[c] = best;
    uses[best]!++;
    if (step % 250 === 249) {
      opts.onProgress?.(step / nCells);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  opts.onProgress?.(1);
  let distinct = 0;
  for (let t = 0; t < nTiles; t++) if (uses[t]) distinct++;
  return { assign, distinct };
}

export function buildResult(
  src: PreparedSource,
  assign: Int32Array,
  distinct: number,
  tileColors: [number, number, number][],
  shape: MosaicShape,
  seed = 1,
): MosaicResult {
  const g = src.grid;
  const scale = PORTRAIT_SIZE / g.size;
  const r = g.r * scale;
  const half = PORTRAIT_SIZE / 2;
  const rand = mulberry32(seed + 99);
  let maxD = 1;
  for (const c of g.centers) maxD = Math.max(maxD, Math.hypot(c.x - g.size / 2, c.y - g.size / 2));
  const cells: MosaicCell[] = g.centers.map((c, i) => {
    const tile = assign[i]!;
    const cr = src.rgb[i * 3]! / 255, cg = src.rgb[i * 3 + 1]! / 255, cb = src.rgb[i * 3 + 2]! / 255;
    const tc = tileColors[tile] ?? [0.5, 0.5, 0.5];
    const lum = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
    const d = Math.hypot(c.x - g.size / 2, c.y - g.size / 2) / maxD;
    return {
      tile,
      col: c.col,
      row: c.row,
      u: c.x * scale - half,
      v: half - c.y * scale,
      relief: (lum - 0.5) * 2.4,
      tint: [cr - tc[0], cg - tc[1], cb - tc[2]],
      delay: Math.min(1, d * 0.72 + rand() * 0.28),
      rgb: [cr, cg, cb],
    };
  });

  const lookup = new Int32Array(g.rows * g.cols).fill(-1);
  cells.forEach((c, i) => { lookup[c.row * g.cols + c.col] = i; });

  return {
    cols: g.cols,
    rows: g.rows,
    r,
    width: PORTRAIT_SIZE,
    height: PORTRAIT_SIZE,
    shape,
    cells,
    distinct,
    cellAt(u: number, v: number): number {
      // Plane coords → honeycomb pixel space → axial → nearest hex.
      const px = u + half;
      const py = half - v - r;
      const qf = ((SQRT3 / 3) * px - py / 3) / r;
      const rf = ((2 / 3) * py) / r;
      const sf = -qf - rf;
      let q = Math.round(qf), rr = Math.round(rf);
      const s = Math.round(sf);
      const dq = Math.abs(q - qf), dr = Math.abs(rr - rf), ds = Math.abs(s - sf);
      if (dq > dr && dq > ds) q = -rr - s;
      else if (dr > ds) rr = -q - s;
      const row = rr;
      const col = q + (rr - (rr & 1)) / 2;
      if (row < 0 || row >= g.rows || col < 0 || col >= g.cols) return -1;
      return lookup[row * g.cols + col]!;
    },
  };
}

// ── export ──────────────────────────────────────────────────────────────

export interface Sheet {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export async function loadSheets(urls: string[]): Promise<Sheet[]> {
  return Promise.all(urls.map(async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`atlas sheet ${res.status}`);
    const bmp = await createImageBitmap(await res.blob());
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close?.();
    return { data: img.data, width: img.width, height: img.height };
  }));
}

export interface RasterOptions {
  size: number; // output px, square
  tint: number;
  gap: number; // 0–1 fraction of each hex given to the gap between hexes
  background: [number, number, number, number]; // rgba 0–255; alpha 0 = transparent
  shapeMask: boolean; // clear everything outside the honeycomb's outline
}

// The blend both renderers apply: pull a tile towards the photo's colour at
// its hex and soften the meme's own contrast a little, so the picture reads
// from across the room while every meme stays legible up close. `tile` is
// the tile's own mean, `target` the photo's, both 0–1; `px` is 0–255.
export const DETAIL_KEEP = 0.5;
function recolor(px: number, tile: number, target: number, blend: number): number {
  const shifted = (target + (px / 255 - tile) * (1 - DETAIL_KEEP * blend)) * 255;
  return Math.max(0, Math.min(255, px + (shifted - px) * blend));
}

// A small software rasteriser: every output pixel finds its hex, samples that
// meme's tile from the atlas bilinearly and applies the same blend the shader
// does. Exact, and independent of whatever the GPU is doing.
export function rasterize(result: MosaicResult, sheets: Sheet[], tileRgb: [number, number, number][], opts: RasterOptions): ImageData {
  const S = opts.size;
  const out = new ImageData(S, S);
  const d = out.data;
  const unit = result.width / S; // world units per output pixel
  const half = result.width / 2;
  const rIn = result.r * (1 - opts.gap);
  const aa = unit * 1.2;
  const hw = (rIn * SQRT3) / 2;
  const [bgR, bgG, bgB, bgA] = opts.background;
  const U0 = (1 - SQRT3 / 2) / 2;

  const sample = (tile: number, u: number, v: number, o: number[]) => {
    const { page, x, y } = tileOrigin(tile);
    const sh = sheets[page];
    if (!sh) { o[0] = o[1] = o[2] = 128; return; }
    const fx = x + Math.min(TILE - 1.001, Math.max(0, u * TILE - 0.5));
    const fy = y + Math.min(TILE - 1.001, Math.max(0, v * TILE - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const i00 = (y0 * sh.width + x0) * 4;
    const i10 = i00 + 4;
    const i01 = i00 + sh.width * 4;
    const i11 = i01 + 4;
    for (let c = 0; c < 3; c++) {
      const a = sh.data[i00 + c]! + (sh.data[i10 + c]! - sh.data[i00 + c]!) * tx;
      const b = sh.data[i01 + c]! + (sh.data[i11 + c]! - sh.data[i01 + c]!) * tx;
      o[c] = a + (b - a) * ty;
    }
  };

  const px: number[] = [0, 0, 0];
  for (let y = 0; y < S; y++) {
    const v = half - (y + 0.5) * unit;
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) * unit - half;
      const o = (y * S + x) * 4;
      const ci = result.cellAt(u, v);
      let cov = 0;
      let cell: MosaicCell | undefined;
      if (ci >= 0) {
        cell = result.cells[ci]!;
        const lx = Math.abs(u - cell.u), ly = Math.abs(v - cell.v);
        // Signed distance to the inset hex edge (positive inside).
        const dist = Math.min(hw - lx, (rIn * hw - hw * ly - (rIn / 2) * lx) / Math.hypot(hw, rIn / 2));
        cov = Math.max(0, Math.min(1, dist / aa + 0.5));
      }
      let r = bgR, g = bgG, b = bgB, a = bgA;
      if (cov > 0 && cell) {
        const lu = (u - cell.u) / rIn; // -0.866..0.866
        const lv = (v - cell.v) / rIn; // -1..1
        const tu = U0 + (lu / (SQRT3 / 2) * 0.5 + 0.5) * (1 - 2 * U0);
        const tv = 0.5 - lv * 0.5;
        sample(cell.tile, tu, tv, px);
        const tc = tileRgb[cell.tile]!;
        const tr = recolor(px[0]!, tc[0], cell.rgb[0], opts.tint);
        const tg = recolor(px[1]!, tc[1], cell.rgb[1], opts.tint);
        const tb = recolor(px[2]!, tc[2], cell.rgb[2], opts.tint);
        if (bgA === 0) {
          r = tr; g = tg; b = tb; a = 255 * cov;
        } else {
          r = bgR + (tr - bgR) * cov;
          g = bgG + (tg - bgG) * cov;
          b = bgB + (tb - bgB) * cov;
        }
      } else if (opts.shapeMask && ci < 0 && bgA !== 0) {
        a = bgA;
      }
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = a;
    }
  }
  return out;
}

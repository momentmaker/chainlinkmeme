import { describe, expect, it } from 'vitest';
import { FEAT_DIM, dequantizeFeatures, hexFeatures, insideHex, quantizeFeatures, rgbToLab, SQRT3 } from '../lib/atlas-format';
import { buildResult, matchMosaic, type PreparedSource } from './mosaic';

// A synthetic honeycomb + archive: no canvas needed. Each "meme" is a flat
// colour, each cell asks for one of those colours.
function setup(cols: number, rows: number, tileCount: number) {
  const size = 100;
  const w = size / cols;
  const r = w / SQRT3;
  const centers: PreparedSource['grid']['centers'] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col <= cols; col++) {
      centers.push({ col, row, x: w * (col + (row & 1) / 2), y: r + row * 1.5 * r });
    }
  }
  const lab = new Float32Array(3);
  const colourOf = (k: number): [number, number, number] => [(k * 37) % 256, (k * 91) % 256, (k * 53) % 256];
  const tileFeatures = new Float32Array(tileCount * FEAT_DIM);
  const tileColors: [number, number, number][] = [];
  for (let t = 0; t < tileCount; t++) {
    const [R, G, B] = colourOf(t);
    rgbToLab(R, G, B, lab);
    for (let q = 0; q < FEAT_DIM; q += 3) tileFeatures.set(lab, t * FEAT_DIM + q);
    tileColors.push([R / 255, G / 255, B / 255]);
  }
  const features = new Float32Array(centers.length * FEAT_DIM);
  const rgb = new Float32Array(centers.length * 3);
  centers.forEach((_, i) => {
    const [R, G, B] = colourOf(i % tileCount);
    rgbToLab(R, G, B, lab);
    for (let q = 0; q < FEAT_DIM; q += 3) features.set(lab, i * FEAT_DIM + q);
    rgb.set([R, G, B], i * 3);
  });
  const src: PreparedSource = { grid: { cols: cols + 1, rows, r, w, size, centers }, features, rgb };
  return { src, tileFeatures, tileColors };
}

describe('matchMosaic', () => {
  it('assigns every cell, and the exact-colour meme when there is room', async () => {
    const { src, tileFeatures, tileColors } = setup(6, 5, 64);
    const { assign, distinct } = await matchMosaic(src, tileFeatures, tileColors, { seed: 3 });
    expect(Array.from(assign).every((t) => t >= 0 && t < 64)).toBe(true);
    // 35 cells asking for 35 different colours from 64 memes: all exact.
    src.grid.centers.forEach((_, i) => expect(assign[i]).toBe(i % 64));
    expect(distinct).toBe(src.grid.centers.length);
  });

  it('never repeats a meme next to itself', async () => {
    // Every cell wants colour 0, so the matcher has to spread out.
    const { src, tileFeatures, tileColors } = setup(10, 8, 40);
    for (let i = 1; i < src.grid.centers.length; i++) src.features.copyWithin(i * FEAT_DIM, 0, FEAT_DIM);
    const { assign, distinct } = await matchMosaic(src, tileFeatures, tileColors, { seed: 7 });
    expect(distinct).toBeGreaterThan(10);
    const at = new Map(src.grid.centers.map((c, i) => [`${c.row},${c.col}`, i]));
    src.grid.centers.forEach((c, i) => {
      for (const [dr, dc] of [[0, 1], [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1]]) {
        const j = at.get(`${c.row + dr!},${c.col + dc!}`);
        if (j !== undefined) expect(assign[j]).not.toBe(assign[i]);
      }
    });
  });

  it('honours excluded memes', async () => {
    const { src, tileFeatures, tileColors } = setup(4, 4, 30);
    const exclude = new Set([0, 1, 2, 3]);
    const { assign } = await matchMosaic(src, tileFeatures, tileColors, { exclude });
    for (const t of assign) expect(exclude.has(t)).toBe(false);
  });
});

describe('buildResult.cellAt', () => {
  it('finds the right cell from any point inside it', async () => {
    const { src, tileFeatures, tileColors } = setup(12, 10, 50);
    const { assign, distinct } = await matchMosaic(src, tileFeatures, tileColors);
    const res = buildResult(src, assign, distinct, tileColors, 'square');
    res.cells.forEach((c, i) => {
      expect(res.cellAt(c.u, c.v)).toBe(i);
      const inner = res.r * 0.6;
      for (let a = 0; a < 6; a++) {
        const t = (a / 6) * Math.PI * 2 + 0.3;
        expect(res.cellAt(c.u + Math.cos(t) * inner, c.v + Math.sin(t) * inner)).toBe(i);
      }
    });
    expect(res.cellAt(-1e4, 0)).toBe(-1);
  });
});

describe('atlas-format', () => {
  it('insideHex matches a pointy-top hex', () => {
    expect(insideHex(0, 0, 0, 0, 1)).toBe(true);
    expect(insideHex(0, 0.99, 0, 0, 1)).toBe(true);
    expect(insideHex(0.85, 0, 0, 0, 1)).toBe(true);
    expect(insideHex(0.9, 0, 0, 0, 1)).toBe(false);
    expect(insideHex(0.8, 0.8, 0, 0, 1)).toBe(false);
  });

  it('feature quantisation round-trips within a byte step', () => {
    const f = new Float32Array([0, -128, 127, 100, 12.3, -45.6, 55.5, 0, 0]);
    const back = dequantizeFeatures(quantizeFeatures(f));
    f.forEach((v, i) => expect(Math.abs(back[i]! - v)).toBeLessThanOrEqual(i % 3 === 0 ? 0.21 : 0.51));
  });

  it('describes a flat hex as one colour in every bin', () => {
    const S = 32;
    const data = new Uint8Array(S * S * 3);
    for (let i = 0; i < S * S; i++) data.set([200, 40, 90], i * 3);
    const out = new Float32Array(FEAT_DIM);
    const rgb = new Float32Array(3);
    hexFeatures({ data, width: S, height: S, channels: 3 }, S / 2, S / 2, S / 2, out, 0, rgb);
    const lab = new Float32Array(3);
    rgbToLab(200, 40, 90, lab);
    for (let q = 0; q < FEAT_DIM; q++) expect(out[q]).toBeCloseTo(lab[q % 3]!, 3);
    expect(Array.from(rgb)).toEqual([200, 40, 90]);
  });
});

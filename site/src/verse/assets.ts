// Loading helpers shared by the memeverse UI: the atlas metadata, the
// mosaic features, and picture sources for assemble (uploads, archive memes,
// the chainlink mark).

import { FEAT_DIM, dequantizeFeatures, type AtlasMeta } from '../lib/atlas-format';
import { fullUrl, memeUrl } from '../lib/meme-url';
import type { VerseMeme } from './engine';

export async function loadAtlasMeta(base: string, version: string): Promise<AtlasMeta> {
  const res = await fetch(`${base}/atlas.json?v=${encodeURIComponent(version)}`);
  if (!res.ok) throw new Error(`atlas.json ${res.status}`);
  return res.json() as Promise<AtlasMeta>;
}

let featuresPromise: Promise<Float32Array> | null = null;
export function loadFeatures(base: string, version: string, count: number): Promise<Float32Array> {
  featuresPromise ??= fetch(`${base}/features.bin?v=${encodeURIComponent(version)}`)
    .then((r) => {
      if (!r.ok) throw new Error(`features.bin ${r.status}`);
      return r.arrayBuffer();
    })
    .then((buf) => {
      const q = new Uint8Array(buf);
      if (q.length < count * FEAT_DIM) throw new Error('features.bin is short');
      return dequantizeFeatures(q.subarray(0, count * FEAT_DIM));
    })
    .catch((err) => { featuresPromise = null; throw err; });
  return featuresPromise;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${src}`));
    img.src = src;
  });
}

export async function imageFromFile(file: File): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try { return await loadImage(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 30_000); }
  }
}

export async function imageFromMeme(m: VerseMeme): Promise<HTMLImageElement> {
  try {
    return await loadImage(fullUrl(m.filename, { animated: m.animated }));
  } catch {
    return loadImage(memeUrl(m.filename));
  }
}

// The chainlink mark — a thick blue hex ring — as a 1024² picture to
// assemble when nobody has a photo handy.
export function chainlinkMark(): HTMLCanvasElement {
  const S = 1024;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.05, S / 2, S / 2, S * 0.75);
  g.addColorStop(0, '#f4f7ff');
  g.addColorStop(1, '#c9d6f6');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const hex = (r: number) => {
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 2 + (k * Math.PI) / 3;
      const x = S / 2 + Math.cos(a) * r;
      const y = S / 2 - Math.sin(a) * r;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  };
  hex(S * 0.36);
  ctx.fillStyle = '#2a5ada';
  ctx.fill();
  hex(S * 0.22);
  ctx.fillStyle = '#eef3ff';
  ctx.fill();
  return c;
}

export function sourceSize(src: CanvasImageSource): { w: number; h: number } {
  const s = src as { naturalWidth?: number; naturalHeight?: number; width: number; height: number };
  return { w: s.naturalWidth || s.width, h: s.naturalHeight || s.height };
}

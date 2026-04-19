// Sticker encoder. Dynamically imported from the permalink page so the
// UPNG + pako bundle (~95KB) only loads when a user clicks "save as sticker".
//
// Targets Signal's sticker pack constraints (strictest of the mainstream
// platforms, so output works on Discord/Telegram-static/WhatsApp-static too):
//   - 512×512 cover-fit
//   - ≤300KB per file
//   - Static → WebP; animated → APNG (no raw GIF)
//   - Animated clipped to 3s
//
// 'webp' and 'webm' animated formats are plumbed through for future use —
// swap the encoder at the bottom of this file to add them.

export type StickerFormat = 'apng' | 'webp' | 'webm';

export interface SaveStickerOptions {
  url: string;
  slug: string;
  animated: boolean;
  format?: StickerFormat;
  size?: number;
  maxBytes?: number;
  maxDurationMs?: number;
}

const SIGNAL_SIZE = 512;
const SIGNAL_MAX_BYTES = 300_000;
const SIGNAL_MAX_DURATION_MS = 3000;

export interface EncodedSticker {
  blob: Blob;
  filename: string;
  oversize: boolean;
  maxBytes: number;
}

export async function encodeSticker(opts: SaveStickerOptions): Promise<EncodedSticker> {
  const size = opts.size ?? SIGNAL_SIZE;
  const maxBytes = opts.maxBytes ?? SIGNAL_MAX_BYTES;
  let blob: Blob;
  let filename: string;
  if (opts.animated) {
    const format = opts.format ?? 'apng';
    if (format !== 'apng') {
      throw new Error(`sticker format not yet implemented: ${format}`);
    }
    const maxDurationMs = opts.maxDurationMs ?? SIGNAL_MAX_DURATION_MS;
    blob = await encodeAnimatedAsApng(opts.url, size, maxBytes, maxDurationMs);
    filename = `${opts.slug}-sticker.png`;
  } else {
    blob = await encodeStaticAsWebp(opts.url, size, maxBytes);
    filename = `${opts.slug}-sticker.webp`;
  }
  return { blob, filename, oversize: blob.size > maxBytes, maxBytes };
}

export async function saveAsSticker(opts: SaveStickerOptions): Promise<EncodedSticker> {
  const result = await encodeSticker(opts);
  triggerDownload(result.blob, result.filename);
  return result;
}

async function encodeStaticAsWebp(
  url: string,
  size: number,
  maxBytes: number,
): Promise<Blob> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.imageSmoothingQuality = 'high';
  drawCoverFit(ctx, img, img.width, img.height, size);
  // Step quality down until we fit the size budget. For 512×512 memes the
  // first pass (0.92) usually clears well under 100KB, so this almost never
  // iterates — but a few edge cases (dense photographic memes) need it.
  const qualities = [0.92, 0.8, 0.65, 0.5, 0.35];
  let last: Blob | null = null;
  for (const q of qualities) {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/webp', q),
    );
    if (!blob) throw new Error('toBlob failed');
    last = blob;
    if (blob.size <= maxBytes) return blob;
  }
  if (!last) throw new Error('toBlob produced nothing');
  return last;
}

async function encodeAnimatedAsApng(
  url: string,
  size: number,
  maxBytes: number,
  maxDurationMs: number,
): Promise<Blob> {
  if (typeof ImageDecoder === 'undefined') {
    throw new Error('ImageDecoder not supported in this browser');
  }
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const decoder = new ImageDecoder({ data: buf, type: mimeFromUrl(url) });
  // tracks.ready resolves once metadata (frame count, selected track) is
  // parsed. `decoder.completed` only matters for progressive/streaming input.
  await decoder.tracks.ready;
  const track = decoder.tracks.selectedTrack;
  if (!track) throw new Error('no image track');
  const frameCount = track.frameCount;
  if (frameCount === 0) throw new Error('no frames');

  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context');
  // Smoothing off: nearest-neighbor rescale keeps frame-to-frame pixel
  // placement deterministic, which gives APNG's inter-frame delta
  // compression a fighting chance on heavy-motion content.
  ctx.imageSmoothingEnabled = false;

  const rgbaBuffers: ArrayBuffer[] = [];
  const delays: number[] = [];
  let cumulativeMs = 0;
  try {
    for (let i = 0; i < frameCount; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      ctx.clearRect(0, 0, size, size);
      drawCoverFit(ctx, image, image.displayWidth, image.displayHeight, size);
      // VideoFrame.duration is microseconds; null on single-frame sources.
      const durationUs = image.duration ?? 100_000;
      const delayMs = Math.max(10, Math.round(durationUs / 1000));
      image.close();
      const imageData = ctx.getImageData(0, 0, size, size);
      rgbaBuffers.push(imageData.data.buffer);
      delays.push(delayMs);
      cumulativeMs += delayMs;
      if (cumulativeMs >= maxDurationMs) break;
    }
  } finally {
    decoder.close();
  }
  // If the last kept frame pushed us past the cap, shorten its delay so the
  // pack meets the duration limit exactly.
  if (cumulativeMs > maxDurationMs) {
    const overshoot = cumulativeMs - maxDurationMs;
    delays[delays.length - 1] = Math.max(10, delays[delays.length - 1] - overshoot);
  }

  const { default: UPNG } = await import('upng-js');

  // Encode with escalating degradation until we fit Signal's size budget:
  //   (1) encode at cnum=256 (best quality)
  //   (2) if within 1.5× budget, sweep palette 128 → 32 — palette reduction
  //       only saves ~30%, so there's no point sweeping when we're wildly
  //       over; halving frames is the only way down from there
  //   (3) halve frame count and loop
  //   (4) a 1-frame still is better than a rejected upload
  let frames = rgbaBuffers;
  let dels = delays;
  let best: ArrayBuffer | null = null;
  const PALETTE_SWEEP_THRESHOLD = 1.5;
  while (true) {
    const full = UPNG.encode(frames, size, size, 256, dels);
    debugLog(`[sticker] cnum=256 frames=${frames.length} → ${Math.round(full.byteLength / 1024)}KB`);
    if (!best || full.byteLength < best.byteLength) best = full;
    if (full.byteLength <= maxBytes) return new Blob([full], { type: 'image/apng' });
    if (full.byteLength <= maxBytes * PALETTE_SWEEP_THRESHOLD) {
      for (const cnum of [128, 64, 32]) {
        const out = UPNG.encode(frames, size, size, cnum, dels);
        debugLog(`[sticker] cnum=${cnum} frames=${frames.length} → ${Math.round(out.byteLength / 1024)}KB`);
        if (out.byteLength < best.byteLength) best = out;
        if (out.byteLength <= maxBytes) return new Blob([out], { type: 'image/apng' });
      }
    }
    if (frames.length <= 1) return new Blob([best], { type: 'image/apng' });
    const subFrames: ArrayBuffer[] = [];
    const subDels: number[] = [];
    for (let i = 0; i < frames.length; i += 2) {
      subFrames.push(frames[i]);
      subDels.push(dels[i] + (dels[i + 1] ?? 0));
    }
    frames = subFrames;
    dels = subDels;
  }
}

function drawCoverFit(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  img: CanvasImageSource,
  iw: number,
  ih: number,
  size: number,
): void {
  const scale = Math.max(size / iw, size / ih);
  const drawW = iw * scale;
  const drawH = ih * scale;
  const dx = (size - drawW) / 2;
  const dy = (size - drawH) / 2;
  ctx.drawImage(img, dx, dy, drawW, drawH);
}

function triggerDownload(blob: Blob, filename: string): void {
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
}

function mimeFromUrl(url: string): string {
  const ext = url.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'png':
    case 'apng':
      return 'image/png';
    default:
      return 'image/gif';
  }
}

function debugLog(msg: string): void {
  if (import.meta.env.DEV) console.debug(msg);
}

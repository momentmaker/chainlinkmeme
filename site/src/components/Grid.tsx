import { useEffect, useMemo, useRef, useState } from 'react';
import type { Manifest, MemeEntry } from '../lib/manifest';
import { memeUrl } from '../lib/meme-url';

interface Props {
  manifestUrl?: string;
}

interface Tile {
  meme: MemeEntry;
  x: number;
  y: number;
  row: number;
  col: number;
}

interface View { scale: number; tx: number; ty: number; }

const TILE_R = 30;
const HEX_W = TILE_R * Math.sqrt(3);
const ROW_H = TILE_R * 1.5;
const PADDING = 40;
const MIN_SCALE = 0.15;
const MAX_SCALE = 8;
const CONCURRENT_LOADS = 8;
const HASH_RE = /^[0-9a-f]{10,}$/i;

function displayTitle(m: MemeEntry): string {
  if (m.title && !HASH_RE.test(m.title)) return m.title;
  return m.tags[0] ? `#${m.tags[0]}` : m.slug;
}

function hexPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const hx = (r * Math.sqrt(3)) / 2;
  const hy = r / 2;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + hx, y - hy);
  ctx.lineTo(x + hx, y + hy);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - hx, y + hy);
  ctx.lineTo(x - hx, y - hy);
  ctx.closePath();
}

function layoutTiles(memes: MemeEntry[]): { tiles: Tile[]; width: number; height: number } {
  const cols = Math.max(4, Math.ceil(Math.sqrt(memes.length * 1.15)));
  const rows = Math.ceil(memes.length / cols);
  const tiles: Tile[] = [];
  for (let i = 0; i < memes.length; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const xOffset = row % 2 === 0 ? 0 : HEX_W / 2;
    const x = PADDING + col * HEX_W + xOffset + HEX_W / 2;
    const y = PADDING + row * ROW_H + TILE_R;
    tiles.push({ meme: memes[i]!, x, y, row, col });
  }
  const width = PADDING * 2 + cols * HEX_W + HEX_W / 2;
  const height = PADDING * 2 + (rows - 1) * ROW_H + TILE_R * 2;
  return { tiles, width, height };
}

export default function Grid({ manifestUrl = '/manifest.json' }: Props) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [hoverTile, setHoverTile] = useState<Tile | null>(null);
  const [transformed, setTransformed] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<View>({ scale: 1, tx: 0, ty: 0 });
  const dragRef = useRef({ active: false, moved: false, startX: 0, startY: 0, origTx: 0, origTy: 0 });
  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const loadingRef = useRef<Set<string>>(new Set());
  const failedRef = useRef<Set<string>>(new Set());
  const markDirtyRef = useRef<() => void>(() => {});
  // Mirror hoverTile in a ref so the raf loop can read it without the effect
  // needing hoverTile in its deps. Without this, every mouse move tears down
  // the raf loop + wheel/pointer listeners and rebuilds them — same pattern
  // Constellation.tsx calls out and avoids.
  const hoverTileRef = useRef<Tile | null>(null);
  useEffect(() => {
    hoverTileRef.current = hoverTile;
    markDirtyRef.current();
  }, [hoverTile]);

  useEffect(() => {
    let cancelled = false;
    fetch(manifestUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`manifest fetch failed: ${r.status}`);
        return r.json() as Promise<Manifest>;
      })
      .then((m) => { if (!cancelled) setManifest(m); })
      .catch(() => { if (!cancelled) setFetchFailed(true); });
    return () => { cancelled = true; };
  }, [manifestUrl]);

  const layout = useMemo(() => {
    if (!manifest) return null;
    return layoutTiles(manifest.memes);
  }, [manifest]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper || !layout) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let needsRedraw = true;
    const markDirty = () => { needsRedraw = true; };
    markDirtyRef.current = markDirty;

    let currentDpr = window.devicePixelRatio || 1;
    let initialized = false;

    function fitToViewport(): void {
      const rect = wrapper!.getBoundingClientRect();
      const fitScale = Math.min(
        rect.width / layout!.width,
        rect.height / layout!.height,
      );
      viewRef.current.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fitScale));
      viewRef.current.tx = (rect.width - layout!.width * viewRef.current.scale) / 2;
      viewRef.current.ty = (rect.height - layout!.height * viewRef.current.scale) / 2;
    }

    function resize(): void {
      const rect = wrapper!.getBoundingClientRect();
      currentDpr = window.devicePixelRatio || 1;
      canvas!.width = rect.width * currentDpr;
      canvas!.height = rect.height * currentDpr;
      canvas!.style.width = rect.width + 'px';
      canvas!.style.height = rect.height + 'px';
      if (!initialized) {
        fitToViewport();
        initialized = true;
      }
      markDirty();
    }
    resize();
    window.addEventListener('resize', resize);

    function visibleTiles(): Tile[] {
      const v = viewRef.current;
      const rect = wrapper!.getBoundingClientRect();
      const worldL = -v.tx / v.scale;
      const worldT = -v.ty / v.scale;
      const worldR = (rect.width - v.tx) / v.scale;
      const worldB = (rect.height - v.ty) / v.scale;
      const slack = TILE_R;
      const out: Tile[] = [];
      for (const t of layout!.tiles) {
        if (t.x + slack < worldL || t.x - slack > worldR) continue;
        if (t.y + slack < worldT || t.y - slack > worldB) continue;
        out.push(t);
      }
      return out;
    }

    function requestImage(meme: MemeEntry): HTMLImageElement | null {
      const cache = imagesRef.current;
      const existing = cache.get(meme.slug);
      if (existing) return existing;
      if (failedRef.current.has(meme.slug)) return null;
      if (loadingRef.current.size >= CONCURRENT_LOADS) return null;
      if (loadingRef.current.has(meme.slug)) return null;
      loadingRef.current.add(meme.slug);
      const img = new Image();
      img.decoding = 'async';
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        cache.set(meme.slug, img);
        loadingRef.current.delete(meme.slug);
        markDirty();
      };
      img.onerror = () => {
        failedRef.current.add(meme.slug);
        loadingRef.current.delete(meme.slug);
        markDirty();
      };
      img.src = memeUrl(meme.filename);
      return null;
    }

    function draw(): void {
      if (!needsRedraw) {
        raf = requestAnimationFrame(draw);
        return;
      }
      needsRedraw = false;
      const v = viewRef.current;
      ctx!.setTransform(1, 0, 0, 1, 0, 0);
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      ctx!.setTransform(
        currentDpr * v.scale, 0, 0, currentDpr * v.scale,
        currentDpr * v.tx, currentDpr * v.ty,
      );

      const tiles = visibleTiles();
      for (const t of tiles) {
        hexPath(ctx!, t.x, t.y, TILE_R);
        ctx!.fillStyle = 'rgba(47, 98, 223, 0.10)';
        ctx!.fill();

        const img = requestImage(t.meme);
        if (img && img.complete && img.naturalWidth > 0) {
          ctx!.save();
          hexPath(ctx!, t.x, t.y, TILE_R - 0.5);
          ctx!.clip();
          const nw = img.naturalWidth;
          const nh = img.naturalHeight;
          const scale = Math.max((TILE_R * 2) / nw, (TILE_R * 2) / nh);
          const dw = nw * scale;
          const dh = nh * scale;
          ctx!.drawImage(img, t.x - dw / 2, t.y - dh / 2, dw, dh);
          ctx!.restore();
        }

        ctx!.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx!.lineWidth = 1 / v.scale;
        hexPath(ctx!, t.x, t.y, TILE_R);
        ctx!.stroke();
      }

      const currentHover = hoverTileRef.current;
      if (currentHover) {
        hexPath(ctx!, currentHover.x, currentHover.y, TILE_R + 1.5);
        ctx!.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        ctx!.lineWidth = 2.5 / v.scale;
        ctx!.shadowColor = 'rgba(110, 155, 255, 0.9)';
        ctx!.shadowBlur = 14;
        ctx!.stroke();
        ctx!.shadowBlur = 0;
      }

      if (loadingRef.current.size > 0) needsRedraw = true;
      raf = requestAnimationFrame(draw);
    }

    raf = requestAnimationFrame(draw);

    const onWheel = (ev: WheelEvent): void => {
      ev.preventDefault();
      if (ev.deltaY === 0) return;
      const rect = canvas!.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const v = viewRef.current;
      const factor = Math.pow(1.0015, -ev.deltaY);
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale * factor));
      const worldX = (mx - v.tx) / v.scale;
      const worldY = (my - v.ty) / v.scale;
      v.scale = next;
      v.tx = mx - worldX * next;
      v.ty = my - worldY * next;
      setTransformed(true);
      markDirty();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    let capturedPointerId: number | null = null;
    const onPointerDown = (ev: PointerEvent): void => {
      const d = dragRef.current;
      if (d.active) return;
      d.active = true;
      d.moved = false;
      d.startX = ev.clientX;
      d.startY = ev.clientY;
      d.origTx = viewRef.current.tx;
      d.origTy = viewRef.current.ty;
      canvas!.setPointerCapture(ev.pointerId);
      capturedPointerId = ev.pointerId;
      canvas!.style.cursor = 'grabbing';
      setHoverTile(null);
    };
    const onPointerMoveNative = (ev: PointerEvent): void => {
      const d = dragRef.current;
      if (!d.active || ev.pointerId !== capturedPointerId) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
      const v = viewRef.current;
      v.tx = d.origTx + dx;
      v.ty = d.origTy + dy;
      setTransformed(true);
      markDirty();
    };
    const onPointerUp = (ev: PointerEvent): void => {
      const d = dragRef.current;
      if (!d.active || ev.pointerId !== capturedPointerId) return;
      d.active = false;
      try { canvas!.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
      capturedPointerId = null;
      canvas!.style.cursor = 'grab';
    };
    const onBlur = (): void => {
      const d = dragRef.current;
      if (!d.active) return;
      d.active = false;
      if (capturedPointerId !== null) {
        try { canvas!.releasePointerCapture(capturedPointerId); } catch { /* ignore */ }
        capturedPointerId = null;
      }
      canvas!.style.cursor = 'grab';
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMoveNative);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('blur', onBlur);
    canvas.style.cursor = 'grab';

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', onBlur);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMoveNative);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
    };
  }, [layout]);

  const resetView = (): void => {
    const wrapper = wrapperRef.current;
    if (!wrapper || !layout) return;
    const rect = wrapper.getBoundingClientRect();
    const fitScale = Math.min(rect.width / layout.width, rect.height / layout.height);
    viewRef.current.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, fitScale));
    viewRef.current.tx = (rect.width - layout.width * viewRef.current.scale) / 2;
    viewRef.current.ty = (rect.height - layout.height * viewRef.current.scale) / 2;
    setTransformed(false);
    markDirtyRef.current();
  };

  const toWorld = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const v = viewRef.current;
    return {
      x: (clientX - rect.left - v.tx) / v.scale,
      y: (clientY - rect.top - v.ty) / v.scale,
    };
  };

  const findTile = (clientX: number, clientY: number): Tile | null => {
    if (!layout) return null;
    const p = toWorld(clientX, clientY);
    if (!p) return null;
    let best: Tile | null = null;
    let bestDist = Infinity;
    for (const t of layout.tiles) {
      const dx = t.x - p.x;
      const dy = t.y - p.y;
      const d = dx * dx + dy * dy;
      if (d < bestDist && d < TILE_R * TILE_R) { bestDist = d; best = t; }
    }
    return best;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    if (dragRef.current.active) return;
    const t = findTile(e.clientX, e.clientY);
    setHoverTile(t);
  };

  const onClick = async (e: React.MouseEvent<HTMLCanvasElement>): Promise<void> => {
    if (dragRef.current.moved) { dragRef.current.moved = false; return; }
    const t = findTile(e.clientX, e.clientY);
    if (!t) return;
    const base = import.meta.env.BASE_URL.replace(/\/$/, '');
    const target = `${base}/m/${t.meme.slug}/`;
    try {
      const mod = await import('astro:transitions/client');
      mod.navigate(target);
    } catch {
      window.location.href = target;
    }
  };

  return (
    <div ref={wrapperRef} className="grid-hex">
      <canvas
        ref={canvasRef}
        className="grid-hex-canvas"
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverTile(null)}
        onClick={onClick}
      />
      {transformed && (
        <button
          type="button"
          className="constellation-reset"
          onClick={resetView}
          aria-label="Reset grid zoom and pan"
          title="Reset zoom + pan"
        >
          reset view
        </button>
      )}
      {hoverTile && (
        <div className="constellation-hover">
          <strong>{displayTitle(hoverTile.meme)}</strong>
          {hoverTile.meme.tags[0] && <span>#{hoverTile.meme.tags[0]}</span>}
        </div>
      )}
      {!layout && !fetchFailed && (
        <p className="constellation-empty">loading the honeycomb…</p>
      )}
      {fetchFailed && !manifest && (
        <p className="constellation-empty">couldn't load the manifest — try refreshing</p>
      )}
    </div>
  );
}

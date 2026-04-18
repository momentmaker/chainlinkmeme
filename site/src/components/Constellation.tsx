import { useEffect, useMemo, useRef, useState } from 'react';
import type { Manifest } from '../lib/manifest';

interface Props {
  manifestUrl?: string;
}

interface Node {
  tag: string;
  count: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

interface Edge {
  a: number;
  b: number;
  weight: number;
}

// A tiny force-directed layout: repulsion between all nodes, attraction
// along edges, a weak pull toward the center to keep the graph on-canvas,
// and velocity damping each frame. Nothing fancy — the beauty comes from
// the tags and their relationships, not the algorithm.
function runPhysics(nodes: Node[], edges: Edge[], w: number, h: number): void {
  const cx = w / 2;
  const cy = h / 2;
  const REPULSE = 3200;
  const SPRING = 0.0015;
  const CENTER = 0.0009;
  const DAMP = 0.85;

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    let fx = 0, fy = 0;
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const b = nodes[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d2 = Math.max(4, dx * dx + dy * dy);
      const f = REPULSE / d2;
      fx += (dx / Math.sqrt(d2)) * f;
      fy += (dy / Math.sqrt(d2)) * f;
    }
    fx += (cx - a.x) * CENTER;
    fy += (cy - a.y) * CENTER;
    a.vx = (a.vx + fx) * DAMP;
    a.vy = (a.vy + fy) * DAMP;
  }

  for (const e of edges) {
    const a = nodes[e.a];
    const b = nodes[e.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const k = SPRING * e.weight;
    a.vx += dx * k;
    a.vy += dy * k;
    b.vx -= dx * k;
    b.vy -= dy * k;
  }

  for (const n of nodes) {
    n.x += n.vx;
    n.y += n.vy;
  }
}

// Pointy-top hexagon path matching the site's clip-path:
// polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%).
// r is the circumscribed radius (distance to the top/bottom point).
function hexPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  const hx = r * Math.sqrt(3) / 2;
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

interface View { scale: number; tx: number; ty: number; }
const IDENTITY_VIEW: View = { scale: 1, tx: 0, ty: 0 };
const MIN_SCALE = 0.5;
const MAX_SCALE = 5;

export default function Constellation({ manifestUrl = '/manifest.json' }: Props) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [hoverTag, setHoverTag] = useState<string | null>(null);
  const [transformed, setTransformed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Ref mirror of hoverTag so the draw loop can pick up latest hover state
  // without being in the effect's dep array. Including hoverTag as a dep
  // cancels+restarts the raf loop on every mouse move, which resets the
  // physics sim and means the graph never settles.
  const hoverTagRef = useRef<string | null>(null);
  useEffect(() => { hoverTagRef.current = hoverTag; }, [hoverTag]);
  // View transform + drag state live in refs so the raf loop + native
  // wheel/pointer handlers can mutate them without tearing the effect down.
  const viewRef = useRef<View>({ ...IDENTITY_VIEW });
  const dragRef = useRef({ active: false, moved: false, startX: 0, startY: 0, origTx: 0, origTy: 0 });
  const markDirtyRef = useRef<() => void>(() => {});

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

  // Build graph once manifest arrives: nodes = tags (sized by meme count),
  // edges = tag co-occurrence weights.
  const { nodes, edges, maxCount } = useMemo(() => {
    if (!manifest) return { nodes: [] as Node[], edges: [] as Edge[], maxCount: 1 };
    const counts = new Map<string, number>();
    const coocc = new Map<string, number>(); // "a|b" with a<b
    for (const m of manifest.memes) {
      for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      for (let i = 0; i < m.tags.length; i++) {
        for (let j = i + 1; j < m.tags.length; j++) {
          const [a, b] = [m.tags[i], m.tags[j]].sort();
          const key = `${a}|${b}`;
          coocc.set(key, (coocc.get(key) ?? 0) + 1);
        }
      }
    }
    // Keep tags that tagged ≥ 3 memes — trims singletons and keeps the
    // constellation legible. 296 → ~120 nodes.
    const tags = [...counts.entries()].filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]);
    const indexByTag = new Map<string, number>();
    const initialW = 900, initialH = 600;
    const mc = tags[0]?.[1] ?? 1;
    const nodes: Node[] = tags.map(([tag, count], i) => {
      indexByTag.set(tag, i);
      const a = (i / tags.length) * Math.PI * 2;
      const r = Math.min(initialW, initialH) / 3;
      return {
        tag,
        count,
        x: initialW / 2 + Math.cos(a) * r + (Math.random() - 0.5) * 20,
        y: initialH / 2 + Math.sin(a) * r + (Math.random() - 0.5) * 20,
        vx: 0, vy: 0,
        radius: 6 + Math.sqrt(count / mc) * 22,
      };
    });
    const edges: Edge[] = [];
    for (const [key, w] of coocc.entries()) {
      const [a, b] = key.split('|');
      const ai = indexByTag.get(a);
      const bi = indexByTag.get(b);
      if (ai === undefined || bi === undefined) continue;
      if (w < 2) continue;
      edges.push({ a: ai, b: bi, weight: w });
    }
    return { nodes, edges, maxCount: mc };
  }, [manifest]);

  // Animation loop — runs physics + redraws the canvas. Honors
  // prefers-reduced-motion by converging faster (fewer iterations).
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper || nodes.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let iters = 0;
    const MAX_SETTLE_ITERS = reduce ? 120 : 240;
    // Stop as soon as the total kinetic energy per node drops below this
    // threshold — in practice the layout converges in 2–3s on desktop.
    const KE_THRESHOLD = 0.08;
    const MIN_SETTLE_ITERS = reduce ? 30 : 80;

    // Separate "needs redraw" signal for after the physics has settled —
    // hover + pan/zoom changes flip this on and the next frame picks it up
    // without paying to re-run the force sim.
    let settled = false;
    let needsRedraw = true;
    const markDirty = () => { needsRedraw = true; };
    markDirtyRef.current = markDirty;

    let currentDpr = window.devicePixelRatio || 1;
    function resize() {
      const rect = wrapper!.getBoundingClientRect();
      currentDpr = window.devicePixelRatio || 1;
      canvas!.width = rect.width * currentDpr;
      canvas!.height = rect.height * currentDpr;
      canvas!.style.width = rect.width + 'px';
      canvas!.style.height = rect.height + 'px';
      // Writing to canvas.width clears the bitmap — force a redraw even if
      // the sim has already settled, otherwise the canvas stays blank after
      // a window resize.
      markDirty();
    }
    resize();
    window.addEventListener('resize', resize);

    function draw() {
      const rect = wrapper!.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;

      if (!settled) {
        runPhysics(nodes, edges, w, h);
        iters++;
        let ke = 0;
        for (const n of nodes) ke += n.vx * n.vx + n.vy * n.vy;
        const perNode = ke / Math.max(1, nodes.length);
        if (iters >= MAX_SETTLE_ITERS || (iters >= MIN_SETTLE_ITERS && perNode < KE_THRESHOLD)) {
          settled = true;
          for (const n of nodes) { n.vx = 0; n.vy = 0; }
        }
      } else if (!needsRedraw) {
        raf = requestAnimationFrame(draw);
        return;
      }
      needsRedraw = false;

      const v = viewRef.current;
      // Combine DPR + view transform. Everything below draws in world
      // coordinates; the matrix handles screen projection.
      ctx!.setTransform(1, 0, 0, 1, 0, 0);
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      ctx!.setTransform(
        currentDpr * v.scale, 0, 0, currentDpr * v.scale,
        currentDpr * v.tx, currentDpr * v.ty,
      );
      const currentHover = hoverTagRef.current;

      // Edges — keep stroke width constant in screen pixels regardless of zoom.
      ctx!.lineWidth = 1 / v.scale;
      for (const e of edges) {
        const a = nodes[e.a];
        const b = nodes[e.b];
        const opacity = currentHover && (a.tag === currentHover || b.tag === currentHover) ? 0.5 : 0.08;
        ctx!.strokeStyle = `rgba(47, 98, 223, ${opacity})`;
        ctx!.beginPath();
        ctx!.moveTo(a.x, a.y);
        ctx!.lineTo(b.x, b.y);
        ctx!.stroke();
      }

      // Nodes — pointy-top hexagons matching the site's clip-path identity.
      for (const n of nodes) {
        const lit = currentHover === n.tag;
        hexPath(ctx!, n.x, n.y, n.radius);
        ctx!.fillStyle = lit ? '#2f62df' : 'rgba(47, 98, 223, 0.65)';
        ctx!.fill();
        ctx!.strokeStyle = lit ? 'white' : 'rgba(255,255,255,0.25)';
        ctx!.lineWidth = (lit ? 2 : 1) / v.scale;
        ctx!.stroke();

        if (lit || n.count > maxCount * 0.2) {
          ctx!.fillStyle = lit ? 'white' : 'rgba(230, 236, 255, 0.85)';
          const px = Math.max(11, Math.min(16, n.radius * 0.7)) / v.scale;
          ctx!.font = `${lit ? 600 : 500} ${px}px -apple-system, system-ui, sans-serif`;
          ctx!.textAlign = 'center';
          ctx!.textBaseline = 'middle';
          ctx!.fillText(n.tag, n.x, n.y + n.radius + 12 / v.scale);
        }
      }

      raf = requestAnimationFrame(draw);
    }

    raf = requestAnimationFrame(draw);

    // Wheel-to-zoom, anchored at the cursor position so the point under the
    // mouse stays put. preventDefault requires a non-passive listener.
    const onWheel = (ev: WheelEvent) => {
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
      setTransformed(v.scale !== 1 || v.tx !== 0 || v.ty !== 0);
      markDirty();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    let capturedPointerId: number | null = null;
    const onPointerDown = (ev: PointerEvent) => {
      const d = dragRef.current;
      // Ignore reentrant pointerdown (e.g. a second finger on touch
      // devices) — without this, the second pointer overwrites the drag
      // anchors and the view jumps unpredictably during multi-touch.
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
      // Pointer capture suppresses onPointerLeave for the duration of the
      // drag, so explicitly drop any hover state when a pan begins — the
      // hover card shouldn't linger over a moving graph.
      setHoverTag(null);
    };
    const onPointerMoveNative = (ev: PointerEvent) => {
      const d = dragRef.current;
      // Only honor moves from the captured pointer. Without this, a second
      // finger on a touch device would feed stray coordinates into the drag
      // math and jitter the view.
      if (!d.active || ev.pointerId !== capturedPointerId) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) d.moved = true;
      const v = viewRef.current;
      v.tx = d.origTx + dx;
      v.ty = d.origTy + dy;
      setTransformed(v.scale !== 1 || v.tx !== 0 || v.ty !== 0);
      markDirty();
    };
    const onPointerUp = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d.active || ev.pointerId !== capturedPointerId) return;
      d.active = false;
      try { canvas!.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
      capturedPointerId = null;
      canvas!.style.cursor = 'grab';
    };
    // If the user alt-tabs or releases the mouse in another window,
    // pointerup may never fire here. Reset on blur so the next interaction
    // isn't silently swallowed by a stuck drag state.
    const onBlur = () => {
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
  }, [nodes, edges, maxCount]);

  // Flip the dirty flag on hover change so the already-running raf loop
  // picks up the new hover state. Decoupled from the raf-setup effect so
  // hovering doesn't tear down and rebuild the animation.
  useEffect(() => {
    markDirtyRef.current();
  }, [hoverTag]);

  const resetView = () => {
    viewRef.current.scale = 1;
    viewRef.current.tx = 0;
    viewRef.current.ty = 0;
    setTransformed(false);
    markDirtyRef.current();
  };

  // Screen → world coords through the active view transform.
  const toWorld = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const v = viewRef.current;
    return {
      x: (clientX - rect.left - v.tx) / v.scale,
      y: (clientY - rect.top - v.ty) / v.scale,
    };
  };

  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current.active) return;
    const p = toWorld(e.clientX, e.clientY);
    if (!p) return;
    const v = viewRef.current;
    const slop = 10 / v.scale;
    let nearest: Node | null = null;
    let bestDist = Infinity;
    for (const n of nodes) {
      const dx = n.x - p.x;
      const dy = n.y - p.y;
      const d = dx * dx + dy * dy;
      if (d < bestDist && d < (n.radius + slop) ** 2) { bestDist = d; nearest = n; }
    }
    setHoverTag(nearest?.tag ?? null);
  };

  const onClick = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    // Suppress the click that trailed a drag so panning doesn't navigate.
    if (dragRef.current.moved) { dragRef.current.moved = false; return; }
    const p = toWorld(e.clientX, e.clientY);
    if (!p) return;
    const v = viewRef.current;
    const slop = 6 / v.scale;
    for (const n of nodes) {
      const dx = n.x - p.x;
      const dy = n.y - p.y;
      if (dx * dx + dy * dy < (n.radius + slop) ** 2) {
        const base = import.meta.env.BASE_URL.replace(/\/$/, '');
        const target = `${base}/?q=${encodeURIComponent(n.tag)}`;
        try {
          const mod = await import('astro:transitions/client');
          mod.navigate(target);
        } catch {
          window.location.href = target;
        }
        return;
      }
    }
  };

  return (
    <div ref={wrapperRef} className="constellation">
      <canvas
        ref={canvasRef}
        className="constellation-canvas"
        onPointerMove={onPointer}
        onPointerLeave={() => setHoverTag(null)}
        onClick={onClick}
      />
      {transformed && (
        <button
          type="button"
          className="constellation-reset"
          onClick={resetView}
          aria-label="Reset constellation zoom and pan"
          title="Reset zoom + pan"
        >
          reset view
        </button>
      )}
      {hoverTag && (
        <div className="constellation-hover">
          <strong>#{hoverTag}</strong>
          <span>{nodes.find((n) => n.tag === hoverTag)?.count ?? 0} memes</span>
        </div>
      )}
      {nodes.length === 0 && manifest && (
        <p className="constellation-empty">archive too small for a constellation yet</p>
      )}
      {fetchFailed && !manifest && (
        <p className="constellation-empty">couldn't load the tag manifest — try refreshing</p>
      )}
    </div>
  );
}

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

// ---- Ambient cosmos: starfield, nebula, comets ----
// The page's tagline is "the archive as a cosmos"; these make it one.
// All effects are gated on prefers-reduced-motion + viewport width so
// mobile/low-power devices get a calmer but still starry view.

interface Star { x: number; y: number; depth: number; size: number; phase: number; speed: number; }
interface Nebula { x: number; y: number; radius: number; rgb: string; breathSpeed: number; breathPhase: number; baseAlpha: number; }
interface Comet { x: number; y: number; vx: number; vy: number; age: number; life: number; tailLen: number; }

function generateStars(w: number, h: number, count: number): Star[] {
  const stars: Star[] = [];
  // Cover 1.5× the viewport so moderate pan doesn't reveal empty edges.
  const W = w * 1.5, H = h * 1.5;
  for (let i = 0; i < count; i++) {
    stars.push({
      x: Math.random() * W - W * 0.25,
      y: Math.random() * H - H * 0.25,
      depth: Math.random(),  // 0 = far, 1 = near
      size: 0.4 + Math.random() * 1.4,
      phase: Math.random() * Math.PI * 2,
      speed: 0.0008 + Math.random() * 0.0022,
    });
  }
  return stars;
}

function generateNebulae(w: number, h: number): Nebula[] {
  // Three large soft gradients. Colors picked to play with the brand blue
  // without fighting it — cyan, magenta-ish, and a deep indigo.
  const colors = ['88,160,255', '180,110,220', '70,90,200'];
  const nebulae: Nebula[] = [];
  for (let i = 0; i < 3; i++) {
    nebulae.push({
      x: 0.2 + Math.random() * 0.6,   // fraction of width
      y: 0.2 + Math.random() * 0.6,
      radius: Math.max(w, h) * (0.45 + Math.random() * 0.25),
      rgb: colors[i] ?? '88,160,255',
      breathSpeed: 0.00015 + Math.random() * 0.0002,
      breathPhase: Math.random() * Math.PI * 2,
      baseAlpha: 0.06 + Math.random() * 0.05,
    });
  }
  return nebulae;
}

function spawnComet(w: number, h: number): Comet {
  // Pick an entry edge + angle that sends it across the canvas.
  const edge = Math.floor(Math.random() * 4);
  let x = 0, y = 0, angle = 0;
  const margin = 80;
  const spread = Math.PI / 4;
  if (edge === 0) { x = -margin; y = Math.random() * h; angle = (Math.random() - 0.5) * spread; }
  else if (edge === 1) { x = w + margin; y = Math.random() * h; angle = Math.PI + (Math.random() - 0.5) * spread; }
  else if (edge === 2) { x = Math.random() * w; y = -margin; angle = Math.PI / 2 + (Math.random() - 0.5) * spread; }
  else { x = Math.random() * w; y = h + margin; angle = -Math.PI / 2 + (Math.random() - 0.5) * spread; }
  const speed = 0.18 + Math.random() * 0.14;  // px/ms
  return {
    x, y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    age: 0,
    life: 3800 + Math.random() * 1800,
    tailLen: 70 + Math.random() * 40,
  };
}

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
  // Ambient effects state: starfield, nebulae, and a small pool of live
  // comets. All regenerated or advanced inside the draw loop.
  const starsRef = useRef<Star[]>([]);
  const nebulaeRef = useRef<Nebula[]>([]);
  const cometsRef = useRef<Comet[]>([]);

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
    // Feature gates. Mobile (<768px) keeps a quiet starfield + static
    // nebula but drops comets and twinkle/breath. Reduced-motion users get
    // the fully-still scene. The viewport-dependent gates (starCount,
    // enableComets) are `let` so they can recompute in resize() — a device
    // rotation or window drag across the boundary should update the scene.
    let narrow = window.innerWidth < 768;
    let starCount = narrow ? 80 : 260;
    let enableComets = !reduce && !narrow;
    const enableTwinkle = !reduce;
    const enableBreath = !reduce;
    // The scene lives: stars twinkle, nebula breathes, comets fly. That
    // means the raf loop can't idle-skip after physics settles the way it
    // used to — drive it continuously unless reduce-motion is on.
    const continuous = !reduce;

    let raf = 0;
    let iters = 0;
    const MAX_SETTLE_ITERS = reduce ? 120 : 240;
    const KE_THRESHOLD = 0.08;
    const MIN_SETTLE_ITERS = reduce ? 30 : 80;

    let settled = false;
    let needsRedraw = true;
    const markDirty = () => { needsRedraw = true; };
    markDirtyRef.current = markDirty;

    const startTime = performance.now();
    let lastFrame = startTime;
    let lastCometSpawn = startTime;
    let nextCometDelay = 8000 + Math.random() * 12000;  // first comet 8-20s in

    let currentDpr = window.devicePixelRatio || 1;
    function resize() {
      const rect = wrapper!.getBoundingClientRect();
      currentDpr = window.devicePixelRatio || 1;
      canvas!.width = rect.width * currentDpr;
      canvas!.height = rect.height * currentDpr;
      canvas!.style.width = rect.width + 'px';
      canvas!.style.height = rect.height + 'px';
      // Recompute viewport-dependent gates. If the user crossed the mobile
      // boundary we adjust star count + comet enablement before the next
      // frame. Also clear any live comets if comets just got disabled, so
      // a frozen-in-place comet doesn't linger.
      const wasCometEnabled = enableComets;
      narrow = window.innerWidth < 768;
      starCount = narrow ? 80 : 260;
      enableComets = !reduce && !narrow;
      if (wasCometEnabled && !enableComets) cometsRef.current = [];
      // Regenerate ambient layers — star density + nebula positions are
      // relative to viewport; stale stars from a pre-resize layout leave
      // empty patches after a viewport change.
      starsRef.current = generateStars(rect.width, rect.height, starCount);
      nebulaeRef.current = generateNebulae(rect.width, rect.height);
      markDirty();
    }
    resize();
    window.addEventListener('resize', resize);

    function draw() {
      const now = performance.now();
      const dt = Math.min(64, now - lastFrame);  // cap dt so tab-wake doesn't teleport comets
      lastFrame = now;
      const t = now - startTime;

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
      } else if (!continuous && !needsRedraw) {
        // Reduced-motion path: freeze after settle and only redraw on user
        // input (hover, pan, zoom).
        raf = requestAnimationFrame(draw);
        return;
      }
      needsRedraw = false;

      const v = viewRef.current;
      const currentHover = hoverTagRef.current;

      // --- Layer 1: clear + nebula wash (screen space) ---
      ctx!.setTransform(1, 0, 0, 1, 0, 0);
      ctx!.clearRect(0, 0, canvas!.width, canvas!.height);
      ctx!.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);

      for (const n of nebulaeRef.current) {
        const breath = enableBreath
          ? n.baseAlpha * (0.75 + 0.25 * Math.sin(t * n.breathSpeed + n.breathPhase))
          : n.baseAlpha;
        const cx = n.x * w;
        const cy = n.y * h;
        const grad = ctx!.createRadialGradient(cx, cy, 0, cx, cy, n.radius);
        grad.addColorStop(0, `rgba(${n.rgb}, ${breath.toFixed(3)})`);
        grad.addColorStop(1, `rgba(${n.rgb}, 0)`);
        ctx!.fillStyle = grad;
        ctx!.fillRect(0, 0, w, h);
      }

      // --- Layer 2: starfield with parallax + twinkle (screen space) ---
      for (const s of starsRef.current) {
        // Depth drives both parallax rate and visual prominence.
        const parallax = 0.04 + s.depth * 0.25;
        // Wrap so we never run out of stars near viewport edges.
        const raw = s.x + v.tx * parallax;
        const ry = s.y + v.ty * parallax;
        const sx = ((raw % w) + w) % w;
        const sy = ((ry % h) + h) % h;
        const twinkle = enableTwinkle ? 0.55 + 0.45 * Math.sin(t * s.speed + s.phase) : 1;
        const alpha = (0.25 + s.depth * 0.55) * twinkle;
        // Near stars are a cooler cyan, far stars fade to brand indigo.
        const col = s.depth > 0.7 ? '255,255,255' : s.depth > 0.4 ? '200,215,255' : '140,160,240';
        ctx!.fillStyle = `rgba(${col}, ${alpha.toFixed(3)})`;
        const r = s.size + s.depth * 0.7;
        ctx!.beginPath();
        ctx!.arc(sx, sy, r, 0, Math.PI * 2);
        ctx!.fill();
      }

      // --- Layer 3: the graph (world space) ---
      ctx!.setTransform(
        currentDpr * v.scale, 0, 0, currentDpr * v.scale,
        currentDpr * v.tx, currentDpr * v.ty,
      );

      // Edges — hovered neighbors glow brighter with a soft blue shadow.
      for (const e of edges) {
        const a = nodes[e.a];
        const b = nodes[e.b];
        const hot = currentHover && (a.tag === currentHover || b.tag === currentHover);
        if (hot) {
          ctx!.strokeStyle = 'rgba(110, 155, 255, 0.7)';
          ctx!.lineWidth = 1.5 / v.scale;
          ctx!.shadowColor = 'rgba(110, 155, 255, 0.9)';
          ctx!.shadowBlur = 8;
        } else {
          ctx!.strokeStyle = 'rgba(47, 98, 223, 0.08)';
          ctx!.lineWidth = 1 / v.scale;
          ctx!.shadowBlur = 0;
        }
        ctx!.beginPath();
        ctx!.moveTo(a.x, a.y);
        ctx!.lineTo(b.x, b.y);
        ctx!.stroke();
      }
      ctx!.shadowBlur = 0;

      // Nodes — pointy-top hexagons. Small ones shimmer like distant stars.
      for (const n of nodes) {
        const lit = currentHover === n.tag;
        const small = n.radius < 12;
        const shimmer = small && enableTwinkle
          ? 0.7 + 0.3 * Math.sin(t * 0.0012 + (n.x + n.y) * 0.01)
          : 1;
        hexPath(ctx!, n.x, n.y, n.radius);
        if (lit) {
          ctx!.fillStyle = '#2f62df';
          ctx!.shadowColor = 'rgba(110, 155, 255, 0.85)';
          ctx!.shadowBlur = 16;
        } else {
          ctx!.fillStyle = `rgba(47, 98, 223, ${(0.65 * shimmer).toFixed(3)})`;
          ctx!.shadowBlur = 0;
        }
        ctx!.fill();
        ctx!.shadowBlur = 0;
        ctx!.strokeStyle = lit ? 'white' : `rgba(255,255,255,${(0.25 * shimmer).toFixed(3)})`;
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

      // --- Layer 4: comets (screen space, on top for drama) ---
      if (enableComets) {
        ctx!.setTransform(currentDpr, 0, 0, currentDpr, 0, 0);
        // Maybe spawn a new one — but never more than 2 live at once.
        if (now - lastCometSpawn > nextCometDelay && cometsRef.current.length < 2) {
          cometsRef.current.push(spawnComet(w, h));
          lastCometSpawn = now;
          nextCometDelay = 15000 + Math.random() * 25000;  // 15–40s between spawns
        }
        // Advance + draw + cull.
        const alive: Comet[] = [];
        for (const c of cometsRef.current) {
          c.x += c.vx * dt;
          c.y += c.vy * dt;
          c.age += dt;
          if (c.age >= c.life || c.x < -250 || c.x > w + 250 || c.y < -250 || c.y > h + 250) continue;
          alive.push(c);
          // Age-driven alpha envelope: fade in, hold, fade out.
          const lifeFrac = c.age / c.life;
          const env = lifeFrac < 0.15
            ? lifeFrac / 0.15
            : lifeFrac > 0.85
              ? (1 - lifeFrac) / 0.15
              : 1;
          const headX = c.x, headY = c.y;
          const dirLen = Math.hypot(c.vx, c.vy) || 1;
          const tailX = headX - (c.vx / dirLen) * c.tailLen;
          const tailY = headY - (c.vy / dirLen) * c.tailLen;
          const grad = ctx!.createLinearGradient(tailX, tailY, headX, headY);
          grad.addColorStop(0, 'rgba(200, 220, 255, 0)');
          grad.addColorStop(1, `rgba(220, 235, 255, ${(0.9 * env).toFixed(3)})`);
          ctx!.strokeStyle = grad;
          ctx!.lineCap = 'round';
          ctx!.lineWidth = 1.8;
          ctx!.beginPath();
          ctx!.moveTo(tailX, tailY);
          ctx!.lineTo(headX, headY);
          ctx!.stroke();
          // Comet head — a bright pinprick with a soft halo.
          ctx!.shadowColor = 'rgba(180, 210, 255, 0.8)';
          ctx!.shadowBlur = 10;
          ctx!.fillStyle = `rgba(255, 255, 255, ${(0.95 * env).toFixed(3)})`;
          ctx!.beginPath();
          ctx!.arc(headX, headY, 2, 0, Math.PI * 2);
          ctx!.fill();
          ctx!.shadowBlur = 0;
        }
        cometsRef.current = alive;
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

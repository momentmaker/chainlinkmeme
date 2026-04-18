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

export default function Constellation({ manifestUrl = '/manifest.json' }: Props) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [hoverTag, setHoverTag] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch(manifestUrl).then((r) => r.json() as Promise<Manifest>).then(setManifest).catch(() => {});
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

  // Animation loop — runs physics + redraws the canvas. Disabled if
  // prefers-reduced-motion is set (just settles the layout in one pass).
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper || nodes.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let iters = 0;
    const MAX_SETTLE_ITERS = reduce ? 180 : Infinity;

    function resize() {
      const rect = wrapper!.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas!.width = rect.width * dpr;
      canvas!.height = rect.height * dpr;
      canvas!.style.width = rect.width + 'px';
      canvas!.style.height = rect.height + 'px';
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    function draw() {
      const rect = wrapper!.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      runPhysics(nodes, edges, w, h);
      ctx!.clearRect(0, 0, w, h);

      // Edges
      ctx!.lineWidth = 1;
      for (const e of edges) {
        const a = nodes[e.a];
        const b = nodes[e.b];
        const opacity = hoverTag && (a.tag === hoverTag || b.tag === hoverTag) ? 0.5 : 0.08;
        ctx!.strokeStyle = `rgba(47, 98, 223, ${opacity})`;
        ctx!.beginPath();
        ctx!.moveTo(a.x, a.y);
        ctx!.lineTo(b.x, b.y);
        ctx!.stroke();
      }

      // Nodes
      for (const n of nodes) {
        const lit = hoverTag === n.tag;
        ctx!.beginPath();
        ctx!.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
        ctx!.fillStyle = lit ? '#2f62df' : 'rgba(47, 98, 223, 0.65)';
        ctx!.fill();
        ctx!.strokeStyle = lit ? 'white' : 'rgba(255,255,255,0.25)';
        ctx!.lineWidth = lit ? 2 : 1;
        ctx!.stroke();

        if (lit || n.count > maxCount * 0.2) {
          ctx!.fillStyle = lit ? 'white' : 'rgba(230, 236, 255, 0.85)';
          ctx!.font = `${lit ? 600 : 500} ${Math.max(11, Math.min(16, n.radius * 0.7))}px -apple-system, system-ui, sans-serif`;
          ctx!.textAlign = 'center';
          ctx!.textBaseline = 'middle';
          ctx!.fillText(n.tag, n.x, n.y + n.radius + 12);
        }
      }

      iters++;
      if (iters < MAX_SETTLE_ITERS) raf = requestAnimationFrame(draw);
    }

    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, [nodes, edges, hoverTag, maxCount]);

  const onPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let nearest: Node | null = null;
    let bestDist = Infinity;
    for (const n of nodes) {
      const dx = n.x - x;
      const dy = n.y - y;
      const d = dx * dx + dy * dy;
      if (d < bestDist && d < (n.radius + 10) ** 2) { bestDist = d; nearest = n; }
    }
    setHoverTag(nearest?.tag ?? null);
  };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    for (const n of nodes) {
      const dx = n.x - x;
      const dy = n.y - y;
      if (dx * dx + dy * dy < (n.radius + 6) ** 2) {
        const base = import.meta.env.BASE_URL.replace(/\/$/, '');
        window.location.href = `${base}/?q=${encodeURIComponent(n.tag)}`;
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
      {hoverTag && (
        <div className="constellation-hover">
          <strong>#{hoverTag}</strong>
          <span>{nodes.find((n) => n.tag === hoverTag)?.count ?? 0} memes</span>
        </div>
      )}
      {nodes.length === 0 && manifest && (
        <p className="constellation-empty">archive too small for a constellation yet</p>
      )}
    </div>
  );
}

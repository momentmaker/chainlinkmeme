// The home page's stage: the meme of the day as a holographic card over a
// living honeycomb of the archive. Vanilla on purpose — it's the first thing
// on the page and shouldn't wait on a framework.
//
//   · the honeycomb drifts, shimmers in a slow diagonal wave, lights up
//     around the pointer (and around a wandering light when there isn't one)
//     and flips a hex to a different meme every so often;
//   · the card tilts towards the pointer, its foil and glare following;
//   · the meme of the day is re-picked in the browser for today's UTC date,
//     so the page agrees with the daily post even between deploys, and it
//     flips over to the next one when the countdown reaches midnight.

import { HERO_COLS, HERO_COUNT, HERO_TILE, HEX_U0, SQRT3 } from './atlas-format';
import type { Manifest, MemeEntry } from './manifest';
import { memeOfDay } from './meme-of-day';
import { fullUrl, memeUrl, permalinkUrl, thumbUrl } from './meme-url';

const R = 27; // hex circumradius, CSS px
const HEX_W = R * SQRT3;
const ROW_H = R * 1.5;
const GAP = 1.5;
const DRIFT_X = 7; // px/s
const DRIFT_Y = 3.5;
const FLIP_MS = 520;
const BASE_ALPHA = 0.26;
const HASH_RE = /^[0-9a-f]{10,}$/i;

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function cellHash(c: number, r: number): number {
  let h = Math.imul(c | 0, 0x27d4eb2d) ^ Math.imul(r | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function displayTitle(m: MemeEntry): string {
  if (m.title && !HASH_RE.test(m.title)) return m.title;
  return m.tags[0] ? `#${m.tags[0]}` : 'meme of the day';
}

export function dayLabel(d: Date): string {
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).toLowerCase().replace(',', '');
}

export function cardNumber(index: number): string {
  return `No. ${String(index + 1).padStart(4, '0')}`;
}

// ── the honeycomb ──────────────────────────────────────────────────────

function mountMosaic(stage: HTMLElement, canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  const still = reducedMotion();
  let sprite: HTMLCanvasElement | null = null;
  let count = 0;
  let dpr = 1;
  let w = 0, h = 0;
  let raf = 0;
  let visible = true;
  let running = true;
  const t0 = performance.now();
  let pointer: { x: number; y: number } | null = null;
  const flips = new Map<string, { from: number; to: number; start: number }>();
  const settled = new Map<string, number>();
  let nextFlip = 0;

  // Every tile pre-cut into a hex once, on one sprite sheet, so a frame is
  // nothing but drawImage calls.
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    count = Math.min(HERO_COUNT, Math.floor(img.naturalWidth / HERO_TILE) * Math.floor(img.naturalHeight / HERO_TILE));
    if (!count) return;
    const sd = Math.min(2, window.devicePixelRatio || 1);
    const tw = Math.ceil(HEX_W * sd), th = Math.ceil(2 * R * sd);
    const s = document.createElement('canvas');
    s.width = tw * HERO_COLS;
    s.height = th * Math.ceil(count / HERO_COLS);
    const sc = s.getContext('2d')!;
    const rr = (R - GAP) * sd;
    for (let k = 0; k < count; k++) {
      const ox = (k % HERO_COLS) * tw, oy = Math.floor(k / HERO_COLS) * th;
      const cx = ox + tw / 2, cy = oy + th / 2;
      sc.save();
      sc.beginPath();
      for (let v = 0; v < 6; v++) {
        const a = Math.PI / 2 + (v * Math.PI) / 3;
        const px = cx + Math.cos(a) * rr, py = cy - Math.sin(a) * rr;
        if (v) sc.lineTo(px, py); else sc.moveTo(px, py);
      }
      sc.closePath();
      sc.clip();
      const sx = (k % HERO_COLS) * HERO_TILE, sy = Math.floor(k / HERO_COLS) * HERO_TILE;
      const u0 = HEX_U0 * HERO_TILE;
      sc.drawImage(img, sx + u0, sy, HERO_TILE - 2 * u0, HERO_TILE, cx - (rr * SQRT3) / 2, cy - rr, rr * SQRT3, rr * 2);
      sc.restore();
    }
    sprite = s;
    stage.classList.add('stage-live');
    kick();
  };
  img.src = canvas.dataset.sheet ?? '';

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(1.5, window.devicePixelRatio || 1);
    w = rect.width;
    h = rect.height;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    kick();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const io = new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; kick(); });
  io.observe(stage);

  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    kick();
  };
  const onLeave = () => { pointer = null; kick(); };
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerleave', onLeave);

  function kick() {
    if (!raf && running) raf = requestAnimationFrame(frame);
  }

  function frame(now: number) {
    raf = 0;
    if (!running || !document.contains(canvas)) { stop(); return; }
    if (!sprite || !visible || document.hidden) return;
    const t = (now - t0) / 1000;
    draw(t, now);
    if (!still) kick();
  }

  function draw(t: number, now: number) {
    const c = ctx!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const ox = still ? 0 : t * DRIFT_X;
    const oy = still ? 0 : t * DRIFT_Y;
    // A light that wanders the stage on its own, so the honeycomb breathes
    // on phones and when nobody's pointing at it.
    const wander = still ? null : {
      x: w * (0.62 + 0.3 * Math.sin(t * 0.21)),
      y: h * (0.5 + 0.38 * Math.sin(t * 0.33 + 1.3)),
    };

    if (!still && now > nextFlip) {
      nextFlip = now + 160 + Math.random() * 240;
      const col = Math.floor((ox + Math.random() * w) / HEX_W);
      const row = Math.floor((oy + Math.random() * h) / ROW_H);
      const key = `${col},${row}`;
      if (!flips.has(key)) {
        const from = settled.get(key) ?? cellHash(col, row) % count;
        flips.set(key, { from, to: Math.floor(Math.random() * count), start: now });
      }
    }

    const tw = sprite!.width / HERO_COLS;
    const th = sprite!.height / Math.ceil(count / HERO_COLS);
    const c0 = Math.floor((ox - HEX_W) / HEX_W), c1 = Math.ceil((ox + w + HEX_W) / HEX_W);
    const r0 = Math.floor((oy - R) / ROW_H), r1 = Math.ceil((oy + h + R) / ROW_H);
    for (let row = r0; row <= r1; row++) {
      const y = row * ROW_H - oy;
      for (let col = c0; col <= c1; col++) {
        const x = col * HEX_W + (row & 1 ? HEX_W / 2 : 0) - ox;
        if (x < -HEX_W || x > w + HEX_W) continue;
        const key = `${col},${row}`;
        let tile = settled.get(key) ?? cellHash(col, row) % count;
        let sx = 1;
        const f = flips.get(key);
        if (f) {
          const p = (now - f.start) / FLIP_MS;
          if (p >= 1) {
            flips.delete(key);
            settled.set(key, f.to);
            tile = f.to;
          } else {
            tile = p < 0.5 ? f.from : f.to;
            sx = Math.max(0.04, Math.abs(Math.cos(Math.PI * p)));
          }
        }
        let light = 0;
        if (pointer) light = Math.max(light, smoothstep(190, 20, Math.hypot(x - pointer.x, y - pointer.y)));
        if (wander) light = Math.max(light, 0.7 * smoothstep(240, 30, Math.hypot(x - wander.x, y - wander.y)));
        const wave = still ? 0 : 0.1 * (0.5 + 0.5 * Math.sin(x * 0.011 + y * 0.007 - t * 0.8));
        c.globalAlpha = Math.min(1, BASE_ALPHA + wave + light * 0.78 + (f ? 0.25 : 0));
        const s = 1 + light * 0.08;
        const dw = HEX_W * s * sx, dh = 2 * R * s;
        c.drawImage(sprite!, (tile % HERO_COLS) * tw, Math.floor(tile / HERO_COLS) * th, tw, th, x - dw / 2, y - dh / 2, dw, dh);
      }
    }
    c.globalAlpha = 1;
    // Keep the flip bookkeeping from growing without bound as cells drift
    // off-screen.
    if (settled.size > 4000) settled.clear();
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
    io.disconnect();
    stage.removeEventListener('pointermove', onMove);
    stage.removeEventListener('pointerleave', onLeave);
  }

  return stop;
}

// ── the card ───────────────────────────────────────────────────────────

function mountCard(stage: HTMLElement, card: HTMLElement): () => void {
  if (reducedMotion()) return () => {};
  const MAX = 14;
  const onMove = (e: PointerEvent) => {
    const r = card.getBoundingClientRect();
    const nx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (r.width * 0.9)));
    const ny = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (r.height * 0.9)));
    card.classList.add('holo-active');
    card.style.setProperty('--ry', `${(nx * MAX).toFixed(2)}deg`);
    card.style.setProperty('--rx', `${(-ny * MAX).toFixed(2)}deg`);
    card.style.setProperty('--mx', `${(50 + nx * 50).toFixed(1)}%`);
    card.style.setProperty('--my', `${(50 + ny * 50).toFixed(1)}%`);
  };
  const onLeave = () => {
    card.classList.remove('holo-active');
    card.style.removeProperty('--rx');
    card.style.removeProperty('--ry');
    card.style.removeProperty('--mx');
    card.style.removeProperty('--my');
  };
  stage.addEventListener('pointermove', onMove);
  stage.addEventListener('pointerleave', onLeave);
  return () => {
    stage.removeEventListener('pointermove', onMove);
    stage.removeEventListener('pointerleave', onLeave);
  };
}

// ── the meme of the day ────────────────────────────────────────────────

function render(stage: HTMLElement, m: MemeEntry, index: number, total: number, base: string, animate: boolean): void {
  const set = () => {
    stage.dataset.modSlug = m.slug;
    const title = stage.querySelector<HTMLElement>('[data-stage-title]');
    if (title) title.textContent = displayTitle(m);
    const no = stage.querySelector<HTMLElement>('[data-stage-no]');
    if (no) no.textContent = cardNumber(index);
    const of = stage.querySelector<HTMLElement>('[data-stage-of]');
    if (of) of.textContent = ` / ${total.toLocaleString('en-US')}`;
    for (const a of stage.querySelectorAll<HTMLAnchorElement>('[data-stage-open]')) a.href = permalinkUrl(m.slug);
    const find = stage.querySelector<HTMLAnchorElement>('[data-stage-find]');
    if (find) find.href = `${base}/verse/#m=${encodeURIComponent(m.slug)}`;
    const art = stage.querySelector<HTMLImageElement>('[data-stage-img]');
    if (art) {
      art.onerror = () => { art.onerror = null; art.src = memeUrl(m.filename); };
      art.src = fullUrl(m.filename, { animated: m.animated });
      art.alt = displayTitle(m);
    }
    const bg = stage.querySelector<HTMLImageElement>('[data-stage-bg]');
    if (bg) bg.src = thumbUrl(m.filename, 240);
    const tags = stage.querySelector<HTMLElement>('[data-stage-tags]');
    if (tags) {
      tags.replaceChildren(...m.tags.slice(0, 6).map((t) => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = `${base}/?q=${encodeURIComponent(t)}`;
        a.textContent = `#${t}`;
        li.append(a);
        return li;
      }));
    }
  };
  const card = stage.querySelector<HTMLElement>('[data-stage-card]');
  card?.setAttribute('aria-label', `Open the meme of the day: ${displayTitle(m)}`);
  if (!animate || !card || reducedMotion()) { set(); return; }
  card.classList.add('holo-flip');
  setTimeout(set, 320);
  setTimeout(() => card.classList.remove('holo-flip'), 700);
}

function mountDaily(stage: HTMLElement, manifestUrl: string, base: string): () => void {
  let manifest: Manifest | null = null;
  let timer = 0;
  let day = new Date().toISOString().slice(0, 10);
  const countdown = stage.querySelector<HTMLElement>('[data-stage-countdown]');
  const date = stage.querySelector<HTMLElement>('[data-stage-date]');

  const pick = (animate: boolean) => {
    if (!manifest) return;
    const now = new Date();
    const m = memeOfDay(manifest.memes, now);
    if (date) date.textContent = dayLabel(now);
    if (!m || m.slug === stage.dataset.modSlug) return;
    render(stage, m, manifest.memes.indexOf(m), manifest.memes.length, base, animate);
  };

  const tick = () => {
    const now = new Date();
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    const s = Math.max(0, Math.floor((next - now.getTime()) / 1000));
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    if (countdown) countdown.textContent = `${hh}:${mm}:${ss}`;
    const today = now.toISOString().slice(0, 10);
    if (today !== day) { day = today; pick(true); }
    if (!document.contains(stage)) { clearInterval(timer); return; }
  };
  tick();
  timer = window.setInterval(tick, 1000);

  fetch(manifestUrl)
    .then((r) => (r.ok ? (r.json() as Promise<Manifest>) : null))
    .then((m) => { manifest = m; pick(false); })
    .catch(() => { /* the build-time pick stands */ });

  return () => clearInterval(timer);
}

export function mountStage(): void {
  const stage = document.querySelector<HTMLElement>('[data-stage]');
  if (!stage || stage.dataset.bound === '1') return;
  stage.dataset.bound = '1';
  const base = stage.dataset.base ?? '';
  const canvas = stage.querySelector<HTMLCanvasElement>('[data-stage-mosaic]');
  const card = stage.querySelector<HTMLElement>('[data-stage-card]');
  const stops: (() => void)[] = [];
  if (canvas) stops.push(mountMosaic(stage, canvas));
  if (card) stops.push(mountCard(stage, card));
  stops.push(mountDaily(stage, stage.dataset.manifest ?? `${base}/manifest.json`, base));
  document.addEventListener('astro:before-swap', () => stops.forEach((s) => s()), { once: true });
}

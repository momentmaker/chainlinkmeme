// The memeverse's brain: owns the renderer, the camera and the galaxy, turns
// pointer input into orbits / picks, keeps system labels pinned to their
// discs, runs flights, the tour and warps, and drives assemble's morph. The
// React layer (components/Verse.tsx) only calls methods and listens to the
// events below — nothing in here re-renders React per frame.

import type { AtlasMeta } from '../lib/atlas-format';
import { OrbitCamera, MAX_DIST } from './camera';
import { HiResCache } from './hires';
import { buildLayout, positionAt, systemCenterAt, type GalaxyLayout, type StarSystem } from './layout';
import { clamp, invert, multiply, mulberry32, smoothstep, v3, type Mat4, type Vec3 } from './math';
import { Renderer, hexToRgb, type MosaicPlane } from './renderer';
import type { MosaicResult } from './mosaic';

export interface VerseMeme {
  slug: string;
  filename: string;
  title: string;
  tags: string[];
  animated: boolean;
}

export interface HoverInfo {
  index: number; // meme index
  x: number;
  y: number;
}

export interface EngineEvents {
  onHover?(h: HoverInfo | null): void;
  onFocus?(index: number | null): void;
  onTour?(system: StarSystem | null): void;
  onIntroDone?(): void;
  onLabelClick?(tag: string): void;
  onMode?(mode: Mode): void;
  onContextLost?(): void;
}

export interface EngineOptions {
  reducedMotion: boolean;
  atlasBase: string;
  atlasVersion: string;
  hiResUrl: (meme: VerseMeme) => string;
}

export type Mode = 'galaxy' | 'assembling' | 'mosaic' | 'disassembling';

const TOUR_HOLD = 6.5;
const FOCUS_DIST = 8.5;

export class VerseEngine {
  readonly layout: GalaxyLayout;
  private renderer: Renderer;
  private cam = new OrbitCamera();
  private raf = 0;
  private last = 0;
  private time = 0;
  private spinT = 0;
  private spinRate = 1;
  private galaxyAngle = 0;
  private warp = 0;
  private warpTarget = 0;
  private pulse = 0;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private viewProj: Mat4 = new Float32Array(16);
  private invViewProj: Mat4 = new Float32Array(16);
  private sx: Float32Array;
  private sy: Float32Array;
  private sd: Float32Array;
  private sr: Float32Array;
  private state: Float32Array;
  private stateDirty = false;
  private hiMap: Float32Array;
  private hiDirty = false;
  private hover = -1;
  private hoverClone = -1;
  private focus = -1;
  private filter: Set<number> | null = null;
  private pointer: { x: number; y: number; inside: boolean; moved: boolean } = { x: 0, y: 0, inside: false, moved: false };
  private drag: {
    id: number; x: number; y: number; sx: number; sy: number; moved: boolean; button: number; pan: boolean;
  } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { d: number; mx: number; my: number } | null = null;
  private lastInput = 0;
  private hiCache: HiResCache;
  private hiTick = 0;
  private labels: HTMLElement[] = [];
  private touring = false;
  private tourOrder: StarSystem[] = [];
  private tourIdx = 0;
  private tourHold = -1;
  private inset = { right: 0, bottom: 0 };
  private mode: Mode = 'galaxy';
  private morph = 0;
  private mosaic: MosaicResult | null = null;
  private plane: MosaicPlane | null = null;
  private introDone = false;
  private disposed = false;
  private resizeObs: ResizeObserver;

  constructor(
    private canvas: HTMLCanvasElement,
    private labelLayer: HTMLElement,
    readonly memes: VerseMeme[],
    private atlas: AtlasMeta,
    private events: EngineEvents,
    private opts: EngineOptions,
  ) {
    const n = memes.length;
    this.layout = buildLayout(memes, atlas.colors);
    this.renderer = new Renderer(canvas, atlas.pages);
    this.renderer.setGalaxy(this.layout, atlas.colors.map(hexToRgb));
    this.sx = new Float32Array(n);
    this.sy = new Float32Array(n);
    this.sd = new Float32Array(n);
    this.sr = new Float32Array(n);
    this.state = new Float32Array(n).fill(1);
    this.hiMap = new Float32Array(n).fill(-1);

    this.hiCache = new HiResCache(
      (t) => opts.hiResUrl(memes[t]!),
      (slot, img) => this.renderer.uploadHi(slot, img),
      (tile, slot) => { this.hiMap[tile] = slot; this.hiDirty = true; },
    );

    this.buildLabels();
    this.loadPages();
    this.bindInput();

    canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas);
    this.resize();

    // The opening shot: high above the disc, then a long swoop down.
    const ext = this.layout.extent;
    this.cam.pose = { target: [0, 0, 0], yaw: 1.1, pitch: 1.32, dist: Math.min(MAX_DIST, ext * 5.5) };
    this.cam.goal = { ...this.cam.pose, target: [0, 0, 0] };
    this.raf = requestAnimationFrame(this.frame);
  }

  // ── setup ────────────────────────────────────────────────────────────

  private async loadPages(): Promise<void> {
    for (let p = 0; p < this.atlas.pages; p++) {
      try {
        const res = await fetch(`${this.opts.atlasBase}/tiles-${p}.webp?v=${this.opts.atlasVersion}`);
        if (!res.ok) throw new Error(String(res.status));
        const bmp = await createImageBitmap(await res.blob());
        if (this.disposed) return;
        this.renderer.uploadPage(p, bmp);
        bmp.close?.();
      } catch (err) {
        console.warn(`[memeverse] atlas sheet ${p} failed to load`, err);
      }
    }
  }

  private buildLabels(): void {
    this.labelLayer.textContent = '';
    this.labels = this.layout.systems.map((s) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'verse-label';
      const hash = document.createElement('span');
      hash.className = 'verse-label-hash';
      hash.textContent = '#';
      const count = document.createElement('span');
      count.className = 'verse-label-n';
      count.textContent = String(s.members.length);
      el.append(hash, s.tag, count);
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.events.onLabelClick?.(s.tag);
      });
      this.labelLayer.appendChild(el);
      return el;
    });
  }

  private overview() {
    // Portrait screens see less of the disc side to side; back off to suit.
    const aspect = this.cssW / this.cssH;
    const narrow = Math.min(1.9, Math.max(1, 1 / (aspect * 1.35)));
    return { target: [0, 0, 0] as Vec3, pitch: 0.62, dist: this.layout.extent * 1.08 * narrow };
  }

  start(): void {
    const dur = this.opts.reducedMotion ? 0 : 5.2;
    this.cam.flyTo({ ...this.overview(), yaw: 0.25 }, dur, () => this.endIntro());
  }

  // Ends the opening swoop's hold on the UI: from here deep links run and the
  // idle drift may start. Called when the swoop lands, when a deep link cuts
  // it short, or when the viewer grabs the camera.
  endIntro(): void {
    if (this.introDone) return;
    this.introDone = true;
    this.events.onIntroDone?.();
  }

  // ── input ────────────────────────────────────────────────────────────

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', this.onPointerDown);
    c.addEventListener('pointermove', this.onPointerMove);
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('pointercancel', this.onPointerUp);
    c.addEventListener('pointerleave', this.onPointerLeave);
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('contextmenu', this.onContextMenu);
  }

  private touched(): void {
    this.lastInput = this.time;
    if (this.touring) this.stopTour();
    // Grabbing the camera mid-swoop cancels the intro flight, and with it
    // the flight's onDone — so end the intro here instead.
    this.endIntro();
  }

  private onContextMenu = (e: Event) => e.preventDefault();

  private onPointerDown = (e: PointerEvent) => {
    if (this.recording) return;
    this.canvas.setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) {
        const [a, b] = [...this.touches.values()] as [{ x: number; y: number }, { x: number; y: number }];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
        if (this.drag) this.drag.moved = true;
        return;
      }
    }
    this.drag = {
      id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, button: e.button,
      pan: e.button === 2 || e.shiftKey,
    };
  };

  private onPointerMove = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect();
    this.pointer = { x: e.clientX - r.left, y: e.clientY - r.top, inside: true, moved: true };
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size >= 2 && this.pinch) {
        const [a, b] = [...this.touches.values()] as [{ x: number; y: number }, { x: number; y: number }];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (d > 0 && this.pinch.d > 0) this.cam.zoom(this.pinch.d / d);
        this.cam.pan(mx - this.pinch.mx, my - this.pinch.my, this.cssH);
        this.pinch = { d, mx, my };
        // Keep the finger that started the drag current, so lifting the
        // other one doesn't orbit by everything it moved during the pinch.
        if (this.drag?.id === e.pointerId) { this.drag.x = e.clientX; this.drag.y = e.clientY; }
        this.touched();
        return;
      }
    }
    const g = this.drag;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 5) g.moved = true;
    if (g.moved) {
      if (g.pan) this.cam.pan(dx, dy, this.cssH);
      else this.cam.orbit(-dx * 0.0055, dy * 0.0045);
      this.touched();
    }
    g.x = e.clientX;
    g.y = e.clientY;
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinch = null;
    }
    const g = this.drag;
    if (!g || g.id !== e.pointerId) return;
    this.drag = null;
    if (g.moved || e.type === 'pointercancel') return;
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    this.touched();
    if (this.mode === 'mosaic') {
      const cell = this.mosaicCellAt(x, y);
      if (cell >= 0 && this.mosaic) this.focusMeme(this.mosaic.cells[cell]!.tile);
      else if (this.focus >= 0) this.clearFocus();
      return;
    }
    if (this.mode !== 'galaxy') return;
    const hit = this.pick(x, y);
    if (hit >= 0) this.focusMeme(hit);
    else if (this.focus >= 0) this.clearFocus();
  };

  private onPointerLeave = () => {
    this.pointer.inside = false;
    this.pointer.moved = true;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (this.recording) return;
    const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    const k = e.ctrlKey ? 0.01 : 0.0013;
    this.cam.zoom(Math.exp(clamp(e.deltaY * scale * k, -0.6, 0.6)));
    this.touched();
  };

  private onContextLost = (e: Event) => {
    e.preventDefault();
    this.events.onContextLost?.();
  };

  private dprCap = 2;
  private slowFrames = 0;

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.cssW = Math.max(1, rect.width);
    this.cssH = Math.max(1, rect.height);
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.75 : 2, this.dprCap);
    this.renderer.resize(this.cssW, this.cssH, this.dpr);
  }

  // If the GPU can't keep up, render fewer pixels rather than stutter: after
  // two seconds of sub-30fps frames, step the pixel ratio down (not below
  // 0.75) and give it another two seconds.
  private adaptQuality(dt: number): void {
    // Never resize mid-clip: the encoder can't follow a resolution change.
    if (this.time < 4 || document.hidden || this.recording) return;
    this.slowFrames = dt > 1 / 30 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 2);
    if (this.slowFrames > 60 && this.dpr > 0.8) {
      this.dprCap = Math.max(0.75, this.dpr * 0.75);
      this.slowFrames = 0;
      this.resize();
    }
  }

  // ── picking ──────────────────────────────────────────────────────────

  private pick(x: number, y: number): number {
    let best = -1;
    let bestD = Infinity;
    const n = this.memes.length;
    for (let i = 0; i < n; i++) {
      const d = this.sd[i]!;
      if (d <= 0) continue;
      const r = this.sr[i]! * (this.filter && !this.filter.has(i) ? 0.85 : this.filter ? 1.3 : 1) * 0.92;
      const dx = x - this.sx[i]!, dy = y - this.sy[i]!;
      if (dx * dx + dy * dy > r * r) continue;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  private rayAt(x: number, y: number): { o: Vec3; d: Vec3 } {
    const nx = (x / this.cssW) * 2 - 1;
    const ny = 1 - (y / this.cssH) * 2;
    const m = this.invViewProj;
    const unproject = (z: number): Vec3 => {
      const X = m[0]! * nx + m[4]! * ny + m[8]! * z + m[12]!;
      const Y = m[1]! * nx + m[5]! * ny + m[9]! * z + m[13]!;
      const Z = m[2]! * nx + m[6]! * ny + m[10]! * z + m[14]!;
      const W = m[3]! * nx + m[7]! * ny + m[11]! * z + m[15]!;
      return [X / W, Y / W, Z / W];
    };
    const a = unproject(-1), b = unproject(1);
    return { o: a, d: v3.norm(v3.sub(b, a)) };
  }

  private mosaicCellAt(x: number, y: number): number {
    if (!this.mosaic || !this.plane) return -1;
    const { o, d } = this.rayAt(x, y);
    const pl = this.plane;
    const denom = v3.dot(d, pl.normal);
    if (Math.abs(denom) < 1e-5) return -1;
    const t = v3.dot(v3.sub(pl.origin, o), pl.normal) / denom;
    if (t <= 0) return -1;
    const p = v3.add(o, v3.scale(d, t));
    const rel = v3.sub(p, pl.origin);
    return this.mosaic.cellAt(v3.dot(rel, pl.right), v3.dot(rel, pl.up));
  }

  // ── public controls ──────────────────────────────────────────────────

  get focused(): number {
    return this.focus;
  }

  get currentMode(): Mode {
    return this.mode;
  }

  private setMode(m: Mode): void {
    if (this.mode === m) return;
    this.mode = m;
    this.events.onMode?.(m);
    // Anyone filming the assembly stops waiting once it lands — or once
    // it's abandoned.
    if (m !== 'assembling') this.assembledWaiters.splice(0).forEach((r) => r());
  }

  get filterSet(): ReadonlySet<number> | null {
    return this.filter;
  }

  setTint(v: number): void {
    this.renderer.tintAmount = v;
  }

  setInset(right: number, bottom: number): void {
    this.inset = { right, bottom };
  }

  private focusPose(i: number) {
    const p = positionAt(this.layout, i, this.spinT, this.galaxyAngle);
    const pitch = clamp(this.cam.pose.pitch, 0.08, 0.55);
    const yaw = this.cam.pose.yaw;
    // Shift the target so the tile lands in the middle of whatever the info
    // panel leaves uncovered.
    const worldPerPx = (2 * FOCUS_DIST * Math.tan(this.cam.fov / 2)) / this.cssH;
    const right: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const cp = Math.cos(pitch);
    const back: Vec3 = [cp * Math.sin(yaw), Math.sin(pitch), cp * Math.cos(yaw)];
    const up = v3.norm(v3.cross(back, right));
    let target = v3.add(p, v3.scale(right, (this.inset.right / 2) * worldPerPx));
    target = v3.add(target, v3.scale(up, -(this.inset.bottom / 2) * worldPerPx));
    return { target, yaw, pitch, dist: FOCUS_DIST };
  }

  focusMeme(i: number, opts: { warp?: boolean } = {}): void {
    if (i < 0 || i >= this.memes.length) return;
    // Over the portrait the camera stays put; the panel just shows the meme.
    if (this.mode === 'mosaic') {
      this.focus = i;
      this.events.onFocus?.(i);
      return;
    }
    if (this.mode !== 'galaxy') return;
    this.stopTour();
    this.focus = i;
    this.spinRate = 0;
    const pose = this.focusPose(i);
    const hop = v3.dist(this.cam.pose.target, pose.target);
    const motion = this.opts.reducedMotion ? 0 : 1;
    if (opts.warp && motion) {
      this.warpTarget = 1;
      this.cam.fovKick = 0.55;
      this.cam.flyTo(pose, 2.1, () => { this.warpTarget = 0; });
    } else {
      this.cam.flyTo(pose, motion * clamp(0.9 + hop / 140, 1.1, 2.6));
    }
    this.events.onFocus?.(i);
  }

  clearFocus(opts: { pullBack?: boolean } = {}): void {
    if (this.focus < 0) return;
    this.focus = -1;
    if (opts.pullBack !== false && this.mode === 'galaxy') {
      this.cam.flyTo({ dist: Math.max(this.cam.pose.dist, 38) }, this.opts.reducedMotion ? 0 : 1.2);
    }
    this.events.onFocus?.(null);
  }

  systemByTag(tag: string): StarSystem | undefined {
    return this.layout.systems.find((s) => s.tag === tag);
  }

  focusSystem(s: StarSystem, dur = 2.4): void {
    const c = systemCenterAt(s, this.galaxyAngle);
    this.cam.flyTo(
      { target: c, dist: s.radius * 2.5 + 14, pitch: clamp(this.cam.pose.pitch, 0.3, 0.75) },
      this.opts.reducedMotion ? 0 : dur,
    );
  }

  // Dim everything outside `set` and frame what's left.
  setFilter(set: Set<number> | null, fly = true): void {
    this.filter = set && set.size ? set : null;
    for (let i = 0; i < this.memes.length; i++) this.state[i] = this.filter?.has(i) ? 1 : 0;
    this.stateDirty = true;
    this.systemLit = this.layout.systems.map((s) => !!this.filter && s.members.some((i) => this.filter!.has(i)));
    if (!this.filter || !fly || this.mode !== 'galaxy') return;
    if (this.focus >= 0) this.clearFocus({ pullBack: false });
    // Fit a sphere around the matches as they stand right now.
    const pts = [...this.filter].map((i) => positionAt(this.layout, i, this.spinT, this.galaxyAngle));
    const c = pts.reduce<Vec3>((a, p) => v3.add(a, p), [0, 0, 0]).map((v) => v / pts.length) as Vec3;
    const r = Math.max(6, ...pts.map((p) => v3.dist(p, c)));
    const dist = clamp((r * 1.25) / Math.tan(this.cam.fov / 2), 14, MAX_DIST * 0.8);
    this.cam.flyTo({ target: c, dist, pitch: clamp(this.cam.pose.pitch, 0.35, 0.9) }, this.opts.reducedMotion ? 0 : 2.2);
  }

  warpRandom(pool?: number[]): number {
    const all = pool && pool.length ? pool : null;
    const n = all ? all.length : this.memes.length;
    const at = (k: number) => (all ? all[k]! : k);
    // Never warp to where you already are; stay inside the pool.
    let k = Math.floor(Math.random() * n);
    if (at(k) === this.focus && n > 1) k = (k + 1 + Math.floor(Math.random() * (n - 1))) % n;
    const i = at(k);
    if (this.focus >= 0) this.focus = -1;
    this.focusMeme(i, { warp: true });
    return i;
  }

  flyHome(): void {
    if (this.mode !== 'galaxy') return;
    this.stopTour();
    if (this.focus >= 0) this.clearFocus({ pullBack: false });
    this.cam.flyTo(this.overview(), this.opts.reducedMotion ? 0 : 2.6);
  }

  // Autopilot: core outward, alternating arms, a slow orbit at each stop.
  startTour(): void {
    if (this.mode !== 'galaxy') return;
    if (this.focus >= 0) this.clearFocus({ pullBack: false });
    const core = this.layout.systems.filter((s) => s.arm === -1);
    const rest = this.layout.systems
      .filter((s) => s.arm !== -1)
      .sort((a, b) => Math.hypot(a.center[0], a.center[2]) - Math.hypot(b.center[0], b.center[2]));
    this.tourOrder = [...core, ...rest];
    this.tourIdx = 0;
    this.touring = true;
    this.nextTourStop();
  }

  stopTour(): void {
    if (!this.touring) return;
    this.touring = false;
    this.tourHold = -1;
    this.events.onTour?.(null);
  }

  get isTouring(): boolean {
    return this.touring;
  }

  private nextTourStop(): void {
    if (!this.touring || !this.tourOrder.length) return;
    const s = this.tourOrder[this.tourIdx % this.tourOrder.length]!;
    this.events.onTour?.(s);
    const c = systemCenterAt(s, this.galaxyAngle);
    const rand = mulberry32(this.tourIdx + 11);
    this.tourHold = -1;
    this.cam.flyTo(
      { target: c, dist: s.radius * 2.3 + 12, pitch: 0.25 + rand() * 0.45, yaw: this.cam.pose.yaw + 0.5 + rand() * 0.8 },
      this.opts.reducedMotion ? 0 : 3.4,
      () => { if (this.touring) this.tourHold = TOUR_HOLD; },
    );
  }

  // ── assemble ─────────────────────────────────────────────────────────

  assemble(result: MosaicResult): void {
    this.stopTour();
    if (this.focus >= 0) this.clearFocus({ pullBack: false });
    this.events.onHover?.(null);
    this.hover = -1;
    // Hang the portrait above the core, square to wherever the viewer is
    // already facing, so nobody gets spun round to see it.
    const yaw = this.cam.pose.yaw;
    const normal: Vec3 = [Math.sin(yaw), 0, Math.cos(yaw)];
    const right: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const up: Vec3 = [0, 1, 0];
    const h = result.height;
    const origin: Vec3 = [0, h * 0.5 + 16, 0];
    this.plane = { origin, right, up, normal, tileR: result.r * 0.93 };
    this.mosaic = result;
    this.renderer.setMosaic(result.cells, this.plane);
    this.setMode('assembling');
    this.morph = 0;
    this.spinRate = 0;
    this.cam.flyTo(this.portraitPose(), this.opts.reducedMotion ? 0 : 2.8);
  }

  // Square on to the portrait, fitted into the space the top bar and the
  // result toolbar leave free (or the whole frame, for a clip) and nudged up
  // so the toolbar doesn't cover it.
  private portraitPose(clip = false) {
    const pl = this.plane!, res = this.mosaic!;
    const top = clip ? 0 : 64, bottom = clip ? 0 : this.cssW < 720 ? 150 : 128;
    const freeH = Math.max(120, this.cssH - top - bottom);
    const freeFrac = freeH / this.cssH;
    const aspect = this.cssW / this.cssH;
    const halfH = Math.max(res.height / 2, res.width / 2 / aspect) / freeFrac;
    const dist = (halfH * (clip ? 1.12 : 1.06)) / Math.tan(this.cam.fov / 2);
    const worldPerPx = (2 * dist * Math.tan(this.cam.fov / 2)) / this.cssH;
    const lift = ((bottom - top) / 2) * worldPerPx;
    const yaw = Math.atan2(pl.normal[0], pl.normal[2]);
    return { target: v3.add(pl.origin, [0, -lift, 0]) as Vec3, yaw, pitch: 0.04, dist };
  }

  disassemble(): void {
    if (this.mode === 'galaxy' || this.mode === 'disassembling' || this.recording) return;
    if (this.focus >= 0) this.clearFocus({ pullBack: false });
    this.setMode('disassembling');
    this.events.onHover?.(null);
    this.hoverClone = -1;
    this.cam.flyTo(this.overview(), this.opts.reducedMotion ? 0 : 3.2);
  }

  replayAssemble(): void {
    if (!this.mosaic || this.recording) return;
    this.setMode('assembling');
    this.morph = 0;
  }

  // ── clips ────────────────────────────────────────────────────────────

  private recording = false;
  private assembledWaiters: (() => void)[] = [];

  static clipType(): string | undefined {
    if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined') return undefined;
    if (!('captureStream' in HTMLCanvasElement.prototype)) return undefined;
    // MP4 first: it's what X and iMessage accept. Chrome 126+ and Safari
    // record it; Firefox falls back to WebM, which Discord and Telegram play.
    return ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find((t) => MediaRecorder.isTypeSupported(t));
  }

  get isRecording(): boolean {
    return this.recording;
  }

  // Films the assembly from scratch — the galaxy pouring into the portrait
  // under a slow push-in — straight off the canvas (none of the HTML UI is
  // in it), at most 1920px on the long side.
  async recordAssemble(): Promise<{ blob: Blob; ext: 'mp4' | 'webm' } | null> {
    const type = VerseEngine.clipType();
    if (!this.mosaic || !this.plane || !type || this.recording || this.mode === 'disassembling') return null;
    this.recording = true;
    this.setHover(-1, -1);
    if (this.focus >= 0) this.clearFocus({ pullBack: false });
    const cap = this.dprCap;
    this.dprCap = Math.min(cap, 1920 / Math.max(this.cssW, this.cssH));
    this.resize();
    const pose = this.portraitPose(true);
    this.cam.pose = { ...pose, target: [...pose.target] as Vec3, dist: pose.dist * 1.32 };
    this.cam.goal = { ...this.cam.pose, target: [...pose.target] as Vec3 };
    this.cam.flyTo(pose, 6.4);
    this.setMode('assembling');
    this.morph = 0;

    const stream = this.canvas.captureStream(30);
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 12_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise<void>((r) => { rec.onstop = () => r(); });
    try {
      rec.start(500);
      // The assembly runs ~5.5s of engine time; a slow device stretches
      // that, but never past a minute.
      await new Promise<void>((r) => {
        this.assembledWaiters.push(r);
        setTimeout(r, 60_000);
      });
      if ((this.mode as Mode) === 'mosaic') await new Promise((r) => setTimeout(r, 1800));
    } finally {
      if (rec.state !== 'inactive') rec.stop();
      await stopped;
      stream.getTracks().forEach((t) => t.stop());
      this.dprCap = cap;
      this.resize();
      this.recording = false;
      if (!this.disposed && (this.mode as Mode) === 'mosaic') this.cam.flyTo(this.portraitPose(), 1.2);
    }
    if (!chunks.length) return null;
    return { blob: new Blob(chunks, { type: type.split(';')[0] }), ext: type.startsWith('video/mp4') ? 'mp4' : 'webm' };
  }

  // ── frame ────────────────────────────────────────────────────────────

  private frame = (now: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const raw = this.last ? (now - this.last) / 1000 : 1 / 60;
    const dt = Math.min(0.05, raw);
    this.last = now;
    this.time += dt;
    this.adaptQuality(raw);
    const rm = this.opts.reducedMotion;

    // Galaxy motion — it holds still while you're looking at something.
    const spinGoal = rm || this.focus >= 0 || this.mode !== 'galaxy' ? 0 : 1;
    this.spinRate += (spinGoal - this.spinRate) * (1 - Math.exp(-dt * 0.8));
    this.spinT += dt * this.spinRate;
    this.galaxyAngle += dt * 0.0045 * this.spinRate;

    // Idle drift.
    if (!rm && this.introDone && !this.touring && this.focus < 0 && this.mode === 'galaxy'
      && !this.cam.flying && this.time - this.lastInput > 9 && !this.drag) {
      this.cam.goal.yaw += dt * 0.025;
    }

    // Tour hold: a slow orbit, then on to the next stop.
    if (this.touring && this.tourHold > 0) {
      this.cam.goal.yaw += dt * 0.09;
      this.tourHold -= dt;
      if (this.tourHold <= 0) {
        this.tourIdx++;
        this.nextTourStop();
      }
    }

    // Assemble morph.
    if (this.mode === 'assembling') {
      this.morph = Math.min(1, this.morph + dt / (rm ? 0.01 : 5.5));
      if (this.morph >= 1) {
        this.pulse = 1;
        this.setMode('mosaic');
      }
    } else if (this.mode === 'disassembling') {
      this.morph = Math.max(0, this.morph - dt / (rm ? 0.01 : 3.2));
      if (this.morph <= 0) {
        this.renderer.clearMosaic();
        this.mosaic = null;
        this.plane = null;
        this.setMode('galaxy');
      }
    }
    this.pulse *= Math.exp(-dt * 1.6);

    this.warp += (this.warpTarget - this.warp) * (1 - Math.exp(-dt * (this.warpTarget > this.warp ? 6 : 2.5)));

    const aspect = this.cssW / this.cssH;
    this.cam.update(dt, aspect);
    multiply(this.cam.proj, this.cam.view, this.viewProj);
    invert(this.viewProj, this.invViewProj);

    this.projectTiles();

    // Hover.
    if (this.pointer.moved || this.cam.flying || this.spinRate > 0.01) {
      this.pointer.moved = false;
      if (!this.pointer.inside || this.drag?.moved || this.pinch || this.recording) {
        this.setHover(-1, -1);
      } else if (this.mode === 'mosaic') {
        const cell = this.mosaicCellAt(this.pointer.x, this.pointer.y);
        this.setHover(-1, cell);
      } else if (this.mode === 'galaxy') {
        this.setHover(this.pick(this.pointer.x, this.pointer.y), -1);
      }
    }

    this.updateLabels();

    this.hiTick -= dt;
    if (this.hiTick <= 0 && (this.mode === 'galaxy' || this.mode === 'mosaic')) {
      this.hiTick = 0.25;
      this.hiCache.update(this.mode === 'mosaic' ? this.bigCells() : this.bigTiles());
    }
    if (this.stateDirty) {
      this.renderer.setState(this.state);
      this.stateDirty = false;
    }
    if (this.hiDirty) {
      this.renderer.setHiMap(this.hiMap);
      this.hiDirty = false;
    }

    const d = this.cam.pose.dist;
    this.renderer.render({
      view: this.cam.view,
      proj: this.cam.proj,
      invViewProj: this.invViewProj,
      camPos: this.cam.eye,
      camRight: this.cam.right,
      camUp: this.cam.up,
      spinT: this.spinT,
      galaxyAngle: this.galaxyAngle,
      time: this.time,
      warp: this.warp,
      hover: this.hover,
      hoverClone: this.hoverClone,
      focus: this.focus,
      filterOn: !!this.filter,
      morph: this.morph,
      galaxyFade: 1 - 0.72 * smoothstep(0, 0.6, this.morph),
      fog: [d * 1.6 + 60, d * 4.5 + 520],
      pulse: this.pulse,
      coreFade: 0.12 + 0.88 * smoothstep(10, 80, v3.len(this.cam.eye)),
    });
  };

  private projectTiles(): void {
    const m = this.viewProj;
    const n = this.memes.length;
    const halfH = this.cssH / 2, halfW = this.cssW / 2;
    const k = this.cam.proj[5]! * halfH;
    const p: Vec3 = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      positionAt(this.layout, i, this.spinT, this.galaxyAngle, p);
      const cx = m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!;
      const cy = m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!;
      const cw = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!;
      if (cw <= 0.05) { this.sd[i] = -1; this.sr[i] = 0; continue; }
      this.sx[i] = (cx / cw + 1) * halfW;
      this.sy[i] = (1 - cy / cw) * halfH;
      this.sd[i] = cw;
      this.sr[i] = k / cw;
    }
  }

  private bigTiles(): number[] {
    const out: { i: number; r: number }[] = [];
    const n = this.memes.length;
    for (let i = 0; i < n; i++) {
      const r = this.sr[i]!;
      if (r < 30 || this.sd[i]! <= 0) continue;
      const x = this.sx[i]!, y = this.sy[i]!;
      if (x < -r || y < -r || x > this.cssW + r || y > this.cssH + r) continue;
      if (this.filter && !this.filter.has(i)) continue;
      out.push({ i, r });
    }
    out.sort((a, b) => b.r - a.r);
    return out.slice(0, 48).map((o) => o.i);
  }

  // The mosaic's version of bigTiles(): memes whose hexes on the portrait
  // are big on screen right now, biggest first, each meme once.
  private bigCells(): number[] {
    if (!this.mosaic || !this.plane) return [];
    const m = this.viewProj;
    const k = this.cam.proj[5]! * (this.cssH / 2);
    const { origin, right, up } = this.plane;
    const best = new Map<number, number>();
    for (const c of this.mosaic.cells) {
      const x = origin[0] + right[0] * c.u + up[0] * c.v;
      const y = origin[1] + right[1] * c.u + up[1] * c.v;
      const z = origin[2] + right[2] * c.u + up[2] * c.v;
      const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
      if (cw <= 0.05) continue;
      const r = (this.mosaic.r * k) / cw;
      if (r < 30) continue;
      const sx = ((m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / cw + 1) * (this.cssW / 2);
      const sy = (1 - (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / cw) * (this.cssH / 2);
      if (sx < -r || sy < -r || sx > this.cssW + r || sy > this.cssH + r) continue;
      if ((best.get(c.tile) ?? 0) < r) best.set(c.tile, r);
    }
    return [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, 48).map(([t]) => t);
  }

  private setHover(i: number, clone: number): void {
    if (i === this.hover && clone === this.hoverClone) {
      if (i >= 0) this.events.onHover?.({ index: i, x: this.sx[i]!, y: this.sy[i]! - this.sr[i]! * 1.4 });
      return;
    }
    this.hover = i;
    this.hoverClone = clone;
    if (i >= 0) {
      this.events.onHover?.({ index: i, x: this.sx[i]!, y: this.sy[i]! - this.sr[i]! * 1.4 });
      this.canvas.style.cursor = 'pointer';
    } else if (clone >= 0 && this.mosaic) {
      this.events.onHover?.({ index: this.mosaic.cells[clone]!.tile, x: this.pointer.x, y: this.pointer.y - 26 });
      this.canvas.style.cursor = 'pointer';
    } else {
      this.events.onHover?.(null);
      this.canvas.style.cursor = '';
    }
  }

  private labelW: number[] = [];
  private labelOrder: number[] = [];
  private systemLit: boolean[] = [];

  // Pin each system's label above its disc. Labels fade in once a disc is
  // big enough to be worth naming and out again when you're inside it;
  // where two collide, the bigger system keeps its name.
  private updateLabels(): void {
    const m = this.viewProj;
    const k = this.cam.proj[5]! * (this.cssH / 2);
    const hideAll = this.mode !== 'galaxy' || this.focus >= 0 || (!this.introDone && this.time < 2.5);
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    if (!this.labelOrder.length) {
      this.labelOrder = this.layout.systems.map((_, i) => i).sort((a, b) => this.layout.systems[b]!.members.length - this.layout.systems[a]!.members.length);
    }
    for (const idx of this.labelOrder) {
      const s = this.layout.systems[idx]!;
      const el = this.labels[idx]!;
      const c = systemCenterAt(s, this.galaxyAngle);
      const cx = m[0]! * c[0] + m[4]! * c[1] + m[8]! * c[2] + m[12]!;
      const cy = m[1]! * c[0] + m[5]! * c[1] + m[9]! * c[2] + m[13]!;
      const cw = m[3]! * c[0] + m[7]! * c[1] + m[11]! * c[2] + m[15]!;
      let alpha = 0;
      let x = 0, y = 0;
      if (cw > 0.5 && !hideAll) {
        const rpx = (s.radius * k) / cw;
        x = (cx / cw + 1) * (this.cssW / 2);
        y = (1 - cy / cw) * (this.cssH / 2) - Math.min(rpx * 0.62, this.cssH * 0.3) - 12;
        alpha = smoothstep(16, 42, rpx) * (1 - smoothstep(this.cssH * 0.45, this.cssH * 0.9, rpx));
        if (this.filter) alpha *= this.systemLit[idx] ? 1 : 0.25;
        if (alpha > 0.02) {
          const w = (this.labelW[idx] ||= el.offsetWidth || s.tag.length * 8 + 44);
          const box = { x0: x - w / 2 - 4, x1: x + w / 2 + 4, y0: y - 26, y1: y + 2 };
          if (placed.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) alpha = 0;
          else placed.push(box);
        }
      }
      if (alpha < 0.02) {
        if (el.style.opacity !== '0') { el.style.opacity = '0'; el.style.pointerEvents = 'none'; }
        continue;
      }
      el.style.opacity = alpha.toFixed(3);
      el.style.pointerEvents = alpha > 0.35 ? 'auto' : 'none';
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.assembledWaiters.splice(0).forEach((r) => r());
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointercancel', this.onPointerUp);
    c.removeEventListener('pointerleave', this.onPointerLeave);
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('contextmenu', this.onContextMenu);
    c.removeEventListener('webglcontextlost', this.onContextLost);
    this.labelLayer.textContent = '';
    this.renderer.dispose();
  }
}

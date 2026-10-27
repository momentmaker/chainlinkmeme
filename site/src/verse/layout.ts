// Lays the archive out as a spiral galaxy.
//
// Every tag carried by at least SYSTEM_MIN memes becomes a star system: a
// small spinning disc of hex tiles. Each meme joins exactly one system — the
// rarest qualifying tag it carries — so the giant tags (sergey, pepe,
// linkpilled) don't swallow everything and the niche ones still get a home.
// The sergey system wraps the galactic core around the glowing chainlink
// hex; the rest wind outward along two arms, each placed next to the system
// it shares the most memes with. Memes with no qualifying tag drift on the
// outer rim.
//
// Pure and deterministic: same manifest in, same galaxy out.

import { hashString, mulberry32, type Vec3 } from './math';

export const SYSTEM_MIN = 12;
export const MAX_SYSTEMS = 40;
export const CORE_TAG = 'sergey';
// Tile circumradius is 1 world unit; centre-to-centre spacing inside a disc.
export const TILE_SPACING = 2.55;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const PHYLLO_C = TILE_SPACING * Math.sqrt(Math.sqrt(3) / (2 * Math.PI));
const CORE_HOLE = 7; // keeps the core disc off the logo
const ARM_PITCH = 0.2;
const SYSTEM_GAP = 7;

export interface LayoutMeme {
  slug: string;
  tags: string[];
}

export interface StarSystem {
  tag: string;
  index: number;
  members: number[];
  // How many memes in the whole archive carry the tag (members is the subset
  // that call this system home).
  tagTotal: number;
  center: Vec3;
  radius: number;
  tiltX: number;
  tiltZ: number;
  spin: number; // rad/s around the disc's own axis
  arm: number; // -1 for the core
}

export interface GalaxyLayout {
  systems: StarSystem[];
  // Per meme: owning system index (-1 = outer rim), anchor point, offset in
  // the anchor's disc frame, disc tilt and spin speed. These map 1:1 onto
  // instance attributes; positionAt() mirrors the vertex shader on the CPU.
  memeSystem: Int32Array;
  anchor: Float32Array;
  local: Float32Array;
  tilt: Float32Array;
  spin: Float32Array;
  extent: number;
}

function luminance(hex: string | undefined): number {
  if (!hex || hex.length !== 7) return 0.5;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function buildLayout(memes: LayoutMeme[], colors: string[] = []): GalaxyLayout {
  const n = memes.length;
  const tagCount = new Map<string, number>();
  for (const m of memes) for (const t of m.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);

  const systemTags = [...tagCount.entries()]
    .filter(([, c]) => c >= SYSTEM_MIN)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_SYSTEMS)
    .map(([t]) => t);
  const systemIndex = new Map(systemTags.map((t, i) => [t, i]));

  const memeSystem = new Int32Array(n).fill(-1);
  const members: number[][] = systemTags.map(() => []);
  for (let i = 0; i < n; i++) {
    let best = -1;
    let bestCount = Infinity;
    for (const t of memes[i]!.tags) {
      const s = systemIndex.get(t);
      if (s === undefined) continue;
      const c = tagCount.get(t)!;
      if (c < bestCount || (c === bestCount && t < systemTags[best]!)) { best = s; bestCount = c; }
    }
    memeSystem[i] = best;
    if (best >= 0) members[best]!.push(i);
  }

  // Brightest memes at each disc's heart, darkest on its edge — every system
  // gets a glowing core for free.
  for (const list of members) list.sort((a, b) => luminance(colors[b]) - luminance(colors[a]) || a - b);

  // Affinity between systems: shared memes, normalised by size.
  const k = systemTags.length;
  const cooc = Array.from({ length: k }, () => new Float32Array(k));
  for (const m of memes) {
    const ids = m.tags.map((t) => systemIndex.get(t)).filter((s): s is number => s !== undefined);
    for (const a of ids) for (const b of ids) if (a !== b) cooc[a]![b]! += 1;
  }
  const affinity = (a: number, b: number) =>
    cooc[a]![b]! / Math.sqrt((tagCount.get(systemTags[a]!) ?? 1) * (tagCount.get(systemTags[b]!) ?? 1));

  const discRadius = (count: number) => PHYLLO_C * Math.sqrt(count + 0.5) + 1.2;
  const rand = mulberry32(hashString('memeverse'));

  const systems: StarSystem[] = systemTags.map((tag, i) => ({
    tag,
    index: i,
    members: members[i]!,
    tagTotal: tagCount.get(tag) ?? 0,
    center: [0, 0, 0],
    radius: 0,
    tiltX: 0,
    tiltZ: 0,
    spin: 0,
    arm: 0,
  }));

  // The core.
  const coreIdx = systemIndex.get(CORE_TAG) ?? 0;
  const core = systems[coreIdx];
  const placed: StarSystem[] = [];
  let coreRadius = CORE_HOLE;
  if (core) {
    const holeK = (CORE_HOLE / PHYLLO_C) ** 2;
    core.radius = PHYLLO_C * Math.sqrt(core.members.length + holeK) + 1.2;
    core.center = [0, 0, 0];
    core.tiltX = 0;
    core.tiltZ = 0;
    core.spin = 0.035;
    core.arm = -1;
    coreRadius = core.radius;
    placed.push(core);
  }

  // Order the rest along two arms: biggest first on each, then greedily the
  // unplaced system that shares the most with the arm's tail.
  const remaining = new Set(systems.filter((s) => s !== core).map((s) => s.index));
  const bySize = [...remaining].sort((a, b) => systems[b]!.members.length - systems[a]!.members.length);
  const arms: number[][] = [[], []];
  for (let a = 0; a < 2 && bySize.length; a++) {
    const first = bySize.find((s) => remaining.has(s));
    if (first === undefined) break;
    arms[a]!.push(first);
    remaining.delete(first);
  }
  let turn = 0;
  while (remaining.size) {
    const arm = arms[turn % 2]!;
    const tail = arm[arm.length - 1]!;
    let best = -1;
    let bestScore = -1;
    for (const s of remaining) {
      const score = affinity(tail, s) * 4 + systems[s]!.members.length / n;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    arm.push(best);
    remaining.delete(best);
    turn++;
  }

  // Walk each arm along a logarithmic spiral, stepping until the next system
  // clears every disc already placed.
  for (let a = 0; a < 2; a++) {
    const phase = a * Math.PI;
    let theta = 0.35;
    const r0 = coreRadius + SYSTEM_GAP;
    for (const si of arms[a]!) {
      const s = systems[si]!;
      s.radius = discRadius(s.members.length);
      s.arm = a;
      const spiralAt = (th: number): Vec3 => {
        const r = r0 * Math.exp(ARM_PITCH * th) + s.radius;
        return [Math.cos(th + phase) * r, (rand() - 0.5) * 2.5, Math.sin(th + phase) * r];
      };
      let pos = spiralAt(theta);
      for (let guard = 0; guard < 4000; guard++) {
        const clear = placed.every((p) =>
          Math.hypot(p.center[0] - pos[0], p.center[2] - pos[2]) >= p.radius + s.radius + SYSTEM_GAP,
        );
        if (clear) break;
        theta += 0.015;
        pos = spiralAt(theta);
      }
      s.center = pos;
      s.tiltX = (rand() - 0.5) * 0.7;
      s.tiltZ = (rand() - 0.5) * 0.7;
      s.spin = (rand() < 0.5 ? -1 : 1) * (0.06 / Math.sqrt(Math.max(1, s.radius / 6)));
      placed.push(s);
    }
  }

  let extent = coreRadius;
  for (const s of systems) extent = Math.max(extent, Math.hypot(s.center[0], s.center[2]) + s.radius);

  const anchor = new Float32Array(n * 3);
  const local = new Float32Array(n * 3);
  const tilt = new Float32Array(n * 2);
  const spin = new Float32Array(n);

  for (const s of systems) {
    const hole = s === core ? (CORE_HOLE / PHYLLO_C) ** 2 : 0;
    const thick = s === core ? 1.6 : 0.6;
    s.members.forEach((mi, k2) => {
      const r = PHYLLO_C * Math.sqrt(k2 + 0.5 + hole);
      const a = k2 * GOLDEN_ANGLE;
      anchor.set(s.center, mi * 3);
      local[mi * 3] = Math.cos(a) * r;
      local[mi * 3 + 1] = (rand() - 0.5) * 2 * thick * (1 - r / (s.radius + 1)) ;
      local[mi * 3 + 2] = Math.sin(a) * r;
      tilt[mi * 2] = s.tiltX;
      tilt[mi * 2 + 1] = s.tiltZ;
      spin[mi] = s.spin;
    });
  }

  // The outer rim: unaffiliated memes scattered in a loose ring past the arms,
  // drifting slowly round the galactic centre.
  const rimInner = extent + 18;
  const rim = [...memeSystem.keys()].filter((i) => memeSystem[i] === -1);
  rim.forEach((mi, k2) => {
    const a = k2 * GOLDEN_ANGLE * 7.3 + rand() * 0.4;
    const r = rimInner + rand() * 26;
    local[mi * 3] = Math.cos(a) * r;
    local[mi * 3 + 1] = (rand() - 0.5) * 22;
    local[mi * 3 + 2] = Math.sin(a) * r;
    spin[mi] = 0.012;
  });
  if (rim.length) extent = rimInner + 26;

  return { systems, memeSystem, anchor, local, tilt, spin, extent };
}

// CPU twin of the vertex shader's galaxy placement: spin the offset round the
// disc's own axis, tilt the disc, move it to its anchor, then turn the whole
// galaxy. Used for picking, labels and camera flights.
export function positionAt(layout: GalaxyLayout, i: number, spinT: number, galaxyAngle: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const lx = layout.local[i * 3]!, ly = layout.local[i * 3 + 1]!, lz = layout.local[i * 3 + 2]!;
  const ang = layout.spin[i]! * spinT;
  const c = Math.cos(ang), s = Math.sin(ang);
  let x = c * lx - s * lz;
  let y = ly;
  let z = s * lx + c * lz;
  const tx = layout.tilt[i * 2]!, tz = layout.tilt[i * 2 + 1]!;
  // tilt about X
  const cx = Math.cos(tx), sx = Math.sin(tx);
  const y1 = cx * y - sx * z;
  const z1 = sx * y + cx * z;
  y = y1; z = z1;
  // tilt about Z
  const cz = Math.cos(tz), sz = Math.sin(tz);
  const x2 = cz * x - sz * y;
  const y2 = sz * x + cz * y;
  x = x2; y = y2;
  x += layout.anchor[i * 3]!;
  y += layout.anchor[i * 3 + 1]!;
  z += layout.anchor[i * 3 + 2]!;
  const cg = Math.cos(galaxyAngle), sg = Math.sin(galaxyAngle);
  out[0] = cg * x - sg * z;
  out[1] = y;
  out[2] = sg * x + cg * z;
  return out;
}

export function systemCenterAt(s: StarSystem, galaxyAngle: number): Vec3 {
  const cg = Math.cos(galaxyAngle), sg = Math.sin(galaxyAngle);
  return [cg * s.center[0] - sg * s.center[2], s.center[1], sg * s.center[0] + cg * s.center[2]];
}

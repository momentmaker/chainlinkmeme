import { describe, expect, it } from 'vitest';
import { buildLayout, CORE_TAG, positionAt, SYSTEM_MIN, systemCenterAt, type LayoutMeme } from './layout';

// A small synthetic archive: a big core tag, a few mid-size tags, some
// overlap between them, and a handful of loners for the outer rim.
function archive(): LayoutMeme[] {
  const memes: LayoutMeme[] = [];
  let n = 0;
  const add = (tags: string[], count: number) => {
    for (let i = 0; i < count; i++) memes.push({ slug: `m${n++}`, tags });
  };
  add([CORE_TAG], 40);
  add(['pepe'], 30);
  add(['pepe', CORE_TAG], 14);
  add(['moon'], 20);
  add(['moon', 'pepe'], 6);
  add(['lambo'], 13);
  add(['rare-one'], 3);
  add(['other'], 2);
  return memes;
}

describe('buildLayout', () => {
  it('is deterministic', () => {
    const a = buildLayout(archive());
    const b = buildLayout(archive());
    expect(Array.from(a.local)).toEqual(Array.from(b.local));
    expect(a.systems.map((s) => s.center)).toEqual(b.systems.map((s) => s.center));
  });

  it('turns every tag with enough memes into a system and puts the core tag at the centre', () => {
    const l = buildLayout(archive());
    const tags = l.systems.map((s) => s.tag).sort();
    expect(tags).toEqual([CORE_TAG, 'lambo', 'moon', 'pepe'].sort());
    const core = l.systems.find((s) => s.tag === CORE_TAG)!;
    expect(core.arm).toBe(-1);
    expect(core.center).toEqual([0, 0, 0]);
    for (const s of l.systems) expect(s.tagTotal).toBeGreaterThanOrEqual(SYSTEM_MIN);
  });

  it('homes each meme in its rarest qualifying tag, and sends the rest to the rim', () => {
    const memes = archive();
    const l = buildLayout(memes);
    const tagOf = (i: number) => (l.memeSystem[i]! >= 0 ? l.systems[l.memeSystem[i]!]!.tag : null);
    // pepe+sergey → pepe (50 memes carry pepe vs 54 sergey)
    expect(tagOf(memes.findIndex((m) => m.tags.join() === `pepe,${CORE_TAG}`))).toBe('pepe');
    // moon+pepe → moon (26 < 50)
    expect(tagOf(memes.findIndex((m) => m.tags.join() === 'moon,pepe'))).toBe('moon');
    expect(tagOf(memes.findIndex((m) => m.tags[0] === 'rare-one'))).toBeNull();
    const placed = l.systems.reduce((n, s) => n + s.members.length, 0);
    const rim = Array.from(l.memeSystem).filter((s) => s === -1).length;
    expect(placed + rim).toBe(memes.length);
  });

  it('keeps star systems from overlapping', () => {
    const l = buildLayout(archive());
    for (let i = 0; i < l.systems.length; i++) {
      for (let j = i + 1; j < l.systems.length; j++) {
        const a = l.systems[i]!, b = l.systems[j]!;
        const d = Math.hypot(a.center[0] - b.center[0], a.center[2] - b.center[2]);
        expect(d).toBeGreaterThanOrEqual(a.radius + b.radius);
      }
    }
  });

  it('places every meme inside the reported extent', () => {
    const l = buildLayout(archive());
    for (let i = 0; i < l.memeSystem.length; i++) {
      const p = positionAt(l, i, 0, 0);
      expect(Math.hypot(p[0], p[2])).toBeLessThanOrEqual(l.extent + 1e-6);
    }
  });

  it('spins tiles round their own system without moving the system', () => {
    const l = buildLayout(archive());
    const s = l.systems.find((x) => x.tag === 'pepe')!;
    const i = s.members[5]!;
    const c = systemCenterAt(s, 0);
    const d0 = Math.hypot(...positionAt(l, i, 0, 0).map((v, k) => v - c[k]!) as [number, number, number]);
    const d1 = Math.hypot(...positionAt(l, i, 37, 0).map((v, k) => v - c[k]!) as [number, number, number]);
    expect(d1).toBeCloseTo(d0, 5);
    expect(positionAt(l, i, 37, 0)).not.toEqual(positionAt(l, i, 0, 0));
  });
});

// Sharper textures for the tiles you're actually close to. The atlas holds
// every meme at 64px — plenty for a galaxy of stars, soft once a tile fills a
// fifth of the screen. Each tick the engine hands over the tiles that are
// big on screen; the biggest get a 256px copy (the same attention crop the
// atlas uses, via wsrv) in one of 64 slots on a cache texture, evicting the
// least recently wanted.

import { HI_SIZE, HI_SLOTS } from './renderer';

const MAX_IN_FLIGHT = 6;

export class HiResCache {
  private slotOf = new Map<number, number>();
  private tileIn: number[] = new Array(HI_SLOTS).fill(-1);
  private lastWanted: number[] = new Array(HI_SLOTS).fill(0);
  private loading = new Set<number>();
  private failed = new Set<number>();
  private tick = 0;

  constructor(
    private urlFor: (tile: number) => string,
    private upload: (slot: number, img: TexImageSource) => void,
    private onAssigned: (tile: number, slot: number) => void,
  ) {}

  // `wanted` arrives biggest-on-screen first.
  update(wanted: number[]): void {
    this.tick++;
    for (const t of wanted) {
      const s = this.slotOf.get(t);
      if (s !== undefined) this.lastWanted[s] = this.tick;
    }
    for (const t of wanted) {
      if (this.loading.size >= MAX_IN_FLIGHT) break;
      if (this.slotOf.has(t) || this.loading.has(t) || this.failed.has(t)) continue;
      this.load(t);
    }
  }

  private freeSlot(): number {
    let best = -1;
    let oldest = Infinity;
    for (let s = 0; s < HI_SLOTS; s++) {
      if (this.tileIn[s] === -1) return s;
      if (this.lastWanted[s]! < oldest && this.lastWanted[s]! < this.tick) { oldest = this.lastWanted[s]!; best = s; }
    }
    return best;
  }

  // Fetch → fully decoded ImageBitmap → upload. Uploading straight from an
  // <img> occasionally left blocks of a slot stale or blank (the browser
  // can hand WebGL a partially decoded image); a bitmap is complete by the
  // time its promise resolves, the same path the atlas sheets take.
  private load(tile: number): void {
    this.loading.add(tile);
    void (async () => {
      let bmp: ImageBitmap | null = null;
      try {
        const res = await fetch(this.urlFor(tile), { mode: 'cors' });
        if (!res.ok) throw new Error(String(res.status));
        bmp = await createImageBitmap(await res.blob());
        if (bmp.width !== HI_SIZE || bmp.height !== HI_SIZE) {
          // The dev server serves full-size originals: centred cover crop.
          const s = Math.min(bmp.width, bmp.height);
          const cropped = await createImageBitmap(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, {
            resizeWidth: HI_SIZE, resizeHeight: HI_SIZE, resizeQuality: 'high',
          });
          bmp.close();
          bmp = cropped;
        }
      } catch {
        this.loading.delete(tile);
        this.failed.add(tile);
        bmp?.close();
        return;
      }
      this.loading.delete(tile);
      const slot = this.freeSlot();
      if (slot < 0) { bmp.close(); return; }
      const prev = this.tileIn[slot]!;
      if (prev >= 0) {
        this.slotOf.delete(prev);
        this.onAssigned(prev, -1);
      }
      this.upload(slot, bmp);
      bmp.close();
      this.tileIn[slot] = tile;
      this.lastWanted[slot] = this.tick;
      this.slotOf.set(tile, slot);
      this.onAssigned(tile, slot);
    })();
  }
}

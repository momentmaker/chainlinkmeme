import type { MemeEntry } from './manifest';

function djb2(input: string): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  return hash;
}

export function memeOfDay(memes: MemeEntry[], date: Date = new Date()): MemeEntry | null {
  if (memes.length === 0) return null;
  const isoDay = date.toISOString().slice(0, 10);
  const idx = djb2(isoDay) % memes.length;
  return memes[idx];
}

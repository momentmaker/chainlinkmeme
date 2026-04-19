// Shared manifest loader + meme-picker logic used by the Discord and
// Telegram bot handlers. Kept behavior-identical to the inline helpers
// that used to live in discord.ts.

export interface ManifestMeme {
  slug: string;
  filename: string;
  title: string;
  tags: string[];
  animated: boolean;
}

export interface Manifest {
  memes: ManifestMeme[];
  synonyms: Record<string, string[]>;
  related: Record<string, string[]>;
}

const HASH_RE = /^[0-9a-f]{10,}$/i;

const MANIFEST_TTL_MS = 5 * 60 * 1000;
const MANIFEST_FETCH_TIMEOUT_MS = 5000;
let cachedManifest: Manifest | null = null;
let cachedAt = 0;

export async function loadManifest(origin: string): Promise<Manifest> {
  const now = Date.now();
  if (cachedManifest && now - cachedAt < MANIFEST_TTL_MS) return cachedManifest;
  // Explicit timeout so a hung upstream surfaces as a caught exception
  // rather than a wall-clock isolate kill, which would bypass handler-level
  // try/catch and trigger Telegram's webhook retry loop.
  const res = await fetch(`${origin}/manifest.json`, {
    cf: { cacheTtl: 300 },
    signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
  cachedManifest = (await res.json()) as Manifest;
  cachedAt = now;
  return cachedManifest;
}

export function displayTitle(m: ManifestMeme): string {
  if (m.title && !HASH_RE.test(m.title)) return m.title;
  return m.tags[0] ? `#${m.tags[0]}` : m.slug;
}

export function memeCdnUrl(filename: string): string {
  return `https://cdn.jsdelivr.net/gh/momentmaker/chainlinkmeme@main/memes/${filename}`;
}

export function scoreMeme(m: ManifestMeme, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  let score = 0;
  const tagSet = new Set(m.tags);
  const titleLower = (m.title ?? '').toLowerCase();
  for (const needle of tokens) {
    if (tagSet.has(needle)) { score += 10; continue; }
    let tagHit = false;
    for (const t of m.tags) {
      if (t.includes(needle)) { score += 6; tagHit = true; break; }
    }
    if (tagHit) continue;
    if (titleLower.includes(needle)) { score += 3; }
  }
  return score;
}

export function expandTokens(
  raw: string[],
  synonyms: Record<string, string[]>,
  related: Record<string, string[]>,
): string[] {
  const expanded = new Set<string>();
  for (const t of raw) {
    const norm = t.trim().toLowerCase();
    if (!norm) continue;
    const canonical = synonyms[norm];
    if (canonical) for (const c of canonical) expanded.add(c);
    else expanded.add(norm);
  }
  const withRelated = new Set(expanded);
  for (const t of expanded) {
    const rel = related[t];
    if (rel) for (const r of rel) withRelated.add(r);
  }
  return [...withRelated];
}

// Fisher-Yates over a copy. Uniformly random order (unlike
// `sort(() => Math.random() - 0.5)`, which is biased on some JS engines).
// For n < items.length, a reservoir pass over the tail keeps selection
// uniform across the whole input.
function randomN<T>(items: readonly T[], n: number): T[] {
  const out = items.slice(0, n);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  for (let i = n; i < items.length; i++) {
    const j = Math.floor(Math.random() * (i + 1));
    if (j < n) out[j] = items[i];
  }
  return out;
}

export function pickMeme(manifest: Manifest, query: string): ManifestMeme | null {
  const memes = manifest.memes;
  if (memes.length === 0) return null;
  const q = query.trim().toLowerCase();
  if (!q) return memes[Math.floor(Math.random() * memes.length)] ?? null;
  const tokens = expandTokens(q.split(/[\s,]+/), manifest.synonyms ?? {}, manifest.related ?? {});
  if (tokens.length === 0) return memes[Math.floor(Math.random() * memes.length)] ?? null;
  const scored = memes
    .map((m) => ({ m, s: scoreMeme(m, tokens) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s);
  if (scored.length === 0) return null;
  const topScore = scored[0].s;
  const ties = scored.filter(({ s }) => s === topScore);
  return ties[Math.floor(Math.random() * ties.length)].m;
}

// Return up to `n` memes for the given query, ordered by score desc with
// random tie-breaking. Empty query => `n` random memes. Used by Telegram
// inline mode to populate a gallery of results.
export function pickMemes(manifest: Manifest, query: string, n: number): ManifestMeme[] {
  const memes = manifest.memes;
  if (memes.length === 0 || n <= 0) return [];
  const q = query.trim().toLowerCase();
  if (!q) return randomN(memes, n);
  const tokens = expandTokens(q.split(/[\s,]+/), manifest.synonyms ?? {}, manifest.related ?? {});
  if (tokens.length === 0) return randomN(memes, n);
  const scored = memes
    .map((m) => ({ m, s: scoreMeme(m, tokens), r: Math.random() }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => (b.s - a.s) || (a.r - b.r));
  return scored.slice(0, n).map(({ m }) => m);
}

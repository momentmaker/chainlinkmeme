import type { MemeEntry, Manifest } from './manifest';

// Ported from chainlink-meme-api's Tag#find_synonyms and Tag#find_like_tags.
// `synonyms` rewrites a user-typed tag into its canonical form(s).
// `related` adds other tags frequently searched alongside the input.

export function expandQuery(
  rawTags: string[],
  synonyms: Record<string, string[]>,
  related: Record<string, string[]>,
): string[] {
  const expanded = new Set<string>();
  for (const raw of rawTags) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    const canonical = synonyms[t];
    if (canonical) {
      for (const c of canonical) expanded.add(c);
    } else {
      expanded.add(t);
    }
  }
  const withRelated = new Set(expanded);
  for (const t of expanded) {
    const rel = related[t];
    if (rel) for (const r of rel) withRelated.add(r);
  }
  return [...withRelated];
}

export interface SearchOptions {
  query: string;
  animatedOnly: boolean;
  favoritesOnly: boolean;
  favorites: Set<string>;
}

// Match score per meme: higher = more relevant. Tag matches outweigh
// title/description hits so "sergey" still ranks exact-tag hits first, but
// phrases like "on the moon" that don't match any tag now surface title
// and description matches. This gets us ~70% of the value of semantic
// search without shipping a 50 MB model.
function scoreMeme(m: MemeEntry, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  let score = 0;
  const tagSet = new Set(m.tags);
  const titleLower = (m.title ?? '').toLowerCase();
  const descLower = (m.description ?? '').toLowerCase();
  for (const needle of tokens) {
    if (tagSet.has(needle)) { score += 10; continue; }
    let tagHit = false;
    for (const t of m.tags) {
      if (t.includes(needle)) { score += 6; tagHit = true; break; }
    }
    if (tagHit) continue;
    if (titleLower.includes(needle)) { score += 3; continue; }
    if (descLower.includes(needle)) { score += 1; }
  }
  return score;
}

export function filterMemes(memes: MemeEntry[], manifest: Manifest, opts: SearchOptions): MemeEntry[] {
  let results = memes;

  if (opts.animatedOnly) {
    results = results.filter((m) => m.animated);
  }

  if (opts.favoritesOnly) {
    results = results.filter((m) => opts.favorites.has(m.slug));
  }

  const rawTokens = opts.query
    .split(/[\s,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  if (rawTokens.length === 0) return results;

  const expanded = expandQuery(rawTokens, manifest.synonyms, manifest.related);
  if (expanded.length === 0) return results;

  const scored = results
    .map((m) => ({ m, s: scoreMeme(m, expanded) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s)
    .map(({ m }) => m);

  return scored;
}

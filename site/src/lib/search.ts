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
    .map((t) => t.trim())
    .filter(Boolean);

  if (rawTokens.length === 0) return results;

  const expanded = expandQuery(rawTokens, manifest.synonyms, manifest.related);
  if (expanded.length === 0) return results;

  return results.filter((m) => {
    for (const needle of expanded) {
      for (const t of m.tags) {
        if (t.includes(needle)) return true;
      }
    }
    return false;
  });
}

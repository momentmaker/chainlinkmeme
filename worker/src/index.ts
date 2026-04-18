import { handleDiscordInteraction } from './discord';

interface Env {
  DB: D1Database;
  LIKES_CACHE_TTL: string;
  LIKES_RATE_PER_MIN: string;
  DISCORD_APP_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  SITE_ORIGIN: string;
}

interface ApiMeme {
  slug: string;
  filename: string;
  title: string;
  tags: string[];
  animated: boolean;
  description?: string;
}

interface ApiManifest {
  repo_ref?: string;
  memes: ApiMeme[];
  synonyms: Record<string, string[]>;
  related: Record<string, string[]>;
}

let cachedApiManifest: ApiManifest | null = null;
let cachedApiManifestAt = 0;
// Dedupe concurrent cold-start fetches: when N requests arrive before the
// first manifest fetch resolves, they all share the in-flight promise instead
// of each firing their own upstream fetch.
let inflightApiManifest: Promise<ApiManifest> | null = null;
const API_MANIFEST_TTL_MS = 5 * 60 * 1000;

async function loadApiManifest(origin: string): Promise<ApiManifest> {
  const now = Date.now();
  if (cachedApiManifest && now - cachedApiManifestAt < API_MANIFEST_TTL_MS) return cachedApiManifest;
  if (inflightApiManifest) return inflightApiManifest;
  inflightApiManifest = (async () => {
    try {
      const res = await fetch(`${origin}/manifest.json`, { cf: { cacheTtl: 300 } });
      if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
      const m = (await res.json()) as ApiManifest;
      cachedApiManifest = m;
      cachedApiManifestAt = Date.now();
      return m;
    } finally {
      inflightApiManifest = null;
    }
  })();
  return inflightApiManifest;
}

const REPO_OWNER = 'momentmaker';
const REPO_NAME = 'chainlinkmeme';

function cdnImage(filename: string, ref: string): string {
  return `https://cdn.jsdelivr.net/gh/${REPO_OWNER}/${REPO_NAME}@${ref}/memes/${filename}`;
}

function shapeMeme(m: ApiMeme, origin: string, ref: string): Record<string, unknown> {
  return {
    slug: m.slug,
    title: m.title,
    tags: m.tags,
    animated: m.animated,
    permalink: `${origin}/m/${m.slug}/`,
    image: cdnImage(m.filename, ref),
  };
}

function scoreMeme(m: ApiMeme, tokens: string[]): number {
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

function expandQuery(rawTokens: string[], synonyms: Record<string, string[]>, related: Record<string, string[]>): string[] {
  const expanded = new Set<string>();
  for (const raw of rawTokens) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    const canonical = synonyms[t];
    if (canonical) for (const c of canonical) expanded.add(c);
    else expanded.add(t);
  }
  const withRelated = new Set(expanded);
  for (const t of expanded) {
    const rel = related[t];
    if (rel) for (const r of rel) withRelated.add(r);
  }
  return [...withRelated];
}

const SLUG_RE = /^[a-z0-9_][a-z0-9_-]*$/;
const REACTIONS = ['heart', 'laugh', 'bolt', 'diamond'] as const;
type Reaction = typeof REACTIONS[number];
const REACTION_SET = new Set<string>(REACTIONS);

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
} as const;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...corsHeaders, ...(init.headers ?? {}) },
  });
}

async function rateLimitOk(env: Env, ip: string): Promise<boolean> {
  const perMin = Number(env.LIKES_RATE_PER_MIN || '20');
  const minute = Math.floor(Date.now() / 60_000);
  const key = `rate:${ip}:${minute}`;
  const res = await env.DB.prepare(
    'INSERT INTO rate_limit (key, hits) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET hits = hits + 1 RETURNING hits',
  ).bind(key).first<{ hits: number }>();
  return (res?.hits ?? 1) <= perMin;
}

// Merge the legacy `likes` table (heart-only counts) with the `reactions`
// table so the old ♥ history survives the multi-axis migration. The client
// sees a single unified map regardless of where the count actually lives.
async function bulkReactions(env: Env): Promise<Record<string, Record<Reaction, number>>> {
  const map: Record<string, Record<Reaction, number>> = {};
  const { results: legacy } = await env.DB.prepare('SELECT slug, count FROM likes').all<{ slug: string; count: number }>();
  for (const r of legacy) {
    map[r.slug] = { heart: r.count, laugh: 0, bolt: 0, diamond: 0 };
  }
  const { results: fresh } = await env.DB.prepare('SELECT slug, reaction, count FROM reactions').all<{ slug: string; reaction: string; count: number }>();
  for (const r of fresh) {
    if (!REACTION_SET.has(r.reaction)) continue;
    if (!map[r.slug]) map[r.slug] = { heart: 0, laugh: 0, bolt: 0, diamond: 0 };
    // For heart, sum legacy + new so a meme that had 12 hearts pre-migration
    // and picks up 3 more post-migration shows 15, not 3.
    if (r.reaction === 'heart') map[r.slug].heart += r.count;
    else map[r.slug][r.reaction as Reaction] = r.count;
  }
  return map;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);
    const path = url.pathname;
    const ttl = Number(env.LIKES_CACHE_TTL || '60');

    // Discord interactions endpoint — signature-verified inside the handler.
    // Never cached, never cross-origin CORSed (Discord calls server-to-server).
    if (path === '/discord/interactions' && request.method === 'POST') {
      return handleDiscordInteraction(request, env);
    }

    // Public API — lightweight endpoints on top of the static manifest.
    // /manifest.json remains the full canonical source for anyone who
    // wants the raw data; these just shape common queries server-side.
    // Each endpoint catches upstream failures explicitly — an unhandled
    // throw would escape to Cloudflare's default 500, which lacks the CORS
    // headers needed for browser-side fetch callers.
    if (path === '/api/random' && request.method === 'GET') {
      try {
        const m = await loadApiManifest(env.SITE_ORIGIN);
        // Empty `?tag=` → same as no filter. Otherwise `x.tags.includes("")`
        // is always false and the endpoint would 404 for a client that
        // passed an empty tag param by accident.
        const tagFilter = url.searchParams.get('tag')?.trim().toLowerCase() || null;
        const pool = tagFilter
          ? m.memes.filter((x) => x.tags.includes(tagFilter))
          : m.memes;
        if (pool.length === 0) return json({ error: 'no memes match' }, { status: 404 });
        const picked = pool[Math.floor(Math.random() * pool.length)]!;
        const ref = m.repo_ref || 'main';
        if (url.searchParams.get('redirect') === '1') {
          return new Response(null, {
            status: 302,
            headers: {
              Location: `${env.SITE_ORIGIN}/m/${picked.slug}/`,
              'Cache-Control': 'no-store',
              ...corsHeaders,
            },
          });
        }
        return json(shapeMeme(picked, env.SITE_ORIGIN, ref), {
          headers: { 'Cache-Control': 'no-store' },
        });
      } catch {
        return json({ error: 'manifest unavailable' }, { status: 503 });
      }
    }

    if (path === '/api/search' && request.method === 'GET') {
      const q = url.searchParams.get('q')?.trim() ?? '';
      if (!q) return json({ error: 'missing query parameter q' }, { status: 400 });
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || '24')));
      try {
        const m = await loadApiManifest(env.SITE_ORIGIN);
        // Cap tokens so a pathological query ("a+b+c+..." × thousands) can't
        // force an O(memes × tokens) scoring loop large enough to time the
        // worker out. 20 is well above any realistic human query.
        const rawTokens = q.split(/[\s,]+/).map((t) => t.toLowerCase()).filter(Boolean).slice(0, 20);
        const expanded = expandQuery(rawTokens, m.synonyms, m.related);
        const ref = m.repo_ref || 'main';
        const results = m.memes
          .map((x) => ({ m: x, s: scoreMeme(x, expanded) }))
          .filter(({ s }) => s > 0)
          .sort((a, b) => b.s - a.s)
          .slice(0, limit)
          .map(({ m: x }) => shapeMeme(x, env.SITE_ORIGIN, ref));
        return json({ query: q, count: results.length, results }, {
          headers: { 'Cache-Control': 'public, max-age=60' },
        });
      } catch {
        return json({ error: 'manifest unavailable' }, { status: 503 });
      }
    }

    if (path === '/api/tags' && request.method === 'GET') {
      try {
        const m = await loadApiManifest(env.SITE_ORIGIN);
        const counts = new Map<string, number>();
        for (const x of m.memes) for (const t of x.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
        const tags = [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([tag, count]) => ({ tag, count }));
        return json({ count: tags.length, tags }, {
          headers: { 'Cache-Control': 'public, max-age=300' },
        });
      } catch {
        return json({ error: 'manifest unavailable' }, { status: 503 });
      }
    }

    // New bulk endpoint: `{ slug: { heart, laugh, bolt, diamond } }`
    if (path === '/api/reactions' && request.method === 'GET') {
      const map = await bulkReactions(env);
      return json(map, { headers: { 'Cache-Control': `public, max-age=${ttl}` } });
    }

    // Legacy bulk endpoint — keep the flat `{ slug: heartCount }` shape so
    // older client builds keep working during rollout.
    if (path === '/api/likes' && request.method === 'GET') {
      const map = await bulkReactions(env);
      const flat: Record<string, number> = {};
      for (const [slug, rs] of Object.entries(map)) flat[slug] = rs.heart;
      return json(flat, { headers: { 'Cache-Control': `public, max-age=${ttl}` } });
    }

    // Increment a specific reaction. Legacy /api/likes/:slug still works and
    // maps to the heart reaction.
    const rxMatch = path.match(/^\/api\/reactions\/([^/]+)\/([^/]+)$/);
    const likeMatch = path.match(/^\/api\/likes\/([^/]+)$/);
    if ((rxMatch || likeMatch) && request.method === 'POST') {
      const slug = decodeURIComponent((rxMatch ? rxMatch[1] : likeMatch![1])!);
      const reaction = (rxMatch ? decodeURIComponent(rxMatch[2]!) : 'heart') as Reaction;
      if (!SLUG_RE.test(slug)) return json({ error: 'invalid slug' }, { status: 400 });
      if (!REACTION_SET.has(reaction)) return json({ error: 'invalid reaction' }, { status: 400 });

      const ip = request.headers.get('cf-connecting-ip') || 'anon';
      if (!(await rateLimitOk(env, ip))) return json({ error: 'rate limited' }, { status: 429 });

      const row = await env.DB.prepare(
        'INSERT INTO reactions (slug, reaction, count) VALUES (?, ?, 1) ON CONFLICT(slug, reaction) DO UPDATE SET count = count + 1 RETURNING count',
      ).bind(slug, reaction).first<{ count: number }>();
      // For heart, include the legacy count so the client sees the true total
      // without an extra roundtrip.
      let count = row?.count ?? 1;
      if (reaction === 'heart') {
        const legacy = await env.DB.prepare('SELECT count FROM likes WHERE slug = ?').bind(slug).first<{ count: number }>();
        count += legacy?.count ?? 0;
      }
      return json({ count });
    }

    return json({ error: 'not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

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

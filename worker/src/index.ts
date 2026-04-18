interface Env {
  DB: D1Database;
  LIKES_CACHE_TTL: string;
  LIKES_RATE_PER_MIN: string;
}

const SLUG_RE = /^[a-z0-9_][a-z0-9_-]*$/;

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/likes' && request.method === 'GET') {
      const ttl = Number(env.LIKES_CACHE_TTL || '60');
      const { results } = await env.DB.prepare('SELECT slug, count FROM likes').all<{ slug: string; count: number }>();
      const map: Record<string, number> = {};
      for (const r of results) map[r.slug] = r.count;
      return json(map, { headers: { 'Cache-Control': `public, max-age=${ttl}` } });
    }

    const inc = path.match(/^\/api\/likes\/([^/]+)$/);
    if (inc && request.method === 'POST') {
      const slug = decodeURIComponent(inc[1]!);
      if (!SLUG_RE.test(slug)) return json({ error: 'invalid slug' }, { status: 400 });

      const ip = request.headers.get('cf-connecting-ip') || 'anon';
      if (!(await rateLimitOk(env, ip))) return json({ error: 'rate limited' }, { status: 429 });

      const row = await env.DB.prepare(
        'INSERT INTO likes (slug, count) VALUES (?, 1) ON CONFLICT(slug) DO UPDATE SET count = count + 1 RETURNING count',
      ).bind(slug).first<{ count: number }>();
      return json({ count: row?.count ?? 1 });
    }

    return json({ error: 'not found' }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

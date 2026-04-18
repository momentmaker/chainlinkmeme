// Discord slash-command handler. Runs inside the Worker, verifies the
// Ed25519 signature Discord sends on every interaction POST, and returns a
// random meme matching the user's query as an embed with the image
// inlined and the permalink as the click-through.

interface DiscordEnv {
  DISCORD_PUBLIC_KEY: string;
  SITE_ORIGIN: string;
}

interface Interaction {
  type: number;
  data?: {
    name?: string;
    options?: Array<{ name: string; value: string }>;
  };
}

interface ManifestMeme {
  slug: string;
  filename: string;
  title: string;
  tags: string[];
  animated: boolean;
}

interface Manifest {
  memes: ManifestMeme[];
  synonyms: Record<string, string[]>;
  related: Record<string, string[]>;
}

const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;
const RESPONSE_PONG = 1;
const RESPONSE_CHANNEL_MESSAGE = 4;
const HASH_RE = /^[0-9a-f]{10,}$/i;

// Cached manifest inside the Worker instance — cold starts fetch, warm
// starts reuse. Cloudflare re-uses an instance across many requests, so
// this effectively caches for minutes at a time. Refetch on each cold boot
// is fine: manifest rarely changes and the cold fetch is ~100ms.
let cachedManifest: Manifest | null = null;
let cachedAt = 0;
const MANIFEST_TTL_MS = 5 * 60 * 1000;

async function loadManifest(origin: string): Promise<Manifest> {
  const now = Date.now();
  if (cachedManifest && now - cachedAt < MANIFEST_TTL_MS) return cachedManifest;
  const res = await fetch(`${origin}/manifest.json`, { cf: { cacheTtl: 300 } });
  if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
  cachedManifest = (await res.json()) as Manifest;
  cachedAt = now;
  return cachedManifest;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// Verify Discord's Ed25519 signature. Discord will not even finish the
// endpoint-URL validation handshake if this is wrong, so getting this
// right is the single hardest part of the bot.
async function verifySignature(publicKeyHex: string, signatureHex: string, timestamp: string, body: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const sig = hexToBytes(signatureHex);
    const msg = new TextEncoder().encode(timestamp + body);
    return await crypto.subtle.verify('Ed25519', key, sig, msg);
  } catch {
    return false;
  }
}

function displayTitle(m: ManifestMeme): string {
  if (m.title && !HASH_RE.test(m.title)) return m.title;
  return m.tags[0] ? `#${m.tags[0]}` : m.slug;
}

function scoreMeme(m: ManifestMeme, tokens: string[]): number {
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

function expandTokens(raw: string[], synonyms: Record<string, string[]>, related: Record<string, string[]>): string[] {
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

function pickMeme(manifest: Manifest, query: string): ManifestMeme | null {
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
  // Pick from the top-scoring tier so repeated invocations of the same
  // query return variety instead of always the same meme.
  const topScore = scored[0].s;
  const ties = scored.filter(({ s }) => s === topScore);
  return ties[Math.floor(Math.random() * ties.length)].m;
}

function memeCdnUrl(filename: string): string {
  // Mirror the client's jsDelivr URL. The Worker can't reach the `PUBLIC_REPO_REF`
  // env the site uses, so we pin @main — jsDelivr still edge-caches the
  // response for days, which is plenty for a meme bot.
  return `https://cdn.jsdelivr.net/gh/momentmaker/chainlinkmeme@main/memes/${filename}`;
}

function errorEmbed(message: string): unknown {
  return {
    type: RESPONSE_CHANNEL_MESSAGE,
    data: {
      content: message,
      flags: 64, // EPHEMERAL — only the caller sees the error
    },
  };
}

export async function handleDiscordInteraction(request: Request, env: DiscordEnv): Promise<Response> {
  const sig = request.headers.get('x-signature-ed25519');
  const ts = request.headers.get('x-signature-timestamp');
  if (!sig || !ts) return new Response('missing signature', { status: 401 });

  const body = await request.text();
  const valid = await verifySignature(env.DISCORD_PUBLIC_KEY, sig, ts, body);
  if (!valid) return new Response('invalid signature', { status: 401 });

  const interaction = JSON.parse(body) as Interaction;

  // Discord pings the endpoint during URL validation and expects a PONG.
  if (interaction.type === INTERACTION_PING) {
    return Response.json({ type: RESPONSE_PONG });
  }

  if (interaction.type !== INTERACTION_APPLICATION_COMMAND || interaction.data?.name !== 'clmeme') {
    return Response.json(errorEmbed('unknown command'));
  }

  const queryOpt = interaction.data.options?.find((o) => o.name === 'query');
  const query = queryOpt?.value ?? '';

  let manifest: Manifest;
  try {
    manifest = await loadManifest(env.SITE_ORIGIN);
  } catch {
    return Response.json(errorEmbed('archive unreachable — try again in a minute'));
  }

  const meme = pickMeme(manifest, query);
  if (!meme) {
    return Response.json(errorEmbed(`no match for **${query}**. try \`sergey\`, \`moon\`, \`wagmi\`…`));
  }

  const permalink = `${env.SITE_ORIGIN}/m/${meme.slug}/`;
  return Response.json({
    type: RESPONSE_CHANNEL_MESSAGE,
    data: {
      embeds: [{
        title: displayTitle(meme),
        url: permalink,
        color: 0x2f62df,
        image: { url: memeCdnUrl(meme.filename) },
        footer: { text: meme.tags.slice(0, 6).map((t) => '#' + t).join(' ') || 'chainlinkme.me' },
      }],
    },
  });
}

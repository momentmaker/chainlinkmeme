// Discord slash-command handler. Runs inside the Worker, verifies the
// Ed25519 signature Discord sends on every interaction POST, and returns a
// random meme matching the user's query as an embed with the image
// inlined and the permalink as the click-through.

import {
  type ManifestMeme,
  type Manifest,
  displayTitle,
  loadManifest,
  memeCdnUrl,
  pickMeme,
} from './picker';

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

const INTERACTION_PING = 1;
const INTERACTION_APPLICATION_COMMAND = 2;
const RESPONSE_PONG = 1;
const RESPONSE_CHANNEL_MESSAGE = 4;

// Explicit ArrayBuffer (not ArrayBufferLike) so the result is assignable to
// BufferSource. TS 5.7+ made Uint8Array generic over its backing buffer and
// defaults to ArrayBufferLike (ArrayBuffer | SharedArrayBuffer), which
// crypto.subtle.importKey/verify reject. Constructing over a fresh
// ArrayBuffer pins the generic parameter.
function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

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
    const encoded = new TextEncoder().encode(timestamp + body);
    const msg = new Uint8Array(new ArrayBuffer(encoded.byteLength));
    msg.set(encoded);
    return await crypto.subtle.verify('Ed25519', key, sig, msg);
  } catch {
    return false;
  }
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

  const meme: ManifestMeme | null = pickMeme(manifest, query);
  if (!meme) {
    return Response.json(errorEmbed(`no match for **${query}**. try \`sergey\`, \`moon\`, \`wagmi\`…`));
  }

  const permalink = `${env.SITE_ORIGIN}/m/${meme.slug}/`;
  const ref = manifest.repo_ref || 'main';
  return Response.json({
    type: RESPONSE_CHANNEL_MESSAGE,
    data: {
      embeds: [{
        title: displayTitle(meme),
        url: permalink,
        color: 0x2f62df,
        image: { url: memeCdnUrl(meme.filename, ref) },
        footer: { text: meme.tags.slice(0, 6).map((t) => '#' + t).join(' ') || 'chainlinkme.me' },
      }],
    },
  });
}

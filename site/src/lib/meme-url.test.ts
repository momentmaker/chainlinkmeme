import { afterEach, describe, expect, it, vi } from 'vitest';
import { memeUrl, thumbUrl } from './meme-url';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('thumbUrl', () => {
  it('passes through to the local original in DEV (wsrv cannot reach localhost)', () => {
    vi.stubEnv('DEV', true);
    expect(thumbUrl('foo.jpg', 360)).toBe('/memes/foo.jpg');
    expect(thumbUrl('foo.gif', 360, { animated: true })).toBe('/memes/foo.gif');
  });

  it('wraps the jsDelivr original through wsrv.nl as WebP in prod', () => {
    vi.stubEnv('DEV', false);
    const url = new URL(thumbUrl('foo.jpg', 540));
    expect(url.origin + url.pathname).toBe('https://wsrv.nl/');
    expect(url.searchParams.get('url')).toBe(memeUrl('foo.jpg'));
    expect(url.searchParams.get('w')).toBe('540');
    expect(url.searchParams.get('output')).toBe('webp');
    expect(url.searchParams.get('q')).toBe('80');
    expect(url.searchParams.get('n')).toBeNull();
  });

  it('requests every frame (n=-1) for animated sources so GIFs stay animated', () => {
    vi.stubEnv('DEV', false);
    const url = new URL(thumbUrl('foo.gif', 360, { animated: true }));
    expect(url.searchParams.get('n')).toBe('-1');
  });
});

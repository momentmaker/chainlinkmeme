// In prod, images are served by jsDelivr from the public GitHub repo.
// In dev, we serve them via a Vite middleware that points at ../memes.
// The repo owner/name/ref are baked at build time from env vars so the deployed
// site pins to an immutable git ref (perfect cache behavior on jsDelivr).

const REPO_OWNER = import.meta.env.PUBLIC_REPO_OWNER ?? 'momentmaker';
const REPO_NAME = import.meta.env.PUBLIC_REPO_NAME ?? 'chainlinkmeme';
const REPO_REF = import.meta.env.PUBLIC_REPO_REF ?? 'main';

export function memeUrl(filename: string): string {
  if (import.meta.env.DEV) {
    return `/memes/${filename}`;
  }
  return `https://cdn.jsdelivr.net/gh/${REPO_OWNER}/${REPO_NAME}@${REPO_REF}/memes/${filename}`;
}

export function permalinkUrl(slug: string): string {
  return `/m/${slug}`;
}

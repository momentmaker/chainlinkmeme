// In prod, images are served by jsDelivr from the public GitHub repo.
// In dev, we serve them via a Vite middleware that points at ../memes.
// The repo owner/name/ref are baked at build time from env vars so the deployed
// site pins to an immutable git ref (perfect cache behavior on jsDelivr).

const REPO_OWNER = import.meta.env.PUBLIC_REPO_OWNER ?? 'momentmaker';
const REPO_NAME = import.meta.env.PUBLIC_REPO_NAME ?? 'chainlinkmeme';
const REPO_REF = import.meta.env.PUBLIC_REPO_REF ?? 'main';

// Worker URL is the same in dev and prod; in dev Vite's /api proxy forwards
// same-origin fetches, in prod the browser calls the Worker cross-origin.
// The Worker has CORS wide-open so this works without a Pages Function.
const WORKER_URL = import.meta.env.PUBLIC_WORKER_URL ?? 'https://chainlinkmeme-api.pilgrim.workers.dev';

// Astro injects BASE_URL from the `base` config. Always use this for internal
// hrefs so the same build serves correctly from either a repo-scoped GH Pages
// URL or a custom apex/subdomain.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export function memeUrl(filename: string): string {
  if (import.meta.env.DEV) {
    return `/memes/${filename}`;
  }
  return `https://cdn.jsdelivr.net/gh/${REPO_OWNER}/${REPO_NAME}@${REPO_REF}/memes/${filename}`;
}

export function permalinkUrl(slug: string): string {
  return `${BASE}/m/${slug}/`;
}

export function apiUrl(path: string): string {
  // Dev: use the Vite /api proxy so we stay same-origin (no CORS preflight).
  // Prod: call the Worker directly — it already has Access-Control-Allow-Origin: *.
  if (import.meta.env.DEV) return path;
  return `${WORKER_URL}${path}`;
}


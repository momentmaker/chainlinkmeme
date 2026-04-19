# chainlinkmeme

⬢ A community-curated archive of Chainlink memes — [chainlinkme.me](https://chainlinkme.me).

Browse, search, favorite, and react. Every meme has a permalink that unfurls beautifully in Discord, Twitter, and Telegram. A tag constellation maps the archive as a cosmos; weekly snapshots preserve the top 7 memes each week; a Discord slash command pulls memes into any server on demand.

## Architecture

```
GitHub repo  ─►  jsDelivr                 (image CDN, automatic)
     │
     │
     ├──►  GitHub Pages                   (Astro, 100% pre-rendered)
     │
     └──►  Cloudflare Worker  ─►  D1      (/api/reactions · /discord/interactions)
```

- **Images + metadata** live in this repo. The repo *is* the archive.
- **Site** is a static Astro build deployed to GitHub Pages — no Cloudflare Pages, no Next.js, no SSR.
- **Worker** handles the two small bits of state: per-meme reactions (D1-backed, edge-cached) and the Discord slash command. ~200 lines total.
- **Images** are served via jsDelivr directly from this public repo — no separate CDN setup, no S3.

Everything else is derived at build time. The live site can be rebuilt from scratch with `git clone && pnpm install && pnpm build` — the only external state is the D1 reactions table, which is allowed to be lossy.

## Repo layout

```
memes/              # source of truth: one .jpg/.gif/.png/.webp + one .toml per meme
site/               # Astro frontend (GitHub Pages)
worker/             # Cloudflare Worker + D1 (reactions + Discord bot)
scripts/            # build-time + one-off tooling
.github/workflows/  # CI: validate PRs, deploy on merge, weekly snapshot
```

## Features

### Gallery
- Responsive JS masonry (1/2/3 columns), append-only so scrolling back up never reshuffles memes
- Tag search with synonym-aware autocomplete
- Per-meme permalinks (`/m/<slug>`) with full OG + Twitter cards
- Filter toggles: GIFs only, Favorites only
- `r` for a random meme; `/` to focus search; `j/k` to navigate; `f` to favorite; `?` for the full keymap
- View transitions between gallery and permalinks
- Dark / light themes (respects `prefers-color-scheme`)
- Meme-of-the-day hero with cursor-reactive tilt + shine
- Hex-shaped scroll-to-top widget

### Reactions
- Four reactions per meme: ❤️, 😂, ⚡, 💎
- Optimistic UI with rollback on failure, offline pill if the worker is unreachable
- Global counts served bulk from `/api/reactions`, edge-cached
- Personal favorites persisted in localStorage
- Legacy `likes` table preserved so pre-migration hearts still count

### Tag constellation (`/map`)
- The archive rendered as a force-directed graph — tags are hexagons, edges are co-occurrences
- Hover highlights a tag's connections; click navigates into the gallery with that tag pre-filtered
- Wheel to zoom (anchored at cursor, 0.5× – 5×); click-drag to pan; "reset view" chip when off-identity

### Weekly snapshots (`/week`)
- Every Monday a GitHub Action freezes the top 7 memes by reaction count and commits the snapshot as `site/src/data/weekly/YYYY-Www.json`
- Historical weeks are browsable forever — no backfill, gaps stay honest

### Discord bot
Summon any meme in your Discord server with `/clmeme <tag>`:

- `/clmeme sergey` → a random sergey meme
- `/clmeme moon wagmi` → a meme matching either tag (weighted by score)
- `/clmeme` → a random meme from the archive

**[Install to your server →](https://discord.com/oauth2/authorize?client_id=1495133781697495102&integration_type=0&scope=applications.commands)**

Server admins only need `applications.commands` scope — no bot user, no gateway, no ongoing permissions. Every invocation hits the Cloudflare Worker, which verifies Discord's Ed25519 signature and embeds the meme inline.

### X (Twitter) bot
Two GitHub-cron-driven bots broadcast the archive:

- **Daily**: once a day at 14:00 UTC, `/tweet-daily` posts the meme-of-the-day — same meme the site's hero shows. Static memes post as a bare permalink so X unfurls the per-meme OG card; animated memes upload the GIF so it plays in-feed.
- **Weekly**: every Monday 14:30 UTC, `/tweet-weekly` posts a single tweet linking to `/week/<key>/`. The per-week OG card (honeycomb of that week's top memes, baked by `scripts/build-og-images.ts`) does the visual work on unfurl. One tweet instead of eight — more thumb-stopping, less quota, and every post is a permanent archive artifact people can bookmark.

Secrets (`X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_SECRET`) live in GitHub Actions.

### Sticker export
Each permalink has a **save as sticker** button that exports to Signal-spec 512×512 — WebP for static memes, APNG for animated (≤300 KB, ≤3s loop). The APNG branch runs UPNG quantization entirely in-browser, adaptively dropping the color palette until it fits the 300 KB budget; the whole encoder bundle is lazy-loaded (~95 KB) and only ships when someone actually clicks the button. Drop the output straight into Signal, Telegram, Discord, or Slack.

### OG images
Every meme has a pre-rendered 1200×630 OG card (baked by `scripts/build-og-images.ts` with Satori + Resvg, CI-cached by content hash). The home page has a custom 77-meme honeycomb mosaic.

### Honeycomb grid (`/grid`)
Every meme in the archive, at once, as a single hex tessellation. Wheel to zoom, drag to pan, click any tile to open.

### Shuffle mode (keyboard-only)
Press `s` anywhere on the site for fullscreen one-meme-at-a-time mode. Space / → for next, ← for previous, Esc to exit. Unlisted — find it in the `?` help dialog.

### Public API
The canonical data source is [`manifest.json`](https://chainlinkme.me/manifest.json) — the full archive, CORS-open, regenerated on every deploy. Worker endpoints on top of it:

| Endpoint | Description |
|---|---|
| `GET /api/random` | JSON for a random meme. `?tag=xxx` filters by tag. `?redirect=1` returns a 302 to the permalink. |
| `GET /api/search?q=...` | Tag + synonym + title/description search. `&limit=N` (default 24, max 100). |
| `GET /api/tags` | Every tag with its meme count, sorted by popularity. |
| `GET /api/reactions` | Bulk `{ slug: { heart, laugh, bolt, diamond } }` map (edge-cached 60s). |

Worker base URL: `https://chainlinkmeme-api.pilgrim.workers.dev`.

### Embed widget
Each permalink has a **copy embed** button that gives you an `<iframe>` snippet you can drop into blogs, Notion, Discord embeds, etc. The embed page lives at `/embed/:slug`.

## Develop locally

```sh
pnpm install
pnpm --filter site dev           # site at http://localhost:4321
pnpm --filter worker dev         # worker at http://localhost:8787
pnpm --filter site build         # pre-render every meme page (~1,800 pages, ~5s)
```

Useful workspace scripts:

```sh
pnpm manifest                    # regenerate site/public/manifest.json from memes/*.toml
pnpm og                          # rebuild OG images (cache-friendly)
pnpm validate                    # PR-style schema + vocab + uniqueness checks
pnpm weekly                      # compute this week's top-7 snapshot
pnpm tweet:daily -- --dry-run    # preview today's daily tweet
pnpm tweet:weekly -- --dry-run   # preview this week's top-7 thread
pnpm discord:register            # (re)register the /clmeme slash command
```

## Contribute a meme

Drop `yourfile.jpg` + `yourfile.toml` into `memes/`, open a PR.

```toml
title = "short display title"          # optional
tags = ["sergey", "moon"]              # required, must exist in memes/_vocab.toml
description = "context or lore"        # optional
credit = "@someone"                    # optional
source_url = "https://..."             # optional
nsfw = false                           # default false
# submitted_by + date_added are auto-filled by CI
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full walkthrough.

## Deploy

- Push to `main` → `deploy.yml` runs three jobs:
  1. `backfill-meta` — auto-fills `submitted_by` and `date_added` on new TOMLs, commits back
  2. `build-and-deploy` — builds manifest, renders OG images, runs `astro build`, publishes to GitHub Pages
  3. `deploy-worker` — ships the Worker via `wrangler deploy`
- Weekly Monday 09:00 UTC → `weekly.yml` writes the new snapshot and commits it to `main`

D1 migrations under `worker/migrations/` are applied with `pnpm wrangler d1 migrations apply chainlinkmeme --remote`.

## License

- Site + worker code: MIT (see `LICENSE`)
- Memes: community-curated, individual attribution where known. Please don't submit anything you don't have the right to share.

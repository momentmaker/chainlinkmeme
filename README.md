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
- **Weekly**: every Monday 14:30 UTC, `/tweet-weekly` posts a thread — one opener + one reply per top-7 meme — pulled from the freshest `site/src/data/weekly/YYYY-Www.json` snapshot.

~40 tweets/month total, well under X's Free-tier 500-post cap. No read endpoints are used, so nothing needs a paid plan. Secrets (`X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_SECRET`) live in GitHub Actions.

### Sticker export
Each permalink page has a **save as sticker** button that renders the meme to a 512×512 WebP — drop it straight into Telegram, Discord, or Slack.

### OG images
Every meme has a pre-rendered 1200×630 OG card (baked by `scripts/build-og-images.ts` with Satori + Resvg, CI-cached by content hash). The home page has a custom 77-meme honeycomb mosaic.

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

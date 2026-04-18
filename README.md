# chainlinkmeme

⬢ A community-curated archive of Chainlink memes.

Browse, search, favorite, and share memes with tag-based discovery, keyboard navigation, and per-meme permalinks that unfurl beautifully in Discord, Twitter, and Telegram.

## Architecture

```
GitHub repo ────► jsDelivr  (automatic image CDN)
     │
     │        ┌─► Cloudflare Pages   (Astro, pre-rendered)
     └── CI ──┤
              └─► Cloudflare Worker ─► D1  (just /api/likes)
```

- **Images + metadata** live in this repo. The repo *is* the archive.
- **Site** is a static Astro build deployed to Cloudflare Pages.
- **Worker** handles nothing but global like counts (D1-backed).
- **Images** are served via jsDelivr directly from this public repo — no separate CDN setup.

No database migrations. No server runtime beyond a ~30-line Worker. The live site can be rebuilt from scratch with `git clone && deploy`.

## Repo layout

```
memes/            # source of truth: one .jpg/.gif + one .toml per meme
site/             # Astro frontend (Cloudflare Pages)
worker/           # Cloudflare Worker + D1 schema
scripts/          # build-time + one-off tooling
.github/workflows # CI: validate PRs, deploy on merge
```

## Develop locally

```sh
pnpm install
pnpm --filter site dev        # site at http://localhost:4321
pnpm --filter worker dev      # worker at http://localhost:8787
pnpm --filter site build      # pre-render every meme page
```

## Contribute a meme

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full walkthrough. Short version: drop `yourfile.jpg` + `yourfile.toml` into `memes/`, open a PR.

## License

- Site code: MIT (see `LICENSE`)
- Memes: community-curated, individual attribution where known. Please don't submit anything you don't have the right to share.

# Contributing a meme

Anyone can submit a meme via a pull request. No account beyond GitHub. No web form. No upload server. Just commit a file.

## Quick steps

1. Fork this repo.
2. Drop your meme into `memes/` — both the image and a `.toml` with the same basename:
   ```
   memes/sergey_moon.jpg
   memes/sergey_moon.toml
   ```
3. Fill out the TOML (see schema below).
4. Open a PR. CI validates schema, tags, and filename uniqueness.
5. A maintainer reviews and merges. Your meme is live in ~60 seconds.

## Filename rules

- Lowercase, `a-z`, `0-9`, `_`. No spaces, no capitals, no weird characters.
- Must be unique across `memes/`.
- Extension: `.jpg`, `.jpeg`, `.png`, `.gif`, or `.webp`.

The basename doubles as the **slug** — the URL will be `chainlinkmeme.com/m/<basename>`.

## TOML schema

```toml
# memes/sergey_moon.toml

# Required
tags = ["sergey", "moon", "wagmi"]     # every tag must exist in memes/_vocab.toml

# Encouraged
title = "Sergey launches"              # short display title

# Optional
description = ""                       # short context or lore
credit = "@someone"                    # original creator, if known
source_url = "https://..."             # origin link, if known

# Auto-filled by CI on merge — leave blank
submitted_by = ""                      # your GitHub handle, filled from PR author
date_added = ""                        # YYYY-MM-DD, filled at merge time
nsfw = false                           # flag inappropriate content
```

## Tag vocabulary

Tags must exist in [`memes/_vocab.toml`](./memes/_vocab.toml). If you need a new tag, add it to `_vocab.toml` in the same PR with a short description, and the maintainer will evaluate.

Misspellings, plurals, and casing variants can be handled with synonyms in `_vocab.toml` — prefer that over forking a tag.

## What CI checks

- `<basename>.<ext>` and `<basename>.toml` both exist and match
- TOML parses and conforms to `_schema.toml`
- All `tags` exist in `_vocab.toml`
- `<basename>` is unique in `memes/`
- Image opens without errors, isn't zero-byte, dimensions reasonable
- Filename has no uppercase, spaces, or forbidden characters

If any check fails, you'll get a bot comment explaining what to fix.

## What NOT to submit

- Anything you don't have the right to share
- Off-topic content (this is a Chainlink-flavored archive)
- Hateful, harassing, or sexually explicit content
- Images that include personal information about non-public people
- Files over 5 MB (compress first)

Maintainers reserve the right to decline any submission without explanation, and to remove any meme at any time.

# The memeverse + Assemble — design

**Date:** 2026-10-26
**Status:** Implemented
**Route:** `/verse/` (Assemble opens at `/verse/#assemble`)

## Goal

Give a Link Marine landing on chainlinkme.me a reason to say "wait, what?" in
the first three seconds, and something to post afterwards.

1. **The memeverse**: the whole archive as one 3D galaxy you fly through.
   Tags are star systems, memes are hex tiles, Sergey is the galactic core.
2. **Assemble**: drop in a photo and the galaxy streams out of orbit to rebuild
   it as a honeycomb portrait made of memes, then download it as a PFP or a
   poster. The shareable artefact.
3. **A bridge to ccip.dev**: LinkMarine callsigns are three tags drawn from
   this archive, so `#callsign=a-b-c` flies a Marine through their tags.

Constraints carried over from the rest of the site: static hosting on GitHub
Pages, no new services, everything derivable at build time from `memes/`.

## Architecture

```
memes/*  ─► build-manifest.ts ─► manifest.json
                 │
                 ▼
           build-atlas.ts ─► atlas/tiles-{0,1}.webp   64px tiles, 1,024 per 2048² sheet
                 │           atlas/features.bin       4×4 Lab bins per tile (48 bytes)
                 │           atlas/atlas.json         slugs in tile order, mean colours
                 ▼
         build-verse-og.ts ─► og/_verse.png, atlas/hero.webp
                 │
                 ▼
      /verse/ (Astro page, React island, raw WebGL 2)
         components/Verse.tsx     UI: search, panel, tour caption, dog tag, help
         components/Assemble.tsx  photo picker, crop, matching, exports
         verse/engine.ts          camera, input, picking, labels, tour, warp, morph
         verse/renderer.ts        GL: atlas array texture, hi-res cache, passes
         verse/layout.ts          the galaxy (pure, tested)
         verse/mosaic.ts          honeycomb, matcher, software rasteriser (pure, tested)
         lib/atlas-format.ts      tile geometry + colour maths shared by build and browser
```

No runtime dependency was added; three.js was considered and skipped — the
scene is one instanced quad, a fullscreen pass and some sprites.

## The galaxy

- Every tag with ≥ 12 memes becomes a system (37 today). A meme joins the
  system of its *rarest* qualifying tag, so `sergey`/`pepe`/`linkpilled`
  don't swallow everything and small tags still get a home.
- `sergey` is the core, a disc with a hole for the chainlink hex. The rest are
  placed along a two-armed logarithmic spiral, biggest first, then greedily
  by shared memes with the arm's previous system.
- Within a disc, members sit on a phyllotaxis spiral sorted by luminance, so
  each system has a bright heart.
- Discs spin slowly about their own axes; the whole galaxy turns very slowly.
  Both stop while a meme is focused. `layout.positionAt()` mirrors the vertex
  shader so picking, labels and flights agree with what's drawn.

## Rendering

- **Tiles**: one instanced draw. A tile is a pointy-top hex cut from its 64px
  square in a `TEXTURE_2D_ARRAY`. Under ~9px on screen it fades to a star of
  its mean colour; a second, additive pass draws halos only for those stars.
- **Hi-res**: every 250ms the engine lists tiles > 60px tall; the biggest get
  a 256px copy (wsrv, same libvips attention crop as the build) in a 64-slot
  cache texture. A 64-wide float texture maps meme → slot so galaxy tiles and
  mosaic clones share it. Uploads go through `createImageBitmap` — uploading
  straight from `<img>` left blocks of stale texels in testing.
- **Sky**: the nebula is baked once into a 512² cubemap and the dust disc into
  a 1024² texture laid on the galactic plane; per frame the sky costs one
  cubemap fetch plus a hashed star field.
- **Quality**: DPR is capped at 2 (1.75 on touch) and steps down by 25% after
  two seconds below 30fps.

## Assemble

1. The cropped photo is drawn so each hex covers ~14px, and every cell gets the
   same description the build gave each meme (`hexFeatures`).
2. Cells are visited in a random order. Each takes the 56 nearest memes by mean
   colour (plus a squared reuse penalty), then the best by full 48-dim
   distance (plus a larger squared reuse penalty), skipping any meme already
   used within two cells. ~2,600 cells match in ~0.2s.
3. In 3D, one clone per cell launches from its meme's place in the galaxy and
   flies a bowed curve to the portrait, which hangs above the core square to
   the current view. Bright cells sit slightly proud (relief).
4. The blend (`recolor()` in mosaic.ts, mirrored in GLSL) shifts each tile to
   the photo's colour at that hex and keeps half of the meme's own contrast.
5. Exports use a software rasteriser over the atlas sheets, not the GPU, so
   they're exact and independent of the viewport: a 1024² PFP (transparent
   outside the hex) and a 2048×2304 poster.

6. **Clips**: `recordAssemble()` replays the assembly from the galaxy under a
   slow push-in and films the canvas with `MediaRecorder` (MP4/H.264 where
   supported, else WebM), capped at 1920px on the long side, with the
   adaptive quality frozen so the resolution never changes mid-stream.

Privacy: the photo is never uploaded. Nothing in the flow makes a network
request except loading the atlas.

## Deep links

`#m=<slug>`, `#tag=<query>`, `#tour`, `#assemble`, `#callsign=a-b-c` /
`#tags=a,b,c`. Deep links cut the opening swoop short; `hashchange` re-runs
them. Focusing a meme writes `#m=` back so the URL is always shareable.

## Entry points

Header hex button (every page), the strip along the foot of the home page's stage,
the footer, a "find it in the memeverse" button on every permalink, the 404
page, and ccip.dev's Marine pages ("Fly your tags in the Memeverse").

`/verse/` opts out of `ClientRouter`, so moving in or out is a full page load —
a WebGL canvas shouldn't ride along in a view transition.

## Build and CI

`build-atlas.ts` takes ~25s on a cold run and skips when its signature (every
meme's filename + byte size) is unchanged; `build-verse-og.ts` takes ~15s and
skips via a stamp. Both outputs are cached in CI under `atlas-v1-…`. The
atlas adds ~2.4 MB to the Pages artefact.

## Fallbacks

No WebGL 2 → a message linking to the gallery, honeycomb and tag map.
Context loss → the same. `prefers-reduced-motion` → no swoop, no spin, no
idle drift, instant flights and an instant assemble.

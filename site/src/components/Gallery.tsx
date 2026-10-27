import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Manifest, MemeEntry } from '../lib/manifest';
import { apiUrl, fullUrl, memeUrl, pageUrl, permalinkUrl, thumbUrl } from '../lib/meme-url';
import { filterMemes } from '../lib/search';
import type { TagCover } from '../lib/tag-rail';
import { mulberry32 } from '../verse/math';

interface Props {
  manifestUrl?: string;
  pageSize?: number;
  // "Browse by vibe": the biggest tags with a cover meme each (built at
  // render time, see lib/tag-rail.ts).
  tagRail?: TagCover[];
  // Memes added on or after this date (YYYY-MM-DD) wear a "new" badge.
  freshSince?: string;
}

type Order = 'fresh' | 'shuffle';

const HASH_RE = /^[0-9a-f]{10,}$/i;
function displayTitle(m: MemeEntry): string {
  if (m.title && !HASH_RE.test(m.title)) return m.title;
  return m.tags[0] ? `#${m.tags[0]}` : m.slug;
}

// Seeded Fisher–Yates, so one shuffle stays put while you scroll it.
function shuffled<T>(list: T[], seed: number): T[] {
  const out = list.slice();
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const FAVS_KEY = 'chainlinkmeme:favorites';
const THEME_KEY = 'chainlinkmeme:theme';

const REACTIONS = ['heart', 'laugh', 'bolt', 'diamond'] as const;
type Reaction = typeof REACTIONS[number];
const REACTION_ICON: Record<Reaction, string> = {
  // ❤️ (heart + VS16) forces emoji presentation on systems that would
  // otherwise render ♥ as thin monochrome text — matches the full-color
  // weight of 😂 ⚡ 💎 so the four buttons look like a set.
  heart: '\u2764\ufe0f',
  laugh: '😂',
  bolt: '\u26a1\ufe0f',
  diamond: '💎',
};
const REACTION_LABEL: Record<Reaction, string> = {
  heart: 'heart',
  laugh: 'laugh',
  bolt: 'bolt',
  diamond: 'diamond',
};
type ReactionCounts = Record<Reaction, number>;
type ReactionsMap = Record<string, ReactionCounts>;
// Compact a count for tight overlay slots: 1,234 → "1.2k", 10,000 → "10k+".
// Keeps the reaction badge legible when a meme inevitably goes viral.
function fmtCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.floor(n / 1000) + 'k+';
}
// Shared frozen zero so rendering 1,798 cards that have no reactions yet
// doesn't allocate 1,798 fresh objects each render — the Card component
// compares reactionCounts by reference, and a new object every render
// invalidates React.memo boundaries and hurts perf at scale.
const EMPTY_REACTIONS: ReactionCounts = Object.freeze({ heart: 0, laugh: 0, bolt: 0, diamond: 0 }) as ReactionCounts;

// Spawn a small drifting-up icon on top of a reaction button. Imperative so
// rapid taps don't thrash React state — each particle is a plain DOM node
// that removes itself when its CSS animation ends. Targets should be
// `position: relative` so the particle can anchor inside.
function burstReactionParticle(target: HTMLElement, icon: string): void {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const el = document.createElement('span');
  el.className = 'reaction-particle';
  el.textContent = icon;
  // Jitter the lateral drift so repeated taps don't stack perfectly.
  el.style.setProperty('--drift', `${(Math.random() - 0.5) * 30}px`);
  target.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

// Umami custom-event helper — fire-and-forget. Wrapped so the rest of the
// code can call `track('x')` without null-checking window.umami at every site.
interface UmamiWindow { umami?: { track: (name: string, data?: Record<string, unknown>) => void } }
function track(name: string, data?: Record<string, unknown>) {
  try {
    const w = window as unknown as UmamiWindow;
    w.umami?.track(name, data);
  } catch { /* ignore */ }
}

function loadFavorites(): Set<string> {
  if (typeof localStorage === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(FAVS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveFavorites(favs: Set<string>) {
  try {
    localStorage.setItem(FAVS_KEY, JSON.stringify([...favs]));
  } catch {
    /* ignore quota */
  }
}

export default function Gallery({ manifestUrl = '/manifest.json', pageSize = 24, tagRail = [], freshSince }: Props) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  // Start with an empty set on SSR and hydrate favorites from localStorage
  // after mount — matches ThemeToggle's pattern and avoids the hydration
  // mismatch on the Favorites pill count + disabled state.
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set());
  useEffect(() => { setFavorites(loadFavorites()); }, []);
  const [query, setQuery] = useState('');
  const [animatedOnly, setAnimatedOnly] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  // The command bar only puts on its glass once it's pinned to the top: a
  // zero-height sentinel above it scrolls out of view at that moment.
  const stickRef = useRef<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = stickRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setStuck(!!e && !e.isIntersecting && e.boundingClientRect.top < 0));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  // "fresh" keeps the manifest's newest-first order; "shuffle" deals a new
  // wall, re-dealt each time it's pressed.
  const [order, setOrder] = useState<Order>('fresh');
  const [seed, setSeed] = useState(1);
  const [page, setPage] = useState(1);
  // Infinite scroll cap — after MAX_AUTO_PAGES the sentinel stops firing and a
  // "show all" button unlocks the rest. Without this, users never see the
  // footer on 1,798 items because the sentinel keeps them scrolling forever.
  const MAX_AUTO_PAGES = 7;
  const [showAll, setShowAll] = useState(false);
  const [focused, setFocused] = useState(-1);
  const [modalSlug, setModalSlug] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [reactions, setReactions] = useState<ReactionsMap>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const focusedCardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    if (q) setQuery(q);
  }, []);

  useEffect(() => {
    fetch(manifestUrl)
      .then((r) => (r.ok ? r.json() as Promise<Manifest> : null))
      .then(setManifest)
      .catch(() => setManifest(null));
  }, [manifestUrl]);

  const filtered = useMemo(
    () => manifest ? filterMemes(manifest.memes, manifest, { query, animatedOnly, favoritesOnly, favorites }) : [],
    [manifest, query, animatedOnly, favoritesOnly, favorites],
  );
  // Live filtered count for the IntersectionObserver callback below. Read via a
  // ref so the observer reads the current length without closing over a stale
  // value and without re-subscribing on every keystroke.
  const filteredLengthRef = useRef(filtered.length);
  filteredLengthRef.current = filtered.length;

  // Spotlight mode: when the query is active, render more cards than usual so
  // the user sees a constellation of matches lit up against their dim
  // neighbours — not a lonely filtered list. Matches always lead the order.
  const queryActive = query.trim().length > 0;
  const spotlightCap = pageSize * 3;
  // Spotlight reveal (matches lit against dimmed neighbours) only makes sense
  // when the matches are few enough to sit alongside that context. With more
  // matches than the cap we switch to a paginated matches-only grid — the same
  // sentinel + "show all" path as the unfiltered home view. Otherwise the
  // result set was silently truncated at spotlightCap with no way to reach the
  // rest of the matches.
  const spotlightActive = queryActive && filtered.length <= spotlightCap;
  const paginated = !spotlightActive;
  const ordered = useMemo(
    () => (order === 'shuffle' ? shuffled(filtered, seed) : filtered),
    [filtered, order, seed],
  );
  const visible = useMemo(() => {
    if (!manifest) return [] as MemeEntry[];
    if (paginated) {
      const take = showAll ? ordered.length : Math.min(page, MAX_AUTO_PAGES) * pageSize;
      return ordered.slice(0, take);
    }
    const matchSet = new Set(filtered.map((m) => m.slug));
    const nonMatches = manifest.memes.filter((m) => !matchSet.has(m.slug));
    return [
      ...filtered.slice(0, spotlightCap),
      ...nonMatches.slice(0, Math.max(0, spotlightCap - filtered.length)),
    ];
  }, [manifest, filtered, ordered, paginated, page, pageSize, spotlightCap, showAll]);
  const matchLookup = useMemo(() => new Set(filtered.map((m) => m.slug)), [filtered]);
  // slug → position in `visible` — lets the JS-masonry column render figure
  // out which card should hold the keyboard focus without an O(N) indexOf.
  const visibleIndex = useMemo(() => {
    const map = new Map<string, number>();
    visible.forEach((m, i) => map.set(m.slug, i));
    return map;
  }, [visible]);

  useEffect(() => {
    setPage(1);
    setFocused(-1);
    setShowAll(false);
  }, [query, animatedOnly, favoritesOnly, order, seed]);

  // `reactionsOffline` flips true once we've seen the bulk GET fail AND a
  // subsequent increment also fail. Surfaces a small footer pill so users
  // know why their taps aren't registering instead of staring at silence.
  const [reactionsOffline, setReactionsOffline] = useState(false);
  useEffect(() => {
    fetch(apiUrl('/api/reactions'))
      .then((r) => (r.ok ? (r.json() as Promise<ReactionsMap>) : {} as ReactionsMap))
      .then((data) => { setReactions(data); setReactionsOffline(false); })
      .catch(() => { setReactionsOffline(true); });
  }, []);

  // Responsive column count, tracked via matchMedia so the JS masonry can
  // redistribute on resize: 4 across on desktop, 3 on small laptops and
  // tablets, 2 on phones. Breakpoints match THUMB_SIZES below.
  const [columnCount, setColumnCount] = useState(4);
  useEffect(() => {
    const sm = window.matchMedia('(max-width: 900px)');
    const md = window.matchMedia('(max-width: 1180px)');
    const update = () => setColumnCount(sm.matches ? 2 : md.matches ? 3 : 4);
    update();
    sm.addEventListener('change', update);
    md.addEventListener('change', update);
    return () => {
      sm.removeEventListener('change', update);
      md.removeEventListener('change', update);
    };
  }, []);

  // JS masonry: distribute into N columns by appending each card to whichever
  // column is currently shortest (height estimated via aspect ratio). Critical
  // property: this is append-only — adding cards at the end never reshuffles
  // earlier cards. CSS column-count would rebalance on every grow, which is
  // exactly what made scrolling back up feel "random" before.
  //
  // Aspect is clamped to match the CSS max-height cap on card images —
  // otherwise a single ultra-tall image "owns" a column and leaves a large
  // empty gap in adjacent columns until many unit-height cards catch up.
  // Only applied when multi-column; the 1-column mobile layout keeps images
  // uncropped so text-heavy screenshots stay readable.
  const columns = useMemo(() => {
    const cols: MemeEntry[][] = Array.from({ length: columnCount }, () => []);
    const heights = new Array<number>(columnCount).fill(0);
    const maxAspect = columnCount > 1 ? 2 : Infinity;
    for (const m of visible) {
      const rawAspect = m.width > 0 && m.height > 0 ? m.height / m.width : 1;
      const aspect = Math.min(rawAspect, maxAspect);
      let shortest = 0;
      for (let i = 1; i < columnCount; i++) if (heights[i] < heights[shortest]) shortest = i;
      cols[shortest].push(m);
      heights[shortest] += aspect;
    }
    return cols;
  }, [visible, columnCount]);

  // Tag usage counts — computed once per manifest load and used to rank the
  // autocomplete suggestions from most common to least.
  const tagCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (!manifest) return counts;
    for (const m of manifest.memes) {
      for (const t of m.tags) counts[t] = (counts[t] ?? 0) + 1;
    }
    return counts;
  }, [manifest]);

  // Autocomplete suggestions based on the last token in the query. Tokeniser
  // matches lib/search.ts (`/[\s,]+/`) so typing `sergey,moo` still offers
  // suggestions for `moo…` instead of failing silently.
  const [showSuggestions, setShowSuggestions] = useState(false);
  const TOKEN_SEP = /[\s,]+/;
  const suggestions = useMemo(() => {
    if (!manifest || !showSuggestions) return [] as Array<[string, number]>;
    const tokens = query.split(TOKEN_SEP);
    const active = tokens[tokens.length - 1]?.toLowerCase() ?? '';
    if (!active) return [];
    const all = Object.entries(tagCounts);
    return all
      .filter(([t]) => t.startsWith(active) && t !== active)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  }, [manifest, tagCounts, query, showSuggestions]);

  const applySuggestion = useCallback((tag: string) => {
    // Replace the last token (the one the user is typing) with the chosen
    // tag. Preserves prior tokens so multi-tag queries keep working.
    const match = query.match(/^(.*?)([^\s,]*)$/);
    const prefix = match ? match[1] : '';
    setQuery(`${prefix}${tag}`);
    setShowSuggestions(false);
    searchRef.current?.focus();
    track('search-suggestion', { tag });
  }, [query]);

  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(null), 1500);
      return () => clearTimeout(id);
    }
  }, [toast]);

  useEffect(() => {
    if (focused < 0 || !focusedCardRef.current) return;
    const el = focusedCardRef.current;
    // content-visibility:auto cards report the 360px intrinsic estimate until
    // first paint, so a scroll computed before the card renders can land
    // off-centre. The first call pulls it into render range; a rAF re-centre
    // then uses its real height. For the common ±1 focus move the card is
    // usually already rendered, so the second call is effectively a no-op.
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const raf = requestAnimationFrame(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    return () => cancelAnimationFrame(raf);
  }, [focused]);

  const toggleFavorite = useCallback((slug: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) { next.delete(slug); track('meme-unfavorite', { slug }); }
      else { next.add(slug); track('meme-favorite', { slug }); }
      saveFavorites(next);
      return next;
    });
  }, []);

  const incrementReaction = useCallback(async (slug: string, reaction: Reaction) => {
    // Optimistic bump — the server round-trip won't keep up with rapid taps.
    setReactions((prev) => {
      const prior = prev[slug] ?? EMPTY_REACTIONS;
      return { ...prev, [slug]: { ...prior, [reaction]: (prior[reaction] ?? 0) + 1 } };
    });
    try {
      const res = await fetch(apiUrl(`/api/reactions/${encodeURIComponent(slug)}/${reaction}`), { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { count: number };
      setReactions((prev) => {
        const prior = prev[slug] ?? EMPTY_REACTIONS;
        return { ...prev, [slug]: { ...prior, [reaction]: body.count } };
      });
      setReactionsOffline(false);
    } catch {
      // Roll the optimistic bump back so we don't drift from the server.
      // A rate-limit hit also lands here — the rollback + offline pill tell
      // the user something's off instead of silently eating the click.
      setReactions((prev) => {
        const prior = prev[slug] ?? EMPTY_REACTIONS;
        const reverted = Math.max(0, (prior[reaction] ?? 0) - 1);
        return { ...prev, [slug]: { ...prior, [reaction]: reverted } };
      });
      setReactionsOffline(true);
    }
  }, []);

  const copyPermalink = useCallback((slug: string) => {
    const url = new URL(permalinkUrl(slug), window.location.origin).toString();
    track('meme-copy-link', { slug });
    navigator.clipboard.writeText(url).then(
      () => setToast('link copied'),
      () => setToast('copy failed'),
    );
  }, []);

  // The meme itself onto the clipboard, ready to paste into an X reply or a
  // Discord message. The clipboard only takes PNG, so whatever wsrv serves is
  // re-encoded through a canvas; the ClipboardItem gets the promise straight
  // away so Safari still counts it as part of the click. GIFs can't be put on
  // the clipboard animated, so they get their link instead.
  const copyImage = useCallback((m: MemeEntry) => {
    const canWrite = typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;
    if (m.animated || !canWrite) {
      copyPermalink(m.slug);
      if (m.animated) setTimeout(() => setToast("GIFs can't ride the clipboard — link copied"), 0);
      return;
    }
    track('meme-copy-image', { slug: m.slug });
    const png = (async () => {
      const res = await fetch(thumbUrl(m.filename, Math.min(1080, m.width || 1080)), { mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bmp = await createImageBitmap(await res.blob());
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d')!.drawImage(bmp, 0, 0);
      bmp.close?.();
      return new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png'));
    })();
    navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).then(
      () => setToast('image copied — paste it anywhere'),
      () => setToast('copy failed — try the link instead'),
    );
  }, [copyPermalink]);

  // Carousel scope for modal arrow-key navigation: the wall as it's laid out
  // (matches only while a query is active), in its current order.
  const carouselList = useMemo(() => {
    if (!manifest) return [] as MemeEntry[];
    return queryActive && spotlightActive ? filtered : ordered;
  }, [manifest, filtered, ordered, queryActive, spotlightActive]);

  const modalMeme = useMemo(
    () => (modalSlug && manifest ? manifest.memes.find((m) => m.slug === modalSlug) ?? null : null),
    [modalSlug, manifest],
  );

  const modalIndex = useMemo(
    () => (modalSlug ? carouselList.findIndex((m) => m.slug === modalSlug) : -1),
    [modalSlug, carouselList],
  );

  const stepModal = useCallback((dir: -1 | 1) => {
    if (modalIndex < 0 || !carouselList.length) return;
    const next = modalIndex + dir;
    if (next < 0 || next >= carouselList.length) return;
    setModalSlug(carouselList[next].slug);
  }, [modalIndex, carouselList]);

  // Preload the neighbours so arrow-key navigation swaps instantly instead of
  // showing the previous image until the new one decodes. `new Image()` kicks
  // off a fetch without mounting anything; decoded bytes stay in the browser
  // cache and the real <img> below picks them up on swap.
  useEffect(() => {
    if (modalIndex < 0) return;
    for (const dir of [-1, 1] as const) {
      const neighbour = carouselList[modalIndex + dir];
      if (neighbour) {
        const img = new Image();
        img.src = fullUrl(neighbour.filename, { animated: neighbour.animated });
      }
    }
  }, [modalIndex, carouselList]);

  // Track any meme view — covers initial open + arrow-key steps. Umami
  // treats this as a distinct custom event per slug, enough to rank the most
  // looked-at memes without touching every open site.
  useEffect(() => {
    if (modalSlug) track('meme-view', { slug: modalSlug });
  }, [modalSlug]);

  // While the new image is decoding, keep the slug we last successfully showed
  // so the <img> element isn't blank — but only for the brief load window.
  // Once `onLoad` fires we clear it. Combined with the preload above, this
  // makes arrow-key navigation feel instant.
  const [modalLoading, setModalLoading] = useState(false);
  useEffect(() => {
    if (!modalSlug) { setModalLoading(false); return; }
    setModalLoading(true);
  }, [modalSlug]);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement && e.key !== 'Escape') return;
      if (modalSlug) {
        if (e.key === 'Escape') { setModalSlug(null); return; }
        if (e.key === 'ArrowRight' || e.key === 'l' || e.key === 'j') { stepModal(1); return; }
        if (e.key === 'ArrowLeft' || e.key === 'h' || e.key === 'k') { stepModal(-1); return; }
        if (e.key === 'c' && modalMeme) { copyPermalink(modalMeme.slug); return; }
        if (e.key === 'i' && modalMeme) { copyImage(modalMeme); return; }
        if (e.key === 'f' && modalMeme) {
          toggleFavorite(modalMeme.slug);
          if (!favorites.has(modalMeme.slug)) incrementReaction(modalMeme.slug, 'heart');
          return;
        }
        return;
      }
      // While the help dialog is open, the only keys we respond to are Esc
      // and `?` (both close it). Everything else is swallowed so focus nav
      // can't move invisibly behind the overlay.
      if (showHelp) {
        if (e.key === 'Escape' || e.key === '?') setShowHelp(false);
        return;
      }
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key === '?') { e.preventDefault(); setShowHelp(true); return; }
      if (e.key === 'Escape') { searchRef.current?.blur(); setFocused(-1); return; }
      if (e.key === 'r' && manifest) {
        const pool = queryActive ? filtered : manifest.memes;
        if (pool.length > 0) setModalSlug(pool[Math.floor(Math.random() * pool.length)].slug);
        return;
      }
      if (e.key === 'j') {
        setFocused((f) => Math.min(visible.length - 1, f + 1));
        return;
      }
      if (e.key === 'k') {
        setFocused((f) => Math.max(0, f - 1));
        return;
      }
      const current = focused >= 0 ? visible[focused] : null;
      if (!current) return;
      if (e.key === 'f') { toggleFavorite(current.slug); incrementReaction(current.slug, 'heart'); return; }
      if (e.key === 'c') { copyPermalink(current.slug); return; }
      if (e.key === 'i') { copyImage(current); return; }
      if (e.key === 'Enter') { setModalSlug(current.slug); return; }
    },
    [
      modalSlug, modalMeme, showHelp, manifest, filtered, queryActive,
      visible, focused, favorites, stepModal,
      toggleFavorite, copyPermalink, copyImage, incrementReaction,
    ],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  // Infinite scroll: observe a sentinel near the footer and bump the page as
  // it enters the viewport. Active whenever we're paginating — the unfiltered
  // home view and the many-matches search view both use it. Skipped only in
  // spotlight mode, which already renders the full (small) match set at once.
  // The sentinel stops at MAX_AUTO_PAGES so the footer becomes reachable;
  // users can click "show all" to keep going.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Swipe state lives at component scope so a mid-gesture re-render (e.g.
  // toggling a favorite between touchstart and touchend) doesn't reset the
  // origin and make the whole screen seem to swipe on release.
  const swipeRef = useRef({ x: 0, y: 0, t: 0 });
  useEffect(() => {
    if (!paginated || showAll) return;
    const el = sentinelRef.current;
    if (!el || !manifest) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setPage((p) => {
            if (p >= MAX_AUTO_PAGES) return p;
            if (p * pageSize >= filteredLengthRef.current) return p;
            return p + 1;
          });
        }
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [paginated, manifest, pageSize, showAll]);


  return (
    <>
      {tagRail.length > 0 && (
        <TagRail
          items={tagRail}
          total={manifest?.memes.length ?? 0}
          active={query.trim().toLowerCase().replace(/^#/, '')}
          onPick={(tag) => {
            track('vibe-pick', { tag: tag ?? 'everything' });
            setQuery(tag ?? '');
            setShowSuggestions(false);
          }}
        />
      )}

      <div ref={stickRef} className="toolbar-sentinel" aria-hidden="true" />
      <div className={`toolbar ${stuck ? 'is-stuck' : ''}`}>
      <div className="search" role="search">
        <div className="search-wrap">
          <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="12,2 21,7 21,17 12,22 3,17 3,7" />
          </svg>
          <input
            ref={searchRef}
            type="search"
            placeholder="search tags — e.g. sergey, moon, wagmi  (/ to focus)"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setShowSuggestions(true); }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && suggestions.length > 0) {
                e.preventDefault();
                applySuggestion(suggestions[0][0]);
              }
            }}
            aria-label="Search memes by tag"
            autoComplete="off"
          />
          {query && (
            <button
              type="button"
              className="search-clear"
              onClick={() => setQuery('')}
              aria-label="Clear search"
            >×</button>
          )}
          {suggestions.length > 0 && (
            <ul className="suggestions" role="listbox">
              {suggestions.map(([tag, count]) => (
                <li key={tag}>
                  <button
                    type="button"
                    className="suggestion"
                    onMouseDown={(e) => { e.preventDefault(); applySuggestion(tag); }}
                  >
                    <span className="suggestion-tag">#{tag}</span>
                    <span className="suggestion-count">{count}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="order-seg" role="radiogroup" aria-label="Order">
          <button
            type="button"
            role="radio"
            aria-checked={order === 'fresh'}
            className={order === 'fresh' ? 'on' : ''}
            onClick={() => { track('order', { order: 'fresh' }); setOrder('fresh'); }}
          >
            fresh
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={order === 'shuffle'}
            className={order === 'shuffle' ? 'on' : ''}
            onClick={() => {
              track('order', { order: 'shuffle' });
              setOrder('shuffle');
              setSeed(Math.floor(Math.random() * 2 ** 31));
            }}
            title="deal a new wall"
          >
            shuffle <span aria-hidden="true">⟳</span>
          </button>
        </div>
        <button
          type="button"
          className={`filter-pill ${animatedOnly ? 'active' : ''}`}
          onClick={() => setAnimatedOnly((v) => { track('filter-gifs', { on: !v }); return !v; })}
        >
          <span className="hex" aria-hidden="true">⬢</span> GIFs
        </button>
        <button
          type="button"
          className={`filter-pill ${favoritesOnly ? 'active' : ''}`}
          onClick={() => setFavoritesOnly((v) => { track('filter-favorites', { on: !v }); return !v; })}
          disabled={favorites.size === 0}
        >
          <span className="hex" aria-hidden="true">{'\u2764\ufe0f'}</span> Favorites · {favorites.size}
        </button>
        <button
          type="button"
          className="filter-pill"
          onClick={() => {
            const pool = queryActive ? filtered : (manifest?.memes ?? []);
            if (pool.length === 0) return;
            track('random-click', { pool: queryActive ? 'filtered' : 'all' });
            setModalSlug(pool[Math.floor(Math.random() * pool.length)].slug);
          }}
          aria-label="Open a random meme"
        >
          <span className="hex" aria-hidden="true">⬡</span> Random
        </button>
        <button
          type="button"
          className="hex-btn"
          onClick={() => setShowHelp(true)}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts"
        >
          <span className="hex-btn-label">?</span>
        </button>
      </div>
      </div>

      {manifest && (
        <div className="match-count">
          {queryActive ? (
            <>
              <strong>{filtered.length}</strong> match{filtered.length === 1 ? '' : 'es'}
              {spotlightActive && filtered.length < manifest.memes.length && (
                <> · non-matches dimmed for context</>
              )}
            </>
          ) : (
            <>
              <strong>{filtered.length.toLocaleString()}</strong> memes · {order === 'fresh' ? 'newest first' : 'shuffled'}
            </>
          )}
        </div>
      )}

      {visible.length === 0 ? (
        <p style={{ textAlign: 'center', color: 'var(--muted)', padding: '40px 0' }}>
          No memes match. Try a different tag or clear filters.
        </p>
      ) : (
        <div className="gallery" role="list" data-cols={columnCount}>
          {columns.map((col, ci) => (
            <div key={ci} className="gallery-column">
              {col.map((m) => {
                const i = visibleIndex.get(m.slug) ?? -1;
                return (
                  <Card
                    key={m.slug}
                    meme={m}
                    index={i}
                    focused={i === focused}
                    lit={spotlightActive && matchLookup.has(m.slug)}
                    dim={spotlightActive && !matchLookup.has(m.slug)}
                    liked={favorites.has(m.slug)}
                    reactionCounts={reactions[m.slug] ?? EMPTY_REACTIONS}
                    fresh={!!freshSince && m.date_added >= freshSince}
                    innerRef={i === focused ? focusedCardRef : null}
                    onOpenModal={() => setModalSlug(m.slug)}
                    onToggleFavorite={() => {
                      toggleFavorite(m.slug);
                      if (!favorites.has(m.slug)) incrementReaction(m.slug, 'heart');
                    }}
                    onReact={(rx) => incrementReaction(m.slug, rx)}
                    onCopyLink={() => copyPermalink(m.slug)}
                    onCopyImage={() => copyImage(m)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}

      {paginated && visible.length < filtered.length && (
        page < MAX_AUTO_PAGES && !showAll ? (
          <div ref={sentinelRef} className="load-sentinel" aria-hidden="true">
            <span>⬢ loading more ⬢</span>
          </div>
        ) : !showAll ? (
          <div className="load-more">
            <p className="load-more-count">
              showing <strong>{visible.length}</strong> of <strong>{filtered.length}</strong> memes
            </p>
            <button
              type="button"
              className="filter-pill"
              onClick={() => { track('show-all', { count: filtered.length }); setShowAll(true); }}
            >
              <span className="hex" aria-hidden="true">⬢</span> show all {filtered.length}
            </button>
          </div>
        ) : null
      )}

      {modalMeme && (() => {
        const rs = reactions[modalMeme.slug] ?? EMPTY_REACTIONS;
        const total = rs.heart + rs.laugh + rs.bolt + rs.diamond;
        const liked = favorites.has(modalMeme.slug);
        // Swipe handlers read + write via swipeRef (component-scope) so a
        // re-render mid-gesture doesn't lose the touchstart origin.
        const onTouchStart = (e: React.TouchEvent) => {
          const t = e.touches[0];
          if (!t) return;
          swipeRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
        };
        const onTouchEnd = (e: React.TouchEvent) => {
          const t = e.changedTouches[0];
          if (!t) return;
          const { x, y, t: startT } = swipeRef.current;
          const dx = t.clientX - x;
          const dy = t.clientY - y;
          const dt = Date.now() - startT;
          // Horizontal swipe only: needs to travel ≥ 40px, be faster than
          // 600ms, and be clearly more horizontal than vertical (so
          // vertical scrolls don't accidentally flip cards).
          if (dt > 600) return;
          if (Math.abs(dx) < 40) return;
          if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
          stepModal(dx > 0 ? -1 : 1);
        };
        // Close the modal then navigate via ClientRouter so we keep the
        // hex view-transition into the permalink. Falls back to a hard
        // navigation when the module isn't available (dev without
        // transitions, missing import map, etc.).
        const openPermalink = async (e: React.MouseEvent) => {
          e.preventDefault();
          const target = permalinkUrl(modalMeme.slug);
          setModalSlug(null);
          try {
            const mod = await import('astro:transitions/client');
            mod.navigate(target);
          } catch {
            window.location.href = target;
          }
        };
        return (
          <div
            className="modal-backdrop"
            onClick={() => setModalSlug(null)}
            role="dialog"
            aria-modal="true"
            aria-label={modalMeme.title || modalMeme.slug}
          >
            <button
              type="button"
              className="modal-nav prev"
              onClick={(e) => { e.stopPropagation(); stepModal(-1); }}
              disabled={modalIndex <= 0}
              aria-label="Previous meme"
            >‹</button>

            <div
              className="modal-content"
              onClick={(e) => e.stopPropagation()}
              onTouchStart={onTouchStart}
              onTouchEnd={onTouchEnd}
            >
              <a
                className={`modal-img-wrap ${modalLoading ? 'loading' : ''}`}
                href={permalinkUrl(modalMeme.slug)}
                onClick={openPermalink}
                aria-label={`Open permalink for ${modalMeme.title || modalMeme.slug}`}
              >
                <img
                  key={modalMeme.slug}
                  src={fullUrl(modalMeme.filename, { animated: modalMeme.animated })}
                  alt={modalMeme.title || modalMeme.slug}
                  onLoad={() => setModalLoading(false)}
                  onError={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = memeUrl(modalMeme.filename); }}
                  decoding="async"
                  fetchPriority="high"
                />
              </a>

              {/* Top-left: position pill + tags */}
              <div className="modal-overlay-top-left">
                <span className="modal-position-pill">
                  <strong>{modalIndex + 1}</strong><span style={{ opacity: 0.6 }}>/{carouselList.length}</span>
                </span>
                {modalMeme.tags.slice(0, 3).map((t) => (
                  <span key={t} className="modal-tag">#{t}</span>
                ))}
              </div>

              {/* Top-right: hex copy-link + hex close */}
              <div className="modal-overlay-top-right">
                <button
                  type="button"
                  className="card-link"
                  onClick={(e) => { e.stopPropagation(); copyImage(modalMeme); }}
                  aria-label={modalMeme.animated ? 'Copy link (GIFs cannot be copied as images)' : 'Copy image'}
                  title={modalMeme.animated ? 'copy link' : 'copy image (i)'}
                >
                  <CopyImageIcon />
                </button>
                <button
                  type="button"
                  className="card-link"
                  onClick={(e) => { e.stopPropagation(); copyPermalink(modalMeme.slug); }}
                  aria-label="Copy permalink"
                  title="Copy permalink"
                >
                  <span className="card-link-icon" aria-hidden="true">🔗</span>
                </button>
                <button
                  type="button"
                  className="card-link"
                  onClick={(e) => { e.stopPropagation(); setModalSlug(null); }}
                  aria-label="Close"
                  title="Close (Esc)"
                >
                  <span className="card-link-icon" aria-hidden="true">×</span>
                </button>
              </div>

              {/* Bottom: reactions + total */}
              <div className="modal-overlay-bottom">
                <div className="reaction-row" role="group" aria-label="Reactions">
                  {REACTIONS.map((rx) => (
                    <button
                      key={rx}
                      type="button"
                      className={`reaction-btn ${rx === 'heart' && liked ? 'liked' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        burstReactionParticle(e.currentTarget, REACTION_ICON[rx]);
                        if (rx === 'heart') toggleFavorite(modalMeme.slug);
                        else incrementReaction(modalMeme.slug, rx);
                      }}
                      aria-label={`React with ${REACTION_LABEL[rx]}`}
                      title={REACTION_LABEL[rx]}
                    >
                      <span className="reaction-icon" aria-hidden="true">{REACTION_ICON[rx]}</span>
                      {rs[rx] > 0 && <span className="reaction-count">{fmtCount(rs[rx])}</span>}
                    </button>
                  ))}
                </div>
                {total > 0 && (
                  <span className="reaction-total" aria-hidden="true" title={`${total} total reactions`}>
                    ⬢ {fmtCount(total)}
                  </span>
                )}
              </div>
            </div>

            <button
              type="button"
              className="modal-nav next"
              onClick={(e) => { e.stopPropagation(); stepModal(1); }}
              disabled={modalIndex >= carouselList.length - 1}
              aria-label="Next meme"
            >›</button>
          </div>
        );
      })()}

      {showHelp && <KeyboardHelp onClose={() => setShowHelp(false)} />}

      {toast && <div className="toast">{toast}</div>}
      {reactionsOffline && (
        <div className="reactions-offline" role="status" aria-live="polite">
          reactions temporarily offline
        </div>
      )}
    </>
  );
}

// Responsive grid thumbnail: serves a right-sized WebP through wsrv.nl so the
// browser fetches ~20 KB on a phone yet stays crisp on retina, instead of the
// multi-megabyte original. width/height carry the *original* aspect ratio so
// the masonry reserves correct space whatever resolution is served. On proxy
// failure (outage, rate limit, an un-resizable source) it falls back once to
// the full-res original so a card never renders blank.
//
// THUMB_SIZES caps each tier at the real card width — the .page container maxes
// at 1280px so a 4-col card never exceeds ~300px; an unclamped 25vw would make
// wide non-retina viewports over-fetch. Its 900/1180 breakpoints MUST stay in
// sync with the matchMedia thresholds in the columnCount effect.
const THUMB_WIDTHS = [360, 540, 720, 1080] as const;
const THUMB_SIZES = '(max-width: 900px) 50vw, (max-width: 1180px) 33vw, 310px';

function Thumb({ meme }: { meme: MemeEntry }) {
  const [failed, setFailed] = useState(false);
  const shared = {
    alt: meme.title || meme.slug,
    loading: 'lazy' as const,
    decoding: 'async' as const,
    width: meme.width || undefined,
    height: meme.height || undefined,
    style: { viewTransitionName: `meme-${meme.slug}` } as React.CSSProperties,
  };
  if (failed) return <img src={memeUrl(meme.filename)} {...shared} />;

  const max = meme.width || THUMB_WIDTHS[THUMB_WIDTHS.length - 1];
  const ladder = THUMB_WIDTHS.filter((w) => w <= max);
  const widths = ladder.length > 0 ? ladder : [max];
  const opts = { animated: meme.animated };
  const srcSet = widths.map((w) => `${thumbUrl(meme.filename, w, opts)} ${w}w`).join(', ');
  const src = thumbUrl(meme.filename, widths[Math.min(1, widths.length - 1)], opts);
  return <img src={src} srcSet={srcSet} sizes={THUMB_SIZES} onError={() => setFailed(true)} {...shared} />;
}

interface CardProps {
  meme: MemeEntry;
  index: number;
  focused: boolean;
  lit: boolean;
  dim: boolean;
  liked: boolean;
  reactionCounts: ReactionCounts;
  fresh: boolean;
  innerRef: React.Ref<HTMLDivElement> | null;
  onOpenModal: () => void;
  onToggleFavorite: () => void;
  onReact: (reaction: Reaction) => void;
  onCopyLink: () => void;
  onCopyImage: () => void;
}

function CopyImageIcon() {
  return (
    <svg className="card-link-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
      <path d="m10.5 18 3-3.5 2.5 2.5 1.5-1.5 2 2" />
    </svg>
  );
}

function Card({ meme, index, focused, lit, dim, liked, reactionCounts, fresh, innerRef, onOpenModal, onToggleFavorite, onReact, onCopyLink, onCopyImage }: CardProps) {
  const totalReactions = reactionCounts.heart + reactionCounts.laugh + reactionCounts.bolt + reactionCounts.diamond;
  return (
    <div
      ref={innerRef ?? undefined}
      className="card"
      data-focused={focused || undefined}
      data-lit={lit || undefined}
      data-dim={dim || undefined}
      style={{ '--card-i': Math.min(index, 30) } as React.CSSProperties}
      role="listitem"
    >
      <a href={permalinkUrl(meme.slug)} onClick={(e) => { e.preventDefault(); onOpenModal(); }}>
        <Thumb meme={meme} />
      </a>
      {fresh && <span className="card-new">new</span>}
      <div className="card-actions">
        <button
          type="button"
          className="card-link"
          onClick={(e) => { e.stopPropagation(); onCopyImage(); }}
          aria-label={meme.animated ? 'Copy link (GIFs cannot be copied as images)' : 'Copy image'}
          title={meme.animated ? 'copy link' : 'copy image'}
        >
          <CopyImageIcon />
        </button>
        <button
          type="button"
          className="card-link"
          onClick={(e) => { e.stopPropagation(); onCopyLink(); }}
          aria-label="Copy permalink"
          title="Copy permalink"
        >
          <span className="card-link-icon" aria-hidden="true">🔗</span>
        </button>
      </div>
      <div className="card-overlay">
        <div className="card-caption">
          <span className="card-title">{displayTitle(meme)}</span>
          <span className="card-tags">{meme.tags.slice(0, 3).map((t) => `#${t}`).join(' ')}</span>
        </div>
        <div className="card-overlay-row">
        <div className="reaction-row" role="group" aria-label="Reactions">
          {REACTIONS.map((rx) => (
            <button
              key={rx}
              type="button"
              className={`reaction-btn ${rx === 'heart' && liked ? 'liked' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                burstReactionParticle(e.currentTarget, REACTION_ICON[rx]);
                if (rx === 'heart') onToggleFavorite();
                else onReact(rx);
              }}
              aria-label={`React with ${REACTION_LABEL[rx]}`}
              title={REACTION_LABEL[rx]}
            >
              <span className="reaction-icon" aria-hidden="true">{REACTION_ICON[rx]}</span>
              {reactionCounts[rx] > 0 && <span className="reaction-count">{fmtCount(reactionCounts[rx])}</span>}
            </button>
          ))}
        </div>
        {totalReactions > 0 && <span className="reaction-total" aria-hidden="true" title={`${totalReactions} total reactions`}>⬢ {fmtCount(totalReactions)}</span>}
        </div>
      </div>
    </div>
  );
}

// "Browse by vibe": the biggest tags as hex covers on a horizontal rail.
// Picking one filters the wall below; "everything" clears it.
function TagRail({ items, total, active, onPick }: {
  items: TagCover[];
  total: number;
  active: string;
  onPick: (tag: string | null) => void;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [edge, setEdge] = useState({ start: true, end: false });
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdge({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth > el.scrollWidth - 8 });
  }, []);
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);
  const nudge = (dir: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };
  return (
    <section className="vibes" aria-label="Browse by vibe">
      <div className="vibes-head">
        <h2 className="vibes-title"><span aria-hidden="true">⬢</span> browse by vibe</h2>
        <a className="vibes-verse" href={pageUrl('/verse/')}>see every tag as a star system <span aria-hidden="true">→</span></a>
      </div>
      <div className={`vibes-rail ${edge.start ? 'at-start' : ''} ${edge.end ? 'at-end' : ''}`}>
        <button type="button" className="vibes-arrow prev" onClick={() => nudge(-1)} aria-label="Scroll vibes left" tabIndex={-1}>‹</button>
        <div className="vibes-scroll" ref={scroller} onScroll={measure}>
          <button type="button" className={`vibe ${active === '' ? 'on' : ''}`} onClick={() => onPick(null)} aria-pressed={active === ''}>
            <span className="vibe-hex vibe-all" aria-hidden="true">
              <svg viewBox="0 0 64 64">
                <g fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinejoin="round">
                  <polygon points="25.07,12 32,16 32,24 25.07,28 18.14,24 18.14,16" />
                  <polygon points="38.93,12 45.86,16 45.86,24 38.93,28 32,24 32,16" />
                  <polygon points="18.14,24 25.07,28 25.07,36 18.14,40 11.21,36 11.21,28" />
                  <polygon points="45.86,24 52.79,28 52.79,36 45.86,40 38.93,36 38.93,28" />
                  <polygon points="25.07,36 32,40 32,48 25.07,52 18.14,48 18.14,40" />
                  <polygon points="38.93,36 45.86,40 45.86,48 38.93,52 32,48 32,40" />
                </g>
                <polygon fill="currentColor" points="32,24 38.93,28 38.93,36 32,40 25.07,36 25.07,28" />
              </svg>
            </span>
            <span className="vibe-tag">everything</span>
            <span className="vibe-n">{total ? total.toLocaleString() : ''}</span>
          </button>
          {items.map((it) => (
            <button
              key={it.tag}
              type="button"
              className={`vibe ${active === it.tag ? 'on' : ''}`}
              onClick={() => onPick(active === it.tag ? null : it.tag)}
              aria-pressed={active === it.tag}
            >
              <span className="vibe-hex" aria-hidden="true">
                <img src={thumbUrl(it.filename, 180)} alt="" loading="lazy" decoding="async" onError={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = memeUrl(it.filename); }} />
              </span>
              <span className="vibe-tag">#{it.tag}</span>
              <span className="vibe-n">{it.count.toLocaleString()}</span>
            </button>
          ))}
        </div>
        <button type="button" className="vibes-arrow next" onClick={() => nudge(1)} aria-label="Scroll vibes right" tabIndex={-1}>›</button>
      </div>
    </section>
  );
}

function KeyboardHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="shortcut-dialog" role="dialog" aria-label="Keyboard shortcuts" onClick={onClose}>
      <div className="shortcut-panel" onClick={(e) => e.stopPropagation()}>
        <h3>⬡ Keyboard shortcuts</h3>
        <dl>
          <dt>/</dt><dd>focus search</dd>
          <dt>j / k</dt><dd>next / previous meme</dd>
          <dt>Enter</dt><dd>open focused meme</dd>
          <dt>f</dt><dd>favorite focused</dd>
          <dt>c</dt><dd>copy permalink</dd>
          <dt>i</dt><dd>copy image</dd>
          <dt>r</dt><dd>random meme</dd>
          <dt>s</dt><dd>shuffle mode (fullscreen)</dd>
          <dt>← / →</dt><dd>step through in modal</dd>
          <dt>?</dt><dd>this help</dd>
          <dt>Esc</dt><dd>close / unfocus</dd>
        </dl>
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <button className="btn" type="button" onClick={onClose}>got it</button>
        </div>
      </div>
    </div>
  );
}

// Theme toggle — SSR renders a neutral button to avoid a hydration mismatch
// (the theme is applied pre-paint via an inline script, so SSR HTML lags the
// real state). Once mounted on the client we read the live theme and render
// the matching icon.
export function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const applied = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    setTheme(applied);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }, [theme, mounted]);

  return (
    <button
      type="button"
      className="hex-btn"
      onClick={() => setTheme((t) => { const next = t === 'dark' ? 'light' : 'dark'; track('theme-toggle', { to: next }); return next; })}
      aria-label="Toggle theme"
    >
      <span className="hex-btn-label">{mounted ? (theme === 'dark' ? '☀︎' : '☾') : '◐'}</span>
    </button>
  );
}

// Hexagon scroll-to-top — ported from chainlink-meme-react. Stays off-screen
// at rest, slides in when scrollY > 100. Clicking smooth-scrolls to top.
export function HexScrollTop() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const onScroll = () => setShown(window.scrollY > 100);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <button
      type="button"
      className={`hex-scroll ${shown ? 'toggled' : ''}`}
      aria-label="Scroll to top"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
    >
      <span className="arrow" aria-hidden="true">▲</span>
    </button>
  );
}

// Per-meme reaction island for the permalink page. Fetches the shared
// bulk reactions endpoint (edge-cached, cheap) on mount, picks out this
// slug, then handles optimistic clicks the same way the gallery does.
// Mirrors the gallery card's visual layout so the permalink feels like a
// zoomed-in version of the same card.
export function PermalinkReactions({ slug }: { slug: string }) {
  const [counts, setCounts] = useState<ReactionCounts>(EMPTY_REACTIONS);
  const [liked, setLiked] = useState(false);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;
    try {
      const favs = JSON.parse(localStorage.getItem(FAVS_KEY) ?? '[]') as string[];
      if (!cancelled) setLiked(favs.includes(slug));
    } catch { /* ignore */ }
    fetch(apiUrl('/api/reactions'))
      .then((r) => (r.ok ? (r.json() as Promise<ReactionsMap>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((map) => { if (!cancelled) setCounts(map[slug] ?? EMPTY_REACTIONS); })
      .catch(() => { if (!cancelled) setOffline(true); });
    return () => { cancelled = true; };
  }, [slug]);

  const toggleFav = () => {
    try {
      const favs = new Set<string>(JSON.parse(localStorage.getItem(FAVS_KEY) ?? '[]') as string[]);
      const wasLiked = favs.has(slug);
      if (wasLiked) favs.delete(slug);
      else favs.add(slug);
      localStorage.setItem(FAVS_KEY, JSON.stringify([...favs]));
      setLiked(!wasLiked);
      if (!wasLiked) {
        // First-time favorite also bumps the global heart count.
        void react('heart');
      }
    } catch { /* ignore */ }
  };

  const react = async (rx: Reaction) => {
    setCounts((prior) => ({ ...prior, [rx]: (prior[rx] ?? 0) + 1 }));
    try {
      const res = await fetch(apiUrl(`/api/reactions/${encodeURIComponent(slug)}/${rx}`), { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { count: number };
      setCounts((prior) => ({ ...prior, [rx]: body.count }));
      setOffline(false);
    } catch {
      setCounts((prior) => ({ ...prior, [rx]: Math.max(0, (prior[rx] ?? 0) - 1) }));
      setOffline(true);
    }
  };

  const total = counts.heart + counts.laugh + counts.bolt + counts.diamond;
  return (
    <>
      <div className="permalink-overlay-bottom">
        <div className="reaction-row" role="group" aria-label="Reactions">
          {REACTIONS.map((rx) => (
            <button
              key={rx}
              type="button"
              className={`reaction-btn ${rx === 'heart' && liked ? 'liked' : ''}`}
              onClick={(e) => {
                burstReactionParticle(e.currentTarget, REACTION_ICON[rx]);
                if (rx === 'heart') toggleFav();
                else void react(rx);
              }}
              aria-label={`React with ${REACTION_LABEL[rx]}`}
              title={REACTION_LABEL[rx]}
            >
              <span className="reaction-icon" aria-hidden="true">{REACTION_ICON[rx]}</span>
              {counts[rx] > 0 && <span className="reaction-count">{fmtCount(counts[rx])}</span>}
            </button>
          ))}
        </div>
        {total > 0 && (
          <span className="reaction-total" aria-hidden="true" title={`${total} total reactions`}>
            ⬢ {fmtCount(total)}
          </span>
        )}
      </div>
      {offline && (
        <div className="reactions-offline" role="status" aria-live="polite">
          reactions temporarily offline
        </div>
      )}
    </>
  );
}

// Progress bar — minimal, not reactive to filter changes
export function ProgressBar() {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const h = document.documentElement;
      const pct = (h.scrollTop / Math.max(1, h.scrollHeight - h.clientHeight)) * 100;
      setWidth(Math.max(0, Math.min(100, pct)));
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <div className="progress-bar" aria-hidden="true">
      <div className="progress" style={{ width: `${width}%` }} />
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Manifest, MemeEntry } from '../lib/manifest';
import { apiUrl, memeUrl, permalinkUrl } from '../lib/meme-url';
import { filterMemes } from '../lib/search';

interface Props {
  manifestUrl?: string;
  pageSize?: number;
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

export default function Gallery({ manifestUrl = '/manifest.json', pageSize = 21 }: Props) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  // Start with an empty set on SSR and hydrate favorites from localStorage
  // after mount — matches ThemeToggle's pattern and avoids the hydration
  // mismatch on the Favorites pill count + disabled state.
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set());
  useEffect(() => { setFavorites(loadFavorites()); }, []);
  const [query, setQuery] = useState('');
  const [animatedOnly, setAnimatedOnly] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
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

  // Spotlight mode: when the query is active, render more cards than usual so
  // the user sees a constellation of matches lit up against their dim
  // neighbours — not a lonely filtered list. Matches always lead the order.
  const queryActive = query.trim().length > 0;
  const spotlightCap = pageSize * 3;
  const visible = useMemo(() => {
    if (!manifest) return [] as MemeEntry[];
    if (!queryActive) {
      const take = showAll ? filtered.length : Math.min(page, MAX_AUTO_PAGES) * pageSize;
      return filtered.slice(0, take);
    }
    const matchSet = new Set(filtered.map((m) => m.slug));
    const nonMatches = manifest.memes.filter((m) => !matchSet.has(m.slug));
    return [
      ...filtered.slice(0, spotlightCap),
      ...nonMatches.slice(0, Math.max(0, spotlightCap - filtered.length)),
    ];
  }, [manifest, filtered, queryActive, page, pageSize, spotlightCap, showAll]);
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
  }, [query, animatedOnly, favoritesOnly]);

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
  // redistribute on resize. Matches the old CSS breakpoints exactly.
  const [columnCount, setColumnCount] = useState(3);
  useEffect(() => {
    const sm = window.matchMedia('(max-width: 640px)');
    const md = window.matchMedia('(max-width: 1096px)');
    const update = () => setColumnCount(sm.matches ? 1 : md.matches ? 2 : 3);
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
  const columns = useMemo(() => {
    const cols: MemeEntry[][] = Array.from({ length: columnCount }, () => []);
    const heights = new Array<number>(columnCount).fill(0);
    for (const m of visible) {
      const aspect = m.width > 0 && m.height > 0 ? m.height / m.width : 1;
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

  // Top 8 most-reacted memes by total across all reactions. Hidden until
  // the archive has real community votes.
  const popular = useMemo(() => {
    if (!manifest) return [] as MemeEntry[];
    return manifest.memes
      .map((m) => {
        const rs = reactions[m.slug];
        const c = rs ? rs.heart + rs.laugh + rs.bolt + rs.diamond : 0;
        return { m, c };
      })
      .filter(({ c }) => c > 0)
      .sort((a, b) => b.c - a.c)
      .slice(0, 8)
      .map(({ m }) => m);
  }, [manifest, reactions]);

  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(null), 1500);
      return () => clearTimeout(id);
    }
  }, [toast]);

  useEffect(() => {
    if (focused >= 0 && focusedCardRef.current) {
      focusedCardRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
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

  // Carousel scope for modal arrow-key navigation. When a query is active the
  // carousel only steps through matches; otherwise it walks the whole archive
  // in manifest order.
  const carouselList = useMemo(() => {
    if (!manifest) return [] as MemeEntry[];
    return queryActive ? filtered : manifest.memes;
  }, [manifest, filtered, queryActive]);

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
        img.src = memeUrl(neighbour.filename);
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
      if (e.key === 'Enter') { setModalSlug(current.slug); return; }
    },
    [
      modalSlug, modalMeme, showHelp, manifest, filtered, queryActive,
      visible, focused, favorites, stepModal,
      toggleFavorite, copyPermalink, incrementReaction,
    ],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  // Infinite scroll: observe a sentinel near the footer and bump the page as
  // it enters the viewport. Only active when no query is set — spotlight mode
  // already shows a large set, and pagination would feel wrong there.
  // The sentinel stops at MAX_AUTO_PAGES so the footer becomes reachable;
  // users can click "show all" to keep going.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (queryActive || showAll) return;
    const el = sentinelRef.current;
    if (!el || !manifest) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setPage((p) => {
            if (p >= MAX_AUTO_PAGES) return p;
            if (p * pageSize >= filtered.length) return p;
            return p + 1;
          });
        }
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [queryActive, manifest, filtered.length, pageSize, showAll]);


  return (
    <>
      {popular.length > 0 && !queryActive && (
        <section className="popular-strip" aria-label="Most-liked memes">
          <h2 className="popular-heading">⬢ most liked</h2>
          <div className="popular-scroll">
            {popular.map((m) => (
              <button
                key={m.slug}
                type="button"
                className="popular-item"
                onClick={() => setModalSlug(m.slug)}
                aria-label={`Open ${m.title || m.slug}`}
              >
                <img src={memeUrl(m.filename)} alt={m.title || m.slug} loading="lazy" />
                <span className="popular-badge">
                  ⚡ {reactions[m.slug] ? (reactions[m.slug].heart + reactions[m.slug].laugh + reactions[m.slug].bolt + reactions[m.slug].diamond) : 0}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

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
          <span className="hex" aria-hidden="true">♥</span> Favorites · {favorites.size}
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

      {queryActive && manifest && (
        <div className="match-count">
          <strong>{filtered.length}</strong> match{filtered.length === 1 ? '' : 'es'}
          {filtered.length < manifest.memes.length && (
            <> · non-matches dimmed for context</>
          )}
        </div>
      )}

      {visible.length === 0 ? (
        <p style={{ textAlign: 'center', color: 'var(--muted)', padding: '40px 0' }}>
          No memes match. Try a different tag or clear filters.
        </p>
      ) : (
        <div className="gallery" role="list">
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
                    lit={queryActive && matchLookup.has(m.slug)}
                    dim={queryActive && !matchLookup.has(m.slug)}
                    liked={favorites.has(m.slug)}
                    reactionCounts={reactions[m.slug] ?? EMPTY_REACTIONS}
                    innerRef={i === focused ? focusedCardRef : null}
                    onOpenModal={() => setModalSlug(m.slug)}
                    onToggleFavorite={() => {
                      toggleFavorite(m.slug);
                      if (!favorites.has(m.slug)) incrementReaction(m.slug, 'heart');
                    }}
                    onReact={(rx) => incrementReaction(m.slug, rx)}
                    onCopyLink={() => copyPermalink(m.slug)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}

      {!queryActive && visible.length < filtered.length && (
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

      {modalMeme && (
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

          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className={`modal-img-wrap ${modalLoading ? 'loading' : ''}`}>
              <img
                key={modalMeme.slug}
                src={memeUrl(modalMeme.filename)}
                alt={modalMeme.title || modalMeme.slug}
                onLoad={() => setModalLoading(false)}
                decoding="async"
                fetchPriority="high"
              />
            </div>
            <div className="modal-toolbar">
              <div className="modal-position">
                <strong>{modalIndex + 1}</strong> <span style={{ opacity: 0.6 }}>/ {carouselList.length}</span>
                {modalMeme.tags.slice(0, 3).map((t) => (
                  <span key={t} className="modal-tag">#{t}</span>
                ))}
              </div>
              <div style={{ flex: 1 }} />
              <a className="btn ghost" href={permalinkUrl(modalMeme.slug)}>
                open permalink →
              </a>
              <button type="button" className="btn" onClick={() => copyPermalink(modalMeme.slug)}>
                copy link
              </button>
              <button type="button" className="btn ghost" onClick={() => setModalSlug(null)}>
                close
              </button>
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
      )}

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

interface CardProps {
  meme: MemeEntry;
  index: number;
  focused: boolean;
  lit: boolean;
  dim: boolean;
  liked: boolean;
  reactionCounts: ReactionCounts;
  innerRef: React.Ref<HTMLDivElement> | null;
  onOpenModal: () => void;
  onToggleFavorite: () => void;
  onReact: (reaction: Reaction) => void;
  onCopyLink: () => void;
}

function Card({ meme, index, focused, lit, dim, liked, reactionCounts, innerRef, onOpenModal, onToggleFavorite, onReact, onCopyLink }: CardProps) {
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
        <img
          src={memeUrl(meme.filename)}
          alt={meme.title || meme.slug}
          loading="lazy"
          decoding="async"
          width={meme.width || undefined}
          height={meme.height || undefined}
          style={{ viewTransitionName: `meme-${meme.slug}` }}
        />
      </a>
      <button
        type="button"
        className="card-link"
        onClick={(e) => { e.stopPropagation(); onCopyLink(); }}
        aria-label="Copy permalink"
        title="Copy permalink"
      >
        <span className="card-link-icon" aria-hidden="true">🔗</span>
      </button>
      <div className="card-overlay">
        <div className="reaction-row" role="group" aria-label="Reactions">
          {REACTIONS.map((rx) => (
            <button
              key={rx}
              type="button"
              className={`reaction-btn ${rx === 'heart' && liked ? 'liked' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
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
        {totalReactions > 0 && <span className="reaction-total" aria-hidden="true">⚡ {fmtCount(totalReactions)}</span>}
      </div>
    </div>
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
          <dt>r</dt><dd>random meme</dd>
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

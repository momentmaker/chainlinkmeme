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

type Likes = Record<string, number>;

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
  const [focused, setFocused] = useState(-1);
  const [modalSlug, setModalSlug] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [likes, setLikes] = useState<Likes>({});
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
    if (!queryActive) return filtered.slice(0, page * pageSize);
    const matchSet = new Set(filtered.map((m) => m.slug));
    const nonMatches = manifest.memes.filter((m) => !matchSet.has(m.slug));
    return [
      ...filtered.slice(0, spotlightCap),
      ...nonMatches.slice(0, Math.max(0, spotlightCap - filtered.length)),
    ];
  }, [manifest, filtered, queryActive, page, pageSize, spotlightCap]);
  const matchLookup = useMemo(() => new Set(filtered.map((m) => m.slug)), [filtered]);

  useEffect(() => {
    setPage(1);
    setFocused(-1);
  }, [query, animatedOnly, favoritesOnly]);

  useEffect(() => {
    fetch(apiUrl('/api/likes'))
      .then((r) => (r.ok ? (r.json() as Promise<Likes>) : {}))
      .then(setLikes)
      .catch(() => {});
  }, []);

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
  }, [query]);

  // Top 8 most-liked memes, hidden until the archive has real community votes.
  const popular = useMemo(() => {
    if (!manifest) return [] as MemeEntry[];
    return manifest.memes
      .map((m) => ({ m, c: likes[m.slug] ?? 0 }))
      .filter(({ c }) => c > 0)
      .sort((a, b) => b.c - a.c)
      .slice(0, 8)
      .map(({ m }) => m);
  }, [manifest, likes]);

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
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      saveFavorites(next);
      return next;
    });
  }, []);

  const incrementLike = useCallback(async (slug: string) => {
    try {
      const res = await fetch(apiUrl(`/api/likes/${encodeURIComponent(slug)}`), { method: 'POST' });
      if (res.ok) {
        const body = (await res.json()) as { count: number };
        setLikes((prev) => ({ ...prev, [slug]: body.count }));
      }
    } catch {
      /* silent */
    }
  }, []);

  const copyPermalink = useCallback((slug: string) => {
    const url = new URL(permalinkUrl(slug), window.location.origin).toString();
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
          if (!favorites.has(modalMeme.slug)) incrementLike(modalMeme.slug);
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
      if (e.key === 'f') { toggleFavorite(current.slug); incrementLike(current.slug); return; }
      if (e.key === 'c') { copyPermalink(current.slug); return; }
      if (e.key === 'Enter') { setModalSlug(current.slug); return; }
    },
    [
      modalSlug, modalMeme, showHelp, manifest, filtered, queryActive,
      visible, focused, favorites, stepModal,
      toggleFavorite, copyPermalink, incrementLike,
    ],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  // Infinite scroll: observe a sentinel near the footer and bump the page as
  // it enters the viewport. Only active when no query is set — spotlight mode
  // already shows a large set, and pagination would feel wrong there.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (queryActive) return;
    const el = sentinelRef.current;
    if (!el || !manifest) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setPage((p) => (p * pageSize < filtered.length ? p + 1 : p));
        }
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [queryActive, manifest, filtered.length, pageSize]);


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
                <span className="popular-badge">♥ {likes[m.slug]}</span>
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
          onClick={() => setAnimatedOnly((v) => !v)}
        >
          <span className="hex" aria-hidden="true">⬢</span> GIFs
        </button>
        <button
          type="button"
          className={`filter-pill ${favoritesOnly ? 'active' : ''}`}
          onClick={() => setFavoritesOnly((v) => !v)}
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
            setModalSlug(pool[Math.floor(Math.random() * pool.length)].slug);
          }}
          aria-label="Open a random meme"
        >
          <span className="hex" aria-hidden="true">⬡</span> Random
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setShowHelp(true)}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts"
        >?</button>
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
          {visible.map((m, i) => (
            <Card
              key={m.slug}
              meme={m}
              index={i}
              focused={i === focused}
              lit={queryActive && matchLookup.has(m.slug)}
              dim={queryActive && !matchLookup.has(m.slug)}
              liked={favorites.has(m.slug)}
              likeCount={likes[m.slug] ?? 0}
              innerRef={i === focused ? focusedCardRef : null}
              onOpenModal={() => setModalSlug(m.slug)}
              onToggleFavorite={() => {
                toggleFavorite(m.slug);
                if (!favorites.has(m.slug)) incrementLike(m.slug);
              }}
              onCopyLink={() => copyPermalink(m.slug)}
            />
          ))}
        </div>
      )}

      {!queryActive && visible.length < filtered.length && (
        <div ref={sentinelRef} className="load-sentinel" aria-hidden="true">
          <span>⬢ loading more ⬢</span>
        </div>
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
            <img src={memeUrl(modalMeme.filename)} alt={modalMeme.title || modalMeme.slug} />
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
  likeCount: number;
  innerRef: React.Ref<HTMLDivElement> | null;
  onOpenModal: () => void;
  onToggleFavorite: () => void;
  onCopyLink: () => void;
}

function Card({ meme, index, focused, lit, dim, liked, likeCount, innerRef, onOpenModal, onToggleFavorite, onCopyLink }: CardProps) {
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
      <div className="card-overlay">
        <button
          type="button"
          className={`like-btn ${liked ? 'liked' : ''}`}
          onClick={onToggleFavorite}
          aria-label={liked ? 'Unfavorite' : 'Favorite'}
        >
          <span className="heart" aria-hidden="true">♥</span>
          {likeCount > 0 && <span>{likeCount}</span>}
        </button>
        <button type="button" className="tag-btn" onClick={onCopyLink} aria-label="Copy permalink">
          link
        </button>
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
      className="filter-pill"
      onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      aria-label="Toggle theme"
    >
      {mounted ? (theme === 'dark' ? '☀︎' : '☾') : '◐'}
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

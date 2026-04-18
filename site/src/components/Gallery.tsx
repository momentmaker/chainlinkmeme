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
      if (showHelp) {
        if (e.key === 'Escape' || e.key === '?') setShowHelp(false);
        return;
      }
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key === '?') { e.preventDefault(); setShowHelp(true); return; }
      if (e.key === 'Escape') { searchRef.current?.blur(); setFocused(-1); return; }
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
      if (e.key === 'f') { toggleFavorite(current.slug); incrementLike(current.slug); }
      if (e.key === 'c') copyPermalink(current.slug);
      if (e.key === 'Enter') setModalSlug(current.slug);
    },
    [modalSlug, showHelp, visible, focused, toggleFavorite, copyPermalink, incrementLike],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);
  // Intentional: stepModal / copyPermalink / favorites / etc. referenced inside
  // onKey are already deps of the useCallback above; suppressing the eslint
  // noise isn't worth a custom config file for this size of project.

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

  return (
    <>
      <div className="search" role="search">
        <input
          ref={searchRef}
          type="search"
          placeholder="search tags — e.g. sergey, moon, wagmi  (press / to focus)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search memes by tag"
        />
        <button
          type="button"
          className={`filter-pill ${animatedOnly ? 'active' : ''}`}
          onClick={() => setAnimatedOnly((v) => !v)}
        >
          GIFs only
        </button>
        <button
          type="button"
          className={`filter-pill ${favoritesOnly ? 'active' : ''}`}
          onClick={() => setFavoritesOnly((v) => !v)}
          disabled={favorites.size === 0}
        >
          Favorites ({favorites.size})
        </button>
        <button type="button" className="filter-pill" onClick={() => setShowHelp(true)} aria-label="Keyboard shortcuts">
          ?
        </button>
      </div>

      {queryActive && (
        <div className="match-count">
          <strong>{filtered.length}</strong> match{filtered.length === 1 ? '' : 'es'}
          {filtered.length < manifest!.memes.length && (
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
        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <button type="button" className="btn" onClick={() => setPage((p) => p + 1)}>
            𝚖⬡𝚛𝚎 𝚖𝚎𝚖𝚎 ({filtered.length - visible.length} more)
          </button>
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
      style={{ ['--card-i' as string]: Math.min(index, 30) }}
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
          <dt>j</dt><dd>next meme</dd>
          <dt>k</dt><dd>previous meme</dd>
          <dt>Enter</dt><dd>open focused meme</dd>
          <dt>f</dt><dd>favorite focused</dd>
          <dt>c</dt><dd>copy permalink</dd>
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

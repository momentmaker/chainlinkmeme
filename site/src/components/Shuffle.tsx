import { useCallback, useEffect, useRef, useState } from 'react';
import type { Manifest, MemeEntry } from '../lib/manifest';
import { memeUrl, permalinkUrl } from '../lib/meme-url';

interface Props {
  manifestUrl?: string;
}

const HASH_RE = /^[0-9a-f]{10,}$/i;

function displayTitle(m: MemeEntry): string {
  if (m.title && !HASH_RE.test(m.title)) return m.title;
  return m.tags[0] ? `#${m.tags[0]}` : m.slug;
}

function pickRandom(memes: MemeEntry[], avoidSlug?: string): MemeEntry {
  if (memes.length <= 1) return memes[0]!;
  for (let i = 0; i < 6; i++) {
    const candidate = memes[Math.floor(Math.random() * memes.length)]!;
    if (candidate.slug !== avoidSlug) return candidate;
  }
  return memes[Math.floor(Math.random() * memes.length)]!;
}

function track(name: string, data?: Record<string, unknown>): void {
  try {
    const w = window as unknown as { umami?: { track: (n: string, d?: Record<string, unknown>) => void } };
    w.umami?.track(name, data);
  } catch { /* ignore */ }
}

export default function Shuffle({ manifestUrl = '/manifest.json' }: Props) {
  const [open, setOpen] = useState(false);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [history, setHistory] = useState<MemeEntry[]>([]);
  const [cursor, setCursor] = useState(-1);
  const manifestRef = useRef<Manifest | null>(null);
  const loadingRef = useRef(false);
  // Mirror `open`, `history.length`, and `cursor` into refs so the keydown
  // listener can read fresh values without re-binding on every change. Without
  // this, advancing rebinds the window listener per navigation — harmless but
  // wasteful, and obscures the lifecycle.
  const openRef = useRef(false);
  const historyLenRef = useRef(0);
  const cursorRef = useRef(-1);

  useEffect(() => { manifestRef.current = manifest; }, [manifest]);
  useEffect(() => { openRef.current = open; }, [open]);
  useEffect(() => { historyLenRef.current = history.length; }, [history.length]);
  useEffect(() => { cursorRef.current = cursor; }, [cursor]);

  const loadManifest = useCallback(async (): Promise<Manifest | null> => {
    if (manifestRef.current) return manifestRef.current;
    if (loadingRef.current) return null;
    loadingRef.current = true;
    try {
      const r = await fetch(manifestUrl);
      if (!r.ok) throw new Error(`manifest fetch failed: ${r.status}`);
      const m = (await r.json()) as Manifest;
      manifestRef.current = m;
      setManifest(m);
      return m;
    } catch {
      return null;
    } finally {
      loadingRef.current = false;
    }
  }, [manifestUrl]);

  const advance = useCallback(async (): Promise<void> => {
    const m = manifestRef.current ?? (await loadManifest());
    if (!m || m.memes.length === 0) return;
    setHistory((prev) => {
      const last = prev[prev.length - 1];
      const next = pickRandom(m.memes, last?.slug);
      const appended = [...prev, next];
      setCursor(appended.length - 1);
      track('shuffle-advance', { slug: next.slug, depth: appended.length });
      return appended;
    });
  }, [loadManifest]);

  const stepBack = useCallback((): void => {
    setCursor((c) => Math.max(0, c - 1));
  }, []);
  const stepForward = useCallback((): void => {
    setCursor((c) => (c < historyLenRef.current - 1 ? c + 1 : c));
  }, []);

  const openShuffle = useCallback(async (): Promise<void> => {
    const firstOpen = historyLenRef.current === 0;
    setOpen(true);
    if (firstOpen) {
      track('shuffle-open');
      await advance();
    }
  }, [advance]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // When focus sits on a button or link (e.g. the overlay's close button
      // after aria-modal focus transfer), the native element already handles
      // Space/Enter as activation. Intercepting them here causes a double-
      // fire: advance() + button-click would both run. Only Escape needs our
      // override in that case.
      const onInteractive = e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement;
      if (onInteractive && e.key !== 'Escape') return;
      if (!openRef.current) {
        if (e.key === 's' || e.key === 'S') {
          e.preventDefault();
          void openShuffle();
        }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
      if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'l' || e.key === 'j' || e.key === 's' || e.key === 'S') {
        e.preventDefault();
        if (cursorRef.current < historyLenRef.current - 1) stepForward();
        else void advance();
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'h' || e.key === 'k') {
        e.preventDefault();
        stepBack();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openShuffle, advance, stepBack, stepForward]);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    // ClientRouter view transitions don't unmount the Shuffle island (it
    // lives in the shared layout), so the cleanup below wouldn't fire if
    // the user clicked the in-overlay permalink link. Close proactively on
    // navigation so the new page doesn't inherit a locked scroll.
    const onNavigate = (): void => setOpen(false);
    document.addEventListener('astro:before-preparation', onNavigate);
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('astro:before-preparation', onNavigate);
    };
  }, [open]);

  const current = cursor >= 0 ? history[cursor] : null;
  const nextMeme = history[cursor + 1];
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  // On open, pull focus into the overlay so AT announces it and keyboard
  // users have a real exit (Tab/Enter on the close button). Without this
  // focus stays on whatever triggered the shortcut and screen readers
  // read behind the overlay.
  useEffect(() => {
    if (open) closeButtonRef.current?.focus();
  }, [open]);

  if (!open) return null;
  return (
    <div className="shuffle-overlay" role="dialog" aria-modal="true" aria-label="Shuffle mode">
      <button
        ref={closeButtonRef}
        type="button"
        className="shuffle-close"
        onClick={() => setOpen(false)}
        aria-label="Exit shuffle"
        title="Esc to exit"
      >
        ×
      </button>
      {current ? (
        <div className="shuffle-stage" onClick={() => { if (cursor < history.length - 1) stepForward(); else void advance(); }}>
          <img
            key={current.slug}
            src={memeUrl(current.filename)}
            alt={displayTitle(current)}
            className="shuffle-image"
          />
          <div className="shuffle-meta">
            <a
              href={permalinkUrl(current.slug)}
              className="shuffle-title"
              onClick={(e) => e.stopPropagation()}
            >
              {displayTitle(current)} →
            </a>
            <p className="shuffle-hint">space / → next · ← previous · esc exit</p>
          </div>
          {nextMeme && <img src={memeUrl(nextMeme.filename)} alt="" aria-hidden="true" className="shuffle-preload" />}
        </div>
      ) : (
        <p className="shuffle-loading">loading…</p>
      )}
    </div>
  );
}

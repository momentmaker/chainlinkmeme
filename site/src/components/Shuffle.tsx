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

export default function Shuffle({ manifestUrl = '/manifest.json' }: Props) {
  const [open, setOpen] = useState(false);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [history, setHistory] = useState<MemeEntry[]>([]);
  const [cursor, setCursor] = useState(-1);
  const manifestRef = useRef<Manifest | null>(null);
  const loadingRef = useRef(false);

  useEffect(() => { manifestRef.current = manifest; }, [manifest]);

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
      return appended;
    });
  }, [loadManifest]);

  const stepBack = useCallback((): void => {
    setCursor((c) => Math.max(0, c - 1));
  }, []);
  const stepForward = useCallback((): void => {
    setCursor((c) => {
      if (c < history.length - 1) return c + 1;
      return c;
    });
  }, [history.length]);

  const openShuffle = useCallback(async (): Promise<void> => {
    setOpen(true);
    if (history.length === 0) await advance();
  }, [advance, history.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!open) {
        if (e.key === 's' || e.key === 'S') {
          e.preventDefault();
          void openShuffle();
        }
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
      if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'l' || e.key === 'j' || e.key === 's' || e.key === 'S') {
        e.preventDefault();
        if (cursor < history.length - 1) stepForward();
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
  }, [open, cursor, history.length, openShuffle, advance, stepBack, stepForward]);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  const current = cursor >= 0 ? history[cursor] : null;
  const nextMeme = history[cursor + 1];

  if (!open) return null;
  return (
    <div className="shuffle-overlay" role="dialog" aria-label="Shuffle mode">
      <button
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

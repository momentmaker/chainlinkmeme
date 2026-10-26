import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Manifest, MemeEntry } from '../lib/manifest';
import type { AtlasMeta } from '../lib/atlas-format';
import { apiUrl, fullUrl, memeUrl, permalinkUrl } from '../lib/meme-url';
import { filterMemes } from '../lib/search';
import { VerseEngine, type HoverInfo, type VerseMeme } from '../verse/engine';
import type { StarSystem } from '../verse/layout';
import { loadAtlasMeta } from '../verse/assets';
import Assemble from './Assemble';

interface Props {
  manifestUrl: string;
  atlasBase: string;
  base: string;
}

const HASH_RE = /^[0-9a-f]{10,}$/i;
function displayTitle(m: { title: string; tags: string[]; slug: string }): string {
  if (m.title && !HASH_RE.test(m.title)) return m.title;
  return m.tags[0] ? `#${m.tags[0]}` : m.slug;
}

const REACTIONS = [
  ['heart', '❤️'],
  ['laugh', '😂'],
  ['bolt', '⚡️'],
  ['diamond', '💎'],
] as const;
type ReactionCounts = Record<(typeof REACTIONS)[number][0], number>;

function hiResUrl(m: VerseMeme): string {
  if (import.meta.env.DEV) return memeUrl(m.filename);
  const p = new URLSearchParams({
    url: memeUrl(m.filename), w: '256', h: '256', fit: 'cover', a: 'attention', output: 'webp', q: '80',
  });
  return `https://wsrv.nl/?${p.toString()}`;
}

function readHash(): Record<string, string> {
  const out: Record<string, string> = {};
  const h = location.hash.replace(/^#/, '');
  if (!h) return out;
  for (const part of h.split('&')) {
    const [k, v = ''] = part.split('=');
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}

function writeHash(entries: Record<string, string | null>): void {
  const cur = readHash();
  for (const [k, v] of Object.entries(entries)) {
    if (v === null) delete cur[k]; else cur[k] = v;
  }
  const s = Object.entries(cur).map(([k, v]) => (v ? `${k}=${encodeURIComponent(v)}` : k)).join('&');
  history.replaceState(history.state, '', s ? `#${s}` : location.pathname + location.search);
}

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function Verse({ manifestUrl, atlasBase, base }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelsRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<VerseEngine | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'nogl'>('loading');
  const [loadingMsg, setLoadingMsg] = useState('charting the memeverse…');
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [atlas, setAtlas] = useState<AtlasMeta | null>(null);
  const [memes, setMemes] = useState<VerseMeme[]>([]);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [tour, setTour] = useState<StarSystem | null>(null);
  const [intro, setIntro] = useState(true);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<{ label: string; count: number } | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIdx, setSuggestIdx] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [assembleOpen, setAssembleOpen] = useState(false);
  const [assembleFrom, setAssembleFrom] = useState<number | null>(null);
  const [mosaicLive, setMosaicLive] = useState(false);
  const [callsign, setCallsign] = useState<{ tags: string[]; active: number; name: string } | null>(null);
  const [reactions, setReactions] = useState<Record<string, ReactionCounts> | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [copied, setCopied] = useState(false);
  const [touched, setTouched] = useState(false);
  const hoverRef = useRef<HoverInfo | null>(null);

  // ── data ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mres = await fetch(manifestUrl);
        if (!mres.ok) throw new Error(`manifest ${mres.status}`);
        const m = (await mres.json()) as Manifest;
        if (cancelled) return;
        setLoadingMsg(`mapping ${m.memes.length.toLocaleString()} memes…`);
        const a = await loadAtlasMeta(atlasBase, m.generated_at ?? 'dev');
        if (cancelled) return;
        const bySlug = new Map(m.memes.map((x) => [x.slug, x]));
        const list: VerseMeme[] = a.slugs.map((slug) => {
          const e = bySlug.get(slug);
          return e
            ? { slug, filename: e.filename, title: e.title, tags: e.tags, animated: e.animated }
            : { slug, filename: `${slug}.jpg`, title: '', tags: [], animated: false };
        });
        setManifest(m);
        setAtlas(a);
        setMemes(list);
      } catch (err) {
        console.error('[memeverse]', err);
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [manifestUrl, atlasBase]);

  useEffect(() => {
    const mq = matchMedia('(max-width: 720px)');
    const apply = () => setNarrow(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  const indexBySlug = useMemo(() => new Map(memes.map((m, i) => [m.slug, i])), [memes]);
  const entryOrder = useMemo<MemeEntry[]>(() => {
    if (!manifest) return [];
    const bySlug = new Map(manifest.memes.map((x) => [x.slug, x]));
    return memes.map((m) => bySlug.get(m.slug)).filter((x): x is MemeEntry => !!x);
  }, [manifest, memes]);

  // ── engine ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!atlas || !memes.length || !canvasRef.current || !labelsRef.current) return;
    let engine: VerseEngine;
    try {
      engine = new VerseEngine(canvasRef.current, labelsRef.current, memes, atlas, {
        onHover: (h) => {
          const prev = hoverRef.current;
          if (!h && !prev) return;
          if (h && prev && h.index === prev.index && Math.abs(h.x - prev.x) < 1 && Math.abs(h.y - prev.y) < 1) return;
          hoverRef.current = h;
          setHover(h);
        },
        onFocus: (i) => {
          setFocus(i);
          if (i !== null) setTouched(true);
          writeHash({ m: i === null ? null : memes[i]!.slug });
        },
        onTour: (s) => setTour(s),
        onIntroDone: () => {
          setIntro(false);
          runDeepLink();
        },
        onLabelClick: (tag) => {
          applyQueryRef.current(tag, false);
          const sys = engineRef.current?.systemByTag(tag);
          if (sys) engineRef.current?.focusSystem(sys);
        },
        onAssembled: () => setMosaicLive(true),
        onDisassembled: () => setMosaicLive(false),
        onContextLost: () => setStatus('error'),
      }, {
        reducedMotion: reducedMotion(),
        atlasBase,
        atlasVersion: atlas.generated_at,
        hiResUrl,
      });
    } catch (err) {
      console.error('[memeverse]', err);
      setStatus('nogl');
      return;
    }
    engineRef.current = engine;
    setStatus('ready');
    engine.start();
    // Someone followed a link to something specific: give the galaxy a
    // moment to appear, then go straight there instead of finishing the swoop.
    const h = readHash();
    const deepLinked = ['m', 'tag', 'callsign', 'tags', 'tour', 'assemble'].some((k) => k in h);
    const cut = deepLinked ? window.setTimeout(() => engine.endIntro(), 1700) : 0;
    return () => {
      clearTimeout(cut);
      engine.dispose();
      engineRef.current = null;
    };
    // runDeepLink and applyQueryRef are stable; the engine is only rebuilt
    // when the data it was built from changes.
  }, [atlas, memes]);

  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    if (focus === null) e.setInset(0, 0);
    else if (narrow) e.setInset(0, Math.min(window.innerHeight * 0.52, 460));
    else e.setInset(420, 0);
  }, [focus, narrow]);

  // ── search / filter ───────────────────────────────────────────────────
  const tagCounts = useMemo(() => {
    const c = new Map<string, number>();
    for (const m of memes) for (const t of m.tags) c.set(t, (c.get(t) ?? 0) + 1);
    return c;
  }, [memes]);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, '');
    if (!q || !manifest) return [] as { tag: string; count: number; via?: string }[];
    const out: { tag: string; count: number; via?: string }[] = [];
    const seen = new Set<string>();
    for (const [tag, count] of [...tagCounts.entries()].sort((a, b) => b[1] - a[1])) {
      if (tag.startsWith(q)) { out.push({ tag, count }); seen.add(tag); }
    }
    for (const [alias, tags] of Object.entries(manifest.synonyms)) {
      if (!alias.startsWith(q)) continue;
      for (const t of tags) {
        if (seen.has(t)) continue;
        seen.add(t);
        out.push({ tag: t, count: tagCounts.get(t) ?? 0, via: alias });
      }
    }
    for (const [tag, count] of tagCounts) {
      if (!seen.has(tag) && tag.includes(q)) { out.push({ tag, count }); seen.add(tag); }
    }
    return out.slice(0, 8);
  }, [query, manifest, tagCounts]);

  const applyQuery = useCallback((q: string, fly = true) => {
    const e = engineRef.current;
    if (!e || !manifest) return;
    const clean = q.trim().replace(/^#/, '');
    if (!clean) {
      e.setFilter(null);
      setFilter(null);
      writeHash({ tag: null });
      return;
    }
    const hits = filterMemes(entryOrder, manifest, { query: clean, animatedOnly: false, favoritesOnly: false, favorites: new Set() });
    const set = new Set<number>();
    for (const h of hits) {
      const i = indexBySlug.get(h.slug);
      if (i !== undefined) set.add(i);
    }
    e.setFilter(set, fly);
    setFilter({ label: clean, count: set.size });
    setQuery(clean);
    setSuggestOpen(false);
    writeHash({ tag: clean });
    setTouched(true);
  }, [manifest, entryOrder, indexBySlug]);

  const applyQueryRef = useRef(applyQuery);
  applyQueryRef.current = applyQuery;

  const clearFilter = useCallback(() => {
    engineRef.current?.setFilter(null);
    setFilter(null);
    setQuery('');
    writeHash({ tag: null });
  }, []);

  // ── deep links ────────────────────────────────────────────────────────
  // #m=<slug> focuses a meme · #tag=<q> filters · #callsign=a-b-c (or
  // #tags=a,b,c) flies a LinkMarine through their three dog-tag tags ·
  // #tour starts the autopilot · #assemble opens assemble.
  const deepLinkRef = useRef<() => void>(() => {});
  const runDeepLink = useCallback(() => deepLinkRef.current(), []);
  deepLinkRef.current = () => {
    const e = engineRef.current;
    if (!e) return;
    const h = readHash();
    if (h.callsign || h.tags) {
      const tags = (h.callsign ? h.callsign.split('-') : h.tags!.split(','))
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 5);
      if (tags.length) { playCallsign(tags, h.callsign ?? tags.join('-')); return; }
    }
    if (h.m) {
      const i = indexBySlug.get(h.m);
      if (i !== undefined) { e.focusMeme(i, { warp: true }); return; }
    }
    if (h.tag) { applyQuery(h.tag); return; }
    if ('tour' in h) { e.startTour(); return; }
    if ('assemble' in h) setAssembleOpen(true);
  };

  const callsignTimer = useRef<number[]>([]);
  const playCallsign = useCallback((tags: string[], name: string) => {
    const e = engineRef.current;
    if (!e) return;
    callsignTimer.current.forEach((t) => clearTimeout(t));
    callsignTimer.current = [];
    setCallsign({ tags, active: 0, name });
    const step = reducedMotion() ? 2500 : 5200;
    tags.forEach((tag, k) => {
      callsignTimer.current.push(window.setTimeout(() => {
        setCallsign((c) => (c ? { ...c, active: k } : c));
        applyQuery(tag);
      }, k * step));
    });
    callsignTimer.current.push(window.setTimeout(() => {
      setCallsign((c) => (c ? { ...c, active: -1 } : c));
      applyQuery(tags.join(' '));
    }, tags.length * step));
  }, [applyQuery]);

  useEffect(() => () => callsignTimer.current.forEach((t) => clearTimeout(t)), []);

  // A new hash typed or linked while the page is open (our own
  // replaceState calls don't fire this).
  useEffect(() => {
    const onHash = () => runDeepLink();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [runDeepLink]);

  // ── focus helpers ─────────────────────────────────────────────────────
  const focusMeme = focus !== null ? memes[focus] : null;
  const focusSystem = useMemo(() => {
    const e = engineRef.current;
    if (focus === null || !e) return null;
    const si = e.layout.memeSystem[focus]!;
    return si >= 0 ? e.layout.systems[si]! : null;
  }, [focus]);

  const step = useCallback((dir: 1 | -1) => {
    const e = engineRef.current;
    if (!e || focus === null) return;
    const si = e.layout.memeSystem[focus]!;
    const pool = si >= 0
      ? e.layout.systems[si]!.members
      : [...e.layout.memeSystem.keys()].filter((i) => e.layout.memeSystem[i] === -1);
    const k = pool.indexOf(focus);
    const next = pool[(k + dir + pool.length) % pool.length]!;
    e.focusMeme(next);
  }, [focus]);

  useEffect(() => {
    if (focus === null || reactions) return;
    let cancelled = false;
    fetch(apiUrl('/api/reactions'))
      .then((r) => (r.ok ? r.json() : {}))
      .then((m) => { if (!cancelled) setReactions(m as Record<string, ReactionCounts>); })
      .catch(() => { if (!cancelled) setReactions({}); });
    return () => { cancelled = true; };
  }, [focus, reactions]);

  // ── keyboard ──────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const e = engineRef.current;
      if (!e) return;
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        if (ev.key === 'Escape') (t as HTMLInputElement).blur();
        return;
      }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (assembleOpen) return;
      if (e.isTouring && ev.key !== 't') e.stopTour();
      setTouched(true);
      switch (ev.key) {
        case '/': ev.preventDefault(); searchRef.current?.focus(); break;
        case 'r': e.warpRandom(e.filterSet ? [...e.filterSet] : undefined); break;
        case 't': if (e.isTouring) e.stopTour(); else e.startTour(); break;
        case 'a': openAssemble(null); break;
        case 'h': e.flyHome(); break;
        case 'f': toggleFullscreen(); break;
        case '?': setHelpOpen((v) => !v); break;
        case 'ArrowRight': if (focus !== null) step(1); break;
        case 'ArrowLeft': if (focus !== null) step(-1); break;
        case 'Escape':
          if (helpOpen) setHelpOpen(false);
          else if (focus !== null) e.clearFocus();
          else if (mosaicLive) e.disassemble();
          else if (filter) clearFilter();
          break;
        default: return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focus, filter, helpOpen, mosaicLive, assembleOpen, step, clearFilter]);

  const openAssemble = (from: number | null) => {
    engineRef.current?.stopTour();
    setAssembleFrom(from);
    setAssembleOpen(true);
  };

  const toggleFullscreen = () => {
    const root = document.documentElement;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.requestFullscreen?.();
  };

  const copyLink = async (slug: string) => {
    const url = `${location.origin}${base}/verse/#m=${encodeURIComponent(slug)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked */ }
  };

  // ── render ────────────────────────────────────────────────────────────
  const stats = atlas && engineRef.current
    ? { memes: atlas.count, systems: engineRef.current.layout.systems.length, tags: tagCounts.size }
    : atlas ? { memes: atlas.count, systems: 0, tags: tagCounts.size } : null;
  const hoverMeme = hover ? memes[hover.index] : null;
  const rs = focusMeme && reactions ? reactions[focusMeme.slug] : undefined;

  return (
    <div className={`verse-root ${focus !== null ? 'has-focus' : ''} ${mosaicLive ? 'has-mosaic' : ''}`}>
      <canvas ref={canvasRef} className="verse-canvas" aria-label="The memeverse: every chainlink meme as a star in a 3D galaxy" />
      <div ref={labelsRef} className="verse-labels" />

      {status === 'loading' && (
        <div className="verse-loading">
          <div className="verse-spinner" aria-hidden="true">⬢</div>
          <p>{loadingMsg}</p>
        </div>
      )}
      {status === 'error' && (
        <div className="verse-fallback">
          <p className="verse-eyebrow">⬢ signal lost</p>
          <h2>the memeverse couldn't load</h2>
          <p>Try a reload — or browse the archive the classic way.</p>
          <p className="verse-fallback-links"><a href={`${base}/`}>gallery</a> · <a href={`${base}/grid/`}>honeycomb</a> · <a href={`${base}/map/`}>tag map</a></p>
        </div>
      )}
      {status === 'nogl' && (
        <div className="verse-fallback">
          <p className="verse-eyebrow">⬢ no warp drive</p>
          <h2>this browser can't render the memeverse</h2>
          <p>It needs WebGL 2. Every meme is still one click away in the classic views.</p>
          <p className="verse-fallback-links"><a href={`${base}/`}>gallery</a> · <a href={`${base}/grid/`}>honeycomb</a> · <a href={`${base}/map/`}>tag map</a></p>
        </div>
      )}

      <header className="verse-top">
        <a className="verse-brand" href={`${base}/`} title="back to the gallery">
          <span className="verse-brand-mark">⬡⏣⬢</span>
          <span className="verse-brand-text">chainlink meme</span>
        </a>
        <div className="verse-title">
          <span className="verse-title-main">the memeverse</span>
          {stats && <span className="verse-title-sub">{stats.memes.toLocaleString()} memes · {stats.systems || '…'} star systems</span>}
        </div>
        <div className="verse-actions">
          <button type="button" className="verse-btn" onClick={() => { setTouched(true); const e = engineRef.current; e?.warpRandom(e.filterSet ? [...e.filterSet] : undefined); }} title="warp to a random meme (r)" disabled={status !== 'ready' || mosaicLive}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></svg>
            <span>warp</span>
          </button>
          <button type="button" className={`verse-btn ${tour ? 'on' : ''}`} onClick={() => { const e = engineRef.current; if (!e) return; setTouched(true); if (e.isTouring) e.stopTour(); else e.startTour(); }} title="autopilot tour (t)" disabled={status !== 'ready' || mosaicLive}>
            <svg viewBox="0 0 24 24" aria-hidden="true">{tour ? <path d="M7 5h4v14H7zM13 5h4v14h-4z" /> : <path d="M7 4.5v15l12-7.5-12-7.5Z" />}</svg>
            <span>{tour ? 'stop' : 'tour'}</span>
          </button>
          <button type="button" className="verse-btn verse-btn-hot" onClick={() => openAssemble(null)} title="assemble a picture out of memes (a)" disabled={status !== 'ready'}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 20.2 7.25v9.5L12 21.5l-8.2-4.75v-9.5L12 2.5Z" /><path d="M12 8.2 15.3 10.1v3.8L12 15.8l-3.3-1.9v-3.8L12 8.2Z" /></svg>
            <span>assemble</span>
          </button>
          <button type="button" className="verse-btn icon" onClick={() => engineRef.current?.flyHome()} title="back to the overview (h)" disabled={status !== 'ready' || mosaicLive}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
          </button>
          <button type="button" className="verse-btn icon" onClick={toggleFullscreen} title="fullscreen (f)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
          </button>
          <button type="button" className="verse-btn icon" onClick={() => setHelpOpen((v) => !v)} title="controls (?)">
            <span className="verse-q">?</span>
          </button>
        </div>
      </header>

      {!mosaicLive && (
        <div className="verse-search">
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              const pick = suggestOpen && suggestions[suggestIdx] ? suggestions[suggestIdx]!.tag : query;
              applyQuery(pick);
              searchRef.current?.blur();
            }}
          >
            <span className="verse-search-hex" aria-hidden="true">⬡</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(ev) => { setQuery(ev.target.value); setSuggestOpen(true); setSuggestIdx(0); }}
              onFocus={() => setSuggestOpen(true)}
              onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
              onKeyDown={(ev) => {
                if (ev.key === 'ArrowDown') { ev.preventDefault(); setSuggestIdx((i) => Math.min(i + 1, suggestions.length - 1)); }
                if (ev.key === 'ArrowUp') { ev.preventDefault(); setSuggestIdx((i) => Math.max(i - 1, 0)); }
              }}
              placeholder="light up a tag — sergey, moon, wagmi…"
              aria-label="Search tags"
              spellCheck={false}
              autoComplete="off"
            />
            {filter && (
              <button type="button" className="verse-chip-x" onClick={clearFilter} aria-label="clear filter">✕</button>
            )}
          </form>
          {filter && !suggestOpen && (
            <p className="verse-filter-note">{filter.count ? <><strong>{filter.count}</strong> memes lit for <strong>#{filter.label}</strong></> : <>nothing in the archive for <strong>{filter.label}</strong> yet</>}</p>
          )}
          {suggestOpen && suggestions.length > 0 && (
            <ul className="verse-suggest" role="listbox">
              {suggestions.map((s, k) => (
                <li key={s.tag}>
                  <button
                    type="button"
                    className={k === suggestIdx ? 'active' : ''}
                    onMouseDown={(ev) => { ev.preventDefault(); applyQuery(s.tag); searchRef.current?.blur(); }}
                  >
                    <span>#{s.tag}{s.via && <em> · {s.via}</em>}</span>
                    <span className="n">{s.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {intro && status === 'ready' && (
        <div className="verse-intro" aria-hidden="true">
          <p className="verse-intro-eyebrow">⬡⏣⬢ chainlinkme.me presents</p>
          <h1>THE MEMEVERSE</h1>
          <p className="verse-intro-sub">every chainlink meme ever archived, in one galaxy</p>
        </div>
      )}

      {!touched && !intro && status === 'ready' && !tour && !callsign && (
        <p className="verse-hint">
          {narrow ? 'drag to orbit · pinch to zoom · tap any meme' : 'drag to orbit · scroll to zoom · right-drag to pan · click any meme'}
        </p>
      )}

      {hoverMeme && hover && !narrow && focus !== hover.index && (
        <div className="verse-tip" style={{ transform: `translate(${Math.round(hover.x)}px, ${Math.round(hover.y)}px) translate(-50%, -100%)` }}>
          <strong>{displayTitle(hoverMeme)}</strong>
          <span>{hoverMeme.tags.slice(0, 4).map((t) => `#${t}`).join(' ')}</span>
        </div>
      )}

      {tour && (
        <div className="verse-tour">
          <p className="verse-tour-eyebrow">{tour.arm === -1 ? 'the galactic core' : 'autopilot'}</p>
          <p className="verse-tour-name">#{tour.tag}</p>
          <p className="verse-tour-sub">{tour.members.length} memes in this system · {tour.tagTotal} carry the tag</p>
        </div>
      )}

      {callsign && (
        <div className="verse-dogtag" role="status">
          <div className="verse-dogtag-plate">
            <span className="verse-dogtag-eyebrow">linkmarine callsign</span>
            <strong>{callsign.name}</strong>
            <span className="verse-dogtag-tags">
              {callsign.tags.map((t, k) => (
                <button key={t} type="button" className={callsign.active === k || callsign.active === -1 ? 'lit' : ''} onClick={() => applyQuery(t)}>#{t}</button>
              ))}
            </span>
          </div>
          <button type="button" className="verse-dogtag-x" onClick={() => { callsignTimer.current.forEach((t) => clearTimeout(t)); setCallsign(null); }} aria-label="dismiss">✕</button>
        </div>
      )}

      {focusMeme && focus !== null && (
        <aside className="verse-panel" aria-label="meme details">
          <button type="button" className="verse-panel-x" onClick={() => engineRef.current?.clearFocus()} aria-label="close">✕</button>
          <a className="verse-panel-img" href={permalinkUrl(focusMeme.slug)}>
            <img
              key={focusMeme.slug}
              src={fullUrl(focusMeme.filename, { animated: focusMeme.animated })}
              alt={displayTitle(focusMeme)}
              onError={(ev) => { const img = ev.currentTarget; if (!img.dataset.fallback) { img.dataset.fallback = '1'; img.src = memeUrl(focusMeme.filename); } }}
            />
          </a>
          <div className="verse-panel-body">
            {focusSystem && <p className="verse-eyebrow">{focusSystem.arm === -1 ? 'galactic core' : 'star system'} · #{focusSystem.tag}</p>}
            {!focusSystem && <p className="verse-eyebrow">the outer rim</p>}
            <h2>{displayTitle(focusMeme)}</h2>
            <div className="verse-tags">
              {focusMeme.tags.map((t) => (
                <button key={t} type="button" onClick={() => applyQuery(t)}>#{t}</button>
              ))}
            </div>
            {rs && (rs.heart + rs.laugh + rs.bolt + rs.diamond > 0) && (
              <p className="verse-reacts">
                {REACTIONS.filter(([k]) => rs[k] > 0).map(([k, icon]) => <span key={k}>{icon} {rs[k]}</span>)}
              </p>
            )}
            <div className="verse-panel-actions">
              <a className="verse-pill primary" href={permalinkUrl(focusMeme.slug)}>open meme ↗</a>
              <button type="button" className="verse-pill" onClick={() => openAssemble(focus)}>⬢ assemble from it</button>
              <button type="button" className="verse-pill" onClick={() => copyLink(focusMeme.slug)}>{copied ? 'copied ✓' : 'copy link'}</button>
            </div>
            <div className="verse-panel-nav">
              <button type="button" onClick={() => step(-1)} aria-label="previous in system">‹ prev</button>
              <span>{focusSystem ? `${focusSystem.members.indexOf(focus) + 1} / ${focusSystem.members.length}` : 'rim'}</span>
              <button type="button" onClick={() => step(1)} aria-label="next in system">next ›</button>
            </div>
          </div>
        </aside>
      )}

      {helpOpen && (
        <div className="verse-help" role="dialog" aria-label="controls" onClick={() => setHelpOpen(false)}>
          <div className="verse-help-card" onClick={(e) => e.stopPropagation()}>
            <p className="verse-eyebrow">⬢ flight manual</p>
            <h2>the memeverse</h2>
            <p>Every meme in the archive is a hex in this galaxy. Each tag with a dozen or more memes forms a star system; a meme lives in the system of its rarest tag. Sergey holds the core. Memes with no system drift on the outer rim.</p>
            <dl>
              <dt>drag</dt><dd>orbit</dd>
              <dt>right-drag · shift-drag</dt><dd>pan</dd>
              <dt>scroll · pinch</dt><dd>zoom</dd>
              <dt>click</dt><dd>fly to a meme</dd>
              <dt>/</dt><dd>light up a tag</dd>
              <dt>r</dt><dd>warp to a random meme</dd>
              <dt>t</dt><dd>autopilot tour</dd>
              <dt>a</dt><dd>assemble a picture out of memes</dd>
              <dt>← →</dt><dd>step through a system</dd>
              <dt>h</dt><dd>back to the overview</dd>
              <dt>f</dt><dd>fullscreen</dd>
              <dt>esc</dt><dd>back out</dd>
            </dl>
            <p className="verse-help-foot">Link a meme: <code>/verse/#m=slug</code> · a tag: <code>#tag=pepe</code> · a LinkMarine's dog tags: <code>#callsign=rory-clippy-fud</code> · screensaver: <code>#tour</code></p>
          </div>
        </div>
      )}

      {atlas && (
        <Assemble
          open={assembleOpen}
          onClose={() => setAssembleOpen(false)}
          engine={engineRef.current}
          memes={memes}
          atlas={atlas}
          atlasBase={atlasBase}
          fromMeme={assembleFrom}
          mosaicLive={mosaicLive}
          base={base}
        />
      )}
    </div>
  );
}


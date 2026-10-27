import { useCallback, useEffect, useRef, useState } from 'react';
import type { AtlasMeta } from '../lib/atlas-format';
import { SQRT3 } from '../lib/atlas-format';
import { VerseEngine, type Mode, type VerseMeme } from '../verse/engine';
import { chainlinkMark, imageFromFile, imageFromMeme, loadFeatures, sourceSize } from '../verse/assets';
import {
  buildResult,
  describeSource,
  loadSheets,
  matchMosaic,
  rasterize,
  type MosaicResult,
  type MosaicShape,
  type Sheet,
} from '../verse/mosaic';
import { hexToRgb } from '../verse/renderer';

interface Props {
  open: boolean;
  onClose: () => void;
  engine: VerseEngine | null;
  memes: VerseMeme[];
  atlas: AtlasMeta;
  atlasBase: string;
  fromMeme: number | null;
  mode: Mode;
  base: string;
}

const DETAIL = [
  { cols: 40, label: 'bold' },
  { cols: 60, label: 'classic' },
  { cols: 84, label: 'fine' },
] as const;

const PREVIEW = 300;

type Source = { img: CanvasImageSource; label: string };

let sheetsPromise: Promise<Sheet[]> | null = null;

export default function Assemble({ open, onClose, engine, memes, atlas, atlasBase, fromMeme, mode, base }: Props) {
  const mosaicLive = mode === 'mosaic';
  const [source, setSource] = useState<Source | null>(null);
  const [crop, setCrop] = useState({ cx: 0.5, cy: 0.5, zoom: 1 });
  const [cols, setCols] = useState<number>(60);
  const [shape, setShape] = useState<MosaicShape>('hex');
  const [tint, setTint] = useState(0.7);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MosaicResult | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const selfieRef = useRef<HTMLInputElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const colors = useRef<[number, number, number][]>([]);
  colors.current = colors.current.length === atlas.colors.length ? colors.current : atlas.colors.map(hexToRgb);

  const sheetUrls = () => Array.from({ length: atlas.pages }, (_, p) => `${atlasBase}/tiles-${p}.webp?v=${atlas.generated_at}`);

  // Opening from a meme's panel: that meme is the picture.
  useEffect(() => {
    if (!open || fromMeme === null) return;
    const m = memes[fromMeme];
    if (!m) return;
    setError(null);
    setBusy('fetching the meme…');
    imageFromMeme(m)
      .then((img) => { setSource({ img, label: `#${m.tags[0] ?? m.slug}` }); setCrop({ cx: 0.5, cy: 0.5, zoom: 1 }); })
      .catch(() => setError('could not load that meme'))
      .finally(() => setBusy(null));
  }, [open, fromMeme, memes]);

  const takeFile = useCallback(async (file: File | undefined | null) => {
    if (!file || !file.type.startsWith('image/')) return;
    setError(null);
    setBusy('reading your picture…');
    try {
      const img = await imageFromFile(file);
      setSource({ img, label: 'your picture' });
      setCrop({ cx: 0.5, cy: 0.45, zoom: 1 });
    } catch {
      setError("couldn't read that image — try a jpg or png");
    } finally {
      setBusy(null);
    }
  }, []);

  // Paste an image straight in.
  useEffect(() => {
    if (!open) return;
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      if (item) void takeFile(item.getAsFile());
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [open, takeFile]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const cropRect = useCallback((src: CanvasImageSource, c = crop) => {
    const { w, h } = sourceSize(src);
    const size = Math.min(w, h) / c.zoom;
    const x = Math.max(0, Math.min(w - size, c.cx * w - size / 2));
    const y = Math.max(0, Math.min(h - size, c.cy * h - size / 2));
    return { x, y, size };
  }, [crop]);

  // Crop preview with the honeycomb drawn over it.
  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas || !source) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = PREVIEW * dpr;
    canvas.height = PREVIEW * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = cropRect(source.img);
    ctx.clearRect(0, 0, PREVIEW, PREVIEW);
    ctx.drawImage(source.img, r.x, r.y, r.size, r.size, 0, 0, PREVIEW, PREVIEW);
    const w = PREVIEW / cols;
    const hr = w / SQRT3;
    const hexPath = (cx: number, cy: number, rr: number) => {
      ctx.moveTo(cx, cy - rr);
      ctx.lineTo(cx + (rr * SQRT3) / 2, cy - rr / 2);
      ctx.lineTo(cx + (rr * SQRT3) / 2, cy + rr / 2);
      ctx.lineTo(cx, cy + rr);
      ctx.lineTo(cx - (rr * SQRT3) / 2, cy + rr / 2);
      ctx.lineTo(cx - (rr * SQRT3) / 2, cy - rr / 2);
      ctx.closePath();
    };
    if (shape === 'hex') {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, PREVIEW, PREVIEW);
      hexPath(PREVIEW / 2, PREVIEW / 2, PREVIEW / 2);
      ctx.fillStyle = 'rgba(5, 8, 18, 0.72)';
      ctx.fill('evenodd');
      ctx.restore();
    }
    ctx.beginPath();
    const rows = Math.ceil(PREVIEW / (1.5 * hr)) + 1;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col <= cols; col++) {
        hexPath(w * (col + (row & 1) / 2), hr + row * 1.5 * hr, hr);
      }
    }
    ctx.strokeStyle = 'rgba(160, 190, 255, 0.22)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
    if (shape === 'hex') {
      ctx.beginPath();
      hexPath(PREVIEW / 2, PREVIEW / 2, PREVIEW / 2 - 1);
      ctx.strokeStyle = 'rgba(120, 165, 255, 0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }, [source, crop, cols, shape, cropRect]);

  const onPreviewDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY };
  };
  const onPreviewMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    if (!d || !source) return;
    const { w, h } = sourceSize(source.img);
    const r = cropRect(source.img);
    const k = r.size / PREVIEW;
    const dx = (e.clientX - d.x) * k, dy = (e.clientY - d.y) * k;
    dragRef.current = { x: e.clientX, y: e.clientY };
    setCrop((c) => {
      const size = Math.min(w, h) / c.zoom;
      const cx = Math.max(size / 2 / w, Math.min(1 - size / 2 / w, c.cx - dx / w));
      const cy = Math.max(size / 2 / h, Math.min(1 - size / 2 / h, c.cy - dy / h));
      return { ...c, cx, cy };
    });
  };
  const onPreviewUp = () => { dragRef.current = null; };
  const onPreviewWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    setCrop((c) => ({ ...c, zoom: Math.max(1, Math.min(6, c.zoom * Math.exp(-e.deltaY * 0.0015))) }));
  };

  const pickRandomMeme = async () => {
    const pool = memes.filter((m) => !m.animated);
    const m = pool[Math.floor(Math.random() * pool.length)];
    if (!m) return;
    setError(null);
    setBusy('fetching a meme…');
    try {
      const img = await imageFromMeme(m);
      setSource({ img, label: `#${m.tags[0] ?? m.slug}` });
      setCrop({ cx: 0.5, cy: 0.5, zoom: 1 });
    } catch {
      setError('could not load that meme — try another');
    } finally {
      setBusy(null);
    }
  };

  const go = async () => {
    if (!source || !engine) return;
    setError(null);
    setBusy('loading the archive’s colours…');
    setProgress(0);
    try {
      const features = await loadFeatures(atlasBase, atlas.generated_at, atlas.count);
      setBusy('cutting the honeycomb…');
      await new Promise((r) => setTimeout(r, 20));
      const prepared = describeSource(source.img, cropRect(source.img), cols, shape);
      setBusy(`matching ${prepared.grid.centers.length.toLocaleString()} hexes against ${atlas.count.toLocaleString()} memes…`);
      const seed = Math.floor(Math.random() * 1e9);
      const { assign, distinct } = await matchMosaic(prepared, features, colors.current, {
        onProgress: setProgress,
        seed,
      });
      const res = buildResult(prepared, assign, distinct, colors.current, shape, seed);
      setResult(res);
      engine.setTint(tint);
      engine.assemble(res);
      onClose();
    } catch (err) {
      console.error('[assemble]', err);
      setError('something went sideways while assembling — try again');
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => { engine?.setTint(tint); }, [tint, engine]);

  const sheets = () => (sheetsPromise ??= loadSheets(sheetUrls()).catch((e) => { sheetsPromise = null; throw e; }));

  const toBlob = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));

  const download = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const renderPfp = async (): Promise<Blob> => {
    if (!result) throw new Error('nothing assembled');
    const sh = await sheets();
    await new Promise((r) => setTimeout(r, 20));
    const img = rasterize(result, sh, colors.current, {
      size: 1024,
      tint,
      gap: 0.07,
      background: result.shape === 'hex' ? [0, 0, 0, 0] : [7, 10, 20, 255],
      shapeMask: true,
    });
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    c.getContext('2d')!.putImageData(img, 0, 0);
    return toBlob(c);
  };

  const renderPoster = async (): Promise<Blob> => {
    if (!result) throw new Error('nothing assembled');
    const sh = await sheets();
    await new Promise((r) => setTimeout(r, 20));
    const W = 2048, H = 2304, M = 1760;
    const img = rasterize(result, sh, colors.current, { size: M, tint, gap: 0.07, background: [0, 0, 0, 0], shapeMask: true });
    const tile = document.createElement('canvas');
    tile.width = tile.height = M;
    tile.getContext('2d')!.putImageData(img, 0, 0);
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(W / 2, H * 0.42, 100, W / 2, H * 0.42, W * 0.85);
    g.addColorStop(0, '#13204a');
    g.addColorStop(1, '#04060d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // A scatter of stars so the poster sits in the same sky as the memeverse.
    for (let i = 0; i < 420; i++) {
      const x = Math.random() * W, y = Math.random() * H, r = Math.random() * 1.8 + 0.3;
      ctx.fillStyle = `rgba(200, 215, 255, ${0.15 + Math.random() * 0.5})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowColor = 'rgba(74, 142, 255, 0.55)';
    ctx.shadowBlur = 80;
    ctx.drawImage(tile, (W - M) / 2, 96);
    ctx.shadowBlur = 0;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 76px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(`assembled from ${result.distinct.toLocaleString()} chainlink memes`, W / 2, H - 230);
    ctx.fillStyle = '#8fb2ff';
    ctx.font = '500 46px Menlo, Monaco, monospace';
    ctx.fillText(`⬡⏣⬢  ${location.host}${base}/verse  ⬢⏣⬡`, W / 2, H - 140);
    return toBlob(c);
  };

  const [canClip] = useState(() => !!VerseEngine.clipType());

  const recordClip = async () => {
    if (!engine || exporting) return;
    setExporting('clip');
    try {
      const clip = await engine.recordAssemble();
      if (!clip) return;
      const name = `memeverse-assemble.${clip.ext}`;
      const file = new File([clip.blob], name, { type: clip.blob.type });
      // Phones: straight into the share sheet (X, Telegram, Photos…).
      if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text: `assembled from ${result?.distinct.toLocaleString()} chainlink memes ⬢` });
      } else {
        download(clip.blob, name);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') console.error('[assemble clip]', err);
    } finally {
      setExporting(null);
    }
  };

  const exportAs = async (kind: 'pfp' | 'poster' | 'share') => {
    if (exporting) return;
    setExporting(kind);
    try {
      if (kind === 'pfp') download(await renderPfp(), 'memeverse-pfp.png');
      else if (kind === 'poster') download(await renderPoster(), 'memeverse-poster.png');
      else {
        const blob = await renderPoster();
        const file = new File([blob], 'memeverse.png', { type: 'image/png' });
        const text = `I got assembled from ${result?.distinct.toLocaleString()} chainlink memes ⬢`;
        const url = `${location.origin}${base}/verse/#assemble`;
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], text, url });
        } else {
          download(blob, 'memeverse-poster.png');
          window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank', 'noopener');
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') console.error('[assemble export]', err);
    } finally {
      setExporting(null);
    }
  };

  const recording = exporting === 'clip';
  // The toolbar belongs to the portrait: up while it assembles and stands,
  // gone as soon as it starts flying back to the galaxy.
  const hud = (mode === 'assembling' || mode === 'mosaic') && result;

  return (
    <>
      {open && (
        <div
          className={`asm-backdrop ${dragOver ? 'drag' : ''}`}
          onClick={onClose}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); void takeFile(e.dataTransfer.files?.[0]); }}
        >
          <div className="asm-card" role="dialog" aria-label="assemble" onClick={(e) => e.stopPropagation()}>
            <button type="button" className="verse-panel-x" onClick={onClose} aria-label="close">✕</button>
            <p className="verse-eyebrow">⬢ link marines, assemble</p>
            <h2>become the meme</h2>
            <p className="asm-lede">
              Drop in a photo and the whole galaxy rebuilds it, hex by hex, out of {atlas.count.toLocaleString()} chainlink memes.
              It all runs in your browser — <strong>your photo never leaves this device.</strong>
            </p>

            <div className="asm-grid">
              <div className="asm-stage">
                {source ? (
                  <>
                    <canvas
                      ref={previewRef}
                      className="asm-preview"
                      style={{ width: PREVIEW, height: PREVIEW }}
                      onPointerDown={onPreviewDown}
                      onPointerMove={onPreviewMove}
                      onPointerUp={onPreviewUp}
                      onPointerCancel={onPreviewUp}
                      onWheel={onPreviewWheel}
                    />
                    <label className="asm-zoom">
                      <span>zoom</span>
                      <input type="range" min={1} max={6} step={0.01} value={crop.zoom} onChange={(e) => setCrop((c) => ({ ...c, zoom: Number(e.target.value) }))} />
                    </label>
                    <p className="asm-note">drag to frame · {source.label}</p>
                  </>
                ) : (
                  <button type="button" className="asm-drop" onClick={() => fileRef.current?.click()}>
                    <span className="asm-drop-hex">⬢</span>
                    <strong>drop a photo here</strong>
                    <span>or click to choose · or paste</span>
                  </button>
                )}
              </div>

              <div className="asm-controls">
                <p className="asm-label">picture</p>
                <div className="asm-sources">
                  <button type="button" className="verse-pill" onClick={() => fileRef.current?.click()}>upload a photo</button>
                  <button type="button" className="verse-pill asm-selfie" onClick={() => selfieRef.current?.click()}>take a selfie</button>
                  <button type="button" className="verse-pill" onClick={() => { setSource({ img: chainlinkMark(), label: 'the chainlink mark' }); setCrop({ cx: 0.5, cy: 0.5, zoom: 1 }); }}>the chainlink mark</button>
                  <button type="button" className="verse-pill" onClick={pickRandomMeme}>a random meme</button>
                </div>
                <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { void takeFile(e.target.files?.[0]); e.target.value = ''; }} />
                <input ref={selfieRef} type="file" accept="image/*" capture="user" hidden onChange={(e) => { void takeFile(e.target.files?.[0]); e.target.value = ''; }} />

                <p className="asm-label">detail</p>
                <div className="asm-seg" role="radiogroup">
                  {DETAIL.map((d) => (
                    <button key={d.cols} type="button" role="radio" aria-checked={cols === d.cols} className={cols === d.cols ? 'on' : ''} onClick={() => setCols(d.cols)}>
                      {d.label}
                    </button>
                  ))}
                </div>

                <p className="asm-label">shape</p>
                <div className="asm-seg" role="radiogroup">
                  {(['hex', 'square'] as const).map((s) => (
                    <button key={s} type="button" role="radio" aria-checked={shape === s} className={shape === s ? 'on' : ''} onClick={() => setShape(s)}>
                      {s === 'hex' ? '⬢ hex' : '■ square'}
                    </button>
                  ))}
                </div>

                <button type="button" className="asm-go" disabled={!source || !!busy || !engine} onClick={go}>
                  {busy ? busy : mosaicLive ? '⬢ re-assemble' : '⬢ assemble'}
                </button>
                {busy && progress > 0 && (
                  <div className="asm-progress"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
                )}
                {error && <p className="asm-error">{error}</p>}
              </div>
            </div>
          </div>
        </div>
      )}

      {hud && (
        <div className="asm-hud" role="toolbar" aria-label="assembled picture">
          <p className="asm-hud-title">
            {mosaicLive || recording
              ? <>assembled from <strong>{result.distinct.toLocaleString()}</strong> different memes · <span>{result.cells.length.toLocaleString()} hexes</span></>
              : <>link marines, assemble…</>}
          </p>
          <div className="asm-hud-row">
            <button type="button" className="verse-pill primary" onClick={() => exportAs('pfp')} disabled={!mosaicLive || !!exporting}>{exporting === 'pfp' ? 'rendering…' : 'download pfp'}</button>
            <button type="button" className="verse-pill" onClick={() => exportAs('poster')} disabled={!mosaicLive || !!exporting}>{exporting === 'poster' ? 'rendering…' : 'poster'}</button>
            {canClip && (
              <button type="button" className={`verse-pill ${exporting === 'clip' ? 'rec' : ''}`} onClick={recordClip} disabled={!mosaicLive || !!exporting} title="film the galaxy assembling your picture">
                {exporting === 'clip' ? '● recording…' : 'record clip'}
              </button>
            )}
            <button type="button" className="verse-pill" onClick={() => exportAs('share')} disabled={!mosaicLive || !!exporting}>{exporting === 'share' ? 'rendering…' : 'share'}</button>
            <label className="asm-tint" title="how strongly each meme leans towards your photo's colour">
              <span>blend</span>
              <input type="range" min={0} max={1} step={0.01} value={tint} onChange={(e) => setTint(Number(e.target.value))} />
            </label>
            <button type="button" className="verse-pill" onClick={() => engine?.replayAssemble()} disabled={!mosaicLive || !!exporting}>replay</button>
            <button type="button" className="verse-pill" onClick={() => { engine?.disassemble(); }} disabled={recording}>back to the galaxy</button>
          </div>
        </div>
      )}
    </>
  );
}

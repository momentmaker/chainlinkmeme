// Scans memes/*.toml, reads image dimensions, emits site/public/manifest.json.
// Runs in CI before `astro build`.

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { synonyms, related } from './synonyms';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MEMES_DIR = path.join(ROOT, 'memes');
const MANIFEST_PATH = path.join(ROOT, 'site', 'public', 'manifest.json');
const VOCAB_PATH = path.join(MEMES_DIR, '_vocab.toml');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const ANIMATED_EXTS = new Set(['.gif']);

function readVocab(): Set<string> {
  if (!fs.existsSync(VOCAB_PATH)) {
    console.warn(`[manifest] no _vocab.toml found — skipping vocab check`);
    return new Set();
  }
  const raw = fs.readFileSync(VOCAB_PATH, 'utf8');
  const parsed = parseToml(raw) as { tags?: string[] };
  return new Set(parsed.tags ?? []);
}

function readImageSize(filePath: string): { width: number; height: number } {
  // minimal header sniffers — avoids a heavy image lib for a ~build-time task.
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.png') {
    if (buf.length < 24) return { width: 0, height: 0 };
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (ext === '.gif') {
    if (buf.length < 10) return { width: 0, height: 0 };
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (ext === '.webp') {
    if (buf.length < 30) return { width: 0, height: 0 };
    if (buf.toString('ascii', 12, 16) === 'VP8 ') {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
    }
    if (buf.toString('ascii', 12, 16) === 'VP8L') {
      const b0 = buf.readUInt8(21);
      const b1 = buf.readUInt8(22);
      const b2 = buf.readUInt8(23);
      const b3 = buf.readUInt8(24);
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width, height };
    }
    if (buf.toString('ascii', 12, 16) === 'VP8X') {
      const width = 1 + buf.readUIntLE(24, 3);
      const height = 1 + buf.readUIntLE(27, 3);
      return { width, height };
    }
    return { width: 0, height: 0 };
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    let offset = 2;
    while (offset < buf.length) {
      if (buf[offset] !== 0xff) { offset++; continue; }
      const marker = buf[offset + 1];
      if (marker === undefined) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)) {
        return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
      }
      const segLen = buf.readUInt16BE(offset + 2);
      offset += 2 + segLen;
    }
    return { width: 0, height: 0 };
  }
  return { width: 0, height: 0 };
}

function slugify(filename: string): string {
  return path.basename(filename, path.extname(filename));
}

function main() {
  const vocab = readVocab();
  const entries = fs.readdirSync(MEMES_DIR);
  const memes: Array<Record<string, unknown>> = [];
  const allTags = new Set<string>();
  let skipped = 0;
  let missing_toml = 0;

  for (const name of entries) {
    if (name.startsWith('_') || name.startsWith('.')) continue;
    const ext = path.extname(name).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;
    const slug = slugify(name);
    const tomlPath = path.join(MEMES_DIR, `${slug}.toml`);
    if (!fs.existsSync(tomlPath)) { missing_toml++; continue; }

    const raw = fs.readFileSync(tomlPath, 'utf8');
    const meta = parseToml(raw) as Record<string, unknown>;
    const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];

    if (vocab.size > 0) {
      const badTags = tags.filter((t) => !vocab.has(t));
      if (badTags.length > 0) {
        console.warn(`[manifest] ${slug}: unknown tags ${badTags.join(', ')}`);
        skipped++;
        continue;
      }
    }

    const filePath = path.join(MEMES_DIR, name);
    const { width, height } = readImageSize(filePath);

    for (const t of tags) allTags.add(t);
    memes.push({
      slug,
      filename: name,
      ext: ext.slice(1),
      title: typeof meta.title === 'string' ? meta.title : '',
      tags,
      description: typeof meta.description === 'string' ? meta.description : '',
      credit: typeof meta.credit === 'string' ? meta.credit : '',
      source_url: typeof meta.source_url === 'string' ? meta.source_url : '',
      submitted_by: typeof meta.submitted_by === 'string' ? meta.submitted_by : '',
      date_added: meta.date_added ? String(meta.date_added) : '',
      nsfw: Boolean(meta.nsfw),
      animated: ANIMATED_EXTS.has(ext),
      width,
      height,
    });
  }

  const repoRef = process.env.GITHUB_SHA || process.env.PUBLIC_REPO_REF || 'main';
  const manifest = {
    generated_at: new Date().toISOString(),
    repo_ref: repoRef,
    memes: memes.sort((a, b) => String(b.date_added ?? '').localeCompare(String(a.date_added ?? '')) || String(a.slug).localeCompare(String(b.slug))),
    tags: [...allTags].sort(),
    synonyms,
    related,
  };

  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`[manifest] wrote ${memes.length} memes, ${allTags.size} tags to ${path.relative(ROOT, MANIFEST_PATH)}`);
  if (missing_toml > 0) console.warn(`[manifest] ${missing_toml} images without a .toml (skipped)`);
  if (skipped > 0) console.warn(`[manifest] ${skipped} memes skipped due to vocab errors`);
}

main();

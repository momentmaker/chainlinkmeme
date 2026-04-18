// Validates memes/ against the schema and the vocabulary.
// Used by CI on every PR.

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MEMES_DIR = path.join(ROOT, 'memes');
const VOCAB_PATH = path.join(MEMES_DIR, '_vocab.toml');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const VALID_SLUG = /^[a-z0-9_][a-z0-9_-]*$/;

interface Vocab { tags: string[]; synonyms: Record<string, string[]>; related: Record<string, string[]>; }

function fail(msgs: string[]): never { for (const m of msgs) console.error(`✗ ${m}`); process.exit(1); }

function main() {
  if (!fs.existsSync(VOCAB_PATH)) fail([`missing ${path.relative(ROOT, VOCAB_PATH)}`]);
  const vocab = parseToml(fs.readFileSync(VOCAB_PATH, 'utf8')) as unknown as Vocab;
  const vocabSet = new Set(vocab.tags);
  const errors: string[] = [];

  const files = fs.readdirSync(MEMES_DIR).filter((n) => !n.startsWith('_') && !n.startsWith('.'));
  const byBase = new Map<string, { image?: string; toml?: string }>();
  for (const f of files) {
    const base = path.basename(f, path.extname(f));
    const ext = path.extname(f).toLowerCase();
    const entry = byBase.get(base) ?? {};
    if (ext === '.toml') entry.toml = f;
    else if (IMAGE_EXTS.has(ext)) entry.image = f;
    byBase.set(base, entry);
  }

  for (const [base, e] of byBase) {
    if (!VALID_SLUG.test(base)) errors.push(`${base}: filename must match /^[a-z0-9_][a-z0-9_-]*$/`);
    if (!e.image) errors.push(`${base}: no image file (expected .jpg/.jpeg/.png/.gif/.webp)`);
    if (!e.toml) errors.push(`${base}: no ${base}.toml`);
    if (!e.image || !e.toml) continue;

    const raw = fs.readFileSync(path.join(MEMES_DIR, e.toml), 'utf8');
    // smol-toml's `parse` returns a loosely-typed record; we type-guard each
    // field below rather than trust a `Meta` interface, because the whole
    // point of validate.ts is to catch contributions with the wrong shapes.
    let meta: Record<string, unknown>;
    try {
      meta = parseToml(raw) as Record<string, unknown>;
    } catch (err) {
      errors.push(`${base}: invalid TOML — ${(err as Error).message}`);
      continue;
    }

    const metaTags = meta.tags;
    if (!Array.isArray(metaTags) || metaTags.length === 0) {
      errors.push(`${base}: tags must be a non-empty array`);
    } else {
      for (const t of metaTags) {
        if (typeof t !== 'string') { errors.push(`${base}: tag is not a string: ${String(t)}`); continue; }
        if (!vocabSet.has(t)) errors.push(`${base}: tag "${t}" not in _vocab.toml`);
      }
    }

    const filePath = path.join(MEMES_DIR, e.image);
    const stat = fs.statSync(filePath);
    if (stat.size === 0) errors.push(`${base}: image is zero bytes`);
    // Hard limit 10 MB. New contributions are nudged to compress below 5 MB
    // in CONTRIBUTING.md, but legacy imports up to 10 MB are grandfathered.
    if (stat.size > 10 * 1024 * 1024) errors.push(`${base}: image exceeds 10 MB — please compress`);

    for (const field of ['title', 'description', 'credit', 'source_url', 'submitted_by'] as const) {
      const v = meta[field];
      if (v !== undefined && typeof v !== 'string') {
        errors.push(`${base}: ${field} must be a string (or omitted)`);
      }
    }
    if (meta.nsfw !== undefined && typeof meta.nsfw !== 'boolean') {
      errors.push(`${base}: nsfw must be boolean`);
    }
    if (typeof meta.title === 'string' && meta.title.length > 80) {
      errors.push(`${base}: title exceeds 80 chars`);
    }
  }

  if (errors.length > 0) fail(errors);

  const count = [...byBase.values()].filter((e) => e.image && e.toml).length;
  console.log(`✓ ${count} memes validated`);
}

main();

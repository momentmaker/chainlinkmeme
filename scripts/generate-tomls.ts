// One-off: reads a JSON dump of the Rails Postgres ({ tags, memes }) and
//   - writes memes/_vocab.toml (canonical tag list + synonyms + related)
//   - writes one memes/<slug>.toml per existing image with tags populated
//
// Produce the dump on the Rails host (no credentials leak this way):
//   fly ssh console -a chainlinkmeme-api -C "bin/rails runner 'puts ...'" > /tmp/rails-dump.json
//
// Then run:
//   tsx scripts/generate-tomls.ts /tmp/rails-dump.json

import fs from 'node:fs';
import path from 'node:path';
import { synonyms, related } from './synonyms';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MEMES_DIR = path.join(ROOT, 'memes');

interface Dump {
  tags: string[];
  memes: Array<{
    filename: string;
    animated: boolean;
    width: number;
    height: number;
    likes: number;
    tags: string[];
  }>;
}

function escapeTomlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function writeVocab(tags: string[]) {
  const sorted = [...new Set(tags)].sort();
  const lines: string[] = [];
  lines.push('# Canonical tag vocabulary.');
  lines.push('# Seeded from the Rails DB, then curated via PR.');
  lines.push('# Every memes/<slug>.toml must list tags only from this set.');
  lines.push('');
  lines.push('tags = [');
  for (const t of sorted) lines.push(`  "${escapeTomlString(t)}",`);
  lines.push(']');
  lines.push('');
  lines.push('# --- synonyms: rewrite a user-typed tag into canonical form(s) ---');
  lines.push('[synonyms]');
  for (const [k, v] of Object.entries(synonyms).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`"${escapeTomlString(k)}" = [${v.map((x) => `"${escapeTomlString(x)}"`).join(', ')}]`);
  }
  lines.push('');
  lines.push('# --- related: when these tags appear in a query, also expand to these ---');
  lines.push('[related]');
  for (const [k, v] of Object.entries(related).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`"${escapeTomlString(k)}" = [${v.map((x) => `"${escapeTomlString(x)}"`).join(', ')}]`);
  }
  lines.push('');
  fs.writeFileSync(path.join(MEMES_DIR, '_vocab.toml'), lines.join('\n'));
  console.log(`[vocab] wrote ${sorted.length} tags`);
}

function writeMemeToml(filename: string, tags: string[], isBootstrap: boolean) {
  const slug = path.basename(filename, path.extname(filename));
  const tomlPath = path.join(MEMES_DIR, `${slug}.toml`);
  if (fs.existsSync(tomlPath)) { return; }
  const lines: string[] = [];
  lines.push(`# Auto-generated from Rails DB on ${new Date().toISOString().slice(0, 10)}.`);
  lines.push(`# Filename: ${filename}`);
  if (isBootstrap) {
    lines.push(`# Bootstrapped with no title/description — open a PR to enrich.`);
  }
  lines.push('');
  if (tags.length === 0) lines.push('tags = []');
  else lines.push(`tags = [${tags.map((t) => `"${escapeTomlString(t)}"`).join(', ')}]`);
  lines.push('title = ""');
  lines.push('description = ""');
  lines.push('credit = ""');
  lines.push('source_url = ""');
  lines.push('submitted_by = ""');
  lines.push('date_added = "2020-02-11"  # original import date from Rails');
  lines.push('nsfw = false');
  lines.push('');
  fs.writeFileSync(tomlPath, lines.join('\n'));
}

function main() {
  const [,, dumpArg] = process.argv;
  if (!dumpArg) {
    console.error('usage: tsx scripts/generate-tomls.ts <path-to-rails-dump.json>');
    process.exit(1);
  }
  const dump = JSON.parse(fs.readFileSync(dumpArg, 'utf8')) as Dump;

  writeVocab(dump.tags);

  const onDisk = new Set(
    fs.readdirSync(MEMES_DIR).filter((n) => /\.(jpe?g|png|gif|webp)$/i.test(n)),
  );

  let written = 0;
  let skippedMissing = 0;
  for (const m of dump.memes) {
    if (!onDisk.has(m.filename)) { skippedMissing++; continue; }
    writeMemeToml(m.filename, m.tags, true);
    written++;
  }
  console.log(`[tomls] wrote/kept ${written} tomls, ${skippedMissing} db rows had no matching file on disk`);

  // Files on disk without a DB entry get an empty-tag TOML (manual fix-up expected)
  let orphaned = 0;
  const dbByFilename = new Map(dump.memes.map((m) => [m.filename, m]));
  for (const f of onDisk) {
    if (!dbByFilename.has(f)) {
      writeMemeToml(f, [], true);
      orphaned++;
    }
  }
  if (orphaned > 0) console.warn(`[tomls] ${orphaned} files on disk had no db row — wrote empty-tag tomls`);
}

main();

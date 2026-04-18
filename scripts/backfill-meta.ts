// Runs in CI on push to main. For every meme TOML changed in the most recent
// commit, if `submitted_by` or `date_added` is empty, fill it in from git +
// environment metadata. Keeps attribution accurate without asking contributors
// to hand-fill fields that only maintainers know.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MEMES_DIR = path.join(ROOT, 'memes');
const today = new Date().toISOString().slice(0, 10);

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', cwd: ROOT }).trim();
}

function changedTomlsInLastCommit(): string[] {
  try {
    const out = git('diff', '--name-only', 'HEAD~1..HEAD', '--', 'memes/');
    return out.split('\n').filter((l) => l.endsWith('.toml') && !l.startsWith('memes/_'));
  } catch {
    return [];
  }
}

function author(): string {
  const actor = process.env.CI_ACTOR?.trim();
  if (actor) return `@${actor}`;
  try {
    return git('log', '-1', '--pretty=%ae', 'HEAD');
  } catch {
    return '';
  }
}

function main() {
  const files = changedTomlsInLastCommit();
  if (files.length === 0) { console.log('[backfill] no meme tomls changed'); return; }

  const whom = author();
  let updated = 0;
  for (const rel of files) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    let src = fs.readFileSync(p, 'utf8');
    let changed = false;
    if (whom && /^submitted_by\s*=\s*""/m.test(src)) {
      src = src.replace(/^submitted_by\s*=\s*""/m, `submitted_by = "${whom}"`);
      changed = true;
    }
    if (/^date_added\s*=\s*""/m.test(src)) {
      src = src.replace(/^date_added\s*=\s*""/m, `date_added = "${today}"`);
      changed = true;
    }
    if (changed) { fs.writeFileSync(p, src); updated++; }
  }
  console.log(`[backfill] updated ${updated} of ${files.length} changed tomls`);
}

main();

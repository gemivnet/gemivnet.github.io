// Pre-commit PII scanner for georgemain.com.
//
// Scans the *staged* diff for patterns that look like sensitive information:
//   - email addresses (outside the allowlist)
//   - phone numbers (US + intl forms)
//   - 9-digit SSN-like
//   - 13–19 digit credit-card-like (Luhn-checked to cut false positives)
//   - GPS coordinates
//   - precise ISO-style timestamps (e.g., 2026-05-19T14:32:08)
//   - US street addresses (heuristic)
//
// Items listed in .pii-allowlist.yaml are ignored.
// Exits non-zero on any hit. Use `git commit --no-verify` to bypass.
//
// Optionally runs a second-pass AI check if ANTHROPIC_API_KEY is set; the AI
// pass is best-effort and never blocks if it can't reach the API.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import exifr from 'exifr';

import { loadAllowlist, buildPatterns } from './lib/pii-patterns.mjs';

const ROOT = path.resolve(import.meta.dirname || new URL('.', import.meta.url).pathname, '..');

// --all sweeps every tracked file instead of the staged diff. The staged mode is right
// for the pre-commit hook; --all is what CI needs, because on a fresh checkout nothing
// is staged and the staged scan exits 0 having examined nothing.
const SCAN_ALL = process.argv.includes('--all');

// execFileSync, not execSync: execSync routes through cmd.exe, which refuses a
// UNC working directory ("CMD.EXE was started with the above path ... UNC paths
// are not supported") and silently falls back to C:\Windows. This repo lives on
// a network share, so every git call here failed that way — and because the
// scanner fails closed, that blocked every commit from the machine.
//
// maxBuffer: execFileSync throws past its 1 MiB default. Adding 780 audio files
// produced a 1.3 MB diff, this threw, and the catch below reported it as "not in
// a git repo" and waved the commit through — the scan skipping itself on
// precisely the largest commits, which are the ones worth scanning.
//
// core.quotepath=false: by default git wraps any path containing a non-ASCII byte in
// quotes and octal-escapes it ("...Brass\303\263.mp3"). The diff parser below matches
// on a bare `+++ b/` prefix, so every one of those files fell out of the scan --
// 1373 of 2585 tracked paths, more than half the repo, silently unscanned.
const git = (args) => execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
});

// Patterns and the allowlist reader live in scripts/lib/pii-patterns.mjs so the
// FOIA ingest pre-flight scans documents against exactly these rules.
const isAllowed = loadAllowlist(ROOT);

// ── get staged content ─────────────────────────────────────
let staged = '';
try {
  if (!SCAN_ALL) staged = git(['diff', '--cached', '--unified=0', '--no-color']);
} catch (err) {
  // Fail closed. A scanner that cannot read the diff and says nothing is worse than no
  // scanner at all, because it looks like it passed. --no-verify is the deliberate way past.
  console.error(`[pii] could not read the staged diff: ${err?.message ?? err}`);
  console.error('[pii] refusing to pass a commit it could not scan. Use --no-verify to override.');
  process.exit(1);
}

// Which files are out of scope, for both the staged scan and the --all sweep.
function skipFile(file) {
  if (!file) return true;
  // Vendor/build/lockfile noise.
  if (file.startsWith('node_modules/')) return true;
  if (file.startsWith('_site/')) return true;
  if (file === 'package-lock.json') return true;
  // Sub-sites are self-contained published artifacts, reviewed as a whole when they are
  // put up rather than line by line here: a flight track, a word game, and so on. Their
  // payload IS the data -- coordinate arrays, minified bundles where 4294967296 is 2^32
  // and a weight array reads as GPS -- so scanning them produces only noise. Authored
  // sources live in their own repos.
  //
  // The trade-off, stated plainly: anything dropped under content/sites/ is unscanned.
  // Review a new sub-site before adding it, because this check will not.
  if (/^content\/sites\//.test(file)) return true;
  // Same reasoning for vendored third-party builds: design/vendor/pdfjs is
  // minified upstream output where 4294967296 is 2^32, not a phone number.
  // Provenance for it is recorded in design/vendor/pdfjs/VENDORED.md.
  if (/^design\/vendor\//.test(file)) return true;
  // Skip the hook itself and the shared pattern module — they document, in
  // comments and examples, exactly the shapes they detect.
  if (file === 'scripts/check-pii.mjs') return true;
  if (file === 'scripts/lib/pii-patterns.mjs') return true;
  if (file.startsWith('.claude/skills/pii-audit/')) return true;
  return false;
}

// Binary payloads carry no reviewable text and produce only noise. EXIF in images is a
// real concern but is a separate check, not this line-oriented one.
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|avif|ico|svgz|mp3|m4a|ogg|wav|flac|mp4|mov|webm|pdf|woff2?|ttf|otf|eot|zip|gz|bz2|xz|7z|docx?|xlsx?|pptx?|sqlite3?|db)$/i;

const lines = [];

if (SCAN_ALL) {
  // Whole-tree sweep, for CI. The staged-diff mode below is right for a pre-commit hook
  // but passes vacuously when nothing is staged -- which is exactly what happens on a CI
  // checkout, so a green tick there meant "nothing was scanned", not "nothing was found".
  const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
  for (const file of tracked) {
    if (skipFile(file) || BINARY_EXT.test(file)) continue;
    let body;
    try {
      body = readFileSync(path.join(ROOT, file), 'utf8');
    } catch {
      continue; // unreadable or vanished between ls-files and here
    }
    if (body.includes('\0')) continue; // binary without a telltale extension
    for (const text of body.split('\n')) {
      if (text.trim()) lines.push({ file, text });
    }
  }
} else {
  // Walk through diff and collect (file, line, addedText) tuples.
  let currentFile = null;
  for (const raw of staged.split('\n')) {
    if (raw.startsWith('+++ b/')) { currentFile = raw.slice(6); continue; }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('@@') || raw.startsWith('diff ') || raw.startsWith('index ')) continue;
    if (!raw.startsWith('+')) continue;
    const text = raw.slice(1);
    if (!text.trim()) continue;
    if (skipFile(currentFile)) continue;
    lines.push({ file: currentFile, text });
  }
}

// ── pattern definitions ───────────────────────────────────
const patterns = buildPatterns(isAllowed);

// ── run scan ───────────────────────────────────────────────
const hits = [];
for (const { file, text } of lines) {
  for (const p of patterns) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text))) {
      const match = m[0];
      if (isAllowed(match)) continue;
      if (!p.test(match)) continue;
      hits.push({ file, type: p.name, match, line: text.trim().slice(0, 140) });
    }
  }
}

// ── EXIF GPS check on staged image files ──────────────────
try {
  const stagedFiles = git(['diff', '--cached', '--name-only', '--diff-filter=AM'])
    .split('\n').map(s => s.trim()).filter(Boolean)
    .filter(f => /\.(jpe?g|png|heic|heif|tiff?|webp)$/i.test(f))
    .filter(f => !f.startsWith('staging/'));
  for (const f of stagedFiles) {
    try {
      const meta = await exifr.parse(path.join(ROOT, f), { gps: true, tiff: false, ifd0: false });
      if (meta && (meta.latitude || meta.longitude)) {
        hits.push({
          file: f,
          type: 'EXIF GPS',
          match: `lat=${meta.latitude}, lon=${meta.longitude}`,
          line: '(image metadata, not visible in text diff)',
        });
      }
    } catch { /* file unreadable / no EXIF — fine */ }
  }
} catch { /* no staged files */ }

// ── report ────────────────────────────────────────────────
if (hits.length === 0) {
  console.log('[pii] no obvious PII in staged changes ✓');
  // optional AI pass
  await maybeAiPass(lines);
  process.exit(0);
}

console.error('\n[pii] possible sensitive content in staged changes:\n');
const byFile = {};
for (const h of hits) (byFile[h.file] ??= []).push(h);
for (const file of Object.keys(byFile)) {
  console.error('  ' + file);
  for (const h of byFile[file]) {
    console.error(`    ✗ ${h.type}: ${JSON.stringify(h.match)}`);
    console.error(`        on: ${h.line}`);
  }
}
console.error('\nIf a match is intentional and OK to publish, add it to .pii-allowlist.yaml');
console.error('or bypass this hook with: git commit --no-verify');
process.exit(1);

// ── optional AI second pass ───────────────────────────────
async function maybeAiPass(addedLines) {
  if (!process.env.ANTHROPIC_API_KEY) return;
  if (addedLines.length === 0) return;
  const sample = addedLines.slice(0, 200).map((l) => `${l.file}: ${l.text}`).join('\n');
  if (sample.length < 50) return;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: 'You audit content for PII (personal identifying information) before it is published to a public website. Output ONLY JSON: {"hits": [{"type": "...", "snippet": "...", "why": "..."}]}. If nothing is concerning, output {"hits": []}.',
        messages: [{ role: 'user', content:
          'The following lines are about to be committed to a public personal blog. Flag anything that should NOT be published: real-world home addresses, full birthdays of private people, passwords/api keys, license plates, financial account numbers, medical info, or anything that identifies someone non-public. Public figures and the author\'s own city/country/work are fine. Lines:\n\n' + sample }],
      }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const text = data?.content?.[0]?.text || '';
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    if (!json?.hits?.length) {
      console.log('[pii ai] no concerns ✓');
      return;
    }
    console.error('\n[pii ai] AI flagged potential issues:');
    for (const h of json.hits) {
      console.error(`    ⚠ ${h.type}: ${JSON.stringify(h.snippet)}`);
      if (h.why) console.error(`        why: ${h.why}`);
    }
    console.error('\nReview before committing. To bypass: git commit --no-verify');
    process.exit(1);
  } catch (e) {
    // best-effort; do not block on failures
    console.log('[pii ai] skipped (' + (e.message || e) + ')');
  }
}

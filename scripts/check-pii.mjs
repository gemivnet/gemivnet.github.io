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
import path from 'node:path';
import exifr from 'exifr';

import { loadAllowlist, buildPatterns } from './lib/pii-patterns.mjs';

const ROOT = path.resolve(import.meta.dirname || new URL('.', import.meta.url).pathname, '..');

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
const git = (args) => execFileSync('git', args, {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
});

// Patterns and the allowlist reader live in scripts/lib/pii-patterns.mjs so the
// FOIA ingest pre-flight scans documents against exactly these rules.
const isAllowed = loadAllowlist(ROOT);

// ── get staged content ─────────────────────────────────────
let staged;
try {
  staged = git(['diff', '--cached', '--unified=0', '--no-color']);
} catch (err) {
  // Fail closed. A scanner that cannot read the diff and says nothing is worse than no
  // scanner at all, because it looks like it passed. --no-verify is the deliberate way past.
  console.error(`[pii] could not read the staged diff: ${err?.message ?? err}`);
  console.error('[pii] refusing to pass a commit it could not scan. Use --no-verify to override.');
  process.exit(1);
}

// Walk through diff and collect (file, line, addedText) tuples.
const lines = [];
let currentFile = null;
for (const raw of staged.split('\n')) {
  if (raw.startsWith('+++ b/')) { currentFile = raw.slice(6); continue; }
  if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('@@') || raw.startsWith('diff ') || raw.startsWith('index ')) continue;
  if (!raw.startsWith('+')) continue;
  const text = raw.slice(1);
  if (!text.trim()) continue;
  // Skip vendor/build/lockfile noise.
  if (!currentFile) continue;
  if (currentFile.startsWith('node_modules/')) continue;
  if (currentFile.startsWith('_site/')) continue;
  if (currentFile === 'package-lock.json') continue;
  // Compiled bundles for a published site. These are minified machine output where number
  // literals routinely trip the heuristics -- 4294967296 is 2^32, and a model's weight array
  // reads as GPS coordinates. The authored sources are reviewed in their own repo.
  if (/^content\/sites\/[^/]+\/assets\//.test(currentFile)) continue;
  // Same reasoning for vendored third-party builds: design/vendor/pdfjs is
  // minified upstream output where 4294967296 is 2^32, not a phone number.
  // Provenance for it is recorded in design/vendor/pdfjs/VENDORED.md.
  if (/^design\/vendor\//.test(currentFile)) continue;
  // Skip the hook itself and the shared pattern module — they document, in
  // comments and examples, exactly the shapes they detect.
  if (currentFile === 'scripts/check-pii.mjs') continue;
  if (currentFile === 'scripts/lib/pii-patterns.mjs') continue;
  if (currentFile.startsWith('.claude/skills/pii-audit/')) continue;
  lines.push({ file: currentFile, text });
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

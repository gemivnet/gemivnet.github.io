// Backfill WebP variants + LQIP onto existing S3-uploaded images.
// For each metadata entry with s3 but no s3_webp:
//   1. download the full-size JPEG from S3 to a temp file
//   2. derive WebP variants (full/med/thumb) + LQIP base64
//   3. upload the 3 new WebP keys to S3
//   4. write s3_webp/s3_med_webp/s3_thumb_webp/lqip into metadata.yaml
//      (or the post frontmatter for inline images)
// Idempotent — skips entries that already have s3_webp.
//
// Also handles musings frontmatter.images entries.

import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import yaml from 'js-yaml';
import matter from 'gray-matter';
import fg from 'fast-glob';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUCKET = 'georgemain-com-media';
const BASE = `https://${BUCKET}.s3.amazonaws.com`;

function s3up(local, key) {
  try {
    execFileSync('aws', ['s3', 'cp', local, `s3://${BUCKET}/${key}`,
      '--content-type', 'image/webp',
      '--cache-control', 'public, max-age=31536000, immutable'], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    console.error('\nAWS upload failed:', e.stderr?.toString() || e.message);
    console.error('refresh credentials and re-run.');
    process.exit(2);
  }
  return `${BASE}/${key}`;
}

// fail fast if creds are bad
try { execFileSync('aws', ['sts', 'get-caller-identity'], { stdio: ['ignore', 'ignore', 'pipe'] }); }
catch { console.error('aws creds missing/expired. run `aws sso login` (or `aws configure`) and try again.'); process.exit(2); }

async function fetchToTemp(url) {
  const tmp = path.join(os.tmpdir(), `backfill-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(tmp, buf);
  return tmp;
}

async function buildVariants(jpegPath, baseKey) {
  // baseKey is e.g. "australia/tasmania/mona/cement-truck" (no extension)
  const tmpFull  = jpegPath.replace(/\.jpe?g$/i, '.full.webp');
  const tmpMed   = jpegPath.replace(/\.jpe?g$/i, '.med.webp');
  const tmpThumb = jpegPath.replace(/\.jpe?g$/i, '.thumb.webp');
  await sharp(jpegPath).webp({ quality: 85, effort: 5 }).toFile(tmpFull);
  await sharp(jpegPath).resize({ width: 1400, withoutEnlargement: true }).webp({ quality: 78, effort: 5 }).toFile(tmpMed);
  await sharp(jpegPath).resize({ width: 600, withoutEnlargement: true }).webp({ quality: 72, effort: 5 }).toFile(tmpThumb);
  const s3_webp       = s3up(tmpFull,  `${baseKey}.webp`);
  const s3_med_webp   = s3up(tmpMed,   `${baseKey}__med.webp`);
  const s3_thumb_webp = s3up(tmpThumb, `${baseKey}__thumb.webp`);
  const lqipBuf = await sharp(jpegPath).resize({ width: 24, withoutEnlargement: true }).jpeg({ quality: 50, mozjpeg: true }).toBuffer();
  const lqip = 'data:image/jpeg;base64,' + lqipBuf.toString('base64');
  await fs.unlink(tmpFull); await fs.unlink(tmpMed); await fs.unlink(tmpThumb);
  return { s3_webp, s3_med_webp, s3_thumb_webp, lqip };
}

function asDateString(d) { return d instanceof Date ? d.toISOString().slice(0, 10) : d; }

// Extract gallery base key from an existing s3 URL.
// "https://georgemain-com-media.s3.amazonaws.com/foo/bar/baz.jpg" → "foo/bar/baz"
function baseKeyFromS3(url) {
  const m = url.match(/amazonaws\.com\/(.+?)\.(?:jpe?g|png|webp)$/i);
  return m ? m[1] : null;
}

// ── galleries ──
for (const rel of await fg('content/media/**/metadata.yaml', { cwd: ROOT })) {
  const full = path.join(ROOT, rel);
  const data = yaml.load(await fs.readFile(full, 'utf8')) || {};
  if (!data.images?.length) continue;
  let updated = false;
  for (const im of data.images) {
    if (im.s3_webp || !im.s3) continue;
    const baseKey = baseKeyFromS3(im.s3);
    if (!baseKey) continue;
    process.stdout.write(`  ${rel} :: ${im.file}…`);
    try {
      const local = await fetchToTemp(im.s3);
      const v = await buildVariants(local, baseKey);
      await fs.unlink(local);
      Object.assign(im, v);
      console.log(' ✓');
      updated = true;
    } catch (e) { console.log(' ✗', e.message); }
  }
  if (updated) await fs.writeFile(full, yaml.dump(data, { lineWidth: 100, noRefs: true, quotingType: '"' }));
}

// ── post-inline images (frontmatter.images map) ──
for (const rel of await fg('content/musings/**/index.md', { cwd: ROOT })) {
  const full = path.join(ROOT, rel);
  const parsed = matter(await fs.readFile(full, 'utf8'));
  const map = parsed.data.images;
  if (!map || typeof map !== 'object') continue;
  let updated = false;
  for (const [file, entry] of Object.entries(map)) {
    if (entry?.s3_webp || !entry?.s3) continue;
    const baseKey = baseKeyFromS3(entry.s3);
    if (!baseKey) continue;
    process.stdout.write(`  ${rel} :: ${file}…`);
    try {
      const local = await fetchToTemp(entry.s3);
      const v = await buildVariants(local, baseKey);
      await fs.unlink(local);
      Object.assign(entry, v);
      console.log(' ✓');
      updated = true;
    } catch (e) { console.log(' ✗', e.message); }
  }
  if (updated) {
    if (parsed.data.date instanceof Date) parsed.data.date = asDateString(parsed.data.date);
    await fs.writeFile(full, matter.stringify(parsed.content, parsed.data));
  }
}

console.log('\ndone.');

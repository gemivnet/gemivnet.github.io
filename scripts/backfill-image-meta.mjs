// Backfill width/height (and bytes if missing) onto already-uploaded
// S3 images. Downloads each entry that's missing dims to a temp file,
// reads via sharp, then updates the source-of-truth metadata (post
// frontmatter or gallery metadata.yaml).
//
// Idempotent — skips entries that already have exif.width/height.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import yaml from 'js-yaml';
import matter from 'gray-matter';
import fg from 'fast-glob';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fetchDims(url) {
  const tmp = path.join(os.tmpdir(), `dims-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(tmp, buf);
  const meta = await sharp(tmp).metadata();
  await fs.unlink(tmp);
  return { width: meta.width, height: meta.height, bytes: buf.length };
}

function asDateString(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : d;
}

// ── musings ──
for (const rel of await fg('content/musings/**/index.md', { cwd: ROOT })) {
  const full = path.join(ROOT, rel);
  const parsed = matter(await fs.readFile(full, 'utf8'));
  const map = parsed.data.images;
  if (!map || typeof map !== 'object') continue;
  let updated = false;
  for (const [file, entry] of Object.entries(map)) {
    const hasDims = entry?.exif?.width && entry?.exif?.height;
    if (hasDims) continue;
    if (!entry?.s3) continue;
    process.stdout.write(`  ${rel} :: ${file}…`);
    try {
      const { width, height, bytes } = await fetchDims(entry.s3);
      entry.exif = { ...(entry.exif || {}), width, height };
      if (!entry.bytes) entry.bytes = bytes;
      console.log(` ${width}×${height}`);
      updated = true;
    } catch (e) { console.log(` ✗ ${e.message}`); }
  }
  if (updated) {
    if (parsed.data.date instanceof Date) parsed.data.date = asDateString(parsed.data.date);
    await fs.writeFile(full, matter.stringify(parsed.content, parsed.data));
  }
}

// ── galleries ──
for (const rel of await fg('content/media/**/metadata.yaml', { cwd: ROOT })) {
  const full = path.join(ROOT, rel);
  const data = yaml.load(await fs.readFile(full, 'utf8')) || {};
  if (!data.images?.length) continue;
  let updated = false;
  for (const im of data.images) {
    const hasDims = im?.exif?.width && im?.exif?.height;
    if (hasDims) continue;
    if (!im?.s3) continue;
    process.stdout.write(`  ${rel} :: ${im.file}…`);
    try {
      const { width, height, bytes } = await fetchDims(im.s3);
      im.exif = { ...(im.exif || {}), width, height };
      if (!im.bytes) im.bytes = bytes;
      console.log(` ${width}×${height}`);
      updated = true;
    } catch (e) { console.log(` ✗ ${e.message}`); }
  }
  if (updated) await fs.writeFile(full, yaml.dump(data, { lineWidth: 100, noRefs: true, quotingType: '"' }));
}

console.log('done.');

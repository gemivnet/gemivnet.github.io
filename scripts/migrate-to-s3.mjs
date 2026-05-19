// One-time migration: lift all in-repo images to S3, rewrite content
// references, delete local files. Idempotent — re-running skips already-
// uploaded files.
//
// Targets:
//   content/musings/<path>/media/*  → s3://<bucket>/musings/<path>/<slug>{.jpg,__med.jpg,__thumb.jpg}
//                                   → frontmatter.images map added to the post
//   content/media/<path>/*          → s3://<bucket>/<path>/<slug>{.jpg,__med.jpg,__thumb.jpg}
//                                   → metadata.yaml entries get s3/s3_med/s3_thumb/bytes

import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import yaml from 'js-yaml';
import matter from 'gray-matter';
import fg from 'fast-glob';
import exifr from 'exifr';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S3_BUCKET = 'georgemain-com-media';
const S3_BASE_URL = `https://${S3_BUCKET}.s3.amazonaws.com`;
const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const formatShutter = (t) => t == null ? null : t >= 1 ? t + 's' : '1/' + Math.round(1 / t);

async function readExif(abs) {
  try {
    const d = await exifr.parse(abs, { gps: true, tiff: true, exif: true });
    const camera = [d?.Make, d?.Model].filter(Boolean).join(' ').trim() || null;
    const out = {};
    if (camera)       out.camera = camera;
    if (d?.LensModel || d?.LensMake) out.lens = d.LensModel || d.LensMake;
    if (d?.ISO)       out.iso = d.ISO;
    if (d?.FNumber)   out.aperture = 'f/' + d.FNumber;
    if (d?.ExposureTime) out.shutter = formatShutter(d.ExposureTime);
    if (d?.FocalLength)  out.focal_length = Math.round(d.FocalLength) + 'mm';
    if (d?.ExifImageWidth || d?.ImageWidth)  out.width  = d.ExifImageWidth || d.ImageWidth;
    if (d?.ExifImageHeight || d?.ImageHeight) out.height = d.ExifImageHeight || d.ImageHeight;
    return out;
  } catch { return {}; }
}

async function renderThreeSizes(srcAbs) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const full  = path.join(os.tmpdir(), `mig-${id}-full.jpg`);
  const med   = path.join(os.tmpdir(), `mig-${id}-med.jpg`);
  const thumb = path.join(os.tmpdir(), `mig-${id}-thumb.jpg`);
  await sharp(srcAbs).rotate().jpeg({ quality: 92, progressive: true, mozjpeg: true }).toFile(full);
  await sharp(srcAbs).rotate().resize({ width: 1400, withoutEnlargement: true }).jpeg({ quality: 82, progressive: true, mozjpeg: true }).toFile(med);
  await sharp(srcAbs).rotate().resize({ width: 600, withoutEnlargement: true }).jpeg({ quality: 78, progressive: true, mozjpeg: true }).toFile(thumb);
  return { full, med, thumb };
}

function s3Upload(localPath, key) {
  execFileSync('aws', [
    's3', 'cp', localPath, `s3://${S3_BUCKET}/${key}`,
    '--content-type', 'image/jpeg',
    '--cache-control', 'public, max-age=31536000, immutable',
    '--no-progress',
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  return `${S3_BASE_URL}/${key}`;
}

async function uploadAllSizes(srcAbs, baseKey) {
  const sizes = await renderThreeSizes(srcAbs);
  const fullBytes = (await fs.stat(sizes.full)).size;
  const s3       = s3Upload(sizes.full,  `${baseKey}.jpg`);
  const s3_med   = s3Upload(sizes.med,   `${baseKey}__med.jpg`);
  const s3_thumb = s3Upload(sizes.thumb, `${baseKey}__thumb.jpg`);
  await fs.unlink(sizes.full); await fs.unlink(sizes.med); await fs.unlink(sizes.thumb);
  return { s3, s3_med, s3_thumb, bytes: fullBytes };
}

// ── post-inline image migration ───────────────────────────
async function migratePostImages() {
  const indices = await fg('content/musings/**/index.md', { cwd: ROOT });
  for (const rel of indices) {
    const full = path.join(ROOT, rel);
    const raw = await fs.readFile(full, 'utf8');
    const parsed = matter(raw);
    const mediaDir = path.join(path.dirname(full), 'media');
    let files;
    try { files = await fs.readdir(mediaDir); } catch { continue; }
    const imgs = files.filter(f => IMG_EXTS.has(path.extname(f).toLowerCase()));
    if (imgs.length === 0) continue;

    const existing = parsed.data.images || {};
    const postRel = path.dirname(rel).replace(/^content\/musings\//, '');
    let updated = false;

    for (const file of imgs) {
      if (existing[file]) {
        console.log(`  skip (already in frontmatter): ${rel} :: ${file}`);
        continue;
      }
      const slug = file.replace(/\.[^.]+$/, '');
      const srcAbs = path.join(mediaDir, file);
      const exif = await readExif(srcAbs);
      const baseKey = `musings/${postRel}/${slug}`;
      process.stdout.write(`  ↑ ${rel} :: ${file} -> s3://${S3_BUCKET}/${baseKey}…`);
      const urls = await uploadAllSizes(srcAbs, baseKey);
      console.log(' ✓');
      existing[file] = {
        ...urls,
        ...(Object.keys(exif).length ? { exif } : {}),
      };
      await fs.unlink(srcAbs);
      updated = true;
    }

    if (updated) {
      parsed.data.images = existing;
      // gray-matter renders Date objects as full ISO timestamps; coerce
      // YAML-parsed date values back to YYYY-MM-DD strings before writing.
      if (parsed.data.date instanceof Date) {
        parsed.data.date = parsed.data.date.toISOString().slice(0, 10);
      }
      const written = matter.stringify(parsed.content, parsed.data);
      await fs.writeFile(full, written);
      // Try to remove media/ if it's now empty
      try {
        const remaining = await fs.readdir(mediaDir);
        if (remaining.length === 0) await fs.rmdir(mediaDir);
      } catch {}
    }
  }
}

// ── gallery image migration ───────────────────────────────
async function migrateGalleries() {
  const yamls = await fg('content/media/**/metadata.yaml', { cwd: ROOT });
  for (const rel of yamls) {
    const full = path.join(ROOT, rel);
    const data = yaml.load(await fs.readFile(full, 'utf8')) || {};
    if (!data.images || !data.images.length) continue;
    const galleryPath = path.dirname(rel).replace(/^content\/media\//, '');
    let updated = false;
    for (const im of data.images) {
      if (im.s3) continue;
      if (!im.file) continue;
      const slug = im.file.replace(/\.[^.]+$/, '');
      const srcAbs = path.join(path.dirname(full), im.file);
      try { await fs.access(srcAbs); } catch { continue; }
      const exif = await readExif(srcAbs);
      const baseKey = `${galleryPath}/${slug}`;
      process.stdout.write(`  ↑ ${rel} :: ${im.file} -> s3://${S3_BUCKET}/${baseKey}…`);
      const urls = await uploadAllSizes(srcAbs, baseKey);
      console.log(' ✓');
      Object.assign(im, urls);
      if (Object.keys(exif).length && !im.exif) im.exif = exif;
      await fs.unlink(srcAbs);
      updated = true;
    }
    if (updated) {
      await fs.writeFile(full, yaml.dump(data, { lineWidth: 100, noRefs: true, quotingType: '"' }));
    }
  }
}

console.log('=== migrating post-inline images ===');
await migratePostImages();
console.log('\n=== migrating gallery images ===');
await migrateGalleries();
console.log('\nDone. Run `npm run build` to verify.');

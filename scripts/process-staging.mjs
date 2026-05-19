// Interactive media intake.
//
// Drop image files into ./staging/, then run:  npm run media
//
//   - Reads EXIF (date/time, GPS) from each file.
//   - Groups consecutive bursts by filename prefix + capture time so you only
//     answer gallery/date/location once per batch.
//   - Strips ALL metadata (incl. GPS) on output.
//   - Renames to img_NNN.jpg-style if you want, or keeps the original.
//   - Appends per-image entries to the gallery's metadata.yaml.
//
// Required answer per image: alt text. Build refuses to ship without it.

import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import yaml from 'js-yaml';
import fg from 'fast-glob';
import exifr from 'exifr';

const S3_BUCKET = 'georgemain-com-media';
const S3_BASE_URL = `https://${S3_BUCKET}.s3.amazonaws.com`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING = path.join(ROOT, 'staging');
const MEDIA = path.join(ROOT, 'content/media');

const rl = readline.createInterface({ input: stdin, output: stdout });
const ask = (q, def = '') => rl.question(def ? `${q} [${def}]: ` : `${q}: `).then(a => a.trim() || def);
const askYes = async (q, def = 'y') => {
  const a = (await rl.question(`${q} (${def === 'y' ? 'Y/n' : 'y/N'}): `)).trim().toLowerCase();
  if (!a) return def === 'y';
  return a.startsWith('y');
};

const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

// ── discover staging ──────────────────────────────────────
async function listStaging() {
  const files = await fg('*', { cwd: STAGING, onlyFiles: true, dot: false });
  return files
    .filter(f => IMG_EXTS.has(path.extname(f).toLowerCase()))
    .map(f => ({ name: f, abs: path.join(STAGING, f) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── read EXIF for date + GPS + camera details ─────────────
function formatShutter(t) {
  if (t == null) return null;
  if (t >= 1) return t + 's';
  return '1/' + Math.round(1 / t);
}
async function readExif(abs) {
  try {
    const d = await exifr.parse(abs, { gps: true, tiff: true, exif: true });
    const camera = [d?.Make, d?.Model].filter(Boolean).join(' ').trim() || null;
    return {
      date: d?.DateTimeOriginal || d?.CreateDate || d?.DateTime || null,
      lat: d?.latitude || null,
      lon: d?.longitude || null,
      camera,
      lens: d?.LensModel || d?.LensMake || null,
      iso: d?.ISO || null,
      aperture: d?.FNumber ? 'f/' + d.FNumber : null,
      shutter: formatShutter(d?.ExposureTime),
      focal_length: d?.FocalLength ? Math.round(d.FocalLength) + 'mm' : null,
      width: d?.ExifImageWidth || d?.ImageWidth || null,
      height: d?.ExifImageHeight || d?.ImageHeight || null,
    };
  } catch {
    return { date: null, lat: null, lon: null };
  }
}

// ── S3 upload via aws CLI ─────────────────────────────────
function uploadToS3(localPath, key) {
  execFileSync('aws', [
    's3', 'cp', localPath, `s3://${S3_BUCKET}/${key}`,
    '--content-type', 'image/jpeg',
    '--cache-control', 'public, max-age=31536000, immutable',
    '--no-progress',
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  return `${S3_BASE_URL}/${key}`;
}

// ── group files into bursts ───────────────────────────────
// A burst = same alpha prefix in filename + capture timestamps within 30 min
// of the previous. If no EXIF, fall back to filename adjacency.
function groupBursts(files, exifByFile) {
  const groups = [];
  let cur = null;
  for (const f of files) {
    const prefix = f.name.replace(/\d+\.[^.]+$/i, '');
    const exif = exifByFile[f.name];
    const t = exif?.date ? new Date(exif.date).getTime() : null;
    if (cur && cur.prefix === prefix &&
        (t == null || cur.lastT == null || Math.abs(t - cur.lastT) < 30 * 60 * 1000)) {
      cur.files.push(f);
      if (t != null) cur.lastT = t;
    } else {
      cur = { prefix, files: [f], lastT: t };
      groups.push(cur);
    }
  }
  return groups;
}

// ── list existing galleries ───────────────────────────────
async function listGalleries() {
  const metas = await fg('**/metadata.yaml', { cwd: MEDIA });
  const out = [];
  for (const m of metas) {
    const dir = path.dirname(m);
    const data = yaml.load(await fs.readFile(path.join(MEDIA, m), 'utf8')) || {};
    out.push({
      path: dir,
      title: data.title || dir,
      location: data.location || '',
      date: data.date ? String(data.date).slice(0, 10) : '',
      count: (data.images || []).length,
    });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// ── load/save metadata.yaml ───────────────────────────────
async function loadMeta(galleryPath) {
  const p = path.join(MEDIA, galleryPath, 'metadata.yaml');
  return yaml.load(await fs.readFile(p, 'utf8')) || {};
}
async function saveMeta(galleryPath, data) {
  const p = path.join(MEDIA, galleryPath, 'metadata.yaml');
  const dumped = yaml.dump(data, { lineWidth: 100, noRefs: true, quotingType: '"' });
  await fs.writeFile(p, dumped);
}

// ── ensure a gallery exists (create if needed) ────────────
async function ensureGallery(galleryPath) {
  const dir = path.join(MEDIA, galleryPath);
  const meta = path.join(dir, 'metadata.yaml');
  try { await fs.access(meta); return; } catch { /* create */ }

  await fs.mkdir(dir, { recursive: true });
  console.log(`\nCreating new gallery: /media/${galleryPath}`);
  const title = await ask('  title', galleryPath.split('/').pop());
  const subtitle = await ask('  subtitle (optional)', '');
  const location = await ask('  location (optional)', '');
  const date = await ask('  date (YYYY-MM-DD, optional)', '');
  const description = await ask('  seo description (1 sentence)', `Photos from ${title}${location ? ', ' + location : ''}.`);

  const data = {
    title,
    ...(subtitle && { subtitle }),
    ...(location && { location }),
    ...(date && { date }),
    seo: { description, keywords: [title.toLowerCase()] },
    images: [],
  };
  await saveMeta(galleryPath, data);
  console.log(`  ✓ created content/media/${galleryPath}/metadata.yaml`);
}

// ── pick the next img_NNN.jpg name ────────────────────────
function nextImgName(meta, ext) {
  let n = 1;
  const used = new Set((meta.images || []).map(i => i.file));
  while (used.has(`img_${String(n).padStart(3, '0')}${ext}`)) n++;
  return `img_${String(n).padStart(3, '0')}${ext}`;
}

// ── render the three sizes (full + med + thumb) into temp files ──
async function renderThreeSizes(srcAbs) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const full = path.join(os.tmpdir(), `stage-${id}-full.jpg`);
  const med  = path.join(os.tmpdir(), `stage-${id}-med.jpg`);
  const thumb = path.join(os.tmpdir(), `stage-${id}-thumb.jpg`);
  // sharp's default behavior strips all metadata — that's what we want.
  await sharp(srcAbs).rotate().jpeg({ quality: 92, progressive: true, mozjpeg: true }).toFile(full);
  await sharp(srcAbs).rotate().resize({ width: 1400, withoutEnlargement: true }).jpeg({ quality: 82, progressive: true, mozjpeg: true }).toFile(med);
  await sharp(srcAbs).rotate().resize({ width: 600, withoutEnlargement: true }).jpeg({ quality: 78, progressive: true, mozjpeg: true }).toFile(thumb);
  return { full, med, thumb };
}

// ── main flow ─────────────────────────────────────────────
async function main() {
  await fs.mkdir(STAGING, { recursive: true });

  const files = await listStaging();
  if (files.length === 0) {
    console.log(`Nothing in staging/. Drop image files into ${STAGING} and run again.`);
    rl.close();
    return;
  }

  console.log(`Found ${files.length} image(s) in staging.\nReading EXIF…`);
  const exifByFile = {};
  for (const f of files) exifByFile[f.name] = await readExif(f.abs);

  const groups = groupBursts(files, exifByFile);
  if (groups.length < files.length) {
    console.log(`Grouped into ${groups.length} burst(s) (similar names + capture time).`);
  }

  const galleries = await listGalleries();
  if (galleries.length) {
    console.log('\nExisting galleries:');
    galleries.forEach((g, i) => console.log(`  [${i + 1}] /${g.path}  —  ${g.title}  (${g.count} photos)`));
  }

  for (const group of groups) {
    console.log(`\n── batch of ${group.files.length} ${group.files.length === 1 ? 'file' : 'files'}:`);
    for (const f of group.files) {
      const ex = exifByFile[f.name];
      console.log(`     ${f.name}${ex?.date ? '  (' + new Date(ex.date).toISOString().slice(0, 19) + ')' : ''}${ex?.lat ? '  GPS✱' : ''}`);
    }

    // Pick gallery
    let galleryPath;
    const sel = await ask('  gallery (existing #, or new path like australia/sydney)', '');
    if (!sel) { console.log('  skipping batch'); continue; }
    if (/^\d+$/.test(sel)) {
      const g = galleries[parseInt(sel, 10) - 1];
      if (!g) { console.log('  bad index, skipping batch'); continue; }
      galleryPath = g.path;
    } else {
      galleryPath = sel.replace(/^\/+|\/+$/g, '');
      await ensureGallery(galleryPath);
      // refresh galleries list
      galleries.push(...(await listGalleries()).filter(g => !galleries.find(x => x.path === g.path)));
    }

    // Batch defaults
    const meta = await loadMeta(galleryPath);
    const exifTimes = group.files.map(f => exifByFile[f.name].date).filter(Boolean);
    const captureDate = exifTimes[0] ? new Date(exifTimes[0]).toISOString().slice(0, 10) : (meta.date ? String(meta.date).slice(0, 10) : '');
    const batchDate = await ask('  date for batch (YYYY-MM-DD)', captureDate);
    const batchLocation = await ask('  location for batch', meta.location || '');
    const rename = await askYes(`  rename to img_NNN.${path.extname(group.files[0].name).slice(1).toLowerCase()}?`, 'y');

    // Per-image questions
    for (const f of group.files) {
      console.log(`\n  • ${f.name}`);
      const ex = exifByFile[f.name];
      if (ex?.lat) console.log(`    (GPS will be stripped: ${ex.lat.toFixed(4)}, ${ex.lon.toFixed(4)})`);
      const title = await ask('    title (optional)', '');
      let alt;
      while (true) {
        alt = await ask('    alt (REQUIRED)', '');
        if (alt) break;
        console.log('    alt text is required — keeps the site accessible and SEO-readable.');
      }

      const ext = '.jpg';   // we normalize everything to jpeg on upload
      const out = rename ? nextImgName(meta, ext) : f.name.replace(/\.[^.]+$/, ext);
      const slug = out.replace(/\.[^.]+$/, '');

      // 1) render three sizes (full + med + thumb) from the scrubbed source
      const sizes = await renderThreeSizes(f.abs);
      const fullBytes = (await fs.stat(sizes.full)).size;
      // dimensions read from the rendered full (after rotate baking) — always available
      const fullMeta = await sharp(sizes.full).metadata();

      // 2) upload all three to S3
      const baseKey = `${galleryPath}/${slug}`;
      process.stdout.write(`    ↑ s3 (${(fullBytes/1024/1024).toFixed(1)} MB original + med + thumb)…`);
      const s3      = uploadToS3(sizes.full,  `${baseKey}.jpg`);
      const s3Med   = uploadToS3(sizes.med,   `${baseKey}__med.jpg`);
      const s3Thumb = uploadToS3(sizes.thumb, `${baseKey}__thumb.jpg`);
      console.log(' ✓');

      // 3) cleanup temp + staging — no local copies kept
      await fs.unlink(sizes.full);
      await fs.unlink(sizes.med);
      await fs.unlink(sizes.thumb);
      await fs.unlink(f.abs);

      // 5) build metadata entry — EXIF kept separate from photo
      const exifBlock = {};
      if (ex?.camera)       exifBlock.camera = ex.camera;
      if (ex?.lens)         exifBlock.lens = ex.lens;
      if (ex?.iso)          exifBlock.iso = ex.iso;
      if (ex?.aperture)     exifBlock.aperture = ex.aperture;
      if (ex?.shutter)      exifBlock.shutter = ex.shutter;
      if (ex?.focal_length) exifBlock.focal_length = ex.focal_length;
      // dimensions: prefer sharp's read of the final file (rotation-corrected),
      // fall back to EXIF if sharp can't tell.
      if (fullMeta?.width)  exifBlock.width  = fullMeta.width;
      else if (ex?.width)   exifBlock.width  = ex.width;
      if (fullMeta?.height) exifBlock.height = fullMeta.height;
      else if (ex?.height)  exifBlock.height = ex.height;

      const entry = {
        file: out,
        ...(title && { title }),
        date: batchDate || undefined,
        ...(batchLocation && { location: batchLocation }),
        alt,
        s3,
        s3_med: s3Med,
        s3_thumb: s3Thumb,
        bytes: fullBytes,
        ...(Object.keys(exifBlock).length ? { exif: exifBlock } : {}),
      };
      Object.keys(entry).forEach(k => entry[k] === undefined && delete entry[k]);

      meta.images = (meta.images || []).concat(entry);
      await saveMeta(galleryPath, meta);
      console.log(`    ✓ -> s3://${S3_BUCKET}/${baseKey}.jpg (full/med/thumb)`);
    }
  }

  console.log('\nDone. Run `npm run build` to preview, then commit.');
  rl.close();
}

main().catch(e => { console.error(e); rl.close(); process.exit(1); });

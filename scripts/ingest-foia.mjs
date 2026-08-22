// FOIA ingest — the mechanical half of publishing a records release.
//
// Two phases, because assigning documents to timeline events needs judgment
// and everything else doesn't:
//
//   node scripts/ingest-foia.mjs inspect dump/<slug>
//     Hashes every file, counts PDF pages, extracts text in memory, runs it
//     past the PII patterns, and prints a JSON manifest. Nothing is written.
//     The .claude/skills/add-foia-request skill reads this to classify the
//     documents and write request.yaml.
//
//   node scripts/ingest-foia.mjs publish <slug>
//     Reads content/foia/<slug>/request.yaml, finds documents carrying a
//     `dump_file:` key, uploads them to S3, builds and uploads a per-release
//     ZIP, rewrites the YAML with s3/bytes/sha256/pages, and deletes the
//     originals from dump/.
//
// Extracted PDF text is scanned and discarded. It is never written to disk and
// never published — the archive ships PDFs only.
//
// Files are deleted from dump/ only after their upload is confirmed. Without a
// usable AWS CLI the script writes dump/UPLOAD-<slug>.sh instead and leaves
// everything in place.

import { promises as fs, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import yaml from 'js-yaml';
import { writeZip } from './lib/zip.mjs';
import { loadAllowlist, scanText } from './lib/pii-patterns.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S3_BUCKET = 'georgemain-com-media';
const S3_BASE = `https://${S3_BUCKET}.s3.amazonaws.com`;
const PDFJS = path.join(ROOT, 'design/vendor/pdfjs');

const MIME = {
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain',
  '.csv': 'text/csv', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav',
};
const mimeFor = (f) => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n.toFixed(0) : n < 10 ? n.toFixed(1) : n.toFixed(0)) + ' ' + u[i];
};

async function sha256File(p) {
  const h = createHash('sha256');
  await pipeline(createReadStream(p), async function* (src) { for await (const c of src) h.update(c); });
  return h.digest('hex');
}

// ── pdf.js in Node ───────────────────────────────────────────
let _pdfjs;
async function pdfjs() {
  if (_pdfjs) return _pdfjs;
  // The import itself prints warnings to stdout — it probes for @napi-rs/canvas
  // and for DOM globals it can't polyfill under Node. All harmless here (we
  // only read text and page counts, never rasterise), but they would corrupt
  // the JSON manifest, so swallow them.
  _pdfjs = await quietly(() => import(pathToFileURL(path.join(PDFJS, 'pdf.min.mjs')).href));
  // Without an explicit workerSrc, pdf.js falls back to a "fake worker" and
  // tries to import the non-minified pdf.worker.mjs, which isn't vendored.
  _pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(PDFJS, 'pdf.worker.min.mjs')).href;
  return _pdfjs;
}

// pdf.js writes font/structure warnings with console.log, which lands on
// stdout — and `inspect` puts machine-readable JSON there. Patching `console`
// isn't enough: the warnings originate in pdf.js's worker thread, whose stdout
// is piped straight through to ours. Redirect at the stream level instead.
async function quietly(fn) {
  const realWrite = process.stdout.write.bind(process.stdout);
  const { log, warn, info } = console;
  process.stdout.write = (chunk, enc, cb) => process.stderr.write(chunk, enc, cb);
  console.log = console.warn = console.info = (...a) => process.stderr.write(a.join(' ') + '\n');
  try { return await fn(); }
  finally {
    process.stdout.write = realWrite;
    Object.assign(console, { log, warn, info });
  }
}

/** Page count + full text. Text is returned to the caller and never persisted. */
async function readPdf(abs) {
  const lib = await pdfjs();
  const data = new Uint8Array(await fs.readFile(abs));
  return quietly(async () => {
    const doc = await lib.getDocument({
      data,
      standardFontDataUrl: path.join(PDFJS, 'standard_fonts') + path.sep,
      verbosity: 0,
    }).promise;
    const pages = doc.numPages;
    let text = '';
    for (let i = 1; i <= pages; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      text += tc.items.map((it) => it.str).join(' ') + '\n';
    }
    await doc.destroy();
    return { pages, text };
  });
}

// ── inspect ──────────────────────────────────────────────────
async function inspect(dumpDir) {
  const abs = path.resolve(ROOT, dumpDir);
  const names = (await fs.readdir(abs, { withFileTypes: true }))
    .filter((d) => d.isFile() && !d.name.startsWith('.') && d.name !== 'UPLOAD.sh')
    .map((d) => d.name).sort();

  const isAllowed = loadAllowlist(ROOT);
  const out = { dir: dumpDir, files: [], pii: [] };

  for (const name of names) {
    const p = path.join(abs, name);
    const st = await fs.stat(p);
    const rec = { file: name, bytes: st.size, bytesFmt: fmtBytes(st.size), sha256: await sha256File(p) };
    let text = '';

    if (path.extname(name).toLowerCase() === '.pdf') {
      try {
        const r = await readPdf(p);
        rec.pages = r.pages;
        text = r.text;
        rec.textChars = text.replace(/\s+/g, '').length;
        // A PDF with a page count but essentially no text is a scan. Worth
        // knowing: it is invisible to search engines and to this PII scan.
        rec.likelyScanned = rec.textChars < r.pages * 40;
        rec.preview = text.replace(/\s+/g, ' ').trim().slice(0, 1200);
      } catch (e) {
        rec.error = String(e.message || e);
      }
    } else if (/\.(txt|csv|md|json)$/i.test(name)) {
      text = await fs.readFile(p, 'utf8');
      rec.textChars = text.length;
      rec.preview = text.replace(/\s+/g, ' ').trim().slice(0, 1200);
    }

    if (text) {
      const hits = scanText(text, isAllowed);
      // Collapse duplicates — a phone number in an email footer repeats on
      // every page and would otherwise bury the one-off that matters.
      const seen = new Map();
      for (const h of hits) {
        const k = h.type + '|' + h.match;
        if (!seen.has(k)) seen.set(k, { ...h, file: name, count: 0 });
        seen.get(k).count++;
      }
      out.pii.push(...seen.values());
    }
    out.files.push(rec);
  }

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');

  console.error(`\n── ${dumpDir} — ${out.files.length} file(s) ──`);
  for (const f of out.files) {
    console.error(`  ${f.file}`);
    console.error(`     ${f.bytesFmt}${f.pages ? ` · ${f.pages} pp` : ''}` +
                  `${f.likelyScanned ? '  ⚠ looks scanned (no text layer)' : ''}` +
                  `${f.error ? `  ✗ ${f.error}` : ''}`);
  }
  if (out.pii.length) {
    console.error(`\n⚠ ${out.pii.length} PII pattern hit(s) — review before publishing.`);
    console.error('  Officials acting officially are normally fine; private individuals are not.\n');
    for (const h of out.pii.slice(0, 40)) {
      console.error(`  [${h.type}] ${JSON.stringify(h.match)}${h.count > 1 ? ` ×${h.count}` : ''}  (${h.file})`);
    }
    if (out.pii.length > 40) console.error(`  … and ${out.pii.length - 40} more (see JSON)`);
  } else {
    console.error('\n✓ no PII pattern hits.');
  }
  console.error('');
}

// ── publish ──────────────────────────────────────────────────

// Resolve the AWS CLI. Bare `aws` is tried first, but a per-user MSI install on
// Windows puts it under LOCALAPPDATA and doesn't always land on PATH — and an
// already-running shell won't see a PATH edit anyway. Falling back to the known
// install locations means ingest works without anyone re-opening a terminal.
let _awsBin;
function awsBin() {
  if (_awsBin !== undefined) return _awsBin;
  const candidates = [
    'aws',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/Amazon/AWSCLIV2/aws.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Amazon/AWSCLIV2/aws.exe'),
    '/usr/local/bin/aws',
    '/opt/homebrew/bin/aws',
  ].filter(Boolean);
  for (const c of candidates) {
    try { execFileSync(c, ['--version'], { stdio: 'ignore' }); _awsBin = c; return c; }
    catch { /* try the next one */ }
  }
  _awsBin = null;
  return null;
}

const hasAws = () => awsBin() !== null;

/** True when the CLI is present *and* has usable credentials. */
function awsAuthed() {
  const bin = awsBin();
  if (!bin) return false;
  try { execFileSync(bin, ['sts', 'get-caller-identity'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

function s3Upload(local, key, contentType) {
  execFileSync(awsBin(), [
    's3', 'cp', local, `s3://${S3_BUCKET}/${key}`,
    '--content-type', contentType,
    '--cache-control', 'public, max-age=31536000, immutable',
    '--no-progress',
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  return `${S3_BASE}/${key}`;
}

const shq = (s) => `'` + String(s).replace(/'/g, `'\\''`) + `'`;

async function publish(slug, opts) {
  const reqPath = path.join(ROOT, 'content/foia', slug, 'request.yaml');
  // dump_file paths are relative to dump/, not dump/<slug>/, so one archive
  // entry can draw on several intake folders — the Clow entry pulls from both
  // the Village dump and the FAA one.
  const dumpRoot = path.join(ROOT, 'dump');
  const data = yaml.load(await fs.readFile(reqPath, 'utf8'));

  // Check credentials, not just the binary. Discovering the CLI can't
  // authenticate halfway through a 24 MB upload is worse than not starting.
  const aws = opts.noUpload ? false : awsAuthed();
  if (!aws) {
    if (opts.noUpload)      console.error('· --no-upload: writing UPLOAD.sh, keeping originals in dump/');
    else if (!hasAws())     console.error('· aws CLI not found: writing UPLOAD.sh, keeping originals in dump/');
    else                    console.error('· aws CLI found but not authenticated (run `aws configure`): writing UPLOAD.sh, keeping originals in dump/');
  }

  const cmds = [];
  const uploaded = [];      // dump paths safe to delete
  let changed = false;

  for (const ev of data.timeline || []) {
    if (!ev.files || !ev.files.length) continue;
    const zipEntries = [];

    for (const d of ev.files) {
      const publishName = d.file || d.dump_file;
      if (!d.dump_file) {
        // Already published; still collect it for the bundle if we can reach it.
        continue;
      }
      const srcAbs = path.join(dumpRoot, d.dump_file);
      try { await fs.access(srcAbs); }
      catch { throw new Error(`${slug}/${ev.id}: dump file not found: dump/${d.dump_file}`); }

      const st = await fs.stat(srcAbs);
      d.bytes = st.size;
      d.sha256 = await sha256File(srcAbs);
      if (path.extname(publishName).toLowerCase() === '.pdf' && d.pages == null) {
        try { d.pages = (await readPdf(srcAbs)).pages; } catch { /* leave unset */ }
      }

      const key = `foia/${slug}/${ev.id}/${publishName}`;
      const ct = mimeFor(publishName);
      if (aws) {
        process.stderr.write(`  ↑ ${publishName} (${fmtBytes(st.size)}) → s3://${S3_BUCKET}/${key} … `);
        d.s3 = s3Upload(srcAbs, key, ct);
        console.error('✓');
        uploaded.push(srcAbs);
        delete d.dump_file;
      } else {
        d.s3 = `${S3_BASE}/${key}`;
        cmds.push(`aws s3 cp ${shq(`dump/${d.dump_file}`)} ${shq(`s3://${S3_BUCKET}/${key}`)} \\\n` +
                  `  --content-type ${shq(ct)} --cache-control 'public, max-age=31536000, immutable'`);
      }
      d.file = publishName;
      zipEntries.push({ name: publishName, path: srcAbs });
      changed = true;
    }

    // Bundle: only worth it for a multi-document release, and only when every
    // file in the release was staged this run. Zipping a partial set would
    // publish a "download all" that quietly isn't all of it.
    if (zipEntries.length > 1 && zipEntries.length < ev.files.length) {
      console.error(`  ⚠ ${ev.id}: ${zipEntries.length} of ${ev.files.length} files staged — skipping the bundle. ` +
                    `Re-run with every document unpublished to rebuild it.`);
    } else if (zipEntries.length > 1) {
      const zipName = `${ev.id}.zip`;
      const tmp = path.join(os.tmpdir(), `foia-${slug}-${ev.id}.zip`);
      process.stderr.write(`  ⧉ bundling ${zipEntries.length} files → ${zipName} … `);
      const z = await writeZip(tmp, zipEntries, { date: new Date(ev.date) });
      console.error(`${fmtBytes(z.bytes)} ✓`);

      const key = `foia/${slug}/${zipName}`;
      if (aws) {
        process.stderr.write(`  ↑ ${zipName} → s3://${S3_BUCKET}/${key} … `);
        s3Upload(tmp, key, 'application/zip');
        console.error('✓');
        await fs.rm(tmp, { force: true });
      } else {
        // Keep the built bundle so UPLOAD.sh has something real to push.
        const keepDir = path.join(dumpRoot, '.bundles', slug);
        await fs.mkdir(keepDir, { recursive: true });
        const keep = path.join(keepDir, zipName);
        await fs.rename(tmp, keep).catch(async () => {
          await fs.copyFile(tmp, keep); await fs.rm(tmp, { force: true });
        });
        cmds.push(`aws s3 cp ${shq(`dump/.bundles/${slug}/${zipName}`)} ${shq(`s3://${S3_BUCKET}/${key}`)} \\\n` +
                  `  --content-type 'application/zip' --cache-control 'public, max-age=31536000, immutable'`);
      }
      ev.zip = { s3: `${S3_BASE}/${key}`, bytes: z.bytes, sha256: z.sha256 };
      changed = true;
    }
  }

  if (!changed) { console.error('· nothing to publish (no dump_file entries left)'); return; }

  // js-yaml parses `2026-07-19` into a Date and dumps it back as a full ISO
  // timestamp. That is both noisier than the source and a false positive for
  // the pre-commit scanner's precise-timestamp rule, so put plain dates back.
  const datesToStrings = (v) => {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (Array.isArray(v)) return v.map(datesToStrings);
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) v[k] = datesToStrings(v[k]);
    }
    return v;
  };
  datesToStrings(data);

  await fs.writeFile(reqPath, yaml.dump(data, { lineWidth: 100, noRefs: true, quotingType: '"' }));
  console.error(`· wrote ${path.relative(ROOT, reqPath)}`);

  if (aws) {
    // Only now, with every upload confirmed, are the originals expendable.
    for (const p of uploaded) await fs.rm(p, { force: true });
    console.error(`· consumed ${uploaded.length} file(s) from dump/`);
    // Clear the artefacts of any earlier no-credentials run. A leftover
    // UPLOAD-<slug>.sh reads as "work still pending" when it isn't.
    const stale = path.join(ROOT, 'dump', `UPLOAD-${slug}.sh`);
    if (await fs.rm(stale, { force: true }).then(() => true).catch(() => false)) { /* best effort */ }
    await fs.rm(path.join(dumpRoot, '.bundles', slug), { recursive: true, force: true });
    // Sweep any intake folder this emptied.
    for (const dir of new Set(uploaded.map((p) => path.dirname(p)))) {
      const left = (await fs.readdir(dir).catch(() => [])).filter((f) => !f.startsWith('.'));
      if (left.length === 0) {
        await fs.rmdir(dir).catch(() => {});
        console.error(`· ${path.relative(ROOT, dir)} is empty, removed`);
      } else {
        console.error(`· ${path.relative(ROOT, dir)} still holds: ${left.join(', ')}`);
      }
    }
  } else {
    const sh = ['#!/usr/bin/env bash',
      '# Generated by scripts/ingest-foia.mjs — run from the repo root.',
      '# Originals were NOT deleted, because nothing was uploaded yet.',
      '# Once this completes, re-run: node scripts/ingest-foia.mjs publish ' + slug,
      'set -euo pipefail', '', ...cmds, '',
      `echo 'uploaded ${cmds.length} object(s).'`, ''].join('\n');
    const shPath = path.join(ROOT, 'dump', `UPLOAD-${slug}.sh`);
    await fs.writeFile(shPath, sh);
    console.error(`· wrote dump/UPLOAD-${slug}.sh (${cmds.length} uploads)`);
    console.error('· request.yaml already points at the final S3 URLs; those pages 404 until you run it.');
    console.error('· nothing deleted from dump/.');
  }
}

// ── main ─────────────────────────────────────────────────────
const [cmd, arg, ...rest] = process.argv.slice(2);
const opts = { noUpload: rest.includes('--no-upload') || process.argv.includes('--no-upload') };

try {
  if (cmd === 'inspect' && arg) await inspect(arg);
  else if (cmd === 'publish' && arg) await publish(arg, opts);
  else {
    console.error('usage:');
    console.error('  node scripts/ingest-foia.mjs inspect dump/<slug>');
    console.error('  node scripts/ingest-foia.mjs publish <slug> [--no-upload]');
    process.exit(1);
  }
} catch (e) {
  console.error('✗ ' + (e.message || e));
  process.exit(1);
}

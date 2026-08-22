// Minimal ZIP writer. Zero dependencies — DEFLATE comes from node:zlib.
//
// Exists so the FOIA archive can offer a "download everything" bundle per
// release without pulling in archiver/jszip. Writes entries to disk one at a
// time and keeps only the central directory in memory, so bundling a 2 GB
// release costs a few KB of RAM rather than 2 GB.
//
// Output is deterministic: same inputs + same `date` produce a byte-identical
// archive. That matters because ingest records each ZIP's sha256 in
// request.yaml — a nondeterministic writer would churn that hash on every
// re-run and make the recorded integrity check meaningless.
//
//   import { writeZip } from './lib/zip.mjs';
//   const { bytes, sha256 } = await writeZip('out.zip', [
//     { name: '001-cover-letter.pdf', path: '/abs/001-cover-letter.pdf' },
//   ], { date: new Date('2026-06-02') });
//
// Non-ZIP64 only. Throws rather than emitting a corrupt archive if the inputs
// exceed what 32-bit headers can address (see assertFits below).

import { promises as fs, createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

// Files at or above this are stored uncompressed and streamed. deflateRawSync
// needs the whole file resident, and PDFs — already DEFLATE-compressed
// internally — typically shrink by low single-digit percent, so buying that
// with a multi-hundred-MB allocation is a bad trade.
const STREAM_THRESHOLD = 64 * 1024 * 1024;

const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

// ── CRC-32 ───────────────────────────────────────────────────
// node:zlib gained a crc32() export in 20.15 / 22.2, but package.json only
// requires node >=20, so a 20.0-20.14 runtime would fail at import time on a
// script that is otherwise dependency-free. 12 lines is cheaper than that.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32Update = (crc, buf) => {
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return crc;
};
const crc32 = (buf) => (crc32Update(~0, buf) ^ ~0) >>> 0;

// ── DOS date/time ────────────────────────────────────────────
// ZIP timestamps are local-time MS-DOS fields with 2-second resolution and a
// 1980 epoch. Read in UTC so the archive doesn't change with the build
// machine's timezone.
function dosDateTime(d) {
  const year = d.getUTCFullYear();
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 }; // clamp to 1980-01-01
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

function assertFits(what, n, max) {
  if (n > max) {
    throw new Error(
      `zip: ${what} (${n}) exceeds the ${max} limit of a non-ZIP64 archive. ` +
      `Split this release into multiple bundles, or add ZIP64 support to scripts/lib/zip.mjs.`,
    );
  }
}

// Local file header — 30 bytes + name.
function localHeader(e) {
  const name = Buffer.from(e.name, 'utf8');
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);   // signature
  b.writeUInt16LE(20, 4);           // version needed (2.0)
  b.writeUInt16LE(0x0800, 6);       // flags: bit 11 = filename is UTF-8
  b.writeUInt16LE(e.method, 8);
  b.writeUInt16LE(e.time, 10);
  b.writeUInt16LE(e.date, 12);
  b.writeUInt32LE(e.crc, 14);
  b.writeUInt32LE(e.compressedSize, 18);
  b.writeUInt32LE(e.uncompressedSize, 22);
  b.writeUInt16LE(name.length, 26);
  b.writeUInt16LE(0, 28);           // extra field length
  return Buffer.concat([b, name]);
}

// Central directory header — 46 bytes + name.
function centralHeader(e) {
  const name = Buffer.from(e.name, 'utf8');
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(20, 4);           // version made by
  b.writeUInt16LE(20, 6);           // version needed
  b.writeUInt16LE(0x0800, 8);
  b.writeUInt16LE(e.method, 10);
  b.writeUInt16LE(e.time, 12);
  b.writeUInt16LE(e.date, 14);
  b.writeUInt32LE(e.crc, 16);
  b.writeUInt32LE(e.compressedSize, 20);
  b.writeUInt32LE(e.uncompressedSize, 24);
  b.writeUInt16LE(name.length, 28);
  b.writeUInt16LE(0, 30);           // extra
  b.writeUInt16LE(0, 32);           // comment
  b.writeUInt16LE(0, 34);           // disk number
  b.writeUInt16LE(0, 36);           // internal attrs
  b.writeUInt32LE(0o644 << 16, 38); // external attrs: unix 0644
  b.writeUInt32LE(e.offset, 42);
  return Buffer.concat([b, name]);
}

function endOfCentralDirectory(count, size, offset) {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(0, 4);            // disk number
  b.writeUInt16LE(0, 6);            // disk with central dir
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(size, 12);
  b.writeUInt32LE(offset, 16);
  b.writeUInt16LE(0, 20);           // comment length
  return b;
}

/**
 * Write a ZIP archive.
 *
 * @param {string} outPath           destination .zip path
 * @param {{name: string, path: string}[]} files  entry name (as it appears in
 *                                   the archive) and absolute source path
 * @param {{date?: Date}} [opts]     timestamp stamped on every entry; fix it to
 *                                   keep the output byte-stable
 * @returns {Promise<{bytes: number, sha256: string, entries: number}>}
 */
export async function writeZip(outPath, files, opts = {}) {
  assertFits('entry count', files.length, MAX_ENTRIES);

  const seen = new Set();
  for (const f of files) {
    if (seen.has(f.name)) throw new Error(`zip: duplicate entry name "${f.name}"`);
    seen.add(f.name);
  }

  const { time, date } = dosDateTime(opts.date instanceof Date ? opts.date : new Date(0));
  const out = createWriteStream(outPath);
  const central = [];
  let offset = 0;

  // Backpressure-aware write. Without the drain wait, a large release queues
  // every chunk in memory and defeats the point of streaming.
  const write = (buf) => new Promise((resolve, reject) => {
    out.write(buf, (err) => (err ? reject(err) : resolve()));
  });

  try {
    for (const f of files) {
      const stat = await fs.stat(f.path);
      assertFits(`file "${f.name}"`, stat.size, MAX_U32);

      let method, crc, compressed, compressedSize;

      if (stat.size < STREAM_THRESHOLD) {
        const raw = await fs.readFile(f.path);
        crc = crc32(raw);
        const deflated = deflateRawSync(raw, { level: 9 });
        // Storing beats deflating whenever compression didn't help — routine
        // for PDFs, JPEGs, and anything already compressed.
        if (deflated.length < raw.length) {
          method = 8; compressed = deflated;
        } else {
          method = 0; compressed = raw;
        }
        compressedSize = compressed.length;
      } else {
        // Too big to hold in memory: STORE, and compute the CRC in a first
        // pass so the local header can carry real sizes (no data descriptor).
        method = 0;
        let running = ~0;
        await pipeline(createReadStream(f.path), async function* (source) {
          for await (const chunk of source) running = crc32Update(running, chunk);
        });
        crc = (running ^ ~0) >>> 0;
        compressed = null;
        compressedSize = stat.size;
      }

      assertFits(`compressed size of "${f.name}"`, compressedSize, MAX_U32);
      assertFits('archive size', offset + compressedSize, MAX_U32);

      const entry = {
        name: f.name, method, crc, time, date,
        compressedSize, uncompressedSize: stat.size, offset,
      };

      const header = localHeader(entry);
      await write(header);
      offset += header.length;

      if (compressed) {
        await write(compressed);
      } else {
        // Second pass: stream the bytes straight through, no buffering.
        await pipeline(createReadStream(f.path), out, { end: false });
      }
      offset += compressedSize;

      central.push(entry);
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const e of central) {
      const h = centralHeader(e);
      await write(h);
      centralSize += h.length;
    }
    assertFits('central directory offset', centralStart, MAX_U32);
    await write(endOfCentralDirectory(central.length, centralSize, centralStart));

    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await fs.rm(outPath, { force: true });   // never leave a half-written archive
    throw err;
  }

  // Hash the finished file so request.yaml can record it.
  const hash = createHash('sha256');
  await pipeline(createReadStream(outPath), async function* (source) {
    for await (const chunk of source) hash.update(chunk);
  });
  const { size } = await fs.stat(outPath);

  return { bytes: size, sha256: hash.digest('hex'), entries: central.length };
}

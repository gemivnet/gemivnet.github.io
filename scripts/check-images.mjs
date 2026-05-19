// Verify every S3 image URL referenced from content/* actually exists.
// Run manually before a big push: `npm run check:images`.
//
// HEADs each unique URL concurrently (limit 8). Exits non-zero with a list
// if any return 404 / 403.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import matter from 'gray-matter';
import fg from 'fast-glob';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEYS = ['s3', 's3_med', 's3_thumb', 's3_webp', 's3_med_webp', 's3_thumb_webp'];

const urls = new Set();
const sources = new Map(); // url -> ["where it's referenced"]
const ref = (url, where) => {
  if (!url || !url.startsWith('http')) return;
  urls.add(url);
  if (!sources.has(url)) sources.set(url, []);
  sources.get(url).push(where);
};

// galleries
for (const rel of await fg('content/media/**/metadata.yaml', { cwd: ROOT })) {
  const data = yaml.load(await fs.readFile(path.join(ROOT, rel), 'utf8')) || {};
  for (const im of data.images || []) {
    for (const k of KEYS) ref(im[k], `${rel} :: ${im.file}`);
  }
}
// post-inline images
for (const rel of await fg('content/musings/**/index.md', { cwd: ROOT })) {
  const parsed = matter(await fs.readFile(path.join(ROOT, rel), 'utf8'));
  const map = parsed.data.images || {};
  for (const [file, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== 'object') continue;
    for (const k of KEYS) ref(entry[k], `${rel} :: ${file}`);
  }
}

console.log(`checking ${urls.size} S3 image URLs…`);
const broken = [];
const list = [...urls];
const LIMIT = 8;
async function worker(i) {
  while (i < list.length) {
    const url = list[i]; i += LIMIT;
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (!res.ok) broken.push({ url, status: res.status });
    } catch (e) {
      broken.push({ url, status: e.message });
    }
  }
}
await Promise.all(Array.from({ length: LIMIT }, (_, i) => worker(i)));

if (broken.length === 0) {
  console.log(`✓ all ${urls.size} S3 references resolve.`);
  process.exit(0);
}
console.error(`\n✗ ${broken.length} broken / unreachable URL(s):\n`);
for (const b of broken) {
  console.error(`  [${b.status}] ${b.url}`);
  for (const where of sources.get(b.url) || []) console.error(`        from: ${where}`);
}
process.exit(1);

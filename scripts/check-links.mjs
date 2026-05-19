// Crawl _site/ HTML and HEAD every external href.
// Reports redirects + 4xx / 5xx + unreachable.
// Skips rate-limit-prone domains (twitter, github.com — overridable).
// Run: `npm run build && npm run check:links`

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fg from 'fast-glob';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, '_site');
const SKIP_HOSTS = new Set(['twitter.com', 'x.com', 'instagram.com']);

const urls = new Map(); // url -> [pages it appears on]
for (const rel of await fg('**/*.html', { cwd: SITE })) {
  const html = await fs.readFile(path.join(SITE, rel), 'utf8');
  const re = /href\s*=\s*"(https?:\/\/[^"]+)"/gi;
  let m;
  while ((m = re.exec(html))) {
    const u = m[1];
    const host = (() => { try { return new URL(u).host; } catch { return ''; } })();
    if (SKIP_HOSTS.has(host.replace(/^www\./, ''))) continue;
    if (host.endsWith('georgemain.com') || host.endsWith('amazonaws.com')) continue;
    if (!urls.has(u)) urls.set(u, []);
    urls.get(u).push(rel);
  }
}

console.log(`checking ${urls.size} external URLs from ${(await fg('**/*.html', { cwd: SITE })).length} pages…\n`);
const out = [];
const list = [...urls.keys()];
const LIMIT = 8;
async function worker(start) {
  for (let i = start; i < list.length; i += LIMIT) {
    const url = list[i];
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': 'gm-link-check' } });
      clearTimeout(t);
      if (res.status >= 400) out.push({ url, status: res.status });
      else if (res.status >= 300 && res.status < 400) out.push({ url, status: res.status, redirect: res.headers.get('location') });
    } catch (e) {
      out.push({ url, status: e.name === 'AbortError' ? 'timeout' : e.code || 'fetch-error' });
    }
  }
}
await Promise.all(Array.from({ length: LIMIT }, (_, i) => worker(i)));

if (out.length === 0) {
  console.log(`✓ all ${urls.size} external URLs are fine.`);
  process.exit(0);
}
for (const r of out) {
  console.log(`  [${r.status}]${r.redirect ? ' → ' + r.redirect : ''}  ${r.url}`);
  for (const p of urls.get(r.url).slice(0, 3)) console.log(`        in ${p}`);
}
console.log(`\n${out.length} issue(s). Non-zero exit so CI can fail if you wire it in.`);
process.exit(1);

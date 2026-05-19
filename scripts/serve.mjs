// minimal static file server for local preview of _site
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '_site');
const PORT = process.env.PORT || 4321;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveFile(p, res) {
  try {
    const data = await fs.readFile(p);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
    return true;
  } catch { return false; }
}

http.createServer(async (req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url.endsWith('/')) url += 'index.html';
  let p = path.join(ROOT, url);
  if (!p.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (await serveFile(p, res)) return;
  // try clean URL: /foo -> /foo/index.html or /foo.html
  if (!path.extname(p)) {
    if (await serveFile(p + '.html', res)) return;
    if (await serveFile(path.join(p, 'index.html'), res)) return;
  }
  const fallback = await fs.readFile(path.join(ROOT, '404.html')).catch(() => null);
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fallback || 'Not found');
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));

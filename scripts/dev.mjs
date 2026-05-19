// `npm run dev` — watch + rebuild + serve.
// Watches content/ templates/ design/ copy.yaml site.config.* + scripts/build.mjs.
// On any change: debounced rebuild. Serve _site at :4321.
// Press Ctrl+C to stop.

import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WATCH = ['content', 'templates', 'design', 'copy.yaml', 'scripts/build.mjs'];
const PORT = process.env.PORT || 4321;

let building = false;
let queued = false;
async function rebuild() {
  if (building) { queued = true; return; }
  building = true;
  const start = Date.now();
  await new Promise(res => {
    const p = spawn('node', ['scripts/build.mjs'], { cwd: ROOT, stdio: 'inherit' });
    p.on('exit', () => res());
  });
  building = false;
  process.stdout.write(`\x1b[2m  ↻ rebuilt in ${Date.now() - start}ms\x1b[0m\n`);
  if (queued) { queued = false; rebuild(); }
}

let timer = null;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(rebuild, 80);
}

for (const w of WATCH) {
  try {
    watch(path.join(ROOT, w), { recursive: true }, () => schedule());
  } catch (e) { /* file doesn't exist (e.g. content/media empty) */ }
}

await rebuild();
spawn('node', ['scripts/serve.mjs'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PORT } });
process.stdout.write(`\nwatching for changes — Ctrl+C to stop.\n`);

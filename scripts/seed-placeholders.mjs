// One-off script: generate placeholder JPEGs for sample galleries so the build has real images.
import sharp from 'sharp';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PLACEHOLDERS = [
  // Australia / Tasmania / MONA
  { path: 'content/media/australia/tasmania/mona', file: 'img_001.jpg', color: '#3b2a20', label: 'wall · of · casts' },
  { path: 'content/media/australia/tasmania/mona', file: 'img_002.jpg', color: '#1a1a22', label: 'rain · room' },
  { path: 'content/media/australia/tasmania/mona', file: 'img_003.jpg', color: '#403028', label: 'cantina · stairwell' },
  // Australia / Tasmania / Freycinet
  { path: 'content/media/australia/tasmania/freycinet', file: 'img_001.jpg', color: '#3a5a72', label: 'wineglass · bay' },
  { path: 'content/media/australia/tasmania/freycinet', file: 'img_002.jpg', color: '#264052', label: 'eucalypts · dawn' },
  // Australia / Sydney
  { path: 'content/media/australia/sydney', file: 'img_001.jpg', color: '#2a3a48', label: 'harbour · 6am' },
  { path: 'content/media/australia/sydney', file: 'img_002.jpg', color: '#3a2a2a', label: 'redfern · alley' },
  // Japan / 2024-spring
  { path: 'content/media/japan/2024-spring', file: 'yokohama-pier-08.jpg', color: '#523040', label: 'osanbashi · dawn' },
  { path: 'content/media/japan/2024-spring', file: 'kumano-shrine.jpg', color: '#1f3024', label: 'kumano · shrine' },
  { path: 'content/media/japan/2024-spring', file: 'ramen-bowl.jpg', color: '#3a2418', label: 'ramen · 1am' },
  // Budapest
  { path: 'content/media/budapest', file: 'img_001.jpg', color: '#3a3022', label: 'parliament · dusk' },
  { path: 'content/media/budapest', file: 'img_002.jpg', color: '#241a18', label: 'ruin · bar' },
];

for (const p of PLACEHOLDERS) {
  const dir = path.join(ROOT, p.path);
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, p.file);
  // Tinted noise placeholder.
  const W = 1800, H = 1200;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${p.color}" />
        <stop offset="1" stop-color="#0a0a0a" />
      </linearGradient>
      <pattern id="stripes" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
        <line x1="0" y1="0" x2="0" y2="14" stroke="rgba(255,255,255,0.04)" stroke-width="6"/>
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <rect width="100%" height="100%" fill="url(#stripes)"/>
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
          font-family="IBM Plex Mono, monospace" font-size="42"
          fill="rgba(255,255,255,0.4)" letter-spacing="6">[ ${p.label} ]</text>
  </svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toFile(out);
  console.log('wrote', path.relative(ROOT, out));
}

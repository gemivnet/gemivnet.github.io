// georgemain.com — static site build
//
// One file, top to bottom. Reads content/, writes _site/.
// Fails loud on broken internal links, missing images, malformed frontmatter.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { Eta } from 'eta';
import matter from 'gray-matter';
import { marked } from 'marked';
import yaml from 'js-yaml';
import fg from 'fast-glob';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = (p) => path.join(ROOT, p);
const OUT = SRC('_site');

const COPY = yaml.load(await fs.readFile(SRC('copy.yaml'), 'utf8'));
const SITE = COPY.site;

// Auto-increment version from git commit count, unless overridden.
function computeVersion() {
  if (SITE.version_override) return SITE.version_override;
  try {
    const n = parseInt(execSync('git rev-list --count HEAD', { cwd: ROOT }).toString().trim(), 10);
    return 'v' + (Number.isFinite(n) ? n : 1);
  } catch {
    return 'v1';
  }
}
SITE.version = computeVersion();

const eta = new Eta({
  views: SRC('templates'),
  cache: false,
  autoEscape: false,
  useWith: true,
});

const errors = [];
const fail = (msg) => errors.push(msg);
const log = (...a) => console.log('·', ...a);

// ── helpers ──────────────────────────────────────────────────

const ensureDir = (p) => fs.mkdir(p, { recursive: true });
const exists = async (p) => !!(await fs.stat(p).catch(() => false));

const writeFile = async (rel, body) => {
  const p = path.join(OUT, rel);
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, body);
};

const copyFile = async (from, toRel) => {
  const to = path.join(OUT, toRel);
  await ensureDir(path.dirname(to));
  await fs.copyFile(from, to);
};

const copyTree = async (from, toRel) => {
  const files = await fg('**/*', { cwd: from, dot: false, onlyFiles: true });
  for (const f of files) await copyFile(path.join(from, f), path.join(toRel, f));
};

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const decodeEntities = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&(amp|lt|gt|quot|apos|nbsp|hellip|mdash|ndash|rsquo|lsquo|ldquo|rdquo);/g, (_, name) => ({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    hellip: '…', mdash: '—', ndash: '–',
    rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  }[name]));
const stripHtml = (s) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const truncate = (s, n) => s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const xmlEscape = (s) => String(s).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' }[c]));

const wordCount = (txt) => stripHtml(txt).split(/\s+/).filter(Boolean).length;
const readTime = (words) => Math.max(1, Math.round(words / 220));
const fmtDate = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
};
const fmtBytes = (n) => {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n.toFixed(0) : n < 10 ? n.toFixed(1) : n.toFixed(0)) + ' ' + units[i];
};
const fmtMetaDate = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  const mo = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][dt.getUTCMonth()];
  return `${mo} ${String(dt.getUTCDate()).padStart(2, '0')} ${dt.getUTCFullYear()}`;
};
const fmtLongDate = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  const mo = ['January','February','March','April','May','June','July','August','September','October','November','December'][dt.getUTCMonth()];
  return `${mo} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`;
};

// Deterministic seeded shuffle so the random-musing manifest is stable per build.
const seededShuffle = (arr, seed = 1) => {
  const a = arr.slice();
  let s = seed >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ── template helpers exposed to eta ───────────────────────────

// <picture> helper: emit WebP + JPEG sources when WebP is available.
// `im` is an image entry (gallery image or post imagesMap entry).
// `size` is 'med' or 'thumb' (defaults to 'med').
// Returns full HTML string.
function pictureFor(im, size, alt, extraAttrs = '') {
  const jpg = (size === 'thumb' ? im.srcThumb : im.srcMed) || im.s3;
  const webp = (size === 'thumb' ? im.s3_thumb_webp : im.s3_med_webp);
  const altSafe = escapeHtml(alt || '');
  const dims = (im.exif?.width && im.exif?.height) ? ` width="${im.exif.width}" height="${im.exif.height}"` : '';
  const lqipBg = im.lqip ? ` style="background-image:url(${im.lqip});background-size:cover;background-position:center;"` : '';
  if (webp) {
    return `<picture${lqipBg}><source type="image/webp" srcset="${webp}"><img src="${jpg}" alt="${altSafe}"${dims} ${extraAttrs}></picture>`;
  }
  return `<img src="${jpg}" alt="${altSafe}"${dims}${lqipBg} ${extraAttrs}>`;
}

const pageHelpers = {
  site: SITE,
  copy: COPY,
  tabs: COPY.nav.tabs,
  pictureFor,
  bodyClass(active = '', extra = '') {
    const mode = (SITE.theme && SITE.theme.mode) || 'light';
    const cls = ['site-page'];
    if (mode === 'light') cls.push('light');
    if (extra) cls.push(extra);
    if (active) cls.push('active-' + active);
    return cls.join(' ');
  },
  absUrl(p) {
    if (!p) return SITE.url;
    if (p.startsWith('http')) return p;
    return SITE.url + (p.startsWith('/') ? p : '/' + p);
  },
  fmtDate,
  fmtMetaDate,
  fmtLongDate,
  fmtBytes,
  escapeHtml,
};

// Set globally before renderMusings runs so _base.eta can inject random-post JS.
let ALL_POST_URLS = [];

const renderPage = async (templateName, data) => {
  const ctx = { ...pageHelpers, ...data, allPostUrls: ALL_POST_URLS };
  const inner = await eta.render(templateName, ctx);
  return await eta.render('_base', { ...ctx, body: inner });
};

// ── internal link checking ────────────────────────────────────

const allRoutes = new Set(['/', '/musings', '/media', '/changelog', '/license', '/rss.xml', '/atom.xml', '/sitemap.xml', '/robots.txt', '/404.html', '/tokens.css', '/site.css', '/favicon.svg', '/CNAME']);
const trackedLinks = []; // { from, href }

const collectLinks = (from, html) => {
  const re = /href\s*=\s*"([^"]+)"/gi;
  let m;
  while ((m = re.exec(html))) {
    const h = m[1];
    if (h.startsWith('#') || h.startsWith('http') || h.startsWith('mailto:') || h.startsWith('tel:')) continue;
    trackedLinks.push({ from, href: h.split('#')[0].split('?')[0] });
  }
};

// ── markdown image extension: ![alt](media/foo.jpg){.inline} ──

marked.use({
  extensions: [{
    name: 'imageWithClass',
    level: 'inline',
    start(src) { return src.indexOf('!['); },
    tokenizer(src) {
      const m = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)\{([^}]+)\}/.exec(src);
      if (!m) return;
      return {
        type: 'imageWithClass',
        raw: m[0],
        text: m[1],
        href: m[2],
        title: m[3] || null,
        cls: m[4].trim(),
      };
    },
    renderer(t) {
      const klass = t.cls.replace(/[.{}\s]+/g, ' ').trim();
      return imgFigure(t.href, t.text, t.title, klass);
    },
  }],
  renderer: {
    // marked v14 passes a token object, not positional args.
    image(arg) {
      if (typeof arg === 'object' && arg) {
        return imgFigure(arg.href, arg.text || '', arg.title, 'full');
      }
      return imgFigure(arg, arguments[2] || '', arguments[1], 'full');
    },
  },
});

function imgFigure(href, alt, title, kls) {
  const cls = /inline-(l|r)|full|bleed/.test(kls)
    ? kls
    : (kls.includes('inline') ? 'inline-r' : 'full');
  // marked already entity-escapes alt; decode first so we don't double-escape.
  const altText = decodeEntities(alt || '');
  const titleText = title ? decodeEntities(title) : '';
  const t = titleText ? ` title="${escapeHtml(titleText)}"` : '';
  return `<figure class="sp-figure ${cls}">
    <img src="${escapeHtml(href)}" alt="${escapeHtml(altText)}"${t} loading="lazy">
    ${altText ? `<figcaption>${escapeHtml(altText)}</figcaption>` : ''}
  </figure>`;
}

// ── content loaders ───────────────────────────────────────────

// Post sections: each is a musings-shaped tree of markdown posts with its own
// nav tab, index, category pages, tags, and year archives. Home page, feeds,
// and gallery synthesis remain musings-only.
const SECTIONS = {
  musings: { root: 'musings', base: '/musings', active: 'musings' },
  // timeline: index lists all posts date-first in one stream instead of cards-by-folder.
  rv12is:  { root: 'rv12is',  base: '/rv12is',  active: 'rv12is', timeline: true },
};

async function loadPosts(root) {
  const indices = await fg(root + '/**/index.md', { cwd: SRC('content') });
  const posts = [];
  for (const rel of indices) {
    const full = path.join(SRC('content'), rel);
    const raw = await fs.readFile(full, 'utf8');
    let parsed;
    try { parsed = matter(raw); }
    catch (e) { fail(`Bad frontmatter in ${rel}: ${e.message}`); continue; }
    const fm = parsed.data;
    const folder = path.dirname(rel); // musings/travel/japan-tips
    const segs = folder.split('/');
    if (segs[0] !== root) { fail(`Bad ${root} path: ${rel}`); continue; }
    const slug = segs[segs.length - 1];
    const categorySegs = segs.slice(1, -1); // [travel]
    if (!fm.title) { fail(`${rel}: frontmatter is missing required field 'title'`); continue; }
    if (!fm.date) { fail(`${rel}: frontmatter is missing required field 'date' (use YYYY-MM-DD)`); continue; }
    if (fm.draft) continue;
    const url = '/' + folder; // /musings/travel/japan-tips

    const bodyMd = parsed.content;
    // Per-post frontmatter `images:` map provides S3 URLs (+ exif) for each filename.
    // Markdown body still says ![alt](media/foo.jpg); build rewrites at render time.
    const imagesMap = fm.images || {};  // filename -> { s3, s3_med, s3_thumb, bytes, exif }
    const mediaDir = path.join(path.dirname(full), 'media');
    const imageRefs = [];
    const seenFiles = new Set();
    if (fm.featured_image && fm.featured_image.startsWith('media/')) {
      const file = fm.featured_image.replace(/^media\//, '');
      imageRefs.push({ file, alt: fm.title, ...(imagesMap[file] || {}) });
      seenFiles.add(file);
    }
    const imgRe = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let mref;
    while ((mref = imgRe.exec(bodyMd))) {
      const alt = mref[1];
      const src = mref[2];
      if (/^https?:/.test(src)) continue;
      if (src.startsWith('media/')) {
        const file = src.replace(/^media\//, '');
        // S3-backed (in frontmatter.images) OR local (file exists on disk)
        const hasS3 = !!imagesMap[file];
        if (!hasS3) {
          const abs = path.resolve(path.dirname(full), src);
          if (!(await exists(abs))) fail(`${rel}: image '${src}' not found locally and no entry in frontmatter.images`);
        }
        if (!seenFiles.has(file)) {
          imageRefs.push({ file, alt, ...(imagesMap[file] || {}) });
          seenFiles.add(file);
        }
      }
    }
    const bodyHtml = marked.parse(bodyMd, { async: false });
    // Rewrite <img ... src="media/<file>" ...> — swap to S3 med URL and inject
    // width/height (from EXIF) so browsers reserve space and avoid CLS.
    let rewritten = bodyHtml.replace(/<img\s+([^>]*?)src="media\/([^"]+)"([^>]*)>/g, (_, before, file, after) => {
      const entry = imagesMap[file];
      const dest = (entry && (entry.s3_med || entry.s3)) || `${url}/media/${file}`;
      const dims = (entry?.exif?.width && entry?.exif?.height)
        ? ` width="${entry.exif.width}" height="${entry.exif.height}"`
        : '';
      // If WebP variants exist, emit a <picture> with WebP source + JPEG <img> fallback,
      // and a LQIP base64 background so something paints instantly.
      if (entry?.s3_med_webp) {
        const lqipBg = entry.lqip ? ` style="background-image:url(${entry.lqip});background-size:cover;background-position:center;"` : '';
        return `<picture${lqipBg}><source type="image/webp" srcset="${entry.s3_med_webp}"><img ${before}src="${dest}"${dims}${after}></picture>`;
      }
      return `<img ${before}src="${dest}"${dims}${after}>`;
    });
    // Also rewrite plain href="media/..." (rare, e.g. wrapper links) to the full-size URL.
    rewritten = rewritten.replace(/href="media\/([^"]+)"/g, (_, file) => {
      const entry = imagesMap[file];
      return `href="${(entry && (entry.s3 || entry.s3_med)) || `${url}/media/${file}`}"`;
    });

    const words = wordCount(bodyMd);
    const preview = truncate(stripHtml(marked.parse(bodyMd.split('\n\n').slice(0, 2).join('\n\n'), { async: false })), 220);

    // Featured image URL: prefer the S3 entry if mapped, else fall back to a post-local path.
    let featured = null;
    if (fm.featured_image) {
      const cleaned = fm.featured_image.replace(/^\.\//, '');
      if (cleaned.startsWith('media/')) {
        const file = cleaned.replace(/^media\//, '');
        const e = imagesMap[file];
        featured = (e && (e.s3_med || e.s3)) || `${url}/${cleaned}`;
      } else {
        featured = `${url}/${cleaned}`;
      }
    }

    posts.push({
      type: 'musing',
      slug,
      url,
      folder,
      category: categorySegs,
      categoryPath: categorySegs.length ? '/' + root + '/' + categorySegs.join('/') : '/' + root,
      title: fm.title,
      subtitle: fm.subtitle || '',
      date: new Date(fm.date),
      tags: fm.tags || [],
      featured,
      seo: fm.seo || {},
      gallery: fm.gallery || null,   // optional: { path, title?, subtitle?, location?, date? }
      imageRefs,                     // [{ file, alt }] referenced in body + featured
      bodyHtml: rewritten,
      bodyMd,
      preview,
      wordCount: words,
      readTime: readTime(words),
      mediaDir,
      sourceRel: rel,
    });

    allRoutes.add(url);
  }
  posts.sort((a, b) => b.date - a.date);
  return posts;
}

async function loadMedia() {
  // Each directory under content/media is a gallery node. Has metadata.yaml + images.
  const dirs = await fg('media/**/metadata.yaml', { cwd: SRC('content') });
  const nodes = [];
  for (const rel of dirs) {
    const full = path.join(SRC('content'), rel);
    const raw = await fs.readFile(full, 'utf8');
    let data;
    try { data = yaml.load(raw); }
    catch (e) { fail(`Bad YAML in ${rel}: ${e.message}`); continue; }
    if (!data || !data.title) { fail(`${rel}: gallery metadata is missing required field 'title'`); continue; }
    const dir = path.dirname(rel); // media/australia/tasmania/mona
    const segs = dir.split('/');
    const url = '/' + dir;
    const galleryDir = path.dirname(full);

    const images = [];
    for (const im of data.images || []) {
      if (!im.file) { fail(`${rel}: an image entry is missing its 'file' field`); continue; }
      if (!im.alt) console.warn(`  ⚠ ${rel}: image '${im.file}' has no alt text (recommended for accessibility + SEO, not required)`);
      const slug = im.file.replace(/\.[^.]+$/, '');
      // S3-backed image: all sizes live on S3, nothing local.
      // Legacy fallback: file lives locally under content/media/<dir>/<file>.
      const hasS3 = !!im.s3;
      let abs = null;
      if (!hasS3) {
        abs = path.join(galleryDir, im.file);
        if (!(await exists(abs))) {
          fail(`${rel}: file '${im.file}' is listed in metadata but doesn't exist on disk (and no s3 URL provided)`);
          continue;
        }
      }
      images.push({
        ...im,
        slug,
        src:      hasS3 ? im.s3       : `${url}/${im.file}`,
        srcMed:   hasS3 ? im.s3_med   : `${url}/_med/${im.file}`,
        srcThumb: hasS3 ? im.s3_thumb : `${url}/_thumb/${im.file}`,
        pageUrl:  `${url}/${slug}`,
        absPath:  abs,
      });
    }

    nodes.push({
      type: 'gallery',
      url,
      dir,
      depth: segs.length - 1,
      title: data.title,
      subtitle: data.subtitle || '',
      location: data.location || '',
      date: data.date ? new Date(data.date) : null,
      seo: data.seo || {},
      cover: data.cover || null,
      images,
      sourceRel: rel,
      galleryDir,
    });
    allRoutes.add(url);
  }

  // Wire parent/child relationships.
  const byPath = Object.fromEntries(nodes.map(n => [n.dir, n]));
  for (const n of nodes) {
    n.children = nodes.filter(o => path.dirname(o.dir) === n.dir);
    n.children.sort((a, b) => a.title.localeCompare(b.title));
  }
  return { nodes, byPath };
}

// ── image processing ─────────────────────────────────────────

async function processImage(srcAbs, outRel, opts) {
  const out = path.join(OUT, outRel);
  await ensureDir(path.dirname(out));
  const pipeline = sharp(srcAbs).rotate();
  if (opts.width) pipeline.resize({ width: opts.width, withoutEnlargement: true });
  await pipeline.jpeg({ quality: opts.quality || 82, progressive: true }).toFile(out);
}

async function buildMediaImages(node) {
  for (const im of node.images) {
    if (!im.absPath) continue;  // S3-backed image, no local processing needed
    const baseOut = path.join(node.dir, im.file);
    await copyFile(im.absPath, baseOut);
    await processImage(im.absPath, path.join(node.dir, '_med', im.file), { width: 1400 });
    await processImage(im.absPath, path.join(node.dir, '_thumb', im.file), { width: 600, quality: 78 });
  }
}

// ── render: home ──────────────────────────────────────────────

async function computeStats(musings, mediaNodes) {
  let postBytes = 0;
  let totalWords = 0;
  for (const m of musings) {
    totalWords += m.wordCount;
    try { postBytes += (await fs.stat(path.join(SRC('content'), m.sourceRel))).size; } catch {}
  }
  // collect every unique image file referenced by any node
  const seen = new Set();
  let imageBytes = 0;
  let imageCount = 0;
  for (const n of mediaNodes) {
    for (const im of n.images) {
      const key = im.s3 || im.absPath;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      // Prefer the recorded byte count (S3 original's true size).
      // Fallback: local file size (only accurate for non-S3 images, e.g. post-inline images).
      if (typeof im.bytes === 'number' && im.bytes > 0) {
        imageBytes += im.bytes;
        imageCount++;
      } else if (im.absPath) {
        try { imageBytes += (await fs.stat(im.absPath)).size; imageCount++; } catch {}
      }
    }
  }
  const dates = musings.map(m => m.date).filter(Boolean).sort((a, b) => a - b);
  return {
    musings: musings.length,
    musingsBytes: postBytes,
    musingsBytesFmt: fmtBytes(postBytes),
    words: totalWords,
    pictures: imageCount,
    picturesBytes: imageBytes,
    picturesBytesFmt: fmtBytes(imageBytes),
    firstPost: dates[0] ? fmtDate(dates[0]) : null,
    lastPost: dates[dates.length - 1] ? fmtDate(dates[dates.length - 1]) : null,
    firstPostLong: dates[0] ? fmtLongDate(dates[0]) : null,
    lastPostLong: dates[dates.length - 1] ? fmtLongDate(dates[dates.length - 1]) : null,
  };
}

async function renderHome(musings, mediaNodes) {
  const shuffled = seededShuffle(musings.map(m => ({
    url: m.url, title: m.title, subtitle: m.subtitle, preview: m.preview,
    featured: m.featured, tags: m.tags, date: fmtDate(m.date),
    dateLong: fmtLongDate(m.date),
    readtime: `${fmtLongDate(m.date).split(',')[0]} · ${m.wordCount.toLocaleString()} words · ~${m.readTime} min read`,
    path: m.folder, category: m.category.join('/') || 'misc',
  })), 7);

  // Dedupe by `src` so an image that appears in both a real and a synthesized
  // gallery doesn't show up twice in the shuffle (which made consecutive
  // shuffles land on the same URL and look broken to the user).
  const seenSrc = new Set();
  const allImages = [];
  for (const n of mediaNodes) {
    for (const im of n.images) {
      const src = im.srcMed;
      if (!src || seenSrc.has(src)) continue;
      seenSrc.add(src);
      allImages.push({
        src, thumb: im.srcThumb, full: im.src,
        title: im.title || '',
        location: im.location || n.location || '',
        date: im.date ? fmtDate(im.date) : (n.date ? fmtDate(n.date) : ''),
        dateLong: im.date ? fmtLongDate(im.date) : (n.date ? fmtLongDate(n.date) : ''),
        album: n.url, albumTitle: n.title,
        alt: im.alt || '',
      });
    }
  }
  const shuffledImages = seededShuffle(allImages, 13);

  const recent = musings.slice(0, 5).map(m => ({
    date: fmtDate(m.date).replace(/-/g, '·'),
    dateLong: fmtLongDate(m.date),
    title: m.title,
    url: m.url,
    category: m.category[0] || 'misc',
  }));

  const html = await renderPage('home', {
    page: {
      title: SITE.title,
      description: SITE.description,
      url: '/',
      bodyClass: pageHelpers.bodyClass('home'),
      type: 'website',
      ogImage: shuffledImages[0]?.full || null,
    },
    active: 'home',
    shuffled, shuffledImages, recent,
    totalMusings: musings.length,
    stats: await computeStats(musings, mediaNodes),
  });
  collectLinks('/', html);
  await writeFile('index.html', html);
}

// Build a folder/post tree for the sidebar.
// Returns an array of nodes: { type:'folder'|'post', name, url, path, children, post? }
function buildSectionTree(posts, section) {
  const root = { type: 'folder', name: section.root, url: section.base, path: [], children: [] };
  const folders = new Map(); // key -> node
  folders.set('', root);

  // Ensure all folder ancestors exist for each post.
  for (const m of posts) {
    let parentKey = '';
    let parentNode = root;
    for (let d = 0; d < m.category.length; d++) {
      const segs = m.category.slice(0, d + 1);
      const key = segs.join('/');
      if (!folders.has(key)) {
        const node = {
          type: 'folder',
          name: segs[segs.length - 1],
          url: section.base + '/' + key,
          path: segs,
          children: [],
        };
        folders.set(key, node);
        parentNode.children.push(node);
      }
      parentKey = key;
      parentNode = folders.get(key);
    }
    parentNode.children.push({
      type: 'post',
      name: m.slug,
      url: m.url,
      title: m.title,
      post: m,
    });
  }

  // Sort: folders first (alpha), then posts (newest first).
  function sortNode(n) {
    n.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      if (a.type === 'folder') return a.name.localeCompare(b.name);
      return b.post.date - a.post.date;
    });
    n.children.forEach((c) => c.type === 'folder' && sortNode(c));
  }
  sortNode(root);
  return root;
}

// Synthesize media gallery nodes from musings that have images.
// Default behavior: any post with images becomes a gallery at the path
// derived from its folder (first category segment dropped).
// Override via frontmatter `gallery: { path: ..., title: ..., location: ..., date: ... }`.
// Disable for a single post via `gallery: false`.
// Reuses the images already in the post's media/ folder — no duplication.
function synthesizeFromMusings(musings, existingNodes, opts = {}) {
  const out = [];
  const have = new Set(existingNodes.map(n => n.dir));
  const baseSegs = opts.baseSegs || [];
  for (const m of musings) {
    if (m.gallery === false) continue;
    if (!m.imageRefs || m.imageRefs.length === 0) continue;
    // derived default path: drop first category segment (e.g. "travel/"), keep rest + slug
    const derivedSegs = baseSegs.concat(m.category.length > 1 ? m.category.slice(1) : m.category, [m.slug]);
    const derivedPath = derivedSegs.join('/');
    const galleryConfig = (m.gallery && typeof m.gallery === 'object') ? m.gallery : {};
    const galleryPath = (galleryConfig.path || derivedPath).replace(/^\/+|\/+$/g, '');
    const dir = 'media/' + galleryPath;
    if (have.has(dir) || out.find(o => o.dir === dir)) {
      fail(`Gallery path collision: musing ${m.sourceRel} points to ${dir} but it already exists.`);
      continue;
    }
    const segs = dir.split('/');
    const images = m.imageRefs.map(ref => {
      const slug = ref.file.replace(/\.[^.]+$/, '');
      const hasS3 = !!ref.s3;
      return {
        file: ref.file,
        slug,
        alt: ref.alt || '',
        title: '',
        date: m.date,
        location: galleryConfig.location || '',
        src:      hasS3 ? ref.s3       : `${m.url}/media/${ref.file}`,
        srcMed:   hasS3 ? ref.s3_med   : `${m.url}/media/${ref.file}`,
        srcThumb: hasS3 ? ref.s3_thumb : `${m.url}/media/${ref.file}`,
        bytes: ref.bytes,
        exif: ref.exif,
        s3: ref.s3,
        s3_med: ref.s3_med,
        s3_thumb: ref.s3_thumb,
        pageUrl: `/${dir}/${slug}`,
        absPath: hasS3 ? null : path.join(m.mediaDir, ref.file),
      };
    });
    out.push({
      type: 'gallery',
      url: '/' + dir,
      dir,
      depth: segs.length - 1,
      title: galleryConfig.title || m.title,
      subtitle: galleryConfig.subtitle || '',
      location: galleryConfig.location || '',
      date: galleryConfig.date ? new Date(galleryConfig.date) : m.date,
      seo: galleryConfig.seo || { description: `Photos from "${m.title}".` },
      images,
      synthesized: true,
      fromPost: { title: m.title, url: m.url, subtitle: m.subtitle, label: opts.label || 'musing' },
      children: [],
    });
    allRoutes.add('/' + dir);

    // Virtual ancestors so the tree/breadcrumbs work.
    for (let i = 2; i < segs.length; i++) {
      const subDir = segs.slice(0, i).join('/');
      if (have.has(subDir) || out.find(o => o.dir === subDir)) continue;
      const subSegs = subDir.split('/');
      out.push({
        type: 'gallery',
        url: '/' + subDir,
        dir: subDir,
        depth: subSegs.length - 1,
        title: subSegs[subSegs.length - 1],
        subtitle: '',
        location: '',
        date: null,
        seo: {},
        images: [],
        synthesized: true,
        virtual: true,
        children: [],
      });
      allRoutes.add('/' + subDir);
    }
  }
  return out;
}

// Render a folder/post tree to an HTML string for the sidebar.
// Uses nested <ul> so long names wrap naturally and don't overflow.
function renderTreeHtml(tree, activeUrl, activeCategory) {
  function walk(node, depth) {
    const name = node.type === 'folder' ? node.name + '/' : node.name;
    const isActive = node.url === activeUrl;
    const inActive = !isActive && activeCategory && node.type === 'folder' && depth > 0 && activeCategory.startsWith(node.path.join('/'));
    const cls = ['tree-item'];
    if (node.type === 'folder') cls.push('is-folder');
    if (isActive) cls.push('active');
    if (inActive) cls.push('in-active');
    let item = `<li class="${cls.join(' ')}"><a href="${node.url}" class="${isActive ? 'active' : (inActive ? 'in-active' : '')}">${escapeHtml(name)}</a>`;
    if (node.children && node.children.length) {
      item += '<ul>' + node.children.map(c => walk(c, depth + 1)).join('') + '</ul>';
    }
    item += '</li>';
    return item;
  }
  return '<ul class="tree-list">' + walk(tree, 0) + '</ul>';
}

// Sidebar for timeline sections: a dated entry list (newest first, grouped
// by year) instead of the folder tree. Reuses the tree-list CSS classes.
function renderTimelineSidebarHtml(posts, section, activeUrl) {
  let out = `<ul class="tree-list"><li class="tree-item is-folder"><a href="${section.base}">${escapeHtml(section.root)}/</a><ul>`;
  let lastYear = null;
  let open = false;
  for (const p of posts) {
    const y = p.date.getUTCFullYear();
    if (y !== lastYear) {
      if (open) out += '</ul></li>';
      out += `<li class="tree-item is-folder"><a href="${section.base}/${y}">${y}/</a><ul>`;
      lastYear = y;
      open = true;
    }
    const isActive = p.url === activeUrl;
    const day = fmtMetaDate(p.date).slice(0, 6);
    out += `<li class="tree-item${isActive ? ' active' : ''}"><a href="${p.url}" class="${isActive ? 'active' : ''}"><span style="color: var(--ink-3);">${day}</span> ${escapeHtml(p.title)}</a></li>`;
  }
  if (open) out += '</ul></li>';
  out += '</ul></li></ul>';
  return out;
}

// ── render: post sections (musings, rv12is, …) ────────────────

async function renderPostSection(posts, section) {
  const sc = COPY[section.root];
  // Sidebar: folder tree for card sections, dated entry list for timelines.
  const tree = buildSectionTree(posts, section);
  const sidebarFor = (activeUrl, activeCategory) => section.timeline
    ? renderTimelineSidebarHtml(posts, section, activeUrl)
    : renderTreeHtml(tree, activeUrl, activeCategory);
  allRoutes.add(section.base);

  // Index page. Timeline sections list everything date-first in one stream.
  const indexHtml = await renderPage(section.timeline ? 'timeline-index' : 'musings-index', {
    page: {
      title: section.root + ' — ' + SITE.title,
      description: (sc.index.seo_description || '')
        .replace('{count}', posts.length).replace('{author}', SITE.author),
      url: section.base,
      bodyClass: pageHelpers.bodyClass(section.active),
      type: 'website',
    },
    active: section.active,
    section, sectionCopy: sc,
    posts,
    treeHtml: sidebarFor(section.base, ''),
  });
  collectLinks(section.base, indexHtml);
  await writeFile(path.join(section.root, 'index.html'), indexHtml);

  // Helper: pick up to N related posts that share the most tags with a given post.
  function relatedFor(m, n = 3) {
    const mTags = new Set(m.tags || []);
    if (mTags.size === 0) return [];
    return posts
      .filter(o => o.url !== m.url)
      .map(o => ({ post: o, score: (o.tags || []).filter(t => mTags.has(t)).length }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.post.date - a.post.date))
      .slice(0, n)
      .map(x => x.post);
  }

  // Per-post — uses the same tree, marking the current item active.
  for (let i = 0; i < posts.length; i++) {
    const m = posts[i];
    const prev = posts[i + 1] || null;
    const next = posts[i - 1] || null;
    const html = await renderPage('musing', {
      page: {
        title: `${m.title} — ${SITE.title}`,
        description: m.seo.description || truncate(m.preview, 158),
        keywords: m.seo.keywords || m.tags,
        url: m.url,
        bodyClass: pageHelpers.bodyClass(section.active),
        type: 'article',
        ogImage: m.featured,
      },
      active: section.active,
      section, sectionCopy: sc,
      post: m,
      prev,
      next,
      related: relatedFor(m, 3),
      treeHtml: sidebarFor(m.url, m.category.join('/')),
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: m.title,
        description: m.seo.description || truncate(m.preview, 158),
        image: m.featured ? pageHelpers.absUrl(m.featured) : undefined,
        datePublished: m.date.toISOString(),
        author: { '@type': 'Person', name: SITE.author },
        mainEntityOfPage: pageHelpers.absUrl(m.url),
      },
    });
    collectLinks(m.url, html);
    await writeFile(path.join(m.url.slice(1), 'index.html'), html);

    // Copy media folder for this post.
    if (await exists(m.mediaDir)) {
      const files = await fg('**/*', { cwd: m.mediaDir, onlyFiles: true });
      for (const f of files) await copyFile(path.join(m.mediaDir, f), path.join(m.url.slice(1), 'media', f));
    }
  }

  // Categories.
  const cats = new Map(); // path -> { segs, posts, children }
  for (const m of posts) {
    for (let d = 1; d <= m.category.length; d++) {
      const segs = m.category.slice(0, d);
      const key = segs.join('/');
      if (!cats.has(key)) cats.set(key, { segs, posts: [], childKeys: new Set() });
    }
    if (m.category.length > 0) {
      cats.get(m.category.join('/')).posts.push(m);
    }
    for (let d = 0; d < m.category.length - 1; d++) {
      const parentKey = m.category.slice(0, d + 1).join('/');
      const childKey = m.category.slice(0, d + 2).join('/');
      cats.get(parentKey).childKeys.add(childKey);
    }
  }

  for (const [key, cat] of cats) {
    const url = section.base + '/' + key;
    const allDescendants = posts.filter(m => m.category.slice(0, cat.segs.length).join('/') === key);
    const directPosts = cat.posts.slice().sort((a, b) => b.date - a.date);
    const children = [...cat.childKeys].map(k => ({
      key: k,
      label: k.split('/').pop(),
      url: section.base + '/' + k,
      count: posts.filter(m => m.category.slice(0, k.split('/').length).join('/') === k).length,
    }));
    const html = await renderPage('musings-category', {
      page: {
        title: `${key} — ${section.root} — ${SITE.title}`,
        description: `Posts about ${cat.segs.join(' / ')} by ${SITE.author}.`,
        url,
        bodyClass: pageHelpers.bodyClass(section.active),
        type: 'website',
      },
      active: section.active,
      section, sectionCopy: sc,
      categoryKey: key,
      categorySegs: cat.segs,
      posts: directPosts,
      allDescendants,
      children,
      treeHtml: sidebarFor(url, key),
      randomPick: allDescendants[Math.floor((allDescendants.length || 1) / 2) % Math.max(allDescendants.length, 1)],
    });
    collectLinks(url, html);
    await writeFile(path.join(section.root, key, 'index.html'), html);
    allRoutes.add(url);
  }

  // Tags.
  const tags = new Map();
  for (const m of posts) for (const t of m.tags) {
    if (!tags.has(t)) tags.set(t, []);
    tags.get(t).push(m);
  }

  // /<section>/tags — alphabetical list of all tags + counts.
  const tagList = [...tags.entries()]
    .map(([name, tagged]) => ({ name, slug: slugify(name), count: tagged.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const tagsIndexHtml = await renderPage('musings-tags-index', {
    page: {
      title: `tags — ${SITE.title}`,
      description: `All tags used across ${posts.length} posts.`,
      url: `${section.base}/tags`,
      bodyClass: pageHelpers.bodyClass(section.active),
      type: 'website',
    },
    active: section.active,
    section, sectionCopy: sc,
    tagList,
  });
  collectLinks(`${section.base}/tags`, tagsIndexHtml);
  await writeFile(path.join(section.root, 'tags', 'index.html'), tagsIndexHtml);
  allRoutes.add(`${section.base}/tags`);

  // /<section>/YYYY — year archives.
  const byYear = new Map();
  for (const m of posts) {
    const y = String(m.date.getUTCFullYear());
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(m);
  }
  const allYears = [...byYear.keys()].sort().reverse();
  for (const year of allYears) {
    const yearPosts = byYear.get(year);
    const otherYears = allYears.filter(y => y !== year);
    const yearHtml = await renderPage('musings-year', {
      page: {
        title: `${year} — ${section.root} — ${SITE.title}`,
        description: `Posts from ${year} by ${SITE.author}.`,
        url: `${section.base}/${year}`,
        bodyClass: pageHelpers.bodyClass(section.active),
        type: 'website',
      },
      active: section.active,
      section, sectionCopy: sc,
      year,
      posts: yearPosts,
      otherYears,
    });
    collectLinks(`${section.base}/${year}`, yearHtml);
    await writeFile(path.join(section.root, year, 'index.html'), yearHtml);
    allRoutes.add(`${section.base}/${year}`);
  }

  for (const [tag, tagged] of tags) {
    const url = `${section.base}/tag/${slugify(tag)}`;
    const html = await renderPage('musings-tag', {
      page: {
        title: `#${tag} — ${SITE.title}`,
        description: `Posts tagged "${tag}" by ${SITE.author}.`,
        keywords: [tag, ...tagged.flatMap(p => p.tags)].slice(0, 10),
        url,
        bodyClass: pageHelpers.bodyClass(section.active),
        type: 'website',
      },
      active: section.active,
      section, sectionCopy: sc,
      tag,
      posts: tagged,
    });
    collectLinks(url, html);
    await writeFile(path.join(section.root, 'tag', slugify(tag), 'index.html'), html);
    allRoutes.add(url);
  }
}

// ── render: media ─────────────────────────────────────────────

async function renderMedia(mediaNodes) {
  // Process all images. Synthesized nodes reuse the post's media files in place.
  for (const n of mediaNodes) if (!n.synthesized) await buildMediaImages(n);

  // Top-level index aggregates depth-1 nodes (e.g. /media/australia, /media/budapest).
  const topNodes = mediaNodes.filter(n => n.depth === 1);
  topNodes.sort((a, b) => (b.date || 0) - (a.date || 0));
  const indexHtml = await renderPage('media-index', {
    page: {
      title: 'media — ' + SITE.title,
      description: `Photo galleries by ${SITE.author}.`,
      url: '/media',
      bodyClass: pageHelpers.bodyClass('media'),
      type: 'website',
    },
    active: 'media',
    albums: topNodes.map(n => ({
      url: n.url, title: n.title, subtitle: n.subtitle, location: n.location,
      date: n.date ? fmtDate(n.date) : '',
      cover: coverImage(n),
      count: countImages(n, mediaNodes),
      fromPost: n.fromPost || null,
    })),
  });
  collectLinks('/media', indexHtml);
  await writeFile('media/index.html', indexHtml);

  for (const n of mediaNodes) {
    const isLeaf = n.children.length === 0;
    const html = await renderPage('media-gallery', {
      page: {
        title: `${n.title} — ${SITE.title}`,
        description: n.seo.description || `Photos from ${n.title}${n.location ? ', ' + n.location : ''}.`,
        keywords: n.seo.keywords || [],
        url: n.url,
        bodyClass: pageHelpers.bodyClass('media'),
        type: 'website',
        ogImage: coverImage(n)?.full || null,
      },
      active: 'media',
      node: n,
      isLeaf,
      subAlbums: n.children.map(c => ({
        url: c.url, title: c.title, subtitle: c.subtitle, location: c.location,
        date: c.date ? fmtDate(c.date) : '',
        cover: coverImage(c),
        count: countImages(c, mediaNodes),
        fromPost: c.fromPost || null,
      })),
      // All images in this subtree (this node's own + every descendant's),
      // used by the grid/feed view modes on category pages.
      allDescendantImages: (function collect(node) {
        const out = node.images.map(im => ({ ...im, album: node.url, albumTitle: node.title }));
        for (const child of node.children || []) out.push(...collect(child));
        // dedupe by src (same image might appear in real + synthesized gallery)
        const seen = new Set();
        return out.filter(im => { if (seen.has(im.src)) return false; seen.add(im.src); return true; });
      })(n),
      breadcrumbs: breadcrumbs(n.dir),
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'ImageGallery',
        name: n.title,
        description: n.seo.description || `Photos from ${n.title}`,
        image: n.images.map(im => pageHelpers.absUrl(im.src)),
      },
    });
    collectLinks(n.url, html);
    await writeFile(path.join(n.dir, 'index.html'), html);

    // Per-photo pages with prev/next.
    for (let i = 0; i < n.images.length; i++) {
      const im = n.images[i];
      const prev = i > 0 ? n.images[i - 1] : n.images[n.images.length - 1];
      const next = i < n.images.length - 1 ? n.images[i + 1] : n.images[0];
      const pageHtml = await renderPage('media-photo', {
        page: {
          title: `${im.title || im.alt || im.file} — ${n.title} — ${SITE.title}`,
          description: im.alt || `Photo from ${n.title}.`,
          url: im.pageUrl,
          bodyClass: pageHelpers.bodyClass('media'),
          type: 'website',
          ogImage: im.src,
        },
        active: 'media',
        node: n,
        image: im,
        prev,
        next,
        index: i,
        total: n.images.length,
        breadcrumbs: breadcrumbs(n.dir),
      });
      collectLinks(im.pageUrl, pageHtml);
      await writeFile(path.join(n.dir, im.slug, 'index.html'), pageHtml);
      allRoutes.add(im.pageUrl);
    }
  }
}

// Find an image by slug or filename anywhere in this subtree.
function findImageBySlug(node, wanted) {
  for (const im of node.images || []) {
    if (im.slug === wanted || im.file === wanted) return im;
  }
  for (const c of node.children || []) {
    const found = findImageBySlug(c, wanted);
    if (found) return found;
  }
  return null;
}

function coverImage(node) {
  // Honor an explicit `cover:` (slug or filename) anywhere in the subtree.
  if (node.cover) {
    const wanted = node.cover.replace(/\.[^.]+$/, '');
    const found = findImageBySlug(node, wanted) || findImageBySlug(node, node.cover);
    if (found) return { full: found.src, med: found.srcMed, thumb: found.srcThumb, alt: found.alt };
  }
  if (node.images && node.images.length) {
    const pick = node.images[0];
    return { full: pick.src, med: pick.srcMed, thumb: pick.srcThumb, alt: pick.alt };
  }
  for (const c of node.children || []) {
    const inner = coverImage(c);
    if (inner) return inner;
  }
  return null;
}
function countImages(node, all) {
  const prefix = node.dir + '/';
  return all.filter(o => o.dir === node.dir || o.dir.startsWith(prefix)).reduce((s, o) => s + o.images.length, 0);
}
function breadcrumbs(dir) {
  const segs = dir.split('/');
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    out.push({ label: segs[i], url: '/' + segs.slice(0, i + 1).join('/') });
  }
  return out;
}

// ── render: static sites passthrough ─────────────────────────

async function copyStaticSites() {
  const dirs = await fg('sites/*', { cwd: SRC('content'), onlyDirectories: true });
  for (const d of dirs) {
    const from = path.join(SRC('content'), d);
    await copyTree(from, d);
    log('passthrough', d);
  }
}

// ── render: changelog (static stub from copy.yaml) ───────────

async function renderLicense() {
  const html = await renderPage('license', {
    page: {
      title: `License — ${SITE.title}`,
      description: COPY.license.short,
      url: '/license',
      bodyClass: pageHelpers.bodyClass(),
      type: 'website',
    },
    active: '',
  });
  collectLinks('/license', html);
  await writeFile('license/index.html', html);
  allRoutes.add('/license');
}

async function renderChangelog() {
  // Pull commits from git, oldest -> newest. Version = sequential index.
  let entries = [];
  try {
    const raw = execSync(
      'git log --reverse --pretty=format:%H%x1f%aI%x1f%s%x1f%b%x1e',
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    entries = raw.split('\x1e').map(s => s.trim()).filter(Boolean).map((rec, i) => {
      const [hash, iso, subject, body] = rec.split('\x1f');
      return {
        version: 'v' + (i + 1),
        hash: hash.slice(0, 7),
        date: iso ? iso.slice(0, 10) : '',
        subject: subject || '',
        body: (body || '').trim(),
      };
    }).reverse(); // newest first for display
  } catch (e) {
    log('changelog: git log failed, rendering empty');
  }

  const html = await renderPage('changelog', {
    page: {
      title: `changelog — ${SITE.title}`,
      description: COPY.changelog.intro,
      url: '/changelog',
      bodyClass: pageHelpers.bodyClass(),
      type: 'website',
    },
    active: '',
    entries,
  });
  collectLinks('/changelog', html);
  await writeFile('changelog/index.html', html);
}

// ── render: sitemap / robots / rss / 404 ─────────────────────

async function renderFeeds(musings) {
  // sitemap
  const urls = [...allRoutes].filter(u => !u.endsWith('.xml') && !u.endsWith('.txt') && !u.endsWith('.html'));
  const sm = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${xmlEscape(pageHelpers.absUrl(u))}</loc></url>`).join('\n')}
</urlset>
`;
  await writeFile('sitemap.xml', sm);

  // robots
  await writeFile('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${SITE.url}/sitemap.xml\n`);

  // rss
  const items = musings.slice(0, 30).map(m => `
    <item>
      <title>${xmlEscape(m.title)}</title>
      <link>${xmlEscape(pageHelpers.absUrl(m.url))}</link>
      <guid isPermaLink="true">${xmlEscape(pageHelpers.absUrl(m.url))}</guid>
      <pubDate>${m.date.toUTCString()}</pubDate>
      <description>${xmlEscape(m.seo.description || m.preview)}</description>
    </item>`).join('');
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${xmlEscape(SITE.title)}</title>
<link>${xmlEscape(SITE.url)}</link>
<description>${xmlEscape(SITE.description)}</description>
<language>${SITE.language || 'en'}</language>
${items}
</channel></rss>
`;
  await writeFile('rss.xml', rss);

  // atom
  const updated = musings[0]?.date?.toISOString() || new Date().toISOString();
  const atomItems = musings.slice(0, 30).map(m => `
  <entry>
    <title>${xmlEscape(m.title)}</title>
    <link href="${xmlEscape(pageHelpers.absUrl(m.url))}"/>
    <id>${xmlEscape(pageHelpers.absUrl(m.url))}</id>
    <updated>${m.date.toISOString()}</updated>
    <published>${m.date.toISOString()}</published>
    <author><name>${xmlEscape(SITE.author)}</name></author>
    <summary>${xmlEscape(m.seo.description || m.preview)}</summary>
  </entry>`).join('');
  const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${SITE.language || 'en'}">
  <title>${xmlEscape(SITE.title)}</title>
  <subtitle>${xmlEscape(SITE.description)}</subtitle>
  <link rel="self" type="application/atom+xml" href="${SITE.url}/atom.xml"/>
  <link href="${xmlEscape(SITE.url)}"/>
  <updated>${updated}</updated>
  <id>${xmlEscape(SITE.url)}/</id>
  <author><name>${xmlEscape(SITE.author)}</name></author>${atomItems}
</feed>
`;
  await writeFile('atom.xml', atom);

  // 404
  const html404 = await renderPage('404', {
    page: {
      title: '404 — ' + SITE.title,
      description: 'Page not found.',
      url: '/404',
      bodyClass: pageHelpers.bodyClass(),
      type: 'website',
    },
    active: '',
  });
  await writeFile('404.html', html404);
}

// ── link verification ───────────────────────────────────────

function verifyLinks() {
  for (const { from, href } of trackedLinks) {
    let target = href.replace(/\/$/, '') || '/';
    if (target === '/') continue;
    if (allRoutes.has(target)) continue;
    if (allRoutes.has(target + '/')) continue;
    // try as a file route (e.g. /sites/foo)
    if (target.startsWith('/sites/')) continue;
    // image/static asset references — not page routes
    if (/\.(jpe?g|png|webp|gif|svg|ico|pdf|mp4|webm|mp3)$/i.test(target)) continue;
    fail(`Broken internal link: ${href}  (on ${from})`);
  }
}

// ── design assets ────────────────────────────────────────────

async function copyDesign() {
  await copyFile(SRC('design/tokens.css'), 'tokens.css');
  await copyFile(SRC('design/site.css'), 'site.css');
  if (await exists(SRC('design/favicon.svg'))) await copyFile(SRC('design/favicon.svg'), 'favicon.svg');
  if (await exists(SRC('CNAME'))) await copyFile(SRC('CNAME'), 'CNAME');
}

// ── main ─────────────────────────────────────────────────────

async function main() {
  console.time('build');
  await fs.rm(OUT, { recursive: true, force: true });
  await ensureDir(OUT);

  await copyDesign();
  const musings = await loadPosts('musings');
  const rvPosts = await loadPosts('rv12is');
  log(`${musings.length} musings, ${rvPosts.length} rv12is posts`);
  const { nodes: realMediaNodes } = await loadMedia();
  const synthNodes = synthesizeFromMusings(musings, realMediaNodes)
    .concat(synthesizeFromMusings(rvPosts, realMediaNodes, { baseSegs: ['rv12is'], label: 'build log' }));
  const mediaNodes = realMediaNodes.concat(synthNodes);
  // Ensure every ancestor folder has a (possibly virtual) node so breadcrumbs
  // and the album tree resolve — even if no metadata.yaml was created for it.
  const have = new Set(mediaNodes.map(n => n.dir));
  for (const n of [...mediaNodes]) {
    const segs = n.dir.split('/');
    for (let i = 2; i < segs.length; i++) {
      const subDir = segs.slice(0, i).join('/');
      if (have.has(subDir)) continue;
      have.add(subDir);
      mediaNodes.push({
        type: 'gallery',
        url: '/' + subDir,
        dir: subDir,
        depth: i - 1,
        title: segs[i - 1],
        subtitle: '',
        location: '',
        date: null,
        seo: {},
        images: [],
        synthesized: true,
        virtual: true,
        children: [],
      });
      allRoutes.add('/' + subDir);
    }
  }
  // Re-wire parent/child relationships across real + synthesized + virtual.
  for (const n of mediaNodes) {
    n.children = mediaNodes.filter(o => path.dirname(o.dir) === n.dir);
    n.children.sort((a, b) => a.title.localeCompare(b.title));
  }
  log(`${realMediaNodes.length} real + ${synthNodes.length} synthesized gallery nodes`);

  await renderHome(musings, mediaNodes);
  ALL_POST_URLS = musings.map(m => m.url);
  await renderPostSection(musings, SECTIONS.musings);
  await renderPostSection(rvPosts, SECTIONS.rv12is);
  await renderMedia(mediaNodes);
  await renderChangelog();
  await renderLicense();
  await copyStaticSites();
  await renderFeeds(musings);

  verifyLinks();

  if (errors.length) {
    console.error('\nBuild failed with ' + errors.length + ' error(s):');
    for (const e of errors) console.error('  ✗ ' + e);
    process.exit(1);
  }
  console.timeEnd('build');
  console.log('✓ wrote', OUT);
}

main().catch(e => { console.error(e); process.exit(1); });

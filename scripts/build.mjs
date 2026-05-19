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
const stripHtml = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const truncate = (s, n) => s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const xmlEscape = (s) => String(s).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&apos;', '"': '&quot;' }[c]));

const wordCount = (txt) => stripHtml(txt).split(/\s+/).filter(Boolean).length;
const readTime = (words) => Math.max(1, Math.round(words / 220));
const fmtDate = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
};
const fmtMetaDate = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  const mo = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][dt.getUTCMonth()];
  return `${mo} ${String(dt.getUTCDate()).padStart(2, '0')} ${dt.getUTCFullYear()}`;
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

const pageHelpers = {
  site: SITE,
  copy: COPY,
  tabs: COPY.nav.tabs,
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
  escapeHtml,
};

const renderPage = async (templateName, data) => {
  const ctx = { ...pageHelpers, ...data };
  const inner = await eta.render(templateName, ctx);
  return await eta.render('_base', { ...ctx, body: inner });
};

// ── internal link checking ────────────────────────────────────

const allRoutes = new Set(['/', '/musings', '/media', '/changelog', '/rss.xml', '/sitemap.xml', '/robots.txt', '/404.html', '/tokens.css', '/site.css', '/CNAME']);
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
    image(href, title, text) {
      return imgFigure(href, text, title, 'full');
    },
  },
});

function imgFigure(href, alt, title, kls) {
  const cls = /inline-(l|r)|full|bleed/.test(kls)
    ? kls
    : (kls.includes('inline') ? 'inline-r' : 'full');
  const t = title ? ` title="${escapeHtml(title)}"` : '';
  return `<figure class="sp-figure ${cls}">
    <img src="${escapeHtml(href)}" alt="${escapeHtml(alt || '')}"${t} loading="lazy">
    ${alt ? `<figcaption>${escapeHtml(alt)}</figcaption>` : ''}
  </figure>`;
}

// ── content loaders ───────────────────────────────────────────

async function loadMusings() {
  const indices = await fg('musings/**/index.md', { cwd: SRC('content') });
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
    if (segs[0] !== 'musings') { fail(`Bad musings path: ${rel}`); continue; }
    const slug = segs[segs.length - 1];
    const categorySegs = segs.slice(1, -1); // [travel]
    if (!fm.title) { fail(`Missing title in ${rel}`); continue; }
    if (!fm.date) { fail(`Missing date in ${rel}`); continue; }
    if (fm.draft) continue;
    const url = '/' + folder; // /musings/travel/japan-tips

    const bodyMd = parsed.content;
    // Verify referenced images exist & rewrite to absolute output paths.
    const mediaDir = path.join(path.dirname(full), 'media');
    const imgRe = /!\[[^\]]*\]\(([^)\s]+)/g;
    let m;
    while ((m = imgRe.exec(bodyMd))) {
      const src = m[1];
      if (/^https?:/.test(src)) continue;
      const abs = path.resolve(path.dirname(full), src);
      if (!(await exists(abs))) fail(`Missing image ${src} referenced in ${rel}`);
    }
    const bodyHtml = marked.parse(bodyMd, { async: false });
    const rewritten = bodyHtml.replace(/(src|href)="(media\/[^"]+)"/g, (_, attr, p) => `${attr}="${url}/${p}"`);

    const words = wordCount(bodyMd);
    const preview = truncate(stripHtml(marked.parse(bodyMd.split('\n\n').slice(0, 2).join('\n\n'), { async: false })), 220);

    const featured = fm.featured_image
      ? `${url}/${fm.featured_image.replace(/^\.\//, '')}`
      : null;

    posts.push({
      type: 'musing',
      slug,
      url,
      folder,
      category: categorySegs,
      categoryPath: categorySegs.length ? '/musings/' + categorySegs.join('/') : '/musings',
      title: fm.title,
      subtitle: fm.subtitle || '',
      date: new Date(fm.date),
      tags: fm.tags || [],
      featured,
      seo: fm.seo || {},
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
    if (!data || !data.title) { fail(`Missing title in ${rel}`); continue; }
    const dir = path.dirname(rel); // media/australia/tasmania/mona
    const segs = dir.split('/');
    const url = '/' + dir;
    const galleryDir = path.dirname(full);

    const images = [];
    for (const im of data.images || []) {
      if (!im.file) { fail(`Image missing file in ${rel}`); continue; }
      if (!im.alt) fail(`Image alt missing in ${rel} for ${im.file}`);
      const abs = path.join(galleryDir, im.file);
      if (!(await exists(abs))) { fail(`Missing media file ${im.file} in ${rel}`); continue; }
      images.push({
        ...im,
        src: `${url}/${im.file}`,
        srcThumb: `${url}/_thumb/${im.file}`,
        srcMed: `${url}/_med/${im.file}`,
        absPath: abs,
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
    const baseOut = path.join(node.dir, im.file);
    // full (just copy original)
    await copyFile(im.absPath, baseOut);
    // medium
    await processImage(im.absPath, path.join(node.dir, '_med', im.file), { width: 1400 });
    // thumb
    await processImage(im.absPath, path.join(node.dir, '_thumb', im.file), { width: 600, quality: 78 });
  }
}

// ── render: home ──────────────────────────────────────────────

async function renderHome(musings, mediaNodes) {
  const shuffled = seededShuffle(musings.map(m => ({
    url: m.url, title: m.title, subtitle: m.subtitle, preview: m.preview,
    featured: m.featured, tags: m.tags, date: fmtDate(m.date),
    meta: `${fmtMetaDate(m.date)} · ${m.wordCount.toLocaleString()} WORDS · ~${m.readTime} MIN`,
    path: m.folder, category: m.category.join('/') || 'misc',
  })), 7);

  const allImages = mediaNodes.flatMap(n => n.images.map(im => ({
    src: im.srcMed, thumb: im.srcThumb, full: im.src,
    title: im.title || '',
    location: im.location || n.location || '',
    date: im.date ? fmtDate(im.date) : (n.date ? fmtDate(n.date) : ''),
    album: n.url, albumTitle: n.title,
    alt: im.alt || '',
  })));
  const shuffledImages = seededShuffle(allImages, 13);

  const recent = musings.slice(0, 5).map(m => ({
    date: fmtDate(m.date).replace(/-/g, '·'),
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
  });
  collectLinks('/', html);
  await writeFile('index.html', html);
}

// ── render: musings ───────────────────────────────────────────

async function renderMusings(musings) {
  // Index page.
  const indexHtml = await renderPage('musings-index', {
    page: {
      title: 'musings — ' + SITE.title,
      description: `All musings by ${SITE.author}. ${musings.length} posts on travel, code, aviation, home projects.`,
      url: '/musings',
      bodyClass: pageHelpers.bodyClass('musings'),
      type: 'website',
    },
    active: 'musings',
    posts: musings,
  });
  collectLinks('/musings', indexHtml);
  await writeFile('musings/index.html', indexHtml);

  // Per-post.
  for (let i = 0; i < musings.length; i++) {
    const m = musings[i];
    const prev = musings[i + 1] || null;
    const next = musings[i - 1] || null;
    const html = await renderPage('musing', {
      page: {
        title: `${m.title} — ${SITE.title}`,
        description: m.seo.description || truncate(m.preview, 158),
        keywords: m.seo.keywords || m.tags,
        url: m.url,
        bodyClass: pageHelpers.bodyClass('musings'),
        type: 'article',
        ogImage: m.featured,
      },
      active: 'musings',
      post: m,
      prev,
      next,
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
  for (const m of musings) {
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
    const url = '/musings/' + key;
    const allDescendants = musings.filter(m => m.category.slice(0, cat.segs.length).join('/') === key);
    const directPosts = cat.posts.slice().sort((a, b) => b.date - a.date);
    const children = [...cat.childKeys].map(k => ({
      key: k,
      label: k.split('/').pop(),
      url: '/musings/' + k,
      count: musings.filter(m => m.category.slice(0, k.split('/').length).join('/') === k).length,
    }));
    const html = await renderPage('musings-category', {
      page: {
        title: `${key} — musings — ${SITE.title}`,
        description: `Posts about ${cat.segs.join(' / ')} by ${SITE.author}.`,
        url,
        bodyClass: pageHelpers.bodyClass('musings'),
        type: 'website',
      },
      active: 'musings',
      categoryKey: key,
      categorySegs: cat.segs,
      posts: directPosts,
      allDescendants,
      children,
      randomPick: allDescendants[Math.floor((allDescendants.length || 1) / 2) % Math.max(allDescendants.length, 1)],
    });
    collectLinks(url, html);
    await writeFile(path.join('musings', key, 'index.html'), html);
    allRoutes.add(url);
  }

  // Tags.
  const tags = new Map();
  for (const m of musings) for (const t of m.tags) {
    if (!tags.has(t)) tags.set(t, []);
    tags.get(t).push(m);
  }
  for (const [tag, posts] of tags) {
    const url = `/musings/tag/${slugify(tag)}`;
    const html = await renderPage('musings-tag', {
      page: {
        title: `#${tag} — ${SITE.title}`,
        description: `Posts tagged "${tag}" by ${SITE.author}.`,
        keywords: [tag, ...posts.flatMap(p => p.tags)].slice(0, 10),
        url,
        bodyClass: pageHelpers.bodyClass('musings'),
        type: 'website',
      },
      active: 'musings',
      tag,
      posts,
    });
    collectLinks(url, html);
    await writeFile(`musings/tag/${slugify(tag)}/index.html`, html);
    allRoutes.add(url);
  }
}

// ── render: media ─────────────────────────────────────────────

async function renderMedia(mediaNodes) {
  // Process all images.
  for (const n of mediaNodes) await buildMediaImages(n);

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
      })),
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
  }
}

function coverImage(node) {
  if (node.images && node.images[0]) {
    return { full: node.images[0].src, med: node.images[0].srcMed, thumb: node.images[0].srcThumb, alt: node.images[0].alt };
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

async function renderChangelog() {
  const html = await renderPage('changelog', {
    page: {
      title: `changelog — ${SITE.title}`,
      description: COPY.changelog.intro,
      url: '/changelog',
      bodyClass: pageHelpers.bodyClass(),
      type: 'website',
    },
    active: '',
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
    fail(`Broken internal link: ${href}  (on ${from})`);
  }
}

// ── design assets ────────────────────────────────────────────

async function copyDesign() {
  await copyFile(SRC('design/tokens.css'), 'tokens.css');
  await copyFile(SRC('design/site.css'), 'site.css');
  if (await exists(SRC('CNAME'))) await copyFile(SRC('CNAME'), 'CNAME');
}

// ── main ─────────────────────────────────────────────────────

async function main() {
  console.time('build');
  await fs.rm(OUT, { recursive: true, force: true });
  await ensureDir(OUT);

  await copyDesign();
  const musings = await loadMusings();
  log(`${musings.length} musings`);
  const { nodes: mediaNodes } = await loadMedia();
  log(`${mediaNodes.length} gallery nodes`);

  await renderHome(musings, mediaNodes);
  await renderMusings(musings);
  await renderMedia(mediaNodes);
  await renderChangelog();
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

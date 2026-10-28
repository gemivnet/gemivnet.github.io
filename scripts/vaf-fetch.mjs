#!/usr/bin/env node
// Fetch the user's posts from the Van's Air Force build thread.
//
//   node scripts/vaf-fetch.mjs                 # posts newer than the last fetch
//   node scripts/vaf-fetch.mjs --all           # every post by the thread author
//   node scripts/vaf-fetch.mjs --since 123456  # posts with id > 123456
//   node scripts/vaf-fetch.mjs --post 123456   # exactly that post, even if seen
//
// Writes staging/vaf/<post-id>/post.md, post.json and every full-size
// attachment. staging/ is gitignored. Credentials live outside the repo in
// ~/.config/vaf/credentials.json ({ "username", "password" }); the browser
// profile (cookies, Cloudflare clearance) persists in ~/.config/vaf/profile.
//
// VAF sits behind Cloudflare and returns 403 to curl and to WebFetch, and
// full-size attachments need a logged-in session. Headless Chromium (both the
// headless shell and new-headless) gets stuck on the "Just a moment..."
// managed challenge; a headed Chromium under Xvfb clears it. So this runs
// headed, and `npm run vaf:fetch` wraps it in `xvfb-run -a`. The persistent
// profile keeps the clearance cookie and the login between runs.

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const THREAD = 'https://vansairforce.net/threads/rv-12is-121708.241503/';
const AUTHOR = 'gemivnet';
const CONFIG_DIR = join(homedir(), '.config', 'vaf');
const PROFILE_DIR = join(CONFIG_DIR, 'profile');
const CREDS_FILE = join(CONFIG_DIR, 'credentials.json');
const STATE_FILE = join(CONFIG_DIR, 'state.json');
const OUT_DIR = join(process.cwd(), 'staging', 'vaf');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? true;
};
const ALL = args.includes('--all');
const ONLY_POST = flag('--post') ? Number(flag('--post')) : null;
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const SINCE = ALL ? 0 : flag('--since') ? Number(flag('--since')) : state.lastPostId ?? 0;

const creds = JSON.parse(readFileSync(CREDS_FILE, 'utf8'));
mkdirSync(PROFILE_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

if (process.platform === 'linux' && !process.env.DISPLAY) {
  console.error('no DISPLAY; run via `npm run vaf:fetch` (xvfb-run) or on a desktop');
  process.exit(1);
}

// Cloudflare shows this browser an interactive "Verify you are human" box.
// The script never clicks it; that is the site's bot control and a person has
// to answer it. This machine is headless, so `--attend` exposes Chromium's
// DevTools on the LAN: open chrome://inspect on a desktop, add <nas-ip>:9222,
// click "inspect", and click the checkbox in the live view. The clearance
// cookie then lives in the profile and later runs go unattended until it
// expires. The port is open only while the script runs.
const ATTEND = args.includes('--attend');
const DEVTOOLS_PORT = 9222;
const CHALLENGE_WAIT_MS = ATTEND ? 10 * 60_000 : 60_000;

const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: ATTEND
    ? [`--remote-debugging-port=${DEVTOOLS_PORT}`, '--remote-debugging-address=0.0.0.0']
    : [],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

async function open(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  let warned = false;
  const deadline = Date.now() + CHALLENGE_WAIT_MS;
  while (Date.now() < deadline) {
    const title = await page.title();
    if (!/just a moment|attention required/i.test(title)) return;
    if (!warned && page.frames().some((f) => f.url().includes('challenges.cloudflare.com'))) {
      warned = true;
      if (ATTEND) {
        console.error(
          `· Cloudflare wants a human. On your desktop: chrome://inspect → Configure… → add this machine's IP:${DEVTOOLS_PORT} → "inspect" the vansairforce.net tab → click "Verify you are human". Waiting up to ${CHALLENGE_WAIT_MS / 60000} min.`,
        );
      } else {
        console.error('· Cloudflare wants a human; rerun with --attend (npm run vaf:attend)');
      }
    }
    await page.waitForTimeout(1500);
  }
  throw new Error(`Cloudflare challenge did not clear on ${url}`);
}

async function loggedIn() {
  return (await page.locator('.p-navgroup--member, a[href*="/account/"]').count()) > 0;
}

async function login() {
  await open(THREAD);
  if (await loggedIn()) return;
  console.error('· logging in');
  await open('https://vansairforce.net/login/');
  await page.fill('input[name="login"]', creds.username);
  await page.fill('input[name="password"]', creds.password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await open(THREAD);
  if (!(await loggedIn())) throw new Error('login failed; check ~/.config/vaf/credentials.json');
}

// Collect every post by AUTHOR across all thread pages.
async function collectPosts() {
  const posts = [];
  let url = THREAD;
  const seenUrls = new Set();
  while (url && !seenUrls.has(url)) {
    seenUrls.add(url);
    await open(url);
    const found = await page.$$eval(
      'article.message',
      (nodes, author) =>
        nodes
          .filter((n) => n.dataset.author === author)
          .map((n) => {
            const id = Number((n.id || n.dataset.content || '').replace(/\D/g, ''));
            const time = n.querySelector('time[datetime]')?.getAttribute('datetime') ?? null;
            const body = n.querySelector('.message-body .bbWrapper');
            const html = body ? body.innerHTML : '';
            const permalink = n.querySelector('a[href*="/post-"]')?.href ?? null;
            // Full-size attachment links are /attachments/<name>.<id>/ ; the
            // inline thumbnails are /data/attachments/... and must be ignored.
            const attachments = [
              ...n.querySelectorAll('a[href*="/attachments/"]:not([href*="/data/attachments/"])'),
            ].map((a) => ({
              href: a.href,
              alt: a.querySelector('img')?.alt || a.title || a.textContent.trim(),
            }));
            const seen = new Set();
            const uniq = attachments.filter((a) =>
              seen.has(a.href) ? false : (seen.add(a.href), true),
            );
            return { id, time, permalink, html, attachments: uniq };
          }),
      AUTHOR,
    );
    posts.push(...found);
    url = await page
      .$eval('a.pageNav-jump--next', (a) => a.href)
      .catch(() => null);
  }
  return posts;
}

// XenForo bbWrapper HTML to plain markdown-ish text. Good enough to read and
// hand-convert into an entry; it is not a general converter.
function htmlToMd(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<div class="bbImageWrapper[^>]*>[\s\S]*?<img[^>]*src="([^"]+)"[^>]*>[\s\S]*?<\/div>/gi, '\n![]($1)\n')
    .replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, '![]($1)')
    .replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, h, t) => {
      const text = t.replace(/<[^>]+>/g, '').trim();
      return text && text !== h ? `[${text}](${h})` : h;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function download(href, dest) {
  const res = await page.request.get(href);
  if (!res.ok()) throw new Error(`${res.status()} ${href}`);
  writeFileSync(dest, await res.body());
}

try {
  await login();
  const posts = await collectPosts();
  const wanted = posts.filter((p) => (ONLY_POST ? p.id === ONLY_POST : p.id > SINCE));
  console.error(`· ${posts.length} posts by ${AUTHOR}, ${wanted.length} to fetch`);

  for (const p of wanted) {
    const dir = join(OUT_DIR, String(p.id));
    mkdirSync(dir, { recursive: true });
    const files = [];
    for (const a of p.attachments) {
      const name = decodeURIComponent(a.href.replace(/\/$/, '').split('/').pop())
        .replace(/\.\d+$/, '')
        .replace(/[<>:"/\\|?*]/g, '_')
        .replace(/[. ]+$/, '');
      const dest = join(dir, name);
      try {
        await download(a.href, dest);
        files.push({ file: name, alt: a.alt, href: a.href });
      } catch (e) {
        console.error(`  ! ${e.message}`);
        files.push({ file: null, alt: a.alt, href: a.href, error: e.message });
      }
    }
    const md = htmlToMd(p.html);
    const header = `<!-- post ${p.id} · ${p.time} · ${p.permalink} -->\n\n`;
    const attachList = files.length
      ? '\n\n## Attachments\n\n' + files.map((f) => `- ${f.file ?? 'FAILED'}: ${f.alt}`).join('\n')
      : '';
    writeFileSync(join(dir, 'post.md'), header + md + attachList + '\n');
    writeFileSync(join(dir, 'post.json'), JSON.stringify({ ...p, files }, null, 2));
    console.log(`${dir}  (${p.time}, ${files.length} attachments)`);
  }

  const maxId = Math.max(state.lastPostId ?? 0, ...posts.map((p) => p.id));
  if (!ONLY_POST) writeFileSync(STATE_FILE, JSON.stringify({ lastPostId: maxId }, null, 2));
} finally {
  await ctx.close();
}

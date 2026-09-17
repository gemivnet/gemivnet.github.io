/**
 * Offline, and a deck that does not re-download 2,300 clips.
 *
 * The manifest has been here for a while and a service worker has not, so "installable" meant
 * an icon on the home screen that showed a connection error on a train. What this adds:
 *
 *   - the app shell survives going offline, so a session can be played with no network;
 *   - audio is cached as it is heard, permanently, because a clip is immutable and re-fetching
 *     `alma.mp3` every time the word comes round is the single largest thing this app does to a
 *     phone's data;
 *   - an update is picked up on the next visit rather than needing the app to be uninstalled.
 *
 * Deliberately hand-written rather than generated. A build-time precache manifest would pull in
 * a plugin and a build step for a five-file shell, and the awkward part of this file is not the
 * list of assets -- it is the cache strategies below, which a generator would not have chosen
 * any better.
 */

/**
 * Bumped by hand when the strategies change. The asset caches are content-addressed by URL, so
 * this is only about discarding a cache whose *rules* changed, not its contents.
 */
const VERSION = 'v1'
const SHELL = `szojatek-shell-${VERSION}`
const ASSETS = `szojatek-assets-${VERSION}`
const AUDIO = `szojatek-audio-${VERSION}`
const KEEP = new Set([SHELL, ASSETS, AUDIO])

/** The bare minimum to render something. Hashed assets are added as they are requested. */
const SHELL_URLS = ['./', './index.html', './manifest.webmanifest', './favicon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL)
      // Individually, and forgiving: one 404 in `addAll` rejects the whole install and leaves
      // the worker permanently unactivated, which is a much worse failure than a missing icon.
      await Promise.all(SHELL_URLS.map((url) => cache.add(url).catch(() => {})))
      // Take over at the next reload rather than waiting for every tab to close. There is one
      // tab, it is this app, and "quit the app twice to get the update" is not a real workflow.
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (!KEEP.has(key)) await caches.delete(key)
      await self.clients.claim()
    })(),
  )
})

/** Immutable by construction: vite fingerprints these, and audio filenames name one recording. */
const isHashedAsset = (url) => url.pathname.includes('/assets/')
const isAudio = (url) => url.pathname.includes('/audio/') || url.pathname.endsWith('.mp3')
const isFont = (url) => /\.(woff2?|ttf|otf)$/.test(url.pathname)

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  // Same origin only. The locked deck's ciphertext and every clip are served from here; nothing
  // else should be silently persisted on someone's device by this app.
  if (url.origin !== self.location.origin) return

  if (isAudio(url) || isHashedAsset(url) || isFont(url)) {
    event.respondWith(cacheFirst(request, isAudio(url) ? AUDIO : ASSETS))
    return
  }

  // Navigations and anything else: try the network so a deploy is picked up, fall back to the
  // cache so a tunnel is not the end of the session. A navigation that misses falls back to the
  // shell rather than to nothing, which is what makes a bookmarked `#/words` work offline.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL, './index.html'))
    return
  }
  event.respondWith(networkFirst(request, SHELL))
})

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(request)
  if (hit) return hit
  const response = await fetch(request)
  // Only complete, successful responses. A 206 or an opaque error cached here would be served
  // back forever as though it were the file.
  if (response.ok && response.status === 200) cache.put(request, response.clone())
  return response
}

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName)
  try {
    const response = await fetch(request)
    if (response.ok && response.status === 200) cache.put(request, response.clone())
    return response
  } catch (error) {
    const hit = (await cache.match(request)) ?? (fallbackUrl && (await cache.match(fallbackUrl)))
    if (hit) return hit
    throw error
  }
}

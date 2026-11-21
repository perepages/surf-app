// Service worker: keeps the app itself (HTML, JS, CSS, fonts, icons) on the phone so it opens
// instantly and works offline. Built into dist/sw.js by the `serviceWorker` plugin in
// vite.config.ts, which fills in VERSION and PRECACHE.
//
// Data (Open-Meteo, Supabase) is NOT handled here: the app keeps the last good copy itself
// (localStorage) and shows it when the network fails.

const VERSION = '__VERSION__'
const PREFIX = 'surf-shell-'
const CACHE = PREFIX + VERSION
const PRECACHE = __PRECACHE__

/** This version's copy, else any older version's (a page still open on it may need its old chunks). */
function fromCache(req) {
  return caches
    .open(CACHE)
    .then((cache) => cache.match(req))
    .then((hit) => hit ?? caches.match(req))
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // no-cache: revalidate with the server, so a file whose name doesn't change between
      // deploys (icons, manifest) isn't copied from an old browser-cache entry.
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Keep this version and the one before it: a page that is still open on the old version
      // may lazy-load an old chunk (e.g. the chart) after the new worker takes over.
      const names = (await caches.keys()).filter((n) => n.startsWith(PREFIX) && n !== CACHE)
      const dated = await Promise.all(
        names.map(async (n) => {
          const res = await (await caches.open(n)).match('/index.html')
          return { n, t: res ? Date.parse(res.headers.get('date') ?? '') || 0 : 0 }
        }),
      )
      dated.sort((a, b) => b.t - a.t)
      await Promise.all(dated.slice(1).map(({ n }) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // data APIs: straight to the network

  // Opening the app: serve this version's cached shell at once (works offline). A new deploy
  // installs a new worker in the background and is used from the next start.
  // Always this version's cache first: caches.match() alone searches the oldest cache first and
  // would keep serving the previous version's page.
  if (req.mode === 'navigate') {
    event.respondWith(fromCache('/index.html').then((cached) => cached ?? fetch(req)))
    return
  }

  // Hashed assets, fonts, icons: cache first, then network (and remember it).
  event.respondWith(
    fromCache(req).then(
      (cached) =>
        cached ??
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone()
            caches.open(CACHE).then((cache) => cache.put(req, copy))
          }
          return res
        }),
    ),
  )
})

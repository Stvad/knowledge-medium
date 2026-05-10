/* Knowledge Medium service worker.
 *
 * Strategy summary:
 *   - HTML navigations  : network-first, fallback to cached shell.
 *   - Same-origin assets: stale-while-revalidate. The Vite preserveModules
 *                         build emits modules at unhashed URLs, but the
 *                         cache namespace below is stamped with a per-build
 *                         id, so every deploy starts from an empty runtime
 *                         cache and the stale-vs-fresh skew window closes
 *                         on activation rather than spanning sessions.
 *   - esm.sh imports    : cache-first (URLs include version + integrity, so
 *                         they're effectively immutable).
 *   - Everything else   : passes through to the network (Supabase, PowerSync,
 *                         agent-runtime relay, etc. must not be cached).
 *
 * BUILD_ID is replaced by scripts/inject-sw-build-id.mjs after `vite build`.
 * In dev the placeholder is harmless because the SW isn't registered there.
 */

const CACHE_PREFIX = 'km-'
const BUILD_ID = '__BUILD_ID__'
const SHELL_CACHE = `${CACHE_PREFIX}shell-${BUILD_ID}`
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-${BUILD_ID}`
const VENDOR_CACHE = `${CACHE_PREFIX}vendor-${BUILD_ID}`
const ALL_CACHES = new Set([SHELL_CACHE, RUNTIME_CACHE, VENDOR_CACHE])

// The SW lives at <base>/sw.js, so its scope and registration URL share the
// app's base path. Resolve everything relative to the registration URL.
const scopeURL = new URL(self.registration.scope)
const SHELL_URLS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable.png',
  './apple-touch-icon.png',
].map((p) => new URL(p, scopeURL).toString())

// Build-injected list of every JS/CSS asset the HTML pulls in on first
// paint (entry script + modulepreload + stylesheets). Without this,
// first-visit module fetches go around the SW (it activates after they're
// dispatched), and an offline reload right after first load would fail
// to boot. Replaced by scripts/inject-sw-build-id.mjs.
const PRECACHE_ASSETS = JSON.parse('__PRECACHE_ASSETS__')
  .map((p) => new URL(p, scopeURL).toString())

const VENDOR_HOSTS = new Set(['esm.sh'])

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const [shell, runtime] = await Promise.all([
        caches.open(SHELL_CACHE),
        caches.open(RUNTIME_CACHE),
      ])
      // Shell entries use { cache: 'reload' } so an SW update always
      // pulls fresh HTML/icons from the network. The bulk asset list
      // uses { cache: 'default' } so the install satisfies from the
      // browser's HTTP cache (the page itself populated it moments ago)
      // — copying ~10MB from HTTP cache into Cache Storage costs almost
      // nothing on the network and gives us full offline boot coverage.
      // Per-URL failures are swallowed so one 404 can't strand install.
      const fetchInto = (cache, url, mode) =>
        fetch(new Request(url, {cache: mode}))
          .then((res) => (res && res.ok ? cache.put(url, res) : null))
          .catch(() => null)
      await Promise.all([
        ...SHELL_URLS.map((u) => fetchInto(shell, u, 'reload')),
        ...PRECACHE_ASSETS.map((u) => fetchInto(runtime, u, 'default')),
      ])
    })(),
  )
  self.skipWaiting()
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Only touch caches we own — caches.keys() lists every cache on the
      // origin, including ones from other apps or features hosted here.
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((k) => k.startsWith(CACHE_PREFIX) && !ALL_CACHES.has(k))
          .map((k) => caches.delete(k)),
      )
      await self.clients.claim()
    })(),
  )
})

const isNavigationRequest = (request) =>
  request.mode === 'navigate' ||
  (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'))

const isSameOrigin = (url) => url.origin === self.location.origin

const isVendor = (url) => VENDOR_HOSTS.has(url.hostname)

// Network-first for the SPA shell. We always read and write under a
// single canonical key so the many distinct navigation URLs (deep links,
// query-strings, hash routes) all share one cached HTML entry instead of
// each carving out its own duplicate.
const shellNetworkFirst = async (request, cacheName, shellURL) => {
  const cache = await caches.open(cacheName)
  try {
    const fresh = await fetch(request)
    if (fresh && fresh.ok) cache.put(shellURL, fresh.clone()).catch(() => {})
    return fresh
  } catch (err) {
    const cached = await cache.match(shellURL)
    if (cached) return cached
    throw err
  }
}

// Read across every km- cache so an entry placed in the shell cache by the
// install precache is still found when a later request would normally
// only check the runtime cache. Writes still go to the strategy's own
// cache to keep namespacing meaningful.
const staleWhileRevalidate = async (request, cacheName) => {
  const cached = await caches.match(request)
  const networkPromise = fetch(request)
    .then(async (res) => {
      if (res && res.ok) {
        const cache = await caches.open(cacheName)
        cache.put(request, res.clone()).catch(() => {})
      }
      return res
    })
    .catch(() => null)
  return cached || (await networkPromise) || Response.error()
}

const cacheFirst = async (request, cacheName) => {
  const cached = await caches.match(request)
  if (cached) return cached
  const fresh = await fetch(request)
  if (fresh && fresh.ok) {
    const cache = await caches.open(cacheName)
    cache.put(request, fresh.clone()).catch(() => {})
  }
  return fresh
}

self.addEventListener('fetch', (event) => {
  const {request} = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return

  if (isNavigationRequest(request) && isSameOrigin(url)) {
    const shellURL = new URL('./index.html', scopeURL).toString()
    event.respondWith(shellNetworkFirst(request, SHELL_CACHE, shellURL))
    return
  }

  if (isSameOrigin(url)) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE))
    return
  }

  if (isVendor(url)) {
    event.respondWith(cacheFirst(request, VENDOR_CACHE))
    return
  }
  // Default: don't intercept — let the browser handle it.
})


/* Knowledge Medium service worker.
 *
 * Strategy summary:
 *   - HTML navigations  : network-first, fallback to cached shell.
 *   - JS/CSS/WASM/JSON  : network-first w/ cache fallback. The Vite
 *                         preserveModules build emits these at stable URLs
 *                         (no content hash), so SWR could pair a fresh HTML
 *                         shell with stale modules across a deploy and
 *                         half-break the runtime. Network-first keeps online
 *                         users coherent; cache fallback keeps offline working.
 *   - Other same-origin : stale-while-revalidate (images, fonts, manifest,
 *                         maps — staleness here is cosmetic/non-fatal).
 *   - esm.sh imports    : cache-first (URLs include version + integrity, so
 *                         they're effectively immutable).
 *   - Everything else   : passes through to the network (Supabase, PowerSync,
 *                         agent-runtime relay, etc. must not be cached).
 *
 * Cache invalidation: bump CACHE_VERSION whenever this file changes in a
 * way that requires purging old caches.
 */

const CACHE_VERSION = 'v1'
const SHELL_CACHE = `km-shell-${CACHE_VERSION}`
const RUNTIME_CACHE = `km-runtime-${CACHE_VERSION}`
const VENDOR_CACHE = `km-vendor-${CACHE_VERSION}`
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

const VENDOR_HOSTS = new Set(['esm.sh'])

// Asset URLs whose contents define app behavior. Because the build leaves
// these at unhashed paths, a stale cache entry against a fresh HTML shell
// can desync the runtime — so we serve them network-first.
const SEMANTIC_ASSET_RE = /\.(?:m?js|css|wasm|json)$/i

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // Use { cache: 'reload' } to bypass the HTTP cache so we always get
      // a fresh copy of the shell when the SW updates.
      Promise.all(
        SHELL_URLS.map((url) =>
          fetch(new Request(url, {cache: 'reload'}))
            .then((res) => (res.ok ? cache.put(url, res) : null))
            .catch(() => null),
        ),
      ),
    ),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => !ALL_CACHES.has(k)).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

const isNavigationRequest = (request) =>
  request.mode === 'navigate' ||
  (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'))

const isSameOrigin = (url) => url.origin === self.location.origin

const isVendor = (url) => VENDOR_HOSTS.has(url.hostname)

const networkFirst = async (request, cacheName, fallbackURL) => {
  const cache = await caches.open(cacheName)
  try {
    const fresh = await fetch(request)
    if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => {})
    return fresh
  } catch (err) {
    const cached = (await cache.match(request)) || (fallbackURL ? await cache.match(fallbackURL) : null)
    if (cached) return cached
    throw err
  }
}

const staleWhileRevalidate = async (request, cacheName) => {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  const networkPromise = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone()).catch(() => {})
      return res
    })
    .catch(() => null)
  return cached || (await networkPromise) || Response.error()
}

const cacheFirst = async (request, cacheName) => {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  if (cached) return cached
  const fresh = await fetch(request)
  if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => {})
  return fresh
}

self.addEventListener('fetch', (event) => {
  const {request} = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return

  if (isNavigationRequest(request) && isSameOrigin(url)) {
    const shellURL = new URL('./index.html', scopeURL).toString()
    event.respondWith(networkFirst(request, SHELL_CACHE, shellURL))
    return
  }

  if (isSameOrigin(url)) {
    if (SEMANTIC_ASSET_RE.test(url.pathname)) {
      event.respondWith(networkFirst(request, RUNTIME_CACHE))
      return
    }
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE))
    return
  }

  if (isVendor(url)) {
    event.respondWith(cacheFirst(request, VENDOR_CACHE))
    return
  }
  // Default: don't intercept — let the browser handle it.
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

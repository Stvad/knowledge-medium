/* Knowledge Medium service worker.
 *
 * Versioning model — each deploy is an immutable "generation":
 *   - BUILD_ID (injected per build) namespaces this generation's caches:
 *     km-shell-<id> (HTML shell + icons) and km-assets-<id> (JS/CSS/fonts).
 *   - Same-origin app assets are served CACHE-FIRST with no revalidation.
 *     The Vite preserveModules build emits modules at UNHASHED, stable URLs
 *     (so plugins can import them through the import map), which means a
 *     URL's *bytes* differ between deploys. Pinning each generation to its
 *     own cache and never overwriting an entry in place is what keeps a
 *     generation internally consistent — a page only ever sees the single
 *     build it booted with, even across many small lazy-loaded modules.
 *     For that to hold for LAZY modules too, each generation's cache must be
 *     COMPLETE: `install` precaches the whole emitted asset graph (first-paint
 *     + every other cacheable asset, see PRECACHE_REST_ASSETS), so
 *     `assetCacheFirst` finds this generation's copy instead of falling through
 *     to the network — which serves the NEWEST generation and grafts
 *     foreign-build bytes onto an old page (the `does not provide an export
 *     named …` skew). The same completeness is what makes the app work OFFLINE.
 *     Caveat: this is only as good as the precache — a swallowed precache
 *     failure (flaky net, or the storage-yield skip below) leaves a hole, and a
 *     miss there still network-grafts. Fully closing the miss path (so the
 *     fallback refuses cross-generation bytes) needs a per-generation guard and
 *     is a follow-up, not done here.
 *   - We deliberately do NOT call clients.claim(). A freshly installed
 *     worker self-skipWaiting()s so it becomes the ACTIVE worker (and thus
 *     controls the NEXT load — so one reload, the user's own or our update
 *     prompt's, lands fully on the new build). But an already-open page
 *     keeps its existing controller, and therefore its generation, until it
 *     reloads. That is what removes mid-session version skew: an old tab
 *     that lazy-imports a chunk after a deploy gets *its* generation's
 *     chunk from its own cache, not the just-deployed one grafted onto its
 *     already-loaded (old) modules.
 *   - On activate we retain the last KEEP_GENERATIONS generations (current +
 *     previous, tracked by an install-order ledger) so a tab still on the
 *     previous build has a consistent cache to read from. Older generations
 *     are garbage-collected.
 *   - esm.sh imports: cache-first in a single shared, un-namespaced cache —
 *     those URLs carry version + integrity, so they're immutable across
 *     generations and need not be re-fetched on every deploy.
 *   - HTML navigations: network-first, falling back to the cached shell.
 *   - Everything else (Supabase, PowerSync, agent relay): straight to the
 *     network, never cached.
 *
 * BUILD_ID / PRECACHE_ASSETS are replaced by scripts/inject-sw-build-id.mjs
 * after `vite build`. In dev the placeholders are harmless (the SW isn't
 * registered there).
 */

const CACHE_PREFIX = 'km-'
const BUILD_ID = '__BUILD_ID__'
const SHELL_CACHE = `${CACHE_PREFIX}shell-${BUILD_ID}`
const ASSET_CACHE = `${CACHE_PREFIX}assets-${BUILD_ID}`
const VENDOR_CACHE = `${CACHE_PREFIX}vendor`
const META_CACHE = `${CACHE_PREFIX}meta`

// Keep the current build plus the two previous ones, so a tab held open
// across up to two deploys stays pinned to a cache that still exists. Each
// retained generation is roughly one full asset cache (~15-17MB), so this
// is a storage-for-resilience trade — it does NOT scale with fleet size,
// only with how many deploys a single tab can span before it reloads.
// Beyond the window the stale tab degrades to live bytes (possible skew),
// and it's been nudged to reload by the update prompt the whole time.
const KEEP_GENERATIONS = 3

// Storage-yield floor: skip the heavy full-graph precache when the origin has
// less than this much room left, so asset caches never consume the last
// headroom the user's OPFS SQLite DB / IndexedDB needs to write (see the
// install handler). Deliberately generous — the caches are bounded and small
// (one graph × KEEP_GENERATIONS), the DB is the dominant, growing consumer, so
// we bias hard toward leaving the DB room. Inert where quota is large (desktop:
// GBs free); it only bites on genuinely storage-constrained devices.
const MIN_FREE_BYTES_FOR_FULL_PRECACHE = 200 * 1024 * 1024

// VENDOR_CACHE / META_CACHE are never generation-GC'd: the scoped activate GC
// below only ever names this deploy's own shell-/assets-<id> caches, so these
// (and every sibling deploy's caches on this shared origin) are left untouched.

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

// Build-injected list of every OTHER same-origin cacheable asset — the full
// emitted module graph minus first-paint (lazy chunks, @babel/standalone, wasm,
// fonts, …). Precaching all of it is what makes this generation's cache
// self-contained, so `assetCacheFirst` never network-grafts a foreign
// generation (and the app runs offline). Kept separate from PRECACHE_ASSETS
// because it's installed with a different cache mode (see install). Replaced by
// scripts/inject-sw-build-id.mjs.
const PRECACHE_REST_ASSETS = JSON.parse('__PRECACHE_REST_ASSETS__')
  .map((p) => new URL(p, scopeURL).toString())

const VENDOR_HOSTS = new Set(['esm.sh'])

// A production/root SW's scope (…/knowledge-medium/) is a PREFIX of every
// PR-preview path (…/pr-preview/pr-<n>/…), which are hosted on this same origin.
// Since we never clients.claim(), the production SW controls a freshly-opened
// preview page until it reloads — and would otherwise cache the preview's shell
// + assets under production's OWN keys, poisoning the offline production shell
// with an unmerged build. So a SW refuses to serve/cache a preview subtree it
// doesn't own. A preview's own SW (its scope IS under /pr-preview/) is exempt,
// so it still serves its own subtree normally.
const PREVIEW_SUBTREE = /\/pr-preview\/pr-[^/]+\//
const OWN_SCOPE_IS_PREVIEW = PREVIEW_SUBTREE.test(scopeURL.pathname)
const isForeignPreviewRequest = (url) =>
  !OWN_SCOPE_IS_PREVIEW && PREVIEW_SUBTREE.test(url.pathname)

// --- generation ledger ------------------------------------------------------
// An install-ordered list of BUILD_IDs (newest last), stored as a JSON
// Response under a synthetic key in META_CACHE. Lets `activate` GC every
// generation except the most recent KEEP_GENERATIONS without needing the
// build ids to be sortable (they're git shas).
const LEDGER_KEY = new URL('./__km_generations__', scopeURL).toString()

const readLedger = async () => {
  try {
    const cache = await caches.open(META_CACHE)
    const res = await cache.match(LEDGER_KEY)
    if (!res) return []
    const ids = await res.json()
    return Array.isArray(ids) ? ids : []
  } catch {
    return []
  }
}

const writeLedger = async (ids) => {
  const cache = await caches.open(META_CACHE)
  await cache.put(
    LEDGER_KEY,
    new Response(JSON.stringify(ids), {headers: {'content-type': 'application/json'}}),
  )
}

const recordGeneration = async (id) => {
  const ids = (await readLedger()).filter((x) => x !== id)
  ids.push(id)
  await writeLedger(ids)
}

// Whether there's enough free storage to precache the full asset graph without
// crowding the user's local database. Fails OPEN (returns true) whenever we
// can't get a real estimate — a missing/legacy `StorageManager`, or a browser
// that reports `quota`/`usage` as 0/undefined — so we degrade to the prior
// best-effort behavior rather than silently disabling offline everywhere.
const hasHeadroomForFullPrecache = async () => {
  try {
    const est = await self.navigator?.storage?.estimate?.()
    if (!est || typeof est.quota !== 'number' || typeof est.usage !== 'number') return true
    return est.quota - est.usage > MIN_FREE_BYTES_FOR_FULL_PRECACHE
  } catch {
    return true
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const [shell, assets] = await Promise.all([
        caches.open(SHELL_CACHE),
        caches.open(ASSET_CACHE),
      ])
      // Cache modes, chosen so a generation cache only ever holds THIS build's
      // bytes for a URL — never a stale prior deploy's:
      //   - SHELL_URLS → 'reload': always pull the fresh HTML/icons from network.
      //   - PRECACHE_ASSETS (first-paint) + PRECACHE_REST_ASSETS → 'no-cache':
      //     a CONDITIONAL revalidate. The unhashed URLs are served by GitHub
      //     Pages with `Cache-Control: max-age=600` + a content ETag, so the
      //     browser HTTP cache can hold a PRIOR generation's bytes inside that
      //     window. 'default' would copy those stale bytes into this generation
      //     (persistently poisoning it — the exact cross-generation export-skew
      //     this precache exists to kill), and 'reload' would re-download every
      //     asset on every deploy. 'no-cache' revalidates against the origin:
      //     the ETag mismatches a stale entry → 200 with current bytes, and an
      //     unchanged asset → 304 → the warm HTTP-cache bytes are reused (cheap,
      //     and it's what keeps a redeploy from re-downloading unchanged files).
      // Per-URL failures are swallowed so one 404 (or a `cache.put` quota
      // rejection) can't strand install. NOTE: this makes each generation's
      // cache self-contained only if the precache SUCCEEDS — a swallowed failure
      // (flaky net, storage pressure) leaves an asset absent, and
      // `assetCacheFirst`'s network fallback then serves the NEWEST deploy's
      // bytes on that miss, which grafts a foreign generation. That fallback is
      // "self-healing" ONLY while this generation is still the newest deploy;
      // eliminating the graft on a genuine miss needs a per-generation guard and
      // is a follow-up. The persistent IndexedDB compile cache (survives
      // deploys) still covers warm extension compiles regardless.
      const fetchInto = (cache, url, mode) =>
        fetch(new Request(url, {cache: mode}))
          .then((res) => (res && res.ok ? cache.put(url, res) : null))
          .catch(() => null)
      // PRECACHE_REST_ASSETS is the full graph (thousands of small modules), so
      // fan out through a bounded pool rather than dispatching every fetch at
      // once — keeps install from opening thousands of concurrent connections.
      const runPooled = async (items, limit, task) => {
        let next = 0
        const worker = async () => {
          while (next < items.length) await task(items[next++])
        }
        await Promise.all(
          Array.from({length: Math.min(limit, items.length)}, worker),
        )
      }
      // Shell + first-paint are small and needed for offline boot → always cache.
      await Promise.all([
        ...SHELL_URLS.map((u) => fetchInto(shell, u, 'reload')),
        ...PRECACHE_ASSETS.map((u) => fetchInto(assets, u, 'no-cache')),
      ])
      // Storage yield: the user's OPFS SQLite DB / IndexedDB are sacred; asset
      // caches are disposable (re-fetchable from the origin). `persist()` is
      // granted at boot, so the browser won't auto-evict — nothing reclaims cache
      // space for a growing DB unless the SW yields voluntarily. So skip the
      // heavy full-graph precache when the origin is near quota, rather than let
      // it consume the last headroom a DB write needs. The generation then
      // degrades to online-only / on-demand for that low-storage device (skew
      // risk returns there — acceptable; data integrity outranks offline
      // completeness), while shell + first-paint above keep it bootable.
      if (await hasHeadroomForFullPrecache()) {
        await runPooled(PRECACHE_REST_ASSETS, 16, (u) => fetchInto(assets, u, 'no-cache'))
      }
      // Record the generation ONLY after its cache is populated. Recording at
      // the start would leave a phantom ledger id if the (now heavy) install is
      // interrupted mid-precache — a later deploy's activate GC would then count
      // that never-usable id toward KEEP_GENERATIONS and evict a real, still-
      // needed older generation one deploy early.
      await recordGeneration(BUILD_ID)
    })(),
  )
  // Become active immediately so the NEXT load is served by this build.
  // We do NOT claim — open pages keep their generation until they reload.
  self.skipWaiting()
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const ledger = await readLedger()
      const keepIds = new Set(ledger.slice(-KEEP_GENERATIONS))

      // Delete only THIS deploy's own now-expired generations. Cache Storage is
      // per-ORIGIN, so caches.keys() also lists the production deploy's caches
      // and every sibling PR preview's — all sharing the km- prefix, all live
      // (production + previews are served from the same origin). Blanket-deleting
      // km-* not in a keep-set would wipe THEIR caches. Our ledger holds only the
      // generation ids this scope installed, and ids don't collide across deploys
      // (distinct build shas), so mapping our expired ledger ids to cache names
      // targets exactly our own — never a sibling's. The current build's id is
      // the last ledger entry (recorded on install) so it's never expired; an
      // unreadable/empty ledger yields no deletions (safe); vendor/meta and this
      // build's caches are simply never named here.
      const expiredIds = ledger.slice(0, Math.max(0, ledger.length - KEEP_GENERATIONS))
      // Free space FIRST, then trim the ledger. The ledger write is a
      // `cache.put`, which throws `QuotaExceededError` exactly when the origin
      // is full — i.e. the moment GC matters most. Doing it before the deletes
      // (the old order) let that throw abort activate and skip the deletes, so
      // no space was ever reclaimed. Deletes don't depend on the trimmed ledger
      // (expiredIds comes from the original), and a failed ledger trim is benign
      // (a few stale ids that the next activate re-trims), so guard it.
      await Promise.all(
        expiredIds.flatMap((id) => [
          caches.delete(`${CACHE_PREFIX}shell-${id}`),
          caches.delete(`${CACHE_PREFIX}assets-${id}`),
        ]),
      )
      if (ledger.length > keepIds.size) {
        try {
          await writeLedger([...keepIds])
        } catch {
          // benign — the ledger keeps a few extra ids; next activate re-trims.
        }
      }
      // NB: intentionally no clients.claim() — see the file header. Taking
      // over already-open pages is exactly what would let a new chunk land
      // in an old page mid-session.
    })(),
  )
})

const isNavigationRequest = (request) =>
  request.mode === 'navigate' ||
  (request.method === 'GET' && request.headers.get('accept')?.includes('text/html'))

const isSameOrigin = (url) => url.origin === self.location.origin

const isVendor = (url) => VENDOR_HOSTS.has(url.hostname)

// Static build assets we serve cache-first within the generation. Match by
// request.destination (script/style/worker/font/image cover module imports,
// modulepreload, stylesheets, the wasm-sqlite worker and fonts) with an
// extension fallback for anything a browser leaves as an empty destination.
const ASSET_EXTENSION = /\.(?:js|mjs|css|wasm|woff2?|ttf|otf|png|svg|jpe?g|webp|gif|ico)$/
const isCacheableAsset = (request, url) =>
  isSameOrigin(url) &&
  (['script', 'style', 'worker', 'font', 'image'].includes(request.destination) ||
    ASSET_EXTENSION.test(url.pathname))

// Network-first for the SPA shell. We always read and write under a single
// canonical key so the many distinct navigation URLs (deep links,
// query-strings, hash routes) all share one cached HTML entry.
const shellNetworkFirst = async (request, shellURL) => {
  const cache = await caches.open(SHELL_CACHE)
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

// Cache-first within THIS generation's caches, no revalidation. The
// generation's assets are immutable, so a HIT is always correct and skew-free.
// We check the shell cache too (icons/manifest land there at install) — both
// belong to this generation. Since `install` now precaches the WHOLE graph, a
// miss should only happen when precache didn't complete (flaky net / storage
// yield). The network fallback below then serves the NEWEST deploy's bytes,
// which grafts a foreign generation onto an old page — correct only while this
// IS the newest deploy. Closing that (a fallback that refuses cross-generation
// bytes) needs a per-generation guard and is a follow-up.
const assetCacheFirst = async (request) => {
  const assets = await caches.open(ASSET_CACHE)
  const cached =
    (await assets.match(request)) || (await (await caches.open(SHELL_CACHE)).match(request))
  if (cached) return cached
  try {
    const fresh = await fetch(request)
    if (fresh && fresh.ok) assets.put(request, fresh.clone()).catch(() => {})
    return fresh
  } catch {
    return Response.error()
  }
}

const cacheFirst = async (request, cacheName) => {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  if (cached) return cached
  try {
    const fresh = await fetch(request)
    if (fresh && fresh.ok) cache.put(request, fresh.clone()).catch(() => {})
    return fresh
  } catch {
    return Response.error()
  }
}

self.addEventListener('fetch', (event) => {
  const {request} = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return

  // Never let production's broad-scope SW touch a nested preview deploy's
  // requests — let them fall through to the network (the preview's own SW owns
  // them once active). See isForeignPreviewRequest.
  if (isForeignPreviewRequest(url)) return

  if (isNavigationRequest(request) && isSameOrigin(url)) {
    const shellURL = new URL('./index.html', scopeURL).toString()
    event.respondWith(shellNetworkFirst(request, shellURL))
    return
  }

  if (isCacheableAsset(request, url)) {
    event.respondWith(assetCacheFirst(request))
    return
  }

  if (isVendor(url)) {
    event.respondWith(cacheFirst(request, VENDOR_CACHE))
    return
  }
  // Default: don't intercept — let the browser handle it. This includes
  // other same-origin GETs like version.json, which must stay fresh.
})

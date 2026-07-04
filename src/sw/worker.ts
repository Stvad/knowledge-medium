/**
 * The service worker's orchestration — ledger I/O, install precache, activate
 * GC, and fetch routing — as a factory parameterized by its globals
 * (`caches` / `fetch` / origin) instead of reaching for `self`. The worker
 * entry (src/sw/sw.ts) constructs one of these with the real globals + injected
 * build config and wires it to the SW events; tests construct one with an
 * in-memory CacheStorage and a stub fetch and drive install/activate/fetch
 * directly. Keeping this file free of `self` / ServiceWorkerGlobalScope is what
 * makes it importable + unit-testable outside a worker.
 *
 * The versioning model this implements is documented in the sw.ts header.
 */
import {isCacheableAsset} from './assets'
import {
  computeExpiredIds,
  computeKeepIds,
  computeReapableCaches,
  type LedgerEntry,
  normalizeLedger,
  type ScopeLedger,
} from './ledger'
import {isForeignPreviewRequest, PREVIEW_SUBTREE} from './preview'

const CACHE_PREFIX = 'km-'
const VENDOR_HOSTS = new Set(['esm.sh'])

// The HTML shell + icons the app boots from — a static set (not build-injected),
// resolved against the SW scope. Served network-first (HTML) / cache-first
// (icons) from the shell cache.
const SHELL_PATHS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable.png',
  './apple-touch-icon.png',
]

export interface SwConfig {
  /** Per-deploy id namespacing this generation's caches (injected at build). */
  buildId: string
  /** self.registration.scope as a URL — the base every path resolves against. */
  scopeURL: URL
  /** How many generations to retain on activate (current + previous). */
  keepGenerations: number
  /**
   * How long a PR-preview scope may sit untouched before its leaked generation
   * caches are reaped from the shared origin (never applies to production).
   */
  staleScopeMs: number
  /** First-paint asset URLs (build-injected), base-prefixed or scope-relative. */
  precacheAssets: string[]
  /** The rest of the emitted graph (build-injected) — everything minus first-paint. */
  precacheRestAssets: string[]
}

export interface SwEnv {
  caches: CacheStorage
  fetch: typeof fetch
  /** self.location.origin — for the same-origin check. */
  origin: string
  /** Injected clock (Date.now) — stamps ledger writes / drives the stale sweep. */
  now: () => number
}

export const createServiceWorker = (config: SwConfig, env: SwEnv) => {
  const {buildId, scopeURL, keepGenerations} = config
  const {caches, fetch, now} = env

  const SHELL_CACHE = `${CACHE_PREFIX}shell-${buildId}`
  const ASSET_CACHE = `${CACHE_PREFIX}assets-${buildId}`
  const VENDOR_CACHE = `${CACHE_PREFIX}vendor`
  const META_CACHE = `${CACHE_PREFIX}meta`

  const toScopeUrl = (p: string) => new URL(p, scopeURL).toString()
  const SHELL_URLS = SHELL_PATHS.map(toScopeUrl)
  const PRECACHE_ASSETS = config.precacheAssets.map(toScopeUrl)
  const PRECACHE_REST_ASSETS = config.precacheRestAssets.map(toScopeUrl)

  // A production/root SW's scope (…/knowledge-medium/) is a PREFIX of every
  // PR-preview path; see src/sw/preview.ts for why a SW refuses to serve/cache
  // a preview subtree it doesn't own.
  const OWN_SCOPE_IS_PREVIEW = PREVIEW_SUBTREE.test(scopeURL.pathname)

  // --- generation ledger ----------------------------------------------------
  // An install-ordered list of BUILD_IDs (newest last), stored as a JSON
  // Response under a synthetic per-scope key in the shared META_CACHE. Retention
  // math is the pure computeKeepIds / computeExpiredIds in ./ledger.
  const LEDGER_BASENAME = '__km_generations__'
  const LEDGER_KEY = toScopeUrl(`./${LEDGER_BASENAME}`)

  const readLedgerEntry = async (): Promise<LedgerEntry> => {
    try {
      const cache = await caches.open(META_CACHE)
      const res = await cache.match(LEDGER_KEY)
      if (!res) return {ids: [], updatedAt: undefined}
      return normalizeLedger(await res.json())
    } catch {
      return {ids: [], updatedAt: undefined}
    }
  }

  const readLedger = async (): Promise<string[]> => (await readLedgerEntry()).ids

  // Stamp every write with the current time. updatedAt is what the cross-scope
  // sweep reads to tell an ABANDONED preview (SW stopped running after merge) from
  // a live one — and it's refreshed on this scope's install/activate, so the
  // current scope's own ledger always looks fresh and is never self-reaped.
  const writeLedger = async (ids: string[]): Promise<void> => {
    const cache = await caches.open(META_CACHE)
    const entry: LedgerEntry = {ids, updatedAt: now()}
    await cache.put(
      LEDGER_KEY,
      new Response(JSON.stringify(entry), {headers: {'content-type': 'application/json'}}),
    )
  }

  const recordGeneration = async (id: string): Promise<void> => {
    const ids = (await readLedger()).filter((x) => x !== id)
    ids.push(id)
    await writeLedger(ids)
  }

  const install = async (): Promise<void> => {
    // Record this generation up front so its cache stays ledger-tracked (and
    // therefore GC-eligible) even if the heavy precache below is interrupted.
    // An interrupted install then leaves at worst a PHANTOM id that ages out of
    // the keep-window like any other and gets swept — never an UNTRACKED
    // km-assets-<id> the scoped GC can't reach (which recording-at-the-end
    // would strand permanently on the shared origin). The keep-window cost of a
    // phantom is bounded and self-clearing; a cleaner fix (provisional ledger
    // entries that don't consume a keep slot) is a possible follow-up.
    await recordGeneration(buildId)
    const [shell, assets] = await Promise.all([
      caches.open(SHELL_CACHE),
      caches.open(ASSET_CACHE),
    ])
    // Cache mode: SHELL_URLS → 'reload' (always fresh HTML/icons). Both asset
    // lists → 'no-cache', a CONDITIONAL revalidate against the origin. The
    // unhashed URLs are served by Pages with max-age=600 + a content ETag, so
    // the browser HTTP cache can hold a PRIOR generation's bytes within that
    // window: 'default' would copy those stale bytes into this generation
    // (persistently poisoning it — the cross-generation export-skew this whole
    // precache exists to kill); 'reload' would re-download every asset every
    // deploy. 'no-cache' revalidates — a stale entry's ETag mismatches → 200
    // with current bytes; an unchanged asset → 304 → warm HTTP-cache bytes are
    // reused (so a redeploy doesn't re-download unchanged files).
    // Per-URL failures are swallowed so one 404 / a `cache.put` quota rejection
    // can't strand install. Caveat: the cache is self-contained only if the
    // precache SUCCEEDS — a swallowed failure leaves a hole, and
    // `assetCacheFirst`'s network fallback then grafts the newest deploy's
    // bytes on that miss (self-healing only while this IS the newest deploy; a
    // per-generation guard to refuse cross-gen bytes is a follow-up). The
    // persistent IndexedDB compile cache still covers warm extension compiles.
    const fetchInto = (cache: Cache, url: string, mode: RequestCache) =>
      fetch(new Request(url, {cache: mode}))
        .then((res) => (res && res.ok ? cache.put(url, res) : null))
        .catch(() => null)
    // Both lists are large (the minified build first-paints ~200 <script> tags;
    // the rest is the full module graph), so fan every fetch through a bounded
    // pool instead of opening hundreds/thousands of connections at once.
    const runPooled = async (
      items: string[],
      limit: number,
      task: (url: string) => Promise<unknown>,
    ) => {
      let next = 0
      const worker = async () => {
        while (next < items.length) await task(items[next++])
      }
      await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker))
    }
    // ALWAYS precache the whole graph so the current generation is fully
    // offline-capable — we never skip it for storage (footprint is bounded by
    // keepGenerations and reclaimed by the activate GC, not by dropping offline
    // coverage). First-paint first: it's the offline-boot-critical set, so it
    // lands before the lazy tail.
    await Promise.all(SHELL_URLS.map((u) => fetchInto(shell, u, 'reload')))
    await runPooled(PRECACHE_ASSETS, 16, (u) => fetchInto(assets, u, 'no-cache'))
    await runPooled(PRECACHE_REST_ASSETS, 16, (u) => fetchInto(assets, u, 'no-cache'))
  }

  const activate = async (): Promise<void> => {
    const ledger = await readLedger()
    const keepIds = new Set(computeKeepIds(ledger, keepGenerations))

    // Delete only THIS deploy's own now-expired generations. Cache Storage is
    // per-ORIGIN, so caches.keys() also lists the production deploy's caches
    // and every sibling PR preview's — all sharing the km- prefix, all live
    // (production + previews are served from the same origin). Blanket-deleting
    // km-* not in a keep-set would wipe THEIR caches. We instead map only OUR
    // expired ledger ids to cache names. That targets exactly our own — never a
    // sibling's — because a build id is the built commit's sha, and a preview's
    // HEAD carries the PR's own commits, so no two live scopes ever build the
    // same commit (the one case they'd match, a fast-forward merge, tears the
    // preview down). If build-id derivation ever changed to allow collisions,
    // this path would need the same cross-scope shared-id guard the preview
    // sweep already applies (computeReapableCaches's keptIds). The current
    // build's id is the last ledger entry (recorded on install) so it's never
    // expired; an unreadable/empty ledger yields no deletions (safe);
    // vendor/meta and this build's caches are simply never named here.
    const expiredIds = computeExpiredIds(ledger, keepGenerations)
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
    // Then reclaim OTHER scopes' leaked preview caches (best-effort — a sweep
    // failure must never break activation).
    try {
      await sweepStalePreviewGenerations()
    } catch {
      // benign — leaked previews just persist to the next activate.
    }
    // NB: intentionally no clients.claim() — see the sw.ts header. Taking over
    // already-open pages is exactly what would let a new chunk land in an old
    // page mid-session.
  }

  // Cache Storage is shared per-ORIGIN, so a client accumulates the caches of
  // every PR preview it ever opened. Production's activate GC only ever names
  // its OWN generations (by ledger id), and a merged preview's SW never runs
  // again to clean up after itself — so those preview caches (shell + assets +
  // ledger entry) leak on the origin forever. This sweep, run from any active
  // SW, reclaims them: it reads every scope's ledger out of the shared meta
  // cache and deletes the caches of preview scopes untouched for staleScopeMs.
  // computeReapableCaches enforces the safety rails (preview-only — production
  // is structurally unreapable; timestamped-and-stale only; never a cache a
  // surviving scope still references). See src/sw/ledger.ts.
  //
  // Best-effort + snapshot-based: it reads a snapshot of all ledgers, then
  // deletes. In the (near-impossible) window where a 14-day-dormant preview
  // redeploys — re-stamping its ledger — DURING another client's sweep, that
  // sweep's delete can drop the just-written entry. Harmless and self-healing:
  // only ledger TRACKING is lost (the fresh generation's caches are keyed by a
  // new id the snapshot never saw, so they're untouched), and the next deploy
  // re-records it.
  const sweepStalePreviewGenerations = async (): Promise<void> => {
    const meta = await caches.open(META_CACHE)
    const ledgers: ScopeLedger[] = []
    for (const req of await meta.keys()) {
      // Only <scope>/__km_generations__ keys are scope ledgers. META_CACHE holds
      // nothing else today, but guard structurally so a future non-ledger entry
      // — especially one under a /pr-preview/ path — can never be misread as a
      // reapable scope and deleted.
      if (!req.url.endsWith(`/${LEDGER_BASENAME}`)) continue
      const res = await meta.match(req)
      if (!res) continue
      const raw: unknown = await res.json().catch(() => null)
      const {ids, updatedAt} = normalizeLedger(raw)
      ledgers.push({scopeUrl: req.url, ids, updatedAt})
    }
    const {cacheNames, ledgerScopeUrls} = computeReapableCaches({
      ledgers,
      now: now(),
      staleMs: config.staleScopeMs,
      cachePrefix: CACHE_PREFIX,
      selfScopeUrl: LEDGER_KEY,
    })
    await Promise.all([
      ...cacheNames.map((name) => caches.delete(name)),
      ...ledgerScopeUrls.map((url) => meta.delete(url)),
    ])
  }

  const isNavigationRequest = (request: Request): boolean =>
    request.mode === 'navigate' ||
    (request.method === 'GET' && (request.headers.get('accept')?.includes('text/html') ?? false))

  const isSameOrigin = (url: URL): boolean => url.origin === env.origin

  const isVendor = (url: URL): boolean => VENDOR_HOSTS.has(url.hostname)

  // Network-first for the SPA shell. We always read and write under a single
  // canonical key so the many distinct navigation URLs (deep links,
  // query-strings, hash routes) all share one cached HTML entry.
  const shellNetworkFirst = async (request: Request, shellURL: string): Promise<Response> => {
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
  // belong to this generation. Since `install` precaches the WHOLE graph, a miss
  // should only happen when precache didn't complete (flaky net / storage
  // yield). The network fallback below then serves the NEWEST deploy's bytes,
  // which grafts a foreign generation onto an old page — correct only while this
  // IS the newest deploy. Closing that (a fallback that refuses cross-generation
  // bytes) needs a per-generation guard and is a follow-up.
  const assetCacheFirst = async (request: Request): Promise<Response> => {
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

  const cacheFirst = async (request: Request, cacheName: string): Promise<Response> => {
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

  /**
   * Route a GET request. Returns a Response promise for the entry to
   * `respondWith`, or undefined to NOT intercept (let the browser handle it —
   * non-GET, non-http(s), foreign preview subtree, and same-origin non-assets
   * like version.json that must stay fresh).
   */
  const handleFetch = (request: Request): Promise<Response> | undefined => {
    if (request.method !== 'GET') return undefined
    const url = new URL(request.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined

    // Never let production's broad-scope SW touch a nested preview deploy's
    // requests — let them fall through to the network (the preview's own SW owns
    // them once active).
    if (isForeignPreviewRequest(OWN_SCOPE_IS_PREVIEW, url.pathname)) return undefined

    if (isNavigationRequest(request) && isSameOrigin(url)) {
      return shellNetworkFirst(request, toScopeUrl('./index.html'))
    }
    if (isCacheableAsset(request.destination, url.pathname, isSameOrigin(url))) {
      return assetCacheFirst(request)
    }
    if (isVendor(url)) return cacheFirst(request, VENDOR_CACHE)
    return undefined
  }

  return {install, activate, handleFetch, readLedger, writeLedger, recordGeneration}
}

export type ServiceWorkerInstance = ReturnType<typeof createServiceWorker>

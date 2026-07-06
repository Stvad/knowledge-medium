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
import {RECORD_PREVIEW_DATABASE_MESSAGE} from './messages'
import {isForeignPreviewRequest, PREVIEW_SUBTREE} from './preview'

const CACHE_PREFIX = 'km-'
const VENDOR_HOSTS = new Set(['esm.sh'])
const SQLITE_DB_SIBLING_SUFFIXES = ['-journal', '-wal', '-shm'] as const

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
  /**
   * A preview scope that's actively USED (not just deployed) refreshes its own
   * ledger timestamp at most this often, so a long-lived preview that hasn't
   * redeployed isn't mistaken for abandoned and reaped. Must be well under
   * staleScopeMs. Ignored for production (never reaped).
   */
  touchIntervalMs: number
  /** First-paint asset URLs (build-injected), base-prefixed or scope-relative. */
  precacheAssets: string[]
  /** The rest of the emitted graph (build-injected) — everything minus first-paint. */
  precacheRestAssets: string[]
  /**
   * Cross-origin vendor module URLs (esm.sh React set) to precache at install so
   * the app boots OFFLINE. These are ABSOLUTE https URLs (not scope-resolved) and
   * immutable (version- + SRI-pinned), so they live in the shared, un-namespaced
   * vendor cache. Build-injected from the import map's integrity keys — the exact
   * set the app can import — because they're excluded from the same-origin
   * precache (which only walks dist/), leaving an offline hole this closes.
   */
  precacheVendor: string[]
}

export interface SwEnv {
  caches: CacheStorage
  fetch: typeof fetch
  /** self.location.origin — for the same-origin check. */
  origin: string
  /** Injected clock (Date.now) — stamps ledger writes / drives the stale sweep. */
  now: () => number
  /** navigator.storage, injected so OPFS cleanup stays testable. */
  storage?: {
    getDirectory?: () => Promise<{
      removeEntry: (name: string) => Promise<void>
    }>
  }
  /** indexedDB, injected so legacy IndexedDB-backed database cleanup is testable. */
  indexedDB?: {
    databases?: () => Promise<Array<{name?: string | null}>>
    deleteDatabase?: (name: string) => IDBOpenDBRequest
  }
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
  // Vendor URLs are absolute + cross-origin — used verbatim, NOT scope-resolved.
  const PRECACHE_VENDOR = config.precacheVendor

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
      if (!res) return {ids: [], updatedAt: undefined, databaseNames: []}
      return normalizeLedger(await res.json())
    } catch {
      return {ids: [], updatedAt: undefined, databaseNames: []}
    }
  }

  const readLedger = async (): Promise<string[]> => (await readLedgerEntry()).ids

  // Stamp every write with the current time. updatedAt is what the cross-scope
  // sweep reads to tell an ABANDONED preview (SW stopped running after merge) from
  // a live one — and it's refreshed on this scope's install/activate, so the
  // current scope's own ledger always looks fresh and is never self-reaped.
  const writeLedgerEntry = async (entry: LedgerEntry): Promise<void> => {
    const cache = await caches.open(META_CACHE)
    const nextEntry: LedgerEntry = {...entry, updatedAt: now()}
    await cache.put(
      LEDGER_KEY,
      new Response(JSON.stringify(nextEntry), {headers: {'content-type': 'application/json'}}),
    )
  }

  const recordGeneration = async (id: string): Promise<void> => {
    const entry = await readLedgerEntry()
    const ids = entry.ids.filter((x) => x !== id)
    ids.push(id)
    await writeLedgerEntry({...entry, ids})
  }

  const writeLedger = async (ids: string[]): Promise<void> => {
    const entry = await readLedgerEntry()
    await writeLedgerEntry({...entry, ids})
  }

  // Touch-on-use: the cross-scope sweep reaps a preview whose ledger `updatedAt`
  // is older than staleScopeMs, but install/activate (deploys) are the only
  // writers — an actively-used preview that simply hasn't REDEPLOYED in 14 days
  // would be misread as abandoned and have its live caches reaped. So a preview
  // scope re-stamps its OWN ledger on use (any fetch its SW handles is proof a
  // controlled tab is alive), throttled to touchIntervalMs via an in-memory
  // guard so it's ~one write per interval of activity, not one per request.
  // Production never touches (it's never reaped). The write must not delay the
  // response, but it IS tied to the fetch event via waitUntil (see below) so the
  // browser can't terminate the worker mid-write; a failure just retries next
  // interval.
  let lastTouchAt = 0
  const maybeTouchOwnLedger = (waitUntil?: (p: Promise<unknown>) => void): void => {
    if (!OWN_SCOPE_IS_PREVIEW) return
    const t = now()
    if (t - lastTouchAt <= config.touchIntervalMs) return
    lastTouchAt = t // set optimistically so concurrent fetches don't pile on writes
    const touch = (async () => {
      try {
        await writeLedgerEntry(await readLedgerEntry())
      } catch {
        // best-effort — a missed touch just means the next fetch after the
        // interval tries again; worst case the sweep reaps a genuinely idle scope.
      }
    })()
    // Hand the write to event.waitUntil so it's tied to the fetch event's
    // lifetime: a quick cache-hit response can settle in microseconds, and a
    // DETACHED write (`void touch`) lets the browser kill the worker before the
    // `cache.put` lands — silently dropping the heartbeat that keeps a live
    // preview from being reaped. `waitUntil` keeps the worker alive until the
    // write finishes. Detached fallback keeps the factory usable off a
    // FetchEvent (tests / non-event callers).
    if (waitUntil) waitUntil(touch)
    else void touch
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
    const [shell, assets, vendor] = await Promise.all([
      caches.open(SHELL_CACHE),
      caches.open(ASSET_CACHE),
      caches.open(VENDOR_CACHE),
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
    // lands before the lazy tail. Vendor (esm.sh React) is equally boot-critical
    // — the app imports React through the import map, and those cross-origin URLs
    // are excluded from the same-origin precache (which only walks dist/), so
    // without this pass a controlled offline first load can't resolve React. It's
    // fetched with 'default' (not 'no-cache'): the URLs are immutable
    // (version- + SRI-pinned), so a warm HTTP-cache copy from the page's own
    // import is always valid and reused with no extra round-trip. The vendor cache
    // is shared + un-namespaced, so re-running install across deploys just re-puts
    // identical bytes.
    await Promise.all(SHELL_URLS.map((u) => fetchInto(shell, u, 'reload')))
    await Promise.all([
      runPooled(PRECACHE_ASSETS, 16, (u) => fetchInto(assets, u, 'no-cache')),
      runPooled(PRECACHE_VENDOR, 16, (u) => fetchInto(vendor, u, 'default')),
    ])
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
      const {ids, updatedAt, databaseNames} = normalizeLedger(raw)
      ledgers.push({scopeUrl: req.url, ids, updatedAt, databaseNames})
    }
    const {cacheNames, ledgerScopeUrls} = computeReapableCaches({
      ledgers,
      now: now(),
      staleMs: config.staleScopeMs,
      cachePrefix: CACHE_PREFIX,
      selfScopeUrl: LEDGER_KEY,
    })
    const databaseFailures = await sweepStalePreviewDatabases(ledgers, ledgerScopeUrls)
    await Promise.all([
      ...cacheNames.map((name) => caches.delete(name)),
      ...ledgerScopeUrls
        .filter((url) => !databaseFailures.has(url))
        .map((url) => meta.delete(url)),
    ])
  }

  const previewIdForScopeUrl = (scopeUrl: string): string | null => {
    try {
      return new URL(scopeUrl).pathname.match(/\/pr-preview\/(pr-[^/]+)\//)?.[1] ?? null
    } catch {
      return null
    }
  }

  const isDatabaseNameForPreviewScope = (databaseName: string, scopeUrl: string): boolean => {
    const previewId = previewIdForScopeUrl(scopeUrl)
    if (!previewId) return false
    const escapedPreviewId = previewId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`^kmp-v\\d+-[A-Za-z0-9_-]*-${escapedPreviewId}\\.db$`).test(databaseName)
  }

  const databaseNamesForReapedScopes = (
    ledgers: ScopeLedger[],
    ledgerScopeUrls: string[],
  ): Array<{scopeUrl: string; name: string}> => {
    const reapedScopes = new Set(ledgerScopeUrls)
    const names: Array<{scopeUrl: string; name: string}> = []
    const seen = new Set<string>()
    for (const ledger of ledgers) {
      if (!reapedScopes.has(ledger.scopeUrl)) continue
      for (const name of ledger.databaseNames) {
        if (!isDatabaseNameForPreviewScope(name, ledger.scopeUrl)) continue
        const key = `${ledger.scopeUrl}\n${name}`
        if (seen.has(key)) continue
        seen.add(key)
        names.push({scopeUrl: ledger.scopeUrl, name})
      }
    }
    return names
  }

  const sweepStalePreviewDatabases = async (
    ledgers: ScopeLedger[],
    ledgerScopeUrls: string[],
  ): Promise<Set<string>> => {
    const failedScopes = new Set<string>()
    const databases = databaseNamesForReapedScopes(ledgers, ledgerScopeUrls)
    await Promise.all(databases.map(async ({scopeUrl, name}) => {
      try {
        await Promise.all([
          deleteOpfsSqliteDatabase(name),
          deleteIndexedDatabase(name),
        ])
      } catch {
        // Keep this scope's ledger so a later activation can retry after a
        // locked database handle, transient OPFS failure, or blocked IDB delete.
        failedScopes.add(scopeUrl)
      }
    }))
    return failedScopes
  }

  const deleteOpfsSqliteDatabase = async (databaseName: string): Promise<void> => {
    if (typeof env.storage?.getDirectory !== 'function') return
    const root = await env.storage.getDirectory()
    const siblingResults = await Promise.allSettled(
      SQLITE_DB_SIBLING_SUFFIXES.map((suffix) => removeOpfsEntryIfExists(root, databaseName + suffix)),
    )
    const siblingFailure = siblingResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (siblingFailure) throw siblingFailure.reason
    await removeOpfsEntryIfExists(root, databaseName)
  }

  const removeOpfsEntryIfExists = async (
    root: {removeEntry: (name: string) => Promise<void>},
    name: string,
  ): Promise<void> => {
    try {
      await root.removeEntry(name)
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err
    }
  }

  const deleteIndexedDatabase = async (databaseName: string): Promise<void> => {
    const idb = env.indexedDB
    if (typeof idb?.deleteDatabase !== 'function') return
    if (typeof idb.databases === 'function') {
      const existing = await idb.databases().catch(() => null)
      if (existing && !existing.some((db) => db.name === databaseName)) return
    }
    await new Promise<void>((resolve, reject) => {
      const request = idb.deleteDatabase!(databaseName)
      let settled = false
      const settle = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }
      request.onsuccess = () => settle(resolve)
      request.onerror = () => settle(() => reject(request.error))
      request.onblocked = () => settle(() =>
        reject(new Error(`IndexedDB delete blocked for ${databaseName}`)),
      )
    })
  }

  const recordPreviewDatabase = async (databaseName: string): Promise<void> => {
    if (!OWN_SCOPE_IS_PREVIEW) return
    if (!isDatabaseNameForPreviewScope(databaseName, LEDGER_KEY)) return
    const entry = await readLedgerEntry()
    const databaseNames = entry.databaseNames.includes(databaseName)
      ? entry.databaseNames
      : [...entry.databaseNames, databaseName]
    await writeLedgerEntry({...entry, databaseNames})
  }

  const handleMessage = (data: unknown): Promise<void> | undefined => {
    if (
      !data ||
      typeof data !== 'object' ||
      (data as {type?: unknown}).type !== RECORD_PREVIEW_DATABASE_MESSAGE ||
      typeof (data as {databaseName?: unknown}).databaseName !== 'string'
    ) {
      return undefined
    }
    return recordPreviewDatabase((data as {databaseName: string}).databaseName)
  }

  const isNavigationRequest = (request: Request): boolean =>
    request.mode === 'navigate' ||
    (request.method === 'GET' && (request.headers.get('accept')?.includes('text/html') ?? false))

  const isSameOrigin = (url: URL): boolean => url.origin === env.origin

  const isVendor = (url: URL): boolean => VENDOR_HOSTS.has(url.hostname)

  // Cache-first for the SPA shell, PINNED to this generation. `install` precaches
  // ./index.html into this generation's shell cache (fetched fresh via 'reload'),
  // so a controlled navigation boots the shell from the SAME generation as the
  // assets it then loads cache-first — no new-HTML-over-old-assets skew on the
  // load right after a deploy, and no failed network round-trip when offline. We
  // read (and, only on a COLD miss, write) a single canonical key so the many
  // navigation URLs (deep links, query-strings, hash routes) share one entry.
  //
  // We deliberately do NOT overwrite a shell that's already present: a
  // generation's cache stays immutable after install (like its assets), so an
  // old-gen tab can never get a new build's HTML grafted over its old assets.
  // A new deploy is applied on the NEXT reload (once the freshly-installed worker
  // controls) — never mid-generation; the app.checkForUpdates action and the
  // 30-min update poll surface that a new build exists so the user can reload.
  const shellCacheFirst = async (request: Request, shellURL: string): Promise<Response> => {
    const cache = await caches.open(SHELL_CACHE)
    const cached = await cache.match(shellURL)
    if (cached) return cached
    // Cold miss (install's shell precache didn't land): fetch and seed this
    // generation's shell for next time. Offline with nothing cached rejects —
    // there's no shell to show, the same terminal outcome as before.
    const fresh = await fetch(request)
    if (fresh && fresh.ok) cache.put(shellURL, fresh.clone()).catch(() => {})
    return fresh
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
  const handleFetch = (
    request: Request,
    waitUntil?: (p: Promise<unknown>) => void,
  ): Promise<Response> | undefined => {
    if (request.method !== 'GET') return undefined
    const url = new URL(request.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined

    // Any GET this SW handles means a tab it controls is alive — keep this
    // (preview) scope's ledger fresh so the sweep doesn't reap a live preview.
    // Thread the event's waitUntil so the async ledger write is tied to the
    // fetch event lifetime (see maybeTouchOwnLedger).
    maybeTouchOwnLedger(waitUntil)

    // Never let production's broad-scope SW touch a nested preview deploy's
    // requests — let them fall through to the network (the preview's own SW owns
    // them once active).
    if (isForeignPreviewRequest(OWN_SCOPE_IS_PREVIEW, url.pathname)) return undefined

    if (isNavigationRequest(request) && isSameOrigin(url)) {
      return shellCacheFirst(request, toScopeUrl('./index.html'))
    }
    if (isCacheableAsset(request.destination, url.pathname, isSameOrigin(url))) {
      return assetCacheFirst(request)
    }
    if (isVendor(url)) return cacheFirst(request, VENDOR_CACHE)
    return undefined
  }

  return {
    install,
    activate,
    handleFetch,
    handleMessage,
    readLedger,
    writeLedger,
    recordGeneration,
    recordPreviewDatabase,
  }
}

export type ServiceWorkerInstance = ReturnType<typeof createServiceWorker>

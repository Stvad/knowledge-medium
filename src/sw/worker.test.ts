import {describe, expect, it, vi} from 'vitest'
import {createServiceWorker, type SwConfig, type SwEnv} from './worker'
import {previewDatabaseRecordUrl} from './previewDatabases'

// --- in-memory CacheStorage mock -------------------------------------------
// Enough of the Cache / CacheStorage surface for the worker: open/keys/has/
// delete on the storage, match/put/delete on each cache, keyed by request URL
// (the worker only ever matches by URL). `failPutFor` lets a test make a named
// cache's put throw (simulating QuotaExceededError) — consulted at put time, so
// a cache seeded before the flag is set still starts throwing.
const keyOf = (req: RequestInfo | URL): string =>
  typeof req === 'string' ? req : req instanceof URL ? req.toString() : req.url

class MockCache {
  store = new Map<string, Response>()
  constructor(
    private readonly name: string,
    private readonly parent: MockCaches,
  ) {}
  async match(req: RequestInfo | URL) {
    // Real Cache.match returns a fresh, independently-readable Response each
    // call; clone so a stored body isn't consumed by the first reader.
    return this.store.get(keyOf(req))?.clone()
  }
  async put(req: RequestInfo | URL, res: Response) {
    if (this.parent.failPutFor.has(this.name)) {
      throw new DOMException('simulated quota', 'QuotaExceededError')
    }
    this.store.set(keyOf(req), res)
  }
  async delete(req: RequestInfo | URL) {
    return this.store.delete(keyOf(req))
  }
  async keys() {
    return [...this.store.keys()].map((url) => new Request(url))
  }
}

class MockCaches {
  map = new Map<string, MockCache>()
  failPutFor = new Set<string>()
  async open(name: string) {
    let c = this.map.get(name)
    if (!c) {
      c = new MockCache(name, this)
      this.map.set(name, c)
    }
    return c
  }
  async keys() {
    return [...this.map.keys()]
  }
  async has(name: string) {
    return this.map.has(name)
  }
  async delete(name: string) {
    return this.map.delete(name)
  }
}

class MockOpfsRoot {
  entries = new Set<string>()
  failRemoveFor = new Set<string>()

  add(name: string) {
    this.entries.add(name)
  }

  has(name: string) {
    return this.entries.has(name)
  }

  async removeEntry(name: string) {
    if (this.failRemoveFor.has(name)) {
      throw new DOMException('simulated lock', 'NoModificationAllowedError')
    }
    if (!this.entries.delete(name)) {
      throw new DOMException('missing', 'NotFoundError')
    }
  }
}

class MockIndexedDB {
  names = new Set<string>()
  failDeleteFor = new Set<string>()
  blockedDeleteFor = new Set<string>()

  add(name: string) {
    this.names.add(name)
  }

  has(name: string) {
    return this.names.has(name)
  }

  async databases() {
    return [...this.names].map(name => ({name}))
  }

  deleteDatabase(name: string) {
    const request = {error: null} as unknown as IDBOpenDBRequest
    queueMicrotask(() => {
      if (this.blockedDeleteFor.has(name)) {
        request.onblocked?.(new Event('blocked') as IDBVersionChangeEvent)
        return
      }
      if (this.failDeleteFor.has(name)) {
        ;(request as {error: DOMException}).error = new DOMException('simulated failure')
        request.onerror?.(new Event('error'))
        return
      }
      this.names.delete(name)
      request.onsuccess?.(new Event('success'))
    })
    return request
  }
}

const ORIGIN = 'https://app.example'
const SCOPE = `${ORIGIN}/knowledge-medium/`
const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

const makeConfig = (o: Partial<SwConfig> = {}): SwConfig => ({
  buildId: 'gen1',
  scopeURL: new URL(SCOPE),
  keepGenerations: 3,
  staleScopeMs: 14 * DAY,
  touchIntervalMs: DAY,
  precacheAssets: ['/knowledge-medium/src/main.js'],
  precacheRestAssets: ['/knowledge-medium/src/lazy.js'],
  precacheVendor: [],
  ...o,
})

const ok = (body = 'body') => new Response(body, {status: 200})

// Build a fresh worker + mock env per test (in-memory Maps, cheap — no shared
// DB to reset). Returns the worker plus the mocks so tests can seed/inspect.
// `now` is a fixed injected clock so ledger timestamps and the stale sweep are
// deterministic.
const build = (
  configOverrides: Partial<SwConfig> = {},
  fetchImpl: (req: Request) => Promise<Response> = async () => ok(),
  now: () => number = () => NOW,
  envOverrides: Partial<SwEnv> = {},
) => {
  const caches = new MockCaches()
  const fetchMock = vi.fn(fetchImpl)
  const config = makeConfig(configOverrides)
  const sw = createServiceWorker(config, {
    caches: caches as unknown as CacheStorage,
    fetch: fetchMock as unknown as typeof fetch,
    origin: ORIGIN,
    now,
    ...envOverrides,
  })
  return {sw, caches, fetchMock, config}
}

const abs = (p: string) => new URL(p, SCOPE).toString()

describe('generation ledger I/O', () => {
  it('round-trips write → read', async () => {
    const {sw} = build()
    await sw.writeLedger(['a', 'b', 'c'])
    expect(await sw.readLedger()).toEqual(['a', 'b', 'c'])
  })

  it('reads [] when the ledger is absent', async () => {
    const {sw} = build()
    expect(await sw.readLedger()).toEqual([])
  })

  it('reads [] when the stored value is corrupt or not an array', async () => {
    const {sw, caches} = build()
    const meta = await caches.open('km-meta')
    await meta.put(abs('./__km_generations__'), new Response('not json{'))
    expect(await sw.readLedger()).toEqual([])

    await meta.put(abs('./__km_generations__'), new Response(JSON.stringify({not: 'array'})))
    expect(await sw.readLedger()).toEqual([])
  })

  it('recordGeneration appends a new id and moves an existing one to the end', async () => {
    const {sw} = build()
    await sw.writeLedger(['a', 'b'])
    await sw.recordGeneration('c')
    expect(await sw.readLedger()).toEqual(['a', 'b', 'c'])
    // re-recording an existing id de-dupes and re-appends (newest-last invariant)
    await sw.recordGeneration('a')
    expect(await sw.readLedger()).toEqual(['b', 'c', 'a'])
  })
})

describe('install', () => {
  it('records this generation in the ledger (newest-last)', async () => {
    const {sw} = build({buildId: 'gen2'})
    await sw.install()
    expect(await sw.readLedger()).toEqual(['gen2'])
  })

  it('precaches the shell with cache:reload and both asset lists with cache:no-cache', async () => {
    const {sw, caches, fetchMock} = build({
      precacheAssets: ['/knowledge-medium/src/main.js'],
      precacheRestAssets: ['/knowledge-medium/src/lazy.js'],
    })
    await sw.install()

    const modeFor = (url: string) =>
      fetchMock.mock.calls.map((c) => c[0]).find((r) => r.url === url)?.cache

    expect(modeFor(abs('./index.html'))).toBe('reload')
    expect(modeFor(abs('/knowledge-medium/src/main.js'))).toBe('no-cache')
    expect(modeFor(abs('/knowledge-medium/src/lazy.js'))).toBe('no-cache')

    // Shell lands in km-shell-<id>, assets in km-assets-<id>.
    const shell = await caches.open('km-shell-gen1')
    const assets = await caches.open('km-assets-gen1')
    expect(await shell.match(abs('./index.html'))).toBeDefined()
    expect(await assets.match(abs('/knowledge-medium/src/main.js'))).toBeDefined()
    expect(await assets.match(abs('/knowledge-medium/src/lazy.js'))).toBeDefined()
  })

  it('precaches cross-origin vendor URLs into the shared km-vendor cache (cache:default)', async () => {
    const vendorUrl = 'https://esm.sh/react@19.2.6'
    const {sw, caches, fetchMock} = build({precacheVendor: [vendorUrl], precacheRestAssets: []})
    await sw.install()

    // Vendor URLs are absolute cross-origin — cached verbatim, NOT scope-resolved,
    // in the un-namespaced vendor cache (not km-assets-<id>).
    const vendor = await caches.open('km-vendor')
    expect(await vendor.match(vendorUrl)).toBeDefined()
    expect(await (await caches.open('km-assets-gen1')).match(vendorUrl)).toBeUndefined()
    // Immutable (version- + SRI-pinned), so fetched with cache:'default', not 'no-cache'.
    const vendorReq = fetchMock.mock.calls.map((c) => c[0]).find((r) => r.url === vendorUrl)
    expect(vendorReq?.cache).toBe('default')
  })

  it('swallows a per-URL fetch failure — install still resolves and caches the rest', async () => {
    const failUrl = abs('/knowledge-medium/src/lazy.js')
    const {sw, caches} = build(
      {
        precacheAssets: ['/knowledge-medium/src/main.js'],
        precacheRestAssets: ['/knowledge-medium/src/lazy.js'],
      },
      async (req) => {
        if (req.url === failUrl) throw new TypeError('network down')
        return ok()
      },
    )
    await expect(sw.install()).resolves.toBeUndefined()
    const assets = await caches.open('km-assets-gen1')
    expect(await assets.match(abs('/knowledge-medium/src/main.js'))).toBeDefined()
    expect(await assets.match(failUrl)).toBeUndefined() // the failed one left a hole, no throw
  })

  it('does not cache a non-ok (e.g. 404) response', async () => {
    const {sw, caches} = build({precacheAssets: ['/knowledge-medium/src/main.js'], precacheRestAssets: []}, async () =>
      new Response('nope', {status: 404}),
    )
    await sw.install()
    const assets = await caches.open('km-assets-gen1')
    expect(await assets.match(abs('/knowledge-medium/src/main.js'))).toBeUndefined()
  })
})

describe('activate GC', () => {
  const seedGenerationCaches = async (caches: MockCaches, ids: string[]) => {
    for (const id of ids) {
      await caches.open(`km-shell-${id}`)
      await caches.open(`km-assets-${id}`)
    }
  }

  it('deletes only the expired generations, keeps the most recent keepGenerations + vendor/meta', async () => {
    const {sw, caches} = build({keepGenerations: 2})
    await seedGenerationCaches(caches, ['a', 'b', 'c'])
    await caches.open('km-vendor')
    await sw.writeLedger(['a', 'b', 'c']) // also creates km-meta

    await sw.activate()

    expect(await caches.has('km-shell-a')).toBe(false)
    expect(await caches.has('km-assets-a')).toBe(false)
    expect(await caches.has('km-shell-b')).toBe(true)
    expect(await caches.has('km-shell-c')).toBe(true)
    expect(await caches.has('km-vendor')).toBe(true)
    expect(await caches.has('km-meta')).toBe(true)
    // ledger trimmed to the kept ids
    expect(await sw.readLedger()).toEqual(['b', 'c'])
  })

  it('deletes nothing when the ledger fits the keep window', async () => {
    const {sw, caches} = build({keepGenerations: 3})
    await seedGenerationCaches(caches, ['a', 'b'])
    await sw.writeLedger(['a', 'b'])
    await sw.activate()
    expect(await caches.has('km-shell-a')).toBe(true)
    expect(await caches.has('km-shell-b')).toBe(true)
  })

  it('frees space BEFORE trimming the ledger — a quota-throwing ledger write still leaves deletes done', async () => {
    const {sw, caches} = build({keepGenerations: 2})
    await seedGenerationCaches(caches, ['a', 'b', 'c'])
    await sw.writeLedger(['a', 'b', 'c'])
    // Make the ledger trim (km-meta put) throw, as a full origin would.
    caches.failPutFor.add('km-meta')

    await expect(sw.activate()).resolves.toBeUndefined() // benign, not rethrown
    // The expired generation was still reclaimed despite the failed ledger trim.
    expect(await caches.has('km-shell-a')).toBe(false)
    expect(await caches.has('km-assets-a')).toBe(false)
  })
})

describe('handleFetch routing', () => {
  it('does not intercept non-GET requests', () => {
    const {sw} = build()
    expect(sw.handleFetch(new Request(abs('./index.html'), {method: 'POST'}))).toBeUndefined()
  })

  it('does not intercept a same-origin non-asset (e.g. version.json stays fresh)', () => {
    const {sw} = build()
    expect(sw.handleFetch(new Request(abs('./version.json')))).toBeUndefined()
  })

  it('a production-scoped SW hands off preview-subtree requests to the network', () => {
    const {sw} = build() // scope is /knowledge-medium/, not a preview
    const req = new Request(abs('/knowledge-medium/pr-preview/pr-1/src/main.js'))
    expect(sw.handleFetch(req)).toBeUndefined()
  })

  it('serves a cacheable asset from cache without hitting the network', async () => {
    const {sw, caches, fetchMock} = build()
    const url = abs('/knowledge-medium/src/main.js')
    ;(await caches.open('km-assets-gen1')).store.set(url, ok('cached-main'))

    const res = await sw.handleFetch(new Request(url))!
    expect(await res.text()).toBe('cached-main')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to the shell cache for an asset only precached there (an icon)', async () => {
    const {sw, caches, fetchMock} = build()
    const iconUrl = abs('./icon-192.png')
    ;(await caches.open('km-shell-gen1')).store.set(iconUrl, ok('icon-bytes'))

    const res = await sw.handleFetch(new Request(iconUrl))!
    expect(await res.text()).toBe('icon-bytes')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('on an asset cache miss, fetches, caches into km-assets, and returns the response', async () => {
    const {sw, caches, fetchMock} = build({}, async () => ok('fresh-main'))
    const url = abs('/knowledge-medium/src/main.js')

    const res = await sw.handleFetch(new Request(url))!
    expect(await res.text()).toBe('fresh-main')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(await (await caches.open('km-assets-gen1')).match(url)).toBeDefined()
  })

  it('returns Response.error() when an asset misses cache AND the network fails', async () => {
    const {sw} = build({}, async () => {
      throw new TypeError('offline')
    })
    const res = await sw.handleFetch(new Request(abs('/knowledge-medium/src/main.js')))!
    expect(res.type).toBe('error')
  })

  it('serves esm.sh vendor imports cache-first from the shared vendor cache', async () => {
    const {sw, caches, fetchMock} = build({}, async () => ok('vendor-mod'))
    const res = await sw.handleFetch(new Request('https://esm.sh/some-pkg@1.0.0'))!
    expect(await res.text()).toBe('vendor-mod')
    expect(await (await caches.open('km-vendor')).match('https://esm.sh/some-pkg@1.0.0')).toBeDefined()
    // a second request is a cache hit (no second network call)
    fetchMock.mockClear()
    await sw.handleFetch(new Request('https://esm.sh/some-pkg@1.0.0'))!
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('shellCacheFirst (HTML navigation)', () => {
  const navRequest = () =>
    new Request(abs('./deep/link'), {headers: {accept: 'text/html'}})

  it("cache-first: serves this generation's cached shell without touching the network", async () => {
    // Network is UP and would return DIFFERENT bytes — cache-first must still win
    // so the shell stays pinned to the generation the page booted with (no
    // new-HTML-over-old-assets skew on the load right after a deploy).
    const {sw, caches, fetchMock} = build({}, async () => ok('<html>fresh</html>'))
    ;(await caches.open('km-shell-gen1')).store.set(abs('./index.html'), ok('<html>cached</html>'))
    const res = await sw.handleFetch(navRequest())!
    expect(await res.text()).toBe('<html>cached</html>')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('cold miss: falls back to the network and seeds the shell under the canonical key', async () => {
    const {sw, caches, fetchMock} = build({}, async () => ok('<html>fresh</html>'))
    const res = await sw.handleFetch(navRequest())!
    expect(await res.text()).toBe('<html>fresh</html>')
    expect(fetchMock).toHaveBeenCalledOnce()
    // seeded under ./index.html (the single canonical key), not the deep-link URL
    expect(await (await caches.open('km-shell-gen1')).match(abs('./index.html'))).toBeDefined()
  })

  it('rejects when the network is down and there is no cached shell', async () => {
    const {sw} = build({}, async () => {
      throw new TypeError('offline')
    })
    await expect(sw.handleFetch(navRequest())!).rejects.toThrow('offline')
  })
})

describe('activate — stale preview cache sweep', () => {
  const previewScope = (n: number) =>
    `${ORIGIN}/knowledge-medium/pr-preview/pr-${n}/__km_generations__`
  const previewScopeUrl = (n: number) => `${ORIGIN}/knowledge-medium/pr-preview/pr-${n}/`
  const previewDatabaseRecord = (n: number, name: string) =>
    previewDatabaseRecordUrl(previewScopeUrl(n), name)
  const prodScope = `${SCOPE}__km_generations__` // this (production) scope's own ledger key
  const metaMatch = async (caches: MockCaches, url: string) =>
    (await caches.open('km-meta')).match(url)
  const seedDatabaseRecord = async (
    caches: MockCaches,
    n: number,
    name: string,
    updatedAt = NOW - 15 * DAY,
  ) => {
    ;(await caches.open('km-meta')).store.set(
      previewDatabaseRecord(n, name),
      new Response(JSON.stringify({name, updatedAt})),
    )
  }

  // Seed one scope's ledger entry into the shared meta cache + its generation
  // caches — mimicking a PR preview a client visited earlier.
  const seedScope = async (
    caches: MockCaches,
    scopeUrl: string,
    entry: unknown,
    ids: string[],
  ) => {
    ;(await caches.open('km-meta')).store.set(scopeUrl, new Response(JSON.stringify(entry)))
    for (const id of ids) {
      await caches.open(`km-shell-${id}`)
      await caches.open(`km-assets-${id}`)
    }
  }

  it('reaps a merged preview’s caches, recorded databases, and ledger entry', async () => {
    const opfs = new MockOpfsRoot()
    const idb = new MockIndexedDB()
    for (const name of [
      'kmp-v6~pr-309~user-1.db',
      'kmp-v6~pr-309~user-1.db-journal',
      'kmp-v6~pr-310~user-1.db',
      'kmp-v6-prod-pr-309.db',
    ]) {
      opfs.add(name)
      idb.add(name.replace(/-journal$/, ''))
    }
    const {sw, caches} = build({}, async () => ok(), () => NOW, {
      storage: {getDirectory: async () => opfs},
      indexedDB: idb as unknown as SwEnv['indexedDB'],
    }) // current scope = production
    await seedScope(caches, prodScope, {ids: ['prodA'], updatedAt: NOW - DAY}, ['prodA'])
    await seedScope(
      caches,
      previewScope(309),
      {ids: ['pvStale'], updatedAt: NOW - 15 * DAY},
      ['pvStale'],
    )
    await seedDatabaseRecord(caches, 309, 'kmp-v6~pr-309~user-1.db')
    await seedScope(
      caches,
      previewScope(310),
      {ids: ['pvFresh'], updatedAt: NOW - DAY},
      ['pvFresh'],
    )
    await seedDatabaseRecord(caches, 310, 'kmp-v6~pr-310~user-1.db')

    await sw.activate()

    // stale preview 309 fully reclaimed (caches + recorded DB files + ledger entry)
    expect(await caches.has('km-shell-pvStale')).toBe(false)
    expect(await caches.has('km-assets-pvStale')).toBe(false)
    expect(opfs.has('kmp-v6~pr-309~user-1.db')).toBe(false)
    expect(opfs.has('kmp-v6~pr-309~user-1.db-journal')).toBe(false)
    expect(idb.has('kmp-v6~pr-309~user-1.db')).toBe(false)
    expect(await metaMatch(caches, previewScope(309))).toBeUndefined()
    expect(await metaMatch(caches, previewDatabaseRecord(309, 'kmp-v6~pr-309~user-1.db'))).toBeUndefined()
    // fresh preview 310 kept
    expect(await caches.has('km-shell-pvFresh')).toBe(true)
    expect(opfs.has('kmp-v6~pr-310~user-1.db')).toBe(true)
    expect(idb.has('kmp-v6~pr-310~user-1.db')).toBe(true)
    expect(await metaMatch(caches, previewScope(310))).toBeDefined()
    expect(await metaMatch(caches, previewDatabaseRecord(310, 'kmp-v6~pr-310~user-1.db'))).toBeDefined()
    // production untouched
    expect(await caches.has('km-shell-prodA')).toBe(true)
    expect(opfs.has('kmp-v6-prod-pr-309.db')).toBe(true)
    expect(idb.has('kmp-v6-prod-pr-309.db')).toBe(true)
    expect(await metaMatch(caches, prodScope)).toBeDefined()
  })

  it('keeps the stale preview ledger when main database deletion fails so a later sweep can retry', async () => {
    const opfs = new MockOpfsRoot()
    opfs.add('kmp-v6~pr-309~user.db')
    opfs.add('kmp-v6~pr-309~user.db-journal')
    opfs.failRemoveFor.add('kmp-v6~pr-309~user.db')
    const {sw, caches} = build({}, async () => ok(), () => NOW, {
      storage: {getDirectory: async () => opfs},
    })
    await seedScope(
      caches,
      previewScope(309),
      {ids: ['pvStale'], updatedAt: NOW - 15 * DAY},
      ['pvStale'],
    )
    await seedDatabaseRecord(caches, 309, 'kmp-v6~pr-309~user.db')

    await sw.activate()

    expect(await caches.has('km-shell-pvStale')).toBe(true)
    expect(opfs.has('kmp-v6~pr-309~user.db')).toBe(true)
    expect(await metaMatch(caches, previewScope(309))).toBeDefined()
    expect(await metaMatch(caches, previewDatabaseRecord(309, 'kmp-v6~pr-309~user.db'))).toBeDefined()
  })

  it('keeps the stale preview ledger when database sidecar deletion fails before touching the main db', async () => {
    const opfs = new MockOpfsRoot()
    opfs.add('kmp-v6~pr-337~user.db')
    opfs.add('kmp-v6~pr-337~user.db-wal')
    opfs.failRemoveFor.add('kmp-v6~pr-337~user.db-wal')
    const {sw, caches} = build({}, async () => ok(), () => NOW, {
      storage: {getDirectory: async () => opfs},
    })
    await seedScope(
      caches,
      previewScope(337),
      {ids: ['pvStale'], updatedAt: NOW - 15 * DAY},
      ['pvStale'],
    )
    await seedDatabaseRecord(caches, 337, 'kmp-v6~pr-337~user.db')

    await sw.activate()

    expect(await caches.has('km-shell-pvStale')).toBe(true)
    expect(opfs.has('kmp-v6~pr-337~user.db')).toBe(true)
    expect(opfs.has('kmp-v6~pr-337~user.db-wal')).toBe(true)
    expect(await metaMatch(caches, previewScope(337))).toBeDefined()
    expect(await metaMatch(caches, previewDatabaseRecord(337, 'kmp-v6~pr-337~user.db'))).toBeDefined()
  })

  it('does not lose a database record when another worker instance updates the generation ledger', async () => {
    const selfScope = new URL(`${ORIGIN}/knowledge-medium/pr-preview/pr-502/`)
    const caches = new MockCaches()
    const env: SwEnv = {
      caches: caches as unknown as CacheStorage,
      fetch: (async () => ok()) as unknown as typeof fetch,
      origin: ORIGIN,
      now: () => NOW,
    }
    const oldWorker = createServiceWorker(
      makeConfig({scopeURL: selfScope, buildId: 'oldGen'}),
      env,
    )
    const newWorker = createServiceWorker(
      makeConfig({scopeURL: selfScope, buildId: 'newGen'}),
      env,
    )
    await oldWorker.writeLedger(['oldGen'])

    await seedDatabaseRecord(caches, 502, 'kmp-v6~pr-502~alice.db')
    await newWorker.recordGeneration('newGen')

    expect(await metaMatch(caches, previewDatabaseRecord(502, 'kmp-v6~pr-502~alice.db'))).toBeDefined()
    expect(await newWorker.readLedger()).toEqual(['oldGen', 'newGen'])
  })

  it('treats a fresh preview database record as a stale-sweep keep signal', async () => {
    const opfs = new MockOpfsRoot()
    opfs.add('kmp-v6~pr-330~user.db')
    const {sw, caches} = build({}, async () => ok(), () => NOW, {
      storage: {getDirectory: async () => opfs},
    })
    await seedScope(
      caches,
      previewScope(330),
      {ids: ['pvStale'], updatedAt: NOW - 15 * DAY},
      ['pvStale'],
    )
    await seedDatabaseRecord(caches, 330, 'kmp-v6~pr-330~user.db', NOW)

    await sw.activate()

    expect(await caches.has('km-shell-pvStale')).toBe(true)
    expect(opfs.has('kmp-v6~pr-330~user.db')).toBe(true)
    expect(await metaMatch(caches, previewScope(330))).toBeDefined()
    expect(await metaMatch(caches, previewDatabaseRecord(330, 'kmp-v6~pr-330~user.db'))).toBeDefined()
  })

  it('reaps stale preview databases even when only a stale database record remains', async () => {
    const opfs = new MockOpfsRoot()
    opfs.add('kmp-v6~pr-334~user.db')
    const {sw, caches} = build({}, async () => ok(), () => NOW, {
      storage: {getDirectory: async () => opfs},
    })
    await seedDatabaseRecord(caches, 334, 'kmp-v6~pr-334~user.db')

    await sw.activate()

    expect(opfs.has('kmp-v6~pr-334~user.db')).toBe(false)
    expect(await metaMatch(caches, previewDatabaseRecord(334, 'kmp-v6~pr-334~user.db'))).toBeUndefined()
  })

  it('drops stale retry metadata when legacy IndexedDB cleanup fails after OPFS deletion', async () => {
    const opfs = new MockOpfsRoot()
    const idb = new MockIndexedDB()
    opfs.add('kmp-v6~pr-339~user.db')
    idb.add('kmp-v6~pr-339~user.db')
    idb.failDeleteFor.add('kmp-v6~pr-339~user.db')
    const {sw, caches} = build({}, async () => ok(), () => NOW, {
      storage: {getDirectory: async () => opfs},
      indexedDB: idb as unknown as SwEnv['indexedDB'],
    })
    await seedScope(
      caches,
      previewScope(339),
      {ids: ['pvStale'], updatedAt: NOW - 15 * DAY},
      ['pvStale'],
    )
    await seedDatabaseRecord(caches, 339, 'kmp-v6~pr-339~user.db')

    await sw.activate()

    expect(opfs.has('kmp-v6~pr-339~user.db')).toBe(false)
    expect(idb.has('kmp-v6~pr-339~user.db')).toBe(true)
    expect(await caches.has('km-shell-pvStale')).toBe(false)
    expect(await metaMatch(caches, previewScope(339))).toBeUndefined()
    expect(await metaMatch(caches, previewDatabaseRecord(339, 'kmp-v6~pr-339~user.db'))).toBeUndefined()
  })

  it('never reaps production, however old its ledger (not a preview scope)', async () => {
    const {sw, caches} = build()
    await seedScope(caches, prodScope, {ids: ['prodA'], updatedAt: NOW - 999 * DAY}, ['prodA'])

    await sw.activate()

    expect(await caches.has('km-shell-prodA')).toBe(true)
    expect(await metaMatch(caches, prodScope)).toBeDefined()
  })

  it('does not reap a legacy (untimestamped bare-array) preview ledger', async () => {
    const {sw, caches} = build()
    await seedScope(caches, prodScope, {ids: ['prodA'], updatedAt: NOW}, ['prodA'])
    await seedScope(caches, previewScope(311), ['pvLegacy'], ['pvLegacy']) // bare array, no updatedAt

    await sw.activate()

    expect(await caches.has('km-shell-pvLegacy')).toBe(true)
    expect(await metaMatch(caches, previewScope(311))).toBeDefined()
  })

  it('spares a cache a surviving scope still shares, but still drops the stale ledger entry', async () => {
    const {sw, caches} = build()
    await seedScope(caches, prodScope, {ids: ['shared', 'prodA'], updatedAt: NOW - DAY}, ['shared', 'prodA'])
    await seedScope(
      caches,
      previewScope(312),
      {ids: ['shared', 'pvOnly'], updatedAt: NOW - 30 * DAY},
      ['shared', 'pvOnly'],
    )

    await sw.activate()

    expect(await caches.has('km-shell-shared')).toBe(true) // shared with prod — spared
    expect(await caches.has('km-shell-pvOnly')).toBe(false) // preview-only — reaped
    expect(await metaMatch(caches, previewScope(312))).toBeUndefined() // ledger entry dropped
  })

  it('ignores non-ledger km-meta entries (only <scope>/__km_generations__ keys are scopes)', async () => {
    const {sw, caches} = build()
    await seedScope(caches, prodScope, {ids: ['prodA'], updatedAt: NOW}, ['prodA'])
    // A hypothetical future non-ledger entry under a preview-looking path, with a
    // coincidentally ledger-shaped, stale body. It must NOT be treated as a scope.
    const strayKey = `${ORIGIN}/knowledge-medium/pr-preview/pr-999/some-other-meta`
    ;(await caches.open('km-meta')).store.set(
      strayKey,
      new Response(JSON.stringify({ids: ['strayId'], updatedAt: NOW - 99 * DAY})),
    )
    await caches.open('km-shell-strayId')

    await sw.activate()

    expect(await caches.has('km-shell-strayId')).toBe(true) // not reaped
    expect(await metaMatch(caches, strayKey)).toBeDefined() // entry left intact
  })

  it('a preview-scoped SW never reaps its OWN scope, even if its ledger looks stale', async () => {
    // current scope IS a preview. install created its caches + a fresh ledger;
    // force that ledger to look ancient so ONLY the self-scope guard protects it.
    const selfScope = new URL(`${ORIGIN}/knowledge-medium/pr-preview/pr-500/`)
    const {sw, caches} = build({scopeURL: selfScope, buildId: 'selfGen'})
    await sw.install() // creates km-shell-selfGen / km-assets-selfGen + fresh ledger
    ;(await caches.open('km-meta')).store.set(
      `${ORIGIN}/knowledge-medium/pr-preview/pr-500/__km_generations__`,
      new Response(JSON.stringify({ids: ['selfGen'], updatedAt: NOW - 99 * DAY})),
    )

    await sw.activate()

    expect(await caches.has('km-shell-selfGen')).toBe(true)
    expect(await caches.has('km-assets-selfGen')).toBe(true)
  })
})

describe('touch-on-use keeps a live preview from being reaped', () => {
  const previewScopeURL = `${ORIGIN}/knowledge-medium/pr-preview/pr-600/`
  const previewLedgerKey = `${previewScopeURL}__km_generations__`
  const prodLedgerKey = `${SCOPE}__km_generations__`
  const readUpdatedAt = async (caches: MockCaches, key: string): Promise<number | undefined> => {
    const res = await (await caches.open('km-meta')).match(key)
    return res ? ((await res.json()) as {updatedAt?: number}).updatedAt : undefined
  }
  const buildPreview = (nowFn: () => number) =>
    build({scopeURL: new URL(previewScopeURL), buildId: 'liveGen'}, undefined, nowFn)

  it('re-stamps a live preview’s ledger on use once past the touch interval', async () => {
    let clock = NOW
    const {sw, caches} = buildPreview(() => clock)
    await sw.install() // updatedAt = NOW
    clock = NOW + 20 * DAY // 20 days of active use, no redeploy
    sw.handleFetch(new Request(`${previewScopeURL}src/main.js`))
    await vi.waitFor(async () =>
      expect(await readUpdatedAt(caches, previewLedgerKey)).toBe(NOW + 20 * DAY),
    )
  })

  it('throttles: a fetch within the touch interval does not re-stamp (schedules no write)', async () => {
    let clock = NOW
    const {sw, caches} = buildPreview(() => clock)
    await sw.install()
    clock = NOW + 2 * DAY // past the 1-day interval → touches
    sw.handleFetch(new Request(`${previewScopeURL}a.js`))
    await vi.waitFor(async () =>
      expect(await readUpdatedAt(caches, previewLedgerKey)).toBe(NOW + 2 * DAY),
    )
    clock = NOW + 2 * DAY + 60 * 60 * 1000 // +1h, within the interval
    sw.handleFetch(new Request(`${previewScopeURL}b.js`)) // returns synchronously, no write
    expect(await readUpdatedAt(caches, previewLedgerKey)).toBe(NOW + 2 * DAY) // unchanged
  })

  it('production never touches its ledger on use (it is never reaped)', async () => {
    let clock = NOW
    const {sw, caches} = build({}, undefined, () => clock) // production scope
    await sw.install() // updatedAt = NOW
    clock = NOW + 30 * DAY
    sw.handleFetch(new Request(abs('/knowledge-medium/src/main.js'))) // gate returns synchronously
    expect(await readUpdatedAt(caches, prodLedgerKey)).toBe(NOW) // unchanged
  })

  it('hands the touch write to event.waitUntil so early worker termination cannot drop it', async () => {
    let clock = NOW
    const {sw, caches} = buildPreview(() => clock)
    await sw.install()
    const extended: Promise<unknown>[] = []
    const waitUntil = (p: Promise<unknown>) => extended.push(p)

    clock = NOW + 2 * DAY // past the interval → touches
    sw.handleFetch(new Request(`${previewScopeURL}src/main.js`), waitUntil)
    expect(extended).toHaveLength(1) // handed to waitUntil, not fired detached
    await Promise.all(extended) // the browser awaits this before it may terminate
    expect(await readUpdatedAt(caches, previewLedgerKey)).toBe(NOW + 2 * DAY)

    clock = NOW + 2 * DAY + 60 * 60 * 1000 // +1h, within the interval → no touch
    sw.handleFetch(new Request(`${previewScopeURL}b.js`), waitUntil)
    expect(extended).toHaveLength(1) // unchanged — a throttled fetch schedules nothing
  })

})

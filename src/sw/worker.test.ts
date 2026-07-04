import {describe, expect, it, vi} from 'vitest'
import {createServiceWorker, type SwConfig} from './worker'

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

const ORIGIN = 'https://app.example'
const SCOPE = `${ORIGIN}/knowledge-medium/`

const makeConfig = (o: Partial<SwConfig> = {}): SwConfig => ({
  buildId: 'gen1',
  scopeURL: new URL(SCOPE),
  keepGenerations: 3,
  precacheAssets: ['/knowledge-medium/src/main.js'],
  precacheRestAssets: ['/knowledge-medium/src/lazy.js'],
  ...o,
})

const ok = (body = 'body') => new Response(body, {status: 200})

// Build a fresh worker + mock env per test (in-memory Maps, cheap — no shared
// DB to reset). Returns the worker plus the mocks so tests can seed/inspect.
const build = (
  configOverrides: Partial<SwConfig> = {},
  fetchImpl: (req: Request) => Promise<Response> = async () => ok(),
) => {
  const caches = new MockCaches()
  const fetchMock = vi.fn(fetchImpl)
  const config = makeConfig(configOverrides)
  const sw = createServiceWorker(config, {
    caches: caches as unknown as CacheStorage,
    fetch: fetchMock as unknown as typeof fetch,
    origin: ORIGIN,
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

describe('shellNetworkFirst (HTML navigation)', () => {
  const navRequest = () =>
    new Request(abs('./deep/link'), {headers: {accept: 'text/html'}})

  it('network-first: returns fresh HTML and caches it under the canonical shell key', async () => {
    const {sw, caches, fetchMock} = build({}, async () => ok('<html>fresh</html>'))
    const res = await sw.handleFetch(navRequest())!
    expect(await res.text()).toBe('<html>fresh</html>')
    expect(fetchMock).toHaveBeenCalledOnce()
    // cached under ./index.html (the single canonical key), not the deep-link URL
    expect(await (await caches.open('km-shell-gen1')).match(abs('./index.html'))).toBeDefined()
  })

  it('falls back to the cached shell when the network is down', async () => {
    const {sw, caches} = build({}, async () => {
      throw new TypeError('offline')
    })
    ;(await caches.open('km-shell-gen1')).store.set(abs('./index.html'), ok('<html>cached</html>'))
    const res = await sw.handleFetch(navRequest())!
    expect(await res.text()).toBe('<html>cached</html>')
  })

  it('rejects when the network is down and there is no cached shell', async () => {
    const {sw} = build({}, async () => {
      throw new TypeError('offline')
    })
    await expect(sw.handleFetch(navRequest())!).rejects.toThrow('offline')
  })
})

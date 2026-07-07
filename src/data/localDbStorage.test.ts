// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dbFilenameForUser,
  previewDbId,
  recordPreviewDatabaseForReaper,
} from '@/data/localDbStorage'
import {
  SERVICE_WORKER_META_CACHE,
  previewDatabaseRecordUrl,
} from '@/sw/previewDatabases'

class MockCache {
  store = new Map<string, Response>()
  async put(req: RequestInfo | URL, res: Response) {
    const key = typeof req === 'string' ? req : req instanceof URL ? req.toString() : req.url
    this.store.set(key, res)
  }
}

class MockCaches {
  cache = new MockCache()
  openedNames: string[] = []
  failOpen = false

  async open(name: string) {
    this.openedNames.push(name)
    if (this.failOpen) throw new DOMException('simulated quota', 'QuotaExceededError')
    return this.cache
  }
}

const stubCaches = (caches: unknown) => {
  Object.defineProperty(globalThis, 'caches', {configurable: true, value: caches})
}

afterEach(() => {
  vi.unstubAllEnvs()
  Reflect.deleteProperty(globalThis, 'caches')
  Reflect.deleteProperty(navigator, 'storage')
})

// The local SQLite DB is per-origin; PR previews share production's origin. These
// pin the two data-safety invariants of the preview namespacing:
// production's filename must stay byte-for-byte identical (existing users keep
// their data), and a preview must get an isolated filename (a preview's client
// migration can't touch the real local DB).
describe('previewDbId', () => {
  it('is null for production and root deploys', () => {
    expect(previewDbId('/knowledge-medium/')).toBeNull()
    expect(previewDbId('/')).toBeNull()
  })

  it('derives pr-<n> from a preview base path', () => {
    expect(previewDbId('/knowledge-medium/pr-preview/pr-292/')).toBe('pr-292')
    expect(previewDbId('/knowledge-medium/pr-preview/pr-1/')).toBe('pr-1')
  })
})

describe('dbFilenameForUser', () => {
  it('leaves the production filename unchanged', () => {
    expect(dbFilenameForUser('user-1', '/knowledge-medium/')).toBe('kmp-v6-user-1.db')
    expect(dbFilenameForUser('user-1', '/')).toBe('kmp-v6-user-1.db')
  })

  it('isolates a preview into its own DB namespace', () => {
    expect(dbFilenameForUser('user-1', '/knowledge-medium/pr-preview/pr-292/')).toBe(
      'kmp-v6~pr-292~user-1.db',
    )
  })

  it('uses a preview namespace production sanitized ids cannot collide with', () => {
    expect(dbFilenameForUser('alice-pr-292', '/knowledge-medium/')).toBe(
      'kmp-v6-alice-pr-292.db',
    )
    expect(dbFilenameForUser('alice', '/knowledge-medium/pr-preview/pr-292/')).toBe(
      'kmp-v6~pr-292~alice.db',
    )
  })

  it('keeps production capped at the full 40-char user segment', () => {
    expect(dbFilenameForUser('a'.repeat(50), '/knowledge-medium/')).toBe(`kmp-v6-${'a'.repeat(40)}.db`)
  })

  it('sanitizes and length-caps the user segment, reserving room for the namespace', () => {
    const long = 'a'.repeat(80)
    // '~pr-292~' is 8 chars, taken out of the 40-char user budget → 32 kept.
    const name = dbFilenameForUser(`${long}!!`, '/knowledge-medium/pr-preview/pr-292/')
    expect(name).toBe(`kmp-v6~pr-292~${'a'.repeat(32)}.db`)
  })

  it('stays within the 64-char wa-sqlite pathname cap at worst case', () => {
    // Max user + a wide PR number: the namespace eats into the user budget, so the
    // base stays ~50 chars, leaving headroom for sqlite's -journal/-wal/-shm.
    const name = dbFilenameForUser('a'.repeat(40), '/knowledge-medium/pr-preview/pr-99999999/')
    expect(name.length + '-journal'.length).toBeLessThan(64)
  })
})

describe('recordPreviewDatabaseForReaper', () => {
  it('writes the exact preview database metadata record from the page path', async () => {
    vi.stubEnv('BASE_URL', '/knowledge-medium/pr-preview/pr-292/')
    const caches = new MockCaches()
    stubCaches(caches)

    await recordPreviewDatabaseForReaper('kmp-v6~pr-292~user.db')

    const scopeUrl = new URL('/knowledge-medium/pr-preview/pr-292/', window.location.href)
    const record = caches.cache.store.get(
      previewDatabaseRecordUrl(scopeUrl, 'kmp-v6~pr-292~user.db'),
    )
    expect(caches.openedNames).toEqual([SERVICE_WORKER_META_CACHE])
    expect(record).toBeDefined()
    await expect(record!.json()).resolves.toMatchObject({
      name: 'kmp-v6~pr-292~user.db',
      updatedAt: expect.any(Number),
    })
  })

  it('does not fail preview DB preparation when the metadata record cannot be persisted', async () => {
    vi.stubEnv('BASE_URL', '/knowledge-medium/pr-preview/pr-292/')
    const caches = new MockCaches()
    caches.failOpen = true
    stubCaches(caches)

    await expect(recordPreviewDatabaseForReaper('kmp-v6~pr-292~user.db')).resolves.toBeUndefined()
    expect(caches.openedNames).toEqual([SERVICE_WORKER_META_CACHE])
  })

  it('does not require metadata for production databases', async () => {
    vi.stubEnv('BASE_URL', '/knowledge-medium/')
    const caches = new MockCaches()
    caches.failOpen = true
    stubCaches(caches)

    await expect(recordPreviewDatabaseForReaper('kmp-v6-user.db')).resolves.toBeUndefined()
    expect(caches.openedNames).toEqual([])
  })
})

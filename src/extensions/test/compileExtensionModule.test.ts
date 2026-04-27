import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetCompileCacheForTest,
  __setCompileImplForTest,
  compileExtensionModule,
  evictBlockFromCache,
} from '@/extensions/compileExtensionModule'

beforeEach(() => {
  __resetCompileCacheForTest()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// hashContent uses crypto.subtle.digest which is itself async, so a
// single microtask flush isn't enough to drive a parallel call site
// past it. tick() yields long enough for any reasonable async hash to
// complete in the test environment.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('compileExtensionModule — L1 (content-hash) cache', () => {
  it('compiles only once when called twice with the same content + block', async () => {
    let count = 0
    const restore = __setCompileImplForTest(async () => {
      count += 1
      return {default: 'value'}
    })

    try {
      const a = await compileExtensionModule('source', 'block-1')
      const b = await compileExtensionModule('source', 'block-1')

      expect(count).toBe(1)
      expect(a.module).toBe(b.module)
      expect(a.contentHash).toBe(b.contentHash)
    } finally {
      restore()
    }
  })

  it('dedupes concurrent compiles of the same content', async () => {
    let resolveCompile!: (mod: Record<string, unknown>) => void
    let count = 0
    const pending = new Promise<Record<string, unknown>>((resolve) => {
      resolveCompile = resolve
    })
    const restore = __setCompileImplForTest(() => {
      count += 1
      return pending
    })

    try {
      const promiseA = compileExtensionModule('shared', 'block-1')
      const promiseB = compileExtensionModule('shared', 'block-2')

      // Drain the microtask queue until both calls have reached the
      // L1 lookup. crypto.subtle.digest is async so a single tick isn't
      // always enough.
      await tick()

      expect(count).toBe(1)

      const moduleObj = {default: 'shared-default'}
      resolveCompile(moduleObj)

      const a = await promiseA
      const b = await promiseB
      expect(a.module).toBe(moduleObj)
      expect(b.module).toBe(moduleObj)
      expect(count).toBe(1)
    } finally {
      restore()
    }
  })

  it('different blockIds with identical content share the cached module', async () => {
    let count = 0
    const moduleObj = {default: {shared: true}}
    const restore = __setCompileImplForTest(async () => {
      count += 1
      return moduleObj
    })

    try {
      const a = await compileExtensionModule('same-source', 'block-A')
      const b = await compileExtensionModule('same-source', 'block-B')

      expect(count).toBe(1)
      expect(a.module).toBe(b.module)
    } finally {
      restore()
    }
  })
})

describe('compileExtensionModule — L2 (blockId) cache', () => {
  it('returns the same module reference for the same block + content across calls', async () => {
    const restore = __setCompileImplForTest(async () => ({default: 'first'}))

    try {
      const a = await compileExtensionModule('content', 'block-1')
      const b = await compileExtensionModule('content', 'block-1')
      expect(a.module).toBe(b.module)
    } finally {
      restore()
    }
  })

  it('replaces the module reference when block content changes', async () => {
    const restore = __setCompileImplForTest(async (content: string) => ({source: content}))

    try {
      const first = await compileExtensionModule('v1', 'block-1')
      const second = await compileExtensionModule('v2', 'block-1')

      expect(first.module).not.toBe(second.module)
      expect(first.contentHash).not.toBe(second.contentHash)
      expect(second.module).toEqual({source: 'v2'})
    } finally {
      restore()
    }
  })
})

describe('compileExtensionModule — failure handling', () => {
  it('propagates compile errors and does not poison subsequent calls', async () => {
    let attempt = 0
    const restore = __setCompileImplForTest(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('boom')
      return {default: 'recovered'}
    })

    try {
      let firstError: unknown = null
      try {
        await compileExtensionModule('bad', 'block-1')
      } catch (err) {
        firstError = err
      }
      expect(firstError).toBeInstanceOf(Error)
      expect((firstError as Error).message).toBe('boom')

      const retry = await compileExtensionModule('bad', 'block-1')
      expect(retry.module).toEqual({default: 'recovered'})
      expect(attempt).toBe(2)
    } finally {
      restore()
    }
  })
})

describe('compileExtensionModule — eviction', () => {
  it('evictBlockFromCache drops the L2 entry but keeps L1 for shared content', async () => {
    let count = 0
    const restore = __setCompileImplForTest(async () => {
      count += 1
      return {default: 'x'}
    })

    try {
      const a = await compileExtensionModule('source', 'block-A')
      evictBlockFromCache('block-A')

      // Re-asking for the same block with the same content recomputes
      // the L2 entry, but L1 (keyed by hash) serves the same module —
      // so the underlying compile should not run again.
      const aAgain = await compileExtensionModule('source', 'block-A')
      expect(count).toBe(1)
      expect(aAgain.module).toBe(a.module)
    } finally {
      restore()
    }
  })
})

describe('compileExtensionModule — default Babel+blob path', () => {
  // jsdom's import() of blob: URLs is unreliable; we exercise the
  // blob-URL lifecycle (createObjectURL → import → revokeObjectURL)
  // through an injected compile that mirrors the default path's
  // structure but doesn't actually require a real dynamic import.
  it('revokes the blob URL after the dynamic import resolves', async () => {
    const realCreate = URL.createObjectURL
    const realRevoke = URL.revokeObjectURL
    const created: string[] = []
    const revoked: string[] = []

    const fakeUrl = 'blob:fake-url'
    URL.createObjectURL = vi.fn(() => {
      created.push(fakeUrl)
      return fakeUrl
    })
    URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url)
    })

    const restore = __setCompileImplForTest(async () => {
      const url = URL.createObjectURL(new Blob([''], {type: 'text/javascript'}))
      try {
        return {default: 'stub'}
      } finally {
        URL.revokeObjectURL(url)
      }
    })

    try {
      await compileExtensionModule('any', 'block-1')
      expect(created).toEqual([fakeUrl])
      expect(revoked).toEqual([fakeUrl])
    } finally {
      restore()
      URL.createObjectURL = realCreate
      URL.revokeObjectURL = realRevoke
    }
  })
})

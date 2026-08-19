import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __setCompileImplForTest,
  compileForVerification,
  createCompileCache,
  evictBlockFromCache,
  type CompileCache,
} from '@/extensions/compileExtensionModule'

// Each test gets its own cache instance — no cross-test pollution from
// the module-level singleton, even when vitest runs files in parallel.
let cache: CompileCache

beforeEach(() => {
  cache = createCompileCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('compileForVerification — block + content-hash cache', () => {
  it('compiles only once when called twice with the same content + block', async () => {
    let count = 0
    const restore = __setCompileImplForTest(async () => {
      count += 1
      return {default: 'value'}
    })

    try {
      const a = await compileForVerification('source', 'block-1', cache)
      const b = await compileForVerification('source', 'block-1', cache)

      expect(count).toBe(1)
      expect(a.module).toBe(b.module)
      expect(a.contentHash).toBe(b.contentHash)
    } finally {
      restore()
    }
  })

  it('does not share a live module between blocks with the same content', async () => {
    let count = 0
    const restore = __setCompileImplForTest(async () => {
      count += 1
      return {instance: count}
    })

    try {
      const promiseA = compileForVerification('shared', 'block-1', cache)
      const promiseB = compileForVerification('shared', 'block-2', cache)

      const a = await promiseA
      const b = await promiseB
      expect(count).toBe(2)
      expect(a.module).not.toBe(b.module)
    } finally {
      restore()
    }
  })

})

describe('compileForVerification — content changes', () => {
  it('replaces the module reference when block content changes', async () => {
    const restore = __setCompileImplForTest(async (content: string) => ({source: content}))

    try {
      const first = await compileForVerification('v1', 'block-1', cache)
      const second = await compileForVerification('v2', 'block-1', cache)

      expect(first.module).not.toBe(second.module)
      expect(first.contentHash).not.toBe(second.contentHash)
      expect(second.module).toEqual({source: 'v2'})
    } finally {
      restore()
    }
  })
})

describe('compileForVerification — failure handling', () => {
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
        await compileForVerification('bad', 'block-1', cache)
      } catch (err) {
        firstError = err
      }
      expect(firstError).toBeInstanceOf(Error)
      expect((firstError as Error).message).toBe('boom')

      const retry = await compileForVerification('bad', 'block-1', cache)
      expect(retry.module).toEqual({default: 'recovered'})
      expect(attempt).toBe(2)
    } finally {
      restore()
    }
  })
})

describe('compileForVerification — eviction', () => {
  it('evictBlockFromCache drops the block-scoped live module', async () => {
    let count = 0
    const restore = __setCompileImplForTest(async () => {
      count += 1
      return {default: 'x'}
    })

    try {
      const a = await compileForVerification('source', 'block-A', cache)
      evictBlockFromCache('block-A', cache)

      const aAgain = await compileForVerification('source', 'block-A', cache)
      expect(count).toBe(2)
      expect(aAgain.module).not.toBe(a.module)
    } finally {
      restore()
    }
  })
})

describe('compileForVerification — default Babel+blob path', () => {
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
      await compileForVerification('any', 'block-1', cache)
      expect(created).toEqual([fakeUrl])
      expect(revoked).toEqual([fakeUrl])
    } finally {
      restore()
      URL.createObjectURL = realCreate
      URL.revokeObjectURL = realRevoke
    }
  })
})

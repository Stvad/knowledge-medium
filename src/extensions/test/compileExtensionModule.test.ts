import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetCanonicalImportCacheForTest,
  __setCompileImplForTest,
  canonicalizeExtensionImports,
  compileExtensionModule,
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('compileExtensionModule — L1 (content-hash) cache', () => {
  it('compiles only once when called twice with the same content + block', async () => {
    let count = 0
    const restore = __setCompileImplForTest(async () => {
      count += 1
      return {default: 'value'}
    })

    try {
      const a = await compileExtensionModule('source', 'block-1', cache)
      const b = await compileExtensionModule('source', 'block-1', cache)

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
      const promiseA = compileExtensionModule('shared', 'block-1', cache)
      const promiseB = compileExtensionModule('shared', 'block-2', cache)

      // Resolve and await both before asserting count, so we don't
      // depend on microtask-timing assumptions about when a parallel
      // compileImpl is reached.
      const moduleObj = {default: 'shared-default'}
      // Yield enough that hashContent has had time to resolve before
      // we resolve the compile promise.
      await tick()
      resolveCompile(moduleObj)

      const a = await promiseA
      const b = await promiseB
      expect(count).toBe(1)
      expect(a.module).toBe(moduleObj)
      expect(b.module).toBe(moduleObj)
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
      const a = await compileExtensionModule('same-source', 'block-A', cache)
      const b = await compileExtensionModule('same-source', 'block-B', cache)

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
      const a = await compileExtensionModule('content', 'block-1', cache)
      const b = await compileExtensionModule('content', 'block-1', cache)
      expect(a.module).toBe(b.module)
    } finally {
      restore()
    }
  })

  it('replaces the module reference when block content changes', async () => {
    const restore = __setCompileImplForTest(async (content: string) => ({source: content}))

    try {
      const first = await compileExtensionModule('v1', 'block-1', cache)
      const second = await compileExtensionModule('v2', 'block-1', cache)

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
        await compileExtensionModule('bad', 'block-1', cache)
      } catch (err) {
        firstError = err
      }
      expect(firstError).toBeInstanceOf(Error)
      expect((firstError as Error).message).toBe('boom')

      const retry = await compileExtensionModule('bad', 'block-1', cache)
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
      const a = await compileExtensionModule('source', 'block-A', cache)
      evictBlockFromCache('block-A', cache)

      // Re-asking for the same block with the same content recomputes
      // the L2 entry, but L1 (keyed by hash) serves the same module —
      // so the underlying compile should not run again.
      const aAgain = await compileExtensionModule('source', 'block-A', cache)
      expect(count).toBe(1)
      expect(aAgain.module).toBe(a.module)
    } finally {
      restore()
    }
  })
})

describe('canonicalizeExtensionImports — module-identity fix', () => {
  // Background: the kernel imports modules by their literal disk
  // extension (`@/context/repo.tsx`). If an extension uses the
  // conventional `.js` suffix, the browser's module map keys it as a
  // *separate* entry, producing a second copy of every module-scoped
  // singleton — most visibly React `createContext` calls. This rewriter
  // probes the dev server and rewrites `@/foo.js` to whatever extension
  // actually exists, so the extension's effective imports match the
  // kernel's.

  beforeEach(() => {
    __resetCanonicalImportCacheForTest()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rewrites @/foo.js to the kernel-canonical disk extension', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      url: 'http://localhost:5173/src/context/repo.tsx',
    } as Response)))

    const source = `import {useRepo} from '@/context/repo.js'`
    const rewritten = await canonicalizeExtensionImports(source)
    expect(rewritten).toBe(`import {useRepo} from '@/context/repo.tsx'`)
  })

  it('leaves non-@/ specifiers alone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('fetch should not be called for npm specifiers')
    }))

    const source = `
      import React from 'react'
      import {foo} from 'some-pkg/sub.js'
    `
    const rewritten = await canonicalizeExtensionImports(source)
    expect(rewritten).toBe(source)
  })

  it('caches probes — second compile with the same specifier reuses', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      url: 'http://localhost:5173/src/context/repo.tsx',
    } as Response))
    vi.stubGlobal('fetch', fetchMock)

    await canonicalizeExtensionImports(`import x from '@/context/repo.js'`)
    await canonicalizeExtensionImports(`import y from '@/context/repo.js'`)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('leaves the import alone when the probe fails (no canonical found)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ok: false} as Response)))

    const source = `import x from '@/missing/file.js'`
    const rewritten = await canonicalizeExtensionImports(source)
    expect(rewritten).toBe(source)
  })

  it('leaves the import alone when the server returns 200 without redirect', async () => {
    // A `.js` URL that maps to a real `.js` on disk (or a server that
    // doesn't bother redirecting) returns its own URL — there's no
    // canonical to rewrite to.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      url: 'http://localhost:5173/src/utils/genuine.js',
    } as Response)))

    const source = `import x from '@/utils/genuine.js'`
    const rewritten = await canonicalizeExtensionImports(source)
    expect(rewritten).toBe(source)
  })

  it('handles multiple distinct @/ imports in one extension', async () => {
    const probes: Record<string, string> = {
      '/src/context/repo.js': 'http://localhost:5173/src/context/repo.tsx',
      '/src/data/orderKey.js': 'http://localhost:5173/src/data/orderKey.ts',
    }
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = url.startsWith('/') ? url : new URL(url).pathname
      const finalUrl = probes[u]
      if (!finalUrl) return {ok: false} as Response
      return {ok: true, url: finalUrl} as Response
    }))

    const source = [
      `import {useRepo} from '@/context/repo.js'`,
      `import {keyAtEnd} from '@/data/orderKey.js'`,
    ].join('\n')
    const rewritten = await canonicalizeExtensionImports(source)
    expect(rewritten).toContain(`'@/context/repo.tsx'`)
    expect(rewritten).toContain(`'@/data/orderKey.ts'`)
  })
})

describe('compileExtensionModule — default Babel+blob path', () => {
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
      await compileExtensionModule('any', 'block-1', cache)
      expect(created).toEqual([fakeUrl])
      expect(revoked).toEqual([fakeUrl])
    } finally {
      restore()
      URL.createObjectURL = realCreate
      URL.revokeObjectURL = realRevoke
    }
  })
})

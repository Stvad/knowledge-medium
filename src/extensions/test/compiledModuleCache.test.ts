// File-scoped IndexedDB polyfill — sets global `indexedDB`/`IDBKeyRange`
// for this test file only (vitest isolates modules per file), so the
// real IndexedDbCompiledModuleCache path runs in Node. Our records are
// plain JSON, so unlike keyStore's CryptoKey this clones fine.
import 'fake-indexeddb/auto'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  IndexedDbCompiledModuleCache,
  InMemoryCompiledModuleCache,
  type CompiledModuleCache,
  type CompiledRecord,
} from '@/extensions/compiledModuleCache'
import {
  __setInstantiateImplForTest,
  __setTranspileImplForTest,
  compileExtensionModule,
  createCompileCache,
} from '@/extensions/compileExtensionModule'

const record = (over: Partial<CompiledRecord> = {}): CompiledRecord => ({
  sourceHash: 'hash-1',
  compiled: 'export default 1',
  compilerVersion: '1',
  ...over,
})

describe('CompiledModuleCache stores', () => {
  // Run the same contract against both implementations. The IndexedDB
  // one uses fake-indexeddb; a fresh instance reopening the same DB is
  // how we model a page reload.
  const stores: Array<[string, () => CompiledModuleCache]> = [
    ['InMemoryCompiledModuleCache', () => new InMemoryCompiledModuleCache()],
    ['IndexedDbCompiledModuleCache', () => new IndexedDbCompiledModuleCache()],
  ]

  for (const [name, make] of stores) {
    describe(name, () => {
      it('round-trips a record', async () => {
        const store = make()
        await store.write(`${name}-rt`, record({compiled: 'CODE'}))
        expect(await store.read(`${name}-rt`)).toMatchObject({compiled: 'CODE'})
      })

      it('returns undefined for an unknown block', async () => {
        expect(await make().read(`${name}-missing`)).toBeUndefined()
      })

      it('overwrites the row for the same block id', async () => {
        const store = make()
        await store.write(`${name}-ow`, record({sourceHash: 'a', compiled: 'A'}))
        await store.write(`${name}-ow`, record({sourceHash: 'b', compiled: 'B'}))
        expect(await store.read(`${name}-ow`)).toMatchObject({sourceHash: 'b', compiled: 'B'})
      })

      it('deletes a row', async () => {
        const store = make()
        await store.write(`${name}-del`, record())
        await store.delete(`${name}-del`)
        expect(await store.read(`${name}-del`)).toBeUndefined()
      })
    })
  }

  it('IndexedDB row survives a "reload" (fresh instance, same DB)', async () => {
    const writer = new IndexedDbCompiledModuleCache()
    await writer.write('reload-block', record({compiled: 'PERSISTED'}))

    // A brand-new instance has its own connection handle but reopens the
    // same named DB — the row must still be there.
    const reader = new IndexedDbCompiledModuleCache()
    expect(await reader.read('reload-block')).toMatchObject({compiled: 'PERSISTED'})
  })
})

describe('compileExtensionModule — persistent (L3) cache', () => {
  let transpileCount = 0
  let restoreTranspile: () => void
  let restoreInstantiate: () => void

  beforeEach(() => {
    transpileCount = 0
    // Stub the pipeline so no real Babel / blob-URL import runs: transpile
    // tags the source, instantiate exposes which compiled string it built
    // from so we can assert the cache fed it (not Babel).
    restoreTranspile = __setTranspileImplForTest(async (content) => {
      transpileCount += 1
      return `transpiled:${content}`
    })
    restoreInstantiate = __setInstantiateImplForTest(async (compiled) => ({
      default: compiled,
    }))
  })

  afterEach(() => {
    restoreInstantiate()
    restoreTranspile()
    vi.restoreAllMocks()
  })

  it('compiles on a cold miss and persists the transpiled output', async () => {
    const persistent = new InMemoryCompiledModuleCache()
    const result = await compileExtensionModule(
      'SRC', 'block-1', createCompileCache(), persistent,
    )

    expect(transpileCount).toBe(1)
    expect(result.module).toEqual({default: 'transpiled:SRC'})
    expect(await persistent.read('block-1')).toMatchObject({
      compiled: 'transpiled:SRC',
      compilerVersion: '1',
    })
  })

  it('serves a warm reload from the persistent cache WITHOUT re-transpiling', async () => {
    // Use a real (fake-indexeddb) store and two separate cache instances
    // to model: compile this session, reload, compile next session.
    const session1Persistent = new IndexedDbCompiledModuleCache()
    await compileExtensionModule('SRC', 'warm-1', createCompileCache(), session1Persistent)
    expect(transpileCount).toBe(1)

    // Fresh in-memory L1/L2 (page reload) + fresh store handle (same DB).
    const session2Persistent = new IndexedDbCompiledModuleCache()
    const result = await compileExtensionModule(
      'SRC', 'warm-1', createCompileCache(), session2Persistent,
    )

    expect(transpileCount).toBe(1) // Babel/transpile not loaded again
    expect(result.module).toEqual({default: 'transpiled:SRC'})
  })

  it('recompiles when the stored output was built under a different compiler version', async () => {
    const persistent = new InMemoryCompiledModuleCache()
    await compileExtensionModule('SRC', 'cv-1', createCompileCache(), persistent)
    expect(transpileCount).toBe(1)

    // Simulate a COMPILER_VERSION bump: same source hash, stale output.
    const stored = await persistent.read('cv-1')
    await persistent.write('cv-1', {...stored!, compilerVersion: 'stale'})

    await compileExtensionModule('SRC', 'cv-1', createCompileCache(), persistent)
    expect(transpileCount).toBe(2) // invalidated → recompiled
  })

  it('recompiles and overwrites the row when the source changes', async () => {
    const persistent = new InMemoryCompiledModuleCache()
    await compileExtensionModule('V1', 'src-1', createCompileCache(), persistent)
    const first = await persistent.read('src-1')

    const result = await compileExtensionModule('V2', 'src-1', createCompileCache(), persistent)
    expect(transpileCount).toBe(2)
    expect(result.module).toEqual({default: 'transpiled:V2'})

    const second = await persistent.read('src-1')
    expect(second!.compiled).toBe('transpiled:V2')
    expect(second!.sourceHash).not.toBe(first!.sourceHash)
  })

  it('still compiles when the persistent read fails (treated as a miss)', async () => {
    const flaky: CompiledModuleCache = {
      read: async () => { throw new Error('read boom') },
      write: async () => {},
      delete: async () => {},
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await compileExtensionModule('SRC', 'r-1', createCompileCache(), flaky)
    expect(transpileCount).toBe(1)
    expect(result.module).toEqual({default: 'transpiled:SRC'})
  })

  it('still returns the module when the persistent write fails', async () => {
    const flaky: CompiledModuleCache = {
      read: async () => undefined,
      write: async () => { throw new Error('write boom') },
      delete: async () => {},
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await compileExtensionModule('SRC', 'w-1', createCompileCache(), flaky)
    expect(result.module).toEqual({default: 'transpiled:SRC'})
  })
})

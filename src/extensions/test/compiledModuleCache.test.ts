// File-scoped IndexedDB polyfill — sets global `indexedDB`/`IDBKeyRange`
// for this test file only (vitest isolates modules per file), so the
// real IndexedDbCompiledModuleCache path runs in Node. Our records are
// plain JSON, so unlike keyStore's CryptoKey this clones fine.
import 'fake-indexeddb/auto'

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  clearCompiledModuleCache,
  getCompiledModuleCache,
  IndexedDbCompiledModuleCache,
  InMemoryCompiledModuleCache,
  type CompiledModuleCache,
  type CompiledRecord,
} from '@/extensions/compiledModuleCache'
import {
  __setInstantiateImplForTest,
  __setTranspileImplForTest,
  approveExtension,
  createCompileCache,
  loadApprovedExtension,
  lookupApproval,
  readApproval,
} from '@/extensions/compileExtensionModule'

const record = (over: Partial<CompiledRecord> = {}): CompiledRecord => ({
  sourceHash: 'hash-1',
  approvedSource: 'source-1',
  compiled: 'export default 1',
  compilerVersion: '1',
  approvedAt: 0,
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

      it('clear() empties every row', async () => {
        const store = make()
        await store.write(`${name}-c1`, record({compiled: 'A'}))
        await store.write(`${name}-c2`, record({compiled: 'B'}))
        await store.clear()
        expect(await store.read(`${name}-c1`)).toBeUndefined()
        expect(await store.read(`${name}-c2`)).toBeUndefined()
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

  it('clearCompiledModuleCache empties the store via a connection (§6 lock & wipe, boot)', async () => {
    // Operates on the process singleton (IndexedDB-backed in this file).
    const cache = getCompiledModuleCache()
    await cache.write('wipe-a', record({compiled: 'A'}))
    await cache.write('wipe-b', record({compiled: 'B'}))

    await clearCompiledModuleCache()

    expect(await cache.read('wipe-a')).toBeUndefined()
    expect(await cache.read('wipe-b')).toBeUndefined()
    // Store is still usable (clear empties rows, doesn't drop the store).
    await cache.write('wipe-c', record({compiled: 'C'}))
    expect(await cache.read('wipe-c')).toMatchObject({compiled: 'C'})
  })
})

describe('approveExtension + loadApprovedExtension — trust gate + L3 cache', () => {
  let transpileCount = 0
  let instantiateCount = 0
  let restoreTranspile: () => void
  let restoreInstantiate: () => void

  beforeEach(() => {
    transpileCount = 0
    instantiateCount = 0
    // Stub the pipeline so no real Babel / blob-URL import runs: transpile
    // tags the source, instantiate exposes which compiled string it built
    // from (and counts, so we can assert approve never instantiates).
    restoreTranspile = __setTranspileImplForTest(async (content) => {
      transpileCount += 1
      return `transpiled:${content}`
    })
    restoreInstantiate = __setInstantiateImplForTest(async (compiled) => {
      instantiateCount += 1
      return {default: compiled}
    })
  })

  afterEach(() => {
    restoreInstantiate()
    restoreTranspile()
    vi.restoreAllMocks()
  })

  it('approveExtension transpiles + writes the approval row, and does NOT instantiate', async () => {
    const persistent = new InMemoryCompiledModuleCache()
    const result = await approveExtension('block-1', 'SRC', persistent)

    expect(transpileCount).toBe(1)
    // Approving vouches the SOURCE; it doesn't run the module (#67 review).
    expect(instantiateCount).toBe(0)
    const row = await persistent.read('block-1')
    expect(row).toMatchObject({
      sourceHash: result.contentHash,
      approvedSource: 'SRC',
      compiled: 'transpiled:SRC',
      compilerVersion: '1',
    })
    expect(typeof row!.approvedAt).toBe('number')
  })

  it('does not instantiate during approve, so a module that throws at eval still gets a valid pin', async () => {
    // The runtime error must surface later via the loader's errorReporter,
    // not abort the approve/enable action (#67 review).
    restoreInstantiate()
    restoreInstantiate = __setInstantiateImplForTest(async () => {
      throw new Error('module threw at import-eval')
    })
    const persistent = new InMemoryCompiledModuleCache()

    const result = await approveExtension('block-1', 'SRC', persistent) // does NOT throw
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(instantiateCount).toBe(0)
    expect(await persistent.read('block-1')).toMatchObject({
      approvedSource: 'SRC',
      compiled: 'transpiled:SRC',
    })
  })

  it('loadApprovedExtension serves a warm reload from the pinned output WITHOUT re-transpiling', async () => {
    // Real (fake-indexeddb) store + fresh in-memory caches model: approve
    // this session, reload, run next session.
    const session1Persistent = new IndexedDbCompiledModuleCache()
    await approveExtension('warm-1', 'SRC', session1Persistent)
    expect(transpileCount).toBe(1)

    const session2Persistent = new IndexedDbCompiledModuleCache()
    const approval = await readApproval('warm-1', session2Persistent)
    const result = await loadApprovedExtension(
      'warm-1', approval!, createCompileCache(), session2Persistent,
    )

    expect(transpileCount).toBe(1) // Babel/transpile not loaded again
    expect(result.module).toEqual({default: 'transpiled:SRC'})
    expect(result.contentHash).toBe(approval!.sourceHash)
  })

  it('idempotent re-approve of unchanged source skips Babel (reuses the pinned output)', async () => {
    const persistent = new InMemoryCompiledModuleCache()
    await approveExtension('idem', 'SRC', persistent)
    expect(transpileCount).toBe(1)

    await approveExtension('idem', 'SRC', persistent)
    expect(transpileCount).toBe(1)
  })

  it('loadApprovedExtension recompiles the APPROVED source on a compiler-version bump, and re-pins', async () => {
    const persistent = new InMemoryCompiledModuleCache()
    await approveExtension('cv-1', 'SRC', persistent)
    expect(transpileCount).toBe(1)

    // Simulate a COMPILER_VERSION bump: same approved source, stale output.
    const stored = await persistent.read('cv-1')
    await persistent.write('cv-1', {...stored!, compilerVersion: 'stale'})

    const approval = await readApproval('cv-1', persistent)
    const result = await loadApprovedExtension('cv-1', approval!, createCompileCache(), persistent)

    expect(transpileCount).toBe(2) // recompiled from approvedSource
    expect(result.module).toEqual({default: 'transpiled:SRC'})
    // Re-pinned at the current compiler version (approval hash unchanged).
    expect(await persistent.read('cv-1')).toMatchObject({
      sourceHash: stored!.sourceHash,
      compilerVersion: '1',
      compiled: 'transpiled:SRC',
    })
  })

  it('approving changed source overwrites the row and re-pins to the new hash', async () => {
    const persistent = new InMemoryCompiledModuleCache()
    await approveExtension('src-1', 'V1', persistent)
    const first = await persistent.read('src-1')

    await approveExtension('src-1', 'V2', persistent)
    expect(transpileCount).toBe(2)

    const second = await persistent.read('src-1')
    expect(second!.compiled).toBe('transpiled:V2')
    expect(second!.approvedSource).toBe('V2')
    expect(second!.sourceHash).not.toBe(first!.sourceHash)
  })

  it('rejects (does not silently succeed) when the trust write fails', async () => {
    // A swallowed write would let the caller set "enabled" intent against a
    // non-existent approval → a silent needs-approval loop (#67 review).
    const flaky: CompiledModuleCache = {
      read: async () => undefined,
      write: async () => { throw new Error('write boom') },
      delete: async () => {},
      clear: async () => {},
    }

    await expect(approveExtension('w-1', 'SRC', flaky)).rejects.toThrow(/write boom/)
  })

  it('readApproval resolves undefined (not throws) when the persistent read fails', async () => {
    const flaky: CompiledModuleCache = {
      read: async () => { throw new Error('read boom') },
      write: async () => {},
      delete: async () => {},
      clear: async () => {},
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await readApproval('r-1', flaky)).toBeUndefined()
  })

  it('rejects a legacy Phase-1 compile-cache row as an approval (#67)', async () => {
    const persistent = new InMemoryCompiledModuleCache()
    // The exact shape Phase 1 (#167) auto-wrote on every compile: no
    // approvedSource / approvedAt. Treating it as trust would let every
    // already-compiled extension on an upgraded profile run without the
    // explicit approval #67 requires.
    await persistent.write('legacy', {
      sourceHash: 'h',
      compiled: 'export default 1',
      compilerVersion: '1',
    } as unknown as CompiledRecord)
    expect(await readApproval('legacy', persistent)).toBeUndefined()

    // A real Phase-2 approval (carries the markers) IS returned.
    await persistent.write('real', record({sourceHash: 'h2'}))
    expect(await readApproval('real', persistent)).toMatchObject({sourceHash: 'h2'})
  })

  it('lookupApproval distinguishes approved / unapproved / unreadable (#67 fail-closed)', async () => {
    const persistent = new InMemoryCompiledModuleCache()
    await persistent.write('ok', record({sourceHash: 'h3'}))
    await persistent.write('legacy', {
      sourceHash: 'h',
      compiled: 'export default 1',
      compilerVersion: '1',
    } as unknown as CompiledRecord)

    expect(await lookupApproval('ok', persistent)).toMatchObject({
      status: 'approved',
      record: {sourceHash: 'h3'},
    })
    // Legacy + missing rows are both "unapproved" (eligible for approval).
    expect(await lookupApproval('legacy', persistent)).toEqual({status: 'unapproved'})
    expect(await lookupApproval('missing', persistent)).toEqual({status: 'unapproved'})

    // A transient read error is NOT "no approval" — callers that would pin
    // live source must fail closed on this.
    const flaky: CompiledModuleCache = {
      read: async () => { throw new Error('read boom') },
      write: async () => {},
      delete: async () => {},
      clear: async () => {},
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await lookupApproval('x', flaky)).toEqual({status: 'unreadable'})
  })
})

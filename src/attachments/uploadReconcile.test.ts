import { beforeEach, describe, expect, it } from 'vitest'
import { InMemoryByteStore } from './byteStore.js'
import { reconcileUploads } from './uploadReconcile.js'
import { InMemoryByteUploadStore, type StageInput } from './uploadStore.js'

const USER = 'u1'
const WS = 'ws1'

const stageInput = (over: Partial<StageInput> = {}): StageInput => ({
  userId: USER,
  assetBlockId: 'media:a',
  workspaceId: WS,
  contentHash: 'sha256:a',
  contentKey: 'ka',
  generation: 1,
  ...over,
})

describe('reconcileUploads (Phase 5d — boot reconciler)', () => {
  let store: InMemoryByteUploadStore
  let byteStore: InMemoryByteStore
  let present: Set<string>
  let lockedWorkspaces: Set<string>
  let hashCarriers: Set<string>

  const deps = (currentGeneration: number) => ({
    store,
    byteStore,
    isBlockPresent: async (_ws: string, id: string) => present.has(id),
    isWorkspaceMaterializable: async (ws: string) => !lockedWorkspaces.has(ws),
    hashHasCarrier: async (_ws: string, contentHash: string) => hashCarriers.has(contentHash),
    currentGeneration,
  })

  beforeEach(() => {
    store = new InMemoryByteUploadStore(() => 1000)
    byteStore = new InMemoryByteStore()
    present = new Set()
    lockedWorkspaces = new Set()
    hashCarriers = new Set()
  })

  it('promotes a staged record whose block committed (crash after commit, before promote)', async () => {
    await store.stage(stageInput({ assetBlockId: 'media:a' }))
    present.add('media:a')

    const summary = await reconcileUploads(USER, deps(5))

    expect(summary).toMatchObject({ promoted: 1, reaped: 0, kept: 0 })
    expect((await store.get(USER, 'media:a'))?.status).toBe('pending')
  })

  it('reaps a staged orphan from an older boot (record + OPFS bytes), block never committed', async () => {
    await store.stage(stageInput({ assetBlockId: 'media:a', contentKey: 'ka', generation: 1 }))
    await byteStore.put(USER, WS, 'ka', new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>)
    // block 'media:a' is NOT present; generation 1 < current 5

    const summary = await reconcileUploads(USER, deps(5))

    expect(summary).toMatchObject({ promoted: 0, reaped: 1, kept: 0 })
    expect(await store.get(USER, 'media:a')).toBeNull() // record gone
    expect(await byteStore.get(USER, WS, 'ka')).toBeNull() // orphan bytes gone
  })

  it('KEEPS (never reaps) an older-boot orphan in a LOCKED e2ee workspace — absence is inconclusive', async () => {
    // A committed-and-synced block in a locked e2ee workspace is withheld from
    // `blocks`, so isBlockPresent reads false even though the block exists. Reaping
    // here would delete the only copy of its un-uploaded bytes (the headline crash-
    // then-locked-reboot loss). The record must survive for unlock/reboot to promote.
    await store.stage(stageInput({ assetBlockId: 'media:a', contentKey: 'ka', generation: 1 }))
    await byteStore.put(USER, WS, 'ka', new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>)
    lockedWorkspaces.add(WS) // workspace not materializable; block absent; older gen

    const summary = await reconcileUploads(USER, deps(5))

    expect(summary).toMatchObject({ promoted: 0, reaped: 0, kept: 1 })
    expect((await store.get(USER, 'media:a'))?.status).toBe('staged') // record retained
    expect(await byteStore.get(USER, WS, 'ka')).not.toBeNull() // bytes preserved
  })

  it('reaps the record but KEEPS the bytes when another block still carries the hash (dedup/undo)', async () => {
    // Orphan record whose content is still referenced by a live-or-soft-deleted
    // sibling embed — dropping the bytes would break that sibling (and redo of an
    // undone paste). Drop the record, keep the bytes (§16/§8 content-refcount rule).
    await store.stage(stageInput({ assetBlockId: 'media:a', contentHash: 'sha256:a', contentKey: 'ka', generation: 1 }))
    await byteStore.put(USER, WS, 'ka', new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>)
    hashCarriers.add('sha256:a') // a sibling carrier of the same content exists

    const summary = await reconcileUploads(USER, deps(5))

    expect(summary).toMatchObject({ promoted: 0, reaped: 1, kept: 0 })
    expect(await store.get(USER, 'media:a')).toBeNull() // record dropped
    expect(await byteStore.get(USER, WS, 'ka')).not.toBeNull() // shared bytes kept
  })

  it('KEEPS a staged record from the current boot whose block has not committed yet (in-flight)', async () => {
    await store.stage(stageInput({ assetBlockId: 'media:a', generation: 5 }))
    // block absent, but generation == currentGeneration → an in-flight capture

    const summary = await reconcileUploads(USER, deps(5))

    expect(summary).toMatchObject({ promoted: 0, reaped: 0, kept: 1 })
    expect((await store.get(USER, 'media:a'))?.status).toBe('staged') // untouched
  })

  it('only touches staged records — pending/failed are left for the drain / recovery', async () => {
    await store.stage(stageInput({ assetBlockId: 'media:p' }))
    await store.promote(USER, 'media:p') // now pending
    present.add('media:p')

    const summary = await reconcileUploads(USER, deps(5))

    expect(summary).toMatchObject({ promoted: 0, reaped: 0, kept: 0 })
    expect((await store.get(USER, 'media:p'))?.status).toBe('pending') // unchanged
  })

  it('handles a mixed batch and is scoped to the user', async () => {
    await store.stage(stageInput({ assetBlockId: 'media:committed', generation: 1 }))
    present.add('media:committed')
    await store.stage(stageInput({ assetBlockId: 'media:orphan', contentKey: 'ko', generation: 1 }))
    await store.stage(stageInput({ assetBlockId: 'media:inflight', generation: 5 }))
    // a different account's staged record must be invisible
    await store.stage(stageInput({ userId: 'u2', assetBlockId: 'media:other', generation: 1 }))

    const summary = await reconcileUploads(USER, deps(5))

    expect(summary).toMatchObject({ promoted: 1, reaped: 1, kept: 1 })
    expect((await store.get(USER, 'media:committed'))?.status).toBe('pending')
    expect(await store.get(USER, 'media:orphan')).toBeNull()
    expect((await store.get(USER, 'media:inflight'))?.status).toBe('staged')
    expect((await store.get('u2', 'media:other'))?.status).toBe('staged') // untouched
  })
})

import { beforeEach, describe, expect, it } from 'vitest'
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

describe('reconcileUploads (Phase 5d — boot reconciler, promote-only)', () => {
  let store: InMemoryByteUploadStore
  let present: Set<string>

  const deps = () => ({
    store,
    isBlockPresent: async (_ws: string, id: string) => present.has(id),
  })

  beforeEach(() => {
    store = new InMemoryByteUploadStore(() => 1000)
    present = new Set()
  })

  it('promotes a staged record whose block materialized (crash after commit, before promote)', async () => {
    await store.stage(stageInput({ assetBlockId: 'media:a' }))
    present.add('media:a')

    const summary = await reconcileUploads(USER, deps())

    expect(summary).toEqual({ promoted: 1, kept: 0 })
    expect((await store.get(USER, 'media:a'))?.status).toBe('pending')
  })

  it('LEAVES a staged record whose block is not (yet) materialized — never reaps it', async () => {
    // Either a committed-but-unmaterialized block (locked e2ee / unhydrated → it
    // promotes on a later boot) or a rare true orphan (§16 GC reclaims its bytes).
    // Either way we keep the record + its bytes; reaping could destroy a live
    // block's only un-uploaded copy.
    await store.stage(stageInput({ assetBlockId: 'media:a' }))
    // block 'media:a' is NOT present

    const summary = await reconcileUploads(USER, deps())

    expect(summary).toEqual({ promoted: 0, kept: 1 })
    expect((await store.get(USER, 'media:a'))?.status).toBe('staged') // untouched, retained
  })

  it('only touches staged records — pending/failed are left for the drain / recovery', async () => {
    await store.stage(stageInput({ assetBlockId: 'media:p' }))
    await store.promote(USER, 'media:p') // now pending
    present.add('media:p')

    const summary = await reconcileUploads(USER, deps())

    expect(summary).toEqual({ promoted: 0, kept: 0 })
    expect((await store.get(USER, 'media:p'))?.status).toBe('pending') // unchanged
  })

  it('handles a mixed batch and is scoped to the user', async () => {
    await store.stage(stageInput({ assetBlockId: 'media:committed' }))
    present.add('media:committed')
    await store.stage(stageInput({ assetBlockId: 'media:absent', contentKey: 'ko' }))
    // a different account's staged record must be invisible
    await store.stage(stageInput({ userId: 'u2', assetBlockId: 'media:other' }))

    const summary = await reconcileUploads(USER, deps())

    expect(summary).toEqual({ promoted: 1, kept: 1 })
    expect((await store.get(USER, 'media:committed'))?.status).toBe('pending')
    expect((await store.get(USER, 'media:absent'))?.status).toBe('staged')
    expect((await store.get('u2', 'media:other'))?.status).toBe('staged') // untouched
  })
})

import { CrudEntry, UpdateType, type CrudTransaction, type AbstractPowerSyncDatabase } from '@powersync/common'
import type { BlockRow } from '@/data/blockSchema'
import { describe, expect, it, vi } from 'vitest'
import {
  __compactBlockCrudEntriesForTest,
  __normalizeLocalBlockUploadRowForTest,
  __orderedBlockUpsertsForTest,
  __shouldBulkUpsertPatchesForTest,
  __uploadTransactionsWithFallbackForTest,
  type CompactedBlockOperation,
  type UploadDeps,
} from './powersync'

const put = (
  clientId: number,
  id: string,
  data: Record<string, unknown>,
  txId = 1,
) => new CrudEntry(clientId, UpdateType.PUT, 'blocks', id, txId, data)

const patch = (
  clientId: number,
  id: string,
  data: Record<string, unknown>,
  txId = 1,
) => new CrudEntry(clientId, UpdateType.PATCH, 'blocks', id, txId, data)

const del = (clientId: number, id: string, txId = 1) =>
  new CrudEntry(clientId, UpdateType.DELETE, 'blocks', id, txId)

describe('PowerSync upload compaction', () => {
  it('fuses same-tx PUT + PATCH into a single create with merged columns', () => {
    // Within one tx, the developer's intent is a single atomic state — the
    // PUT+PATCH split is an abstraction artefact (e.g. `tx.create` followed
    // by `addTypeInTx` writing the types property as a PATCH). Fusing lets
    // the wire op stay a single insert-or-skip CREATE, so a fresh client
    // bootstrapping over an already-synced server row never clobbers the
    // saved `properties_json`.
    const operations = __compactBlockCrudEntriesForTest([
      put(1, 'block-a', {
        workspace_id: 'workspace-a',
        parent_id: null,
        order_key: 'a0',
        content: 'A',
        properties_json: '{}',
        updated_at: 1,
      }, /* txId */ 1),
      patch(2, 'block-a', {
        properties_json: '{"alias":["A"]}',
        updated_at: 2,
      }, /* txId */ 1),
      patch(3, 'block-a', {
        properties_json: '{"alias":["A"],"types":["page"]}',
        updated_at: 3,
      }, /* txId */ 1),
    ])

    expect(operations).toEqual([
      {
        kind: 'create',
        id: 'block-a',
        order: 0,
        payload: {
          id: 'block-a',
          workspace_id: 'workspace-a',
          parent_id: null,
          order_key: 'a0',
          content: 'A',
          properties_json: '{"alias":["A"],"types":["page"]}',
          updated_at: 3,
        },
      },
    ])
  })

  it('keeps PUT and PATCH separate when they come from different transactions', () => {
    // Cross-tx: the PUT is the bootstrap insert; the PATCH is a later
    // user-intentional edit (separate tx). The PATCH must still land on the
    // server even when the CREATE is a no-op insert-or-skip on a row the
    // server already has — that's how user edits committed before initial
    // sync still propagate after the deterministic-id collision is detected.
    const operations = __compactBlockCrudEntriesForTest([
      put(1, 'block-a', {
        workspace_id: 'workspace-a',
        parent_id: null,
        order_key: 'a0',
        content: 'A',
        properties_json: '{}',
        updated_at: 1,
      }, /* txId */ 1),
      patch(2, 'block-a', {
        properties_json: '{"alias":["A"]}',
        updated_at: 2,
      }, /* txId */ 2),
      patch(3, 'block-a', {
        properties_json: '{"alias":["A"],"types":["page"]}',
        updated_at: 3,
      }, /* txId */ 3),
    ])

    expect(operations).toEqual([
      {
        kind: 'create',
        id: 'block-a',
        order: 0,
        payload: {
          id: 'block-a',
          workspace_id: 'workspace-a',
          parent_id: null,
          order_key: 'a0',
          content: 'A',
          properties_json: '{}',
          updated_at: 1,
        },
      },
      {
        kind: 'patch',
        id: 'block-a',
        order: 0,
        payload: {
          properties_json: '{"alias":["A"],"types":["page"]}',
          updated_at: 3,
        },
      },
    ])
  })

  it('emits a pure PUT as a single create op (insert-or-skip semantics on the server)', () => {
    const operations = __compactBlockCrudEntriesForTest([
      put(1, 'block-a', {
        workspace_id: 'workspace-a',
        parent_id: null,
        order_key: 'a0',
        content: 'A',
        properties_json: '{}',
        updated_at: 1,
      }),
    ])

    expect(operations).toEqual([
      {
        kind: 'create',
        id: 'block-a',
        order: 0,
        payload: {
          id: 'block-a',
          workspace_id: 'workspace-a',
          parent_id: null,
          order_key: 'a0',
          content: 'A',
          properties_json: '{}',
          updated_at: 1,
        },
      },
    ])
  })

  it('leaves update-only edits as patch uploads for normal single-edit latency', () => {
    const operations = __compactBlockCrudEntriesForTest([
      patch(1, 'block-a', {content: 'edited', updated_at: 2}),
      patch(2, 'block-a', {references_json: '[]', updated_at: 3}),
    ])

    expect(operations).toEqual([
      {
        kind: 'patch',
        id: 'block-a',
        order: 0,
        payload: {
          content: 'edited',
          references_json: '[]',
          updated_at: 3,
        },
      },
    ])
  })

  it('lets a final delete supersede earlier writes for the same block', () => {
    const operations = __compactBlockCrudEntriesForTest([
      put(1, 'block-a', {content: 'A'}),
      patch(2, 'block-a', {content: 'B'}),
      del(3, 'block-a'),
    ])

    expect(operations).toEqual([
      {
        kind: 'delete',
        id: 'block-a',
        order: 2,
      },
    ])
  })

  it('orders parent upserts before child upserts within a bulk request', () => {
    const ordered = __orderedBlockUpsertsForTest([
      {id: 'child', parent_id: 'parent', content: 'child'},
      {id: 'parent', parent_id: null, content: 'parent'},
      {id: 'sibling', parent_id: 'parent', content: 'sibling'},
    ])

    expect(ordered.map(row => row.id)).toEqual(['parent', 'child', 'sibling'])
  })

  it('only switches patch uploads to bulk upserts for multi-row backlogs', () => {
    expect(__shouldBulkUpsertPatchesForTest([{id: 'block-a'}])).toBe(false)
    expect(__shouldBulkUpsertPatchesForTest([{id: 'block-a'}, {id: 'block-b'}])).toBe(true)
  })

  it('normalizes local SQLite block rows before remote upsert', () => {
    const payload = __normalizeLocalBlockUploadRowForTest({
      id: 'block-a',
      workspace_id: 'workspace-a',
      parent_id: null,
      order_key: 'a0',
      content: 'A',
      properties_json: '{}',
      references_json: '[]',
      created_at: 1,
      updated_at: 2,
      created_by: 'user-a',
      updated_by: 'user-a',
      deleted: 0,
    } satisfies BlockRow)

    expect(payload.deleted).toBe(false)
  })
})

// ===========================================================================
// uploadTransactionsWithFallback — rejection-tolerance orchestrator.
//
// The handler runs an optimistic batched upload (current fast path); on
// permanent failure it isolates the bad tx by re-applying each tx
// individually, recording the rejection to ps_crud_rejected, and
// continuing past the rejection so the rest of the queue drains. The
// alternative — the prior `throw` on any failure — jammed the bucket
// and surfaced as "sync stops working" until manual ps_crud surgery.
// ===========================================================================

interface FakeTransaction {
  readonly transactionId: number
  readonly crud: CrudEntry[]
  completed: boolean
  complete: () => Promise<void>
}

const fakeTx = (transactionId: number, entries: CrudEntry[]): FakeTransaction => {
  const tx: FakeTransaction = {
    transactionId,
    crud: entries,
    completed: false,
    complete: async () => {
      tx.completed = true
    },
  }
  return tx
}

const fakeDb = {} as AbstractPowerSyncDatabase

const fkError = (): Error => {
  const err = new Error('insert or update on table "blocks" violates foreign key constraint')
  ;(err as Error & {code: string}).code = '23503'
  return err
}

const networkError = (): Error => new Error('fetch failed')

const collectCalls = () => {
  const applyOperations = vi.fn<UploadDeps['applyOperations']>().mockResolvedValue(undefined)
  const recordRejection = vi.fn<UploadDeps['recordRejection']>().mockResolvedValue(undefined)
  return {applyOperations, recordRejection}
}

describe('uploadTransactionsWithFallback', () => {
  it('happy path: applies one batched call and completes the last tx (drains the whole batch)', async () => {
    // The fast path is unchanged from the original handler — one
    // compaction across all txs, one Supabase round trip, mark the
    // tail tx complete (which drains every preceding tx from
    // ps_crud). Mock applyOperations resolves cleanly; the fallback
    // loop must not run.
    const tx1 = fakeTx(1, [
      new CrudEntry(1, UpdateType.PUT, 'blocks', 'block-a', 1, {content: 'A'}),
    ])
    const tx2 = fakeTx(2, [
      new CrudEntry(2, UpdateType.PATCH, 'blocks', 'block-a', 2, {content: 'B'}),
    ])
    const {applyOperations, recordRejection} = collectCalls()

    await __uploadTransactionsWithFallbackForTest(
      fakeDb,
      [tx1, tx2] as unknown as CrudTransaction[],
      {applyOperations, recordRejection},
    )

    expect(applyOperations).toHaveBeenCalledTimes(1)
    expect(recordRejection).not.toHaveBeenCalled()
    expect(tx1.completed).toBe(false)         // batch.complete on the last tx drains both
    expect(tx2.completed).toBe(true)
  })

  it('permanent failure on batch: isolates per-tx, records the bad tx, drains the rest', async () => {
    // The original FK-jam scenario in miniature. The batch fails with
    // 23503; classifier marks permanent; per-tx fallback applies
    // tx1 (succeeds), tx2 (fails — recorded), tx3 (succeeds). All
    // three end up complete()'d so ps_crud drains; only tx2 lands
    // in ps_crud_rejected.
    const tx1 = fakeTx(10, [new CrudEntry(1, UpdateType.PUT, 'blocks', 'block-a', 10, {content: 'A'})])
    const tx2 = fakeTx(20, [new CrudEntry(2, UpdateType.PATCH, 'blocks', 'block-b', 20, {deleted: true})])
    const tx3 = fakeTx(30, [new CrudEntry(3, UpdateType.PUT, 'blocks', 'block-c', 30, {content: 'C'})])
    const {applyOperations, recordRejection} = collectCalls()
    // Batch call (call 1) fails. Per-tx calls: tx1 ok, tx2 fails, tx3 ok.
    applyOperations
      .mockRejectedValueOnce(fkError())
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(fkError())
      .mockResolvedValueOnce(undefined)

    await __uploadTransactionsWithFallbackForTest(
      fakeDb,
      [tx1, tx2, tx3] as unknown as CrudTransaction[],
      {applyOperations, recordRejection},
    )

    expect(applyOperations).toHaveBeenCalledTimes(4)
    expect(recordRejection).toHaveBeenCalledTimes(1)
    expect(recordRejection.mock.calls[0]?.[1]).toBe(tx2)
    expect(tx1.completed).toBe(true)
    expect(tx2.completed).toBe(true)          // completed even though rejected — drains from ps_crud
    expect(tx3.completed).toBe(true)
  })

  it('transient failure on batch: re-throws without completing or recording', async () => {
    // Transient = network blip, 5xx, etc. PowerSync's contract is
    // "throw → retry the batch later." We must NOT complete any tx
    // (would lose data) and must NOT record (it's not a rejection,
    // it's a temporary failure). Per-tx fallback should NOT run.
    const tx1 = fakeTx(1, [new CrudEntry(1, UpdateType.PUT, 'blocks', 'block-a', 1, {content: 'A'})])
    const {applyOperations, recordRejection} = collectCalls()
    applyOperations.mockRejectedValueOnce(networkError())

    await expect(
      __uploadTransactionsWithFallbackForTest(
        fakeDb,
        [tx1] as unknown as CrudTransaction[],
        {applyOperations, recordRejection},
      ),
    ).rejects.toThrow('fetch failed')

    expect(applyOperations).toHaveBeenCalledTimes(1)
    expect(recordRejection).not.toHaveBeenCalled()
    expect(tx1.completed).toBe(false)
  })

  it('transient failure during per-tx fallback: re-throws so PowerSync retries the remainder', async () => {
    // Batch fails permanently → per-tx. tx1 applies fine, tx2 hits a
    // transient error. Throwing here is correct: tx1 stays drained
    // (its complete()'d), but tx2 + tx3 stay in ps_crud. PowerSync
    // calls uploadData again, we re-pull tx2 + tx3, retry. The
    // alternative (recording transient as a rejection) would silently
    // discard data on a temporary blip.
    const tx1 = fakeTx(1, [new CrudEntry(1, UpdateType.PUT, 'blocks', 'block-a', 1, {content: 'A'})])
    const tx2 = fakeTx(2, [new CrudEntry(2, UpdateType.PATCH, 'blocks', 'block-b', 2, {content: 'B'})])
    const tx3 = fakeTx(3, [new CrudEntry(3, UpdateType.PUT, 'blocks', 'block-c', 3, {content: 'C'})])
    const {applyOperations, recordRejection} = collectCalls()
    applyOperations
      .mockRejectedValueOnce(fkError())      // batch fails permanently → fallback
      .mockResolvedValueOnce(undefined)      // tx1 ok
      .mockRejectedValueOnce(networkError()) // tx2 transient

    await expect(
      __uploadTransactionsWithFallbackForTest(
        fakeDb,
        [tx1, tx2, tx3] as unknown as CrudTransaction[],
        {applyOperations, recordRejection},
      ),
    ).rejects.toThrow('fetch failed')

    expect(tx1.completed).toBe(true)
    expect(tx2.completed).toBe(false)
    expect(tx3.completed).toBe(false)
    expect(recordRejection).not.toHaveBeenCalled()
  })

  it('per-tx fallback applies within-tx compaction (PUT + same-tx PATCH still fuse)', async () => {
    // Correctness check: when we drop from batched into per-tx, the
    // create+patch fusion that the original handler relies on for
    // bootstrap idempotence (see compactBlockCrudEntries comments)
    // must still apply within each tx. Otherwise a deterministic-id
    // bootstrap (user_prefs etc.) where the server already has the
    // row would receive a bare PATCH that wipes properties_json.
    const tx1 = fakeTx(1, [
      new CrudEntry(1, UpdateType.PUT, 'blocks', 'block-a', 1, {
        workspace_id: 'w', parent_id: null, content: 'A', properties_json: '{}',
      }),
      new CrudEntry(2, UpdateType.PATCH, 'blocks', 'block-a', 1, {
        properties_json: '{"types":["page"]}',
      }),
    ])
    const tx2 = fakeTx(2, [new CrudEntry(3, UpdateType.PUT, 'blocks', 'block-b', 2, {content: 'B'})])
    const {applyOperations, recordRejection} = collectCalls()
    applyOperations
      .mockRejectedValueOnce(fkError())      // force per-tx path
      .mockResolvedValueOnce(undefined)      // tx1 single fused create
      .mockResolvedValueOnce(undefined)      // tx2 single create

    await __uploadTransactionsWithFallbackForTest(
      fakeDb,
      [tx1, tx2] as unknown as CrudTransaction[],
      {applyOperations, recordRejection},
    )

    const tx1Ops = applyOperations.mock.calls[1]?.[1] as CompactedBlockOperation[]
    expect(tx1Ops).toHaveLength(1)
    expect(tx1Ops[0]).toMatchObject({
      kind: 'create',
      id: 'block-a',
      payload: expect.objectContaining({
        properties_json: '{"types":["page"]}', // PATCH folded into the PUT
      }),
    })
  })
})

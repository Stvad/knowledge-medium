// @vitest-environment node
/**
 * Fix B — self-heal an insert-or-skip phantom via the durable `pending_restage`
 * outbox (issue #336 / PR #345).
 *
 * The phantom: a client mints a deterministic id while its already-synced
 * `blocks_synced` row is momentarily un-materialized (the offline-reconnect race
 * between a mutating plugin effect and initial sync). It writes a real-time-
 * stamped local `blocks` row; the create uploads as insert-or-skip so the server
 * keeps its authoritative row and sends NO echo; the one staging change that
 * arrived during the race was skip-stale'd (pending upload at the time) and
 * consumed. Result: `blocks` sits ahead of an unchanged `blocks_synced` with
 * nothing left to re-trigger reconciliation.
 *
 * The heal is two-phase and durable:
 *   - RECORD (`recordDrainedCreates`): after a create's upload drains, its id is
 *     recorded into `pending_restage` (unconditionally on ps_crud state — the
 *     flush gates on the queue).
 *   - FLUSH (`flushPendingRestage`): once the id's upload queue is clear, a
 *     synthetic `blocks_synced_changes` upsert is enqueued (waking the real
 *     observer to apply the server row) and the outbox row is dropped.
 * A create whose same-id sibling op is REJECTED heals because the rejection
 * drains the queue, letting a later flush fire — the residual the old in-
 * connector re-stage couldn't close.
 *
 * Driven through the REAL observer against an `@powersync/node` DB, so the
 * onChange wake-up (from a DIRECT `blocks_synced_changes` insert) and the
 * reconcile gate are the production ones.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AbstractPowerSyncDatabase } from '@powersync/common'
import { __recordDrainedCreatesForTest, type CompactedBlockOperation } from './powersync'
import { flushPendingRestage } from '@/data/internals/clientSchema.js'
import type { BlockData } from '@/data/api'
import { constMat, setupObserverTestDb } from '@/data/internals/syncObserver/test/harness.js'

const data = (o: Partial<BlockData> = {}): BlockData => ({
  id: 'b1', workspaceId: 'ws-plain', parentId: null, orderKey: 'a0', content: 'hello',
  properties: {}, references: [], createdAt: 1, updatedAt: 1, userUpdatedAt: 1,
  createdBy: 'u', updatedBy: 'u', deleted: false, ...o,
})

const createOp = (id: string): CompactedBlockOperation =>
  ({ kind: 'create', id, order: 0, payload: { id, workspace_id: 'ws-plain' } })

const {
  env, start, seedLocalBlock, stageRow: stageServerRow, deleteStagingRow,
  blocks, queueLen, queuePendingUpload, pendingRestage,
} = setupObserverTestDb()

const record = (ops: CompactedBlockOperation[]) =>
  __recordDrainedCreatesForTest(env.db as unknown as AbstractPowerSyncDatabase, ops)
const flush = () => flushPendingRestage(env.db as unknown as AbstractPowerSyncDatabase)
const insertOutbox = (id: string) =>
  env.db.execute('INSERT OR IGNORE INTO pending_restage (id) VALUES (?)', [id])
const startObserver = () => start({ getMaterializability: constMat('copy') }).observer

/** Stage server rows for the ids under test — the record gate only records a
 *  created id that ALREADY has a `blocks_synced` row (a phantom). */
const stageServerRows = async (...ids: string[]) => {
  for (const id of ids) await stageServerRow(data({ id }))
}

describe('recordDrainedCreates — outbox shape', () => {
  it('records one row per create with a staging row, ignoring patches and deletes', async () => {
    await stageServerRows('c1', 'c2')
    await record([
      createOp('c1'),
      { kind: 'patch', id: 'p1', order: 1, payload: {} },
      { kind: 'delete', id: 'd1', order: 2 },
      createOp('c2'),
    ])
    expect(await pendingRestage()).toEqual([{ id: 'c1' }, { id: 'c2' }])
  })

  it('skips a created id with no staging row (genuine-new insert — nothing to heal)', async () => {
    await stageServerRows('c1') // c1 staged (phantom); c2 has no server row yet
    await record([createOp('c1'), createOp('c2')])
    expect(await pendingRestage()).toEqual([{ id: 'c1' }])
  })

  it('records a create even while a same-id ps_crud upload is pending (no pending-gate at record)', async () => {
    // The KEY change from the old in-connector re-stage: recording is
    // unconditional on the queue, so a create with a still-pending sibling is
    // durably carried until the flush finds its queue clear.
    await stageServerRows('c1')
    await queuePendingUpload('c1')
    await record([createOp('c1')])
    expect(await pendingRestage()).toEqual([{ id: 'c1' }])
  })

  it('no-ops when the batch has no create ops', async () => {
    await record([{ kind: 'patch', id: 'p1', order: 0, payload: {} }])
    expect(await pendingRestage()).toEqual([])
  })

  it('excludes a create whose id also has a separate patch op (the patch echo reconciles it)', async () => {
    // A create + a SEPARATE patch for the same id (cross-tx; same-tx would fuse).
    // The patch is a real server write whose echo reconciles c1, so recording c1
    // would risk the flush reverting the acked patch — exclude it. c2 stays.
    await stageServerRows('c1', 'c2')
    await record([
      createOp('c1'),
      { kind: 'patch', id: 'c1', order: 1, payload: {} },
      createOp('c2'),
    ])
    expect(await pendingRestage()).toEqual([{ id: 'c2' }])
  })

  it('excludes a create whose id also has a separate delete op (would else resurrect the delete)', async () => {
    // A create + a SEPARATE succeeded delete for the same id (cross-tx; a same-
    // batch create+delete cancels in compaction, so only the per-tx fallback
    // surfaces both). The delete's echo removes the row; recording c1 would let
    // the flush enqueue a synthetic upsert from the stale staging row and
    // resurrect the deleted block before the delete echo lands — exclude it.
    await stageServerRows('c1', 'c2')
    await record([
      createOp('c1'),
      { kind: 'delete', id: 'c1', order: 1 },
      createOp('c2'),
    ])
    expect(await pendingRestage()).toEqual([{ id: 'c2' }])
  })
})

describe('flushPendingRestage — queue gate', () => {
  it('re-stages (enqueues an upsert) and clears an outbox id whose queue is clear', async () => {
    await stageServerRows('b1')
    await env.db.execute('DELETE FROM blocks_synced_changes') // drop the staging-insert enqueue
    await insertOutbox('b1')
    await flush()
    const rows = await env.db.getAll<{ id: string; op: string }>(
      'SELECT id, op FROM blocks_synced_changes ORDER BY seq',
    )
    expect(rows).toEqual([{ id: 'b1', op: 'upsert' }])
    expect(await pendingRestage()).toEqual([])
  })

  it('defers an outbox id with a pending same-id upload — enqueues nothing, keeps the row', async () => {
    await stageServerRows('b1')
    await env.db.execute('DELETE FROM blocks_synced_changes')
    await insertOutbox('b1')
    await queuePendingUpload('b1')
    await flush()
    expect(await queueLen()).toBe(0)
    expect(await pendingRestage()).toEqual([{ id: 'b1' }]) // carried for a later flush
  })

  it('drops a revoked outbox id (no staging row) without enqueuing an upsert', async () => {
    // Belt-and-suspenders for the flush SQL's own gate: normally the clear-on-
    // synced-delete trigger removes a revoked id first, but if one lingers the
    // flush deletes it (no staging row ⇒ nothing to heal) rather than emitting a
    // stray 'upsert'.
    await insertOutbox('gone')
    await flush()
    expect(await queueLen()).toBe(0)
    expect(await pendingRestage()).toEqual([])
  })
})

describe('pending_restage clear-on-synced triggers', () => {
  it('a real staging insert (server echo) removes the id from the outbox', async () => {
    await insertOutbox('b1')
    await stageServerRow(data({ id: 'b1' })) // echo lands ⇒ reconciles ⇒ drop the outbox row
    expect(await pendingRestage()).toEqual([])
  })

  it('keeps the outbox id when a same-id upload is still pending (re-stream did not reconcile it)', async () => {
    // A bulk blocks_synced re-stream can re-insert a row while a sibling edit is
    // still queued; that echo is skip-staled (didn't actually reconcile), so the
    // outbox entry must survive — else a later rejection of the sibling would
    // strand the phantom. The clear only fires once no same-id op is pending.
    await insertOutbox('b1')
    await queuePendingUpload('b1')
    await stageServerRow(data({ id: 'b1' }))
    expect(await pendingRestage()).toEqual([{ id: 'b1' }])
  })

  it('a staging delete (revoke) removes the id from the outbox', async () => {
    await stageServerRow(data({ id: 'b1' }))
    await insertOutbox('b1')
    await deleteStagingRow('b1')
    expect(await pendingRestage()).toEqual([])
  })
})

describe('self-heals an insert-or-skip phantom (fix B, via the real observer)', () => {
  /** Post-race stuck state: the server row is staged (its staging change already
   *  consumed by the skip-stale'd race drain), the phantom local row is ahead,
   *  and ps_crud + the change queue are empty — nothing left to re-reconcile. */
  const seedStuckPhantom = async () => {
    await seedLocalBlock(data({ content: 'phantom (local)', updatedAt: 3000 }))
    await stageServerRow(data({ content: 'server truth', updatedAt: 2000 }))
    await env.db.execute('DELETE FROM blocks_synced_changes')
  }

  it('record → flush wakes the observer and applies the server row over the phantom', async () => {
    await seedStuckPhantom()
    const observer = startObserver()
    await observer.flush()
    // Stuck: the idle observer does not heal on its own — no queued change, even
    // though blocks(3000) is ahead of blocks_synced(2000).
    expect(await blocks()).toEqual([{ id: 'b1', content: 'phantom (local)' }])

    await record([createOp('b1')])
    expect(await pendingRestage()).toEqual([{ id: 'b1' }])
    await flush()

    // The synthetic blocks_synced_changes upsert wakes onChange; ps_crud is empty
    // (non-pending), so the gate applies the older server row over the phantom.
    await vi.waitFor(
      async () => expect((await blocks())[0]?.content).toBe('server truth'),
      { timeout: 3000, interval: 20 },
    )
    expect(await pendingRestage()).toEqual([]) // dropped on flush
  })

  it('closes the rejected-sibling residual: recorded while a sibling is queued, heals once it drains', async () => {
    // A later same-id op is still queued when the create drains, so the flush
    // defers. When that op is REJECTED it drains from ps_crud (quarantined), and
    // the next flush — finding the queue clear — heals. The old in-connector
    // re-stage dropped the create here; the durable outbox carries it.
    await seedStuckPhantom()
    await queuePendingUpload('b1') // the sibling op, still queued
    await record([createOp('b1')])
    const observer = startObserver()

    await flush() // sibling pending ⇒ deferred
    await observer.flush()
    expect(await blocks()).toEqual([{ id: 'b1', content: 'phantom (local)' }]) // still stuck
    expect(await pendingRestage()).toEqual([{ id: 'b1' }]) // carried

    // The sibling is rejected → quarantined → drained out of ps_crud.
    await env.db.execute('DELETE FROM ps_crud')
    await flush()

    await vi.waitFor(
      async () => expect((await blocks())[0]?.content).toBe('server truth'),
      { timeout: 3000, interval: 20 },
    )
    expect(await pendingRestage()).toEqual([])
  })

  it('a genuinely-new id (no staging row) records nothing — the fresh local row survives', async () => {
    // A create the server actually accepted has no blocks_synced row yet, so the
    // record gate stores nothing: no outbox row, no flush work, and the fresh
    // local row is untouched (its own later sync-down echo reconciles it).
    await seedLocalBlock(data({ content: 'fresh local insert', updatedAt: 5000 }))
    const observer = startObserver()
    await observer.flush()

    await record([createOp('b1')])
    expect(await pendingRestage()).toEqual([]) // gated out at record time
    await flush()
    expect(await queueLen()).toBe(0)
    await observer.flush()

    expect(await blocks()).toEqual([{ id: 'b1', content: 'fresh local insert' }])
  })
})

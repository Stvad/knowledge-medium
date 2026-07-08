// @vitest-environment node
/**
 * Fix B — re-stage created ids after an insert-or-skip upload so the observer
 * self-heals a phantom.
 *
 * The phantom: a client mints a deterministic id while its already-synced
 * `blocks_synced` row is momentarily un-materialized (the offline-reconnect race
 * between a mutating plugin effect and initial sync). It writes a real-time-
 * stamped local `blocks` row; the create uploads as insert-or-skip so the server
 * keeps its authoritative row and sends NO echo; the one staging change that
 * arrived during the race was skip-stale'd (pending upload at the time) and
 * consumed. Result: `blocks` sits ahead of an unchanged `blocks_synced` with
 * nothing left to re-trigger reconciliation. `restageCreatedIds` supplies the
 * missing trigger.
 *
 * Driven through the REAL observer against an `@powersync/node` DB, so the
 * onChange wake-up (from a DIRECT `blocks_synced_changes` insert) and the
 * reconcile gate are the production ones.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AbstractPowerSyncDatabase } from '@powersync/common'
import { BLOCKS_SYNCED_RAW_TABLE, blockToRowParams } from '@/data/blockSchema'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import {
  startBlocksSyncedObserver,
  type BlocksSyncedObserver,
} from '@/data/internals/syncObserver/observer.js'
import type { GetMaterializability } from '@/data/internals/syncObserver/materialize.js'
import { __restageCreatedIdsForTest, type CompactedBlockOperation } from './powersync'
import type { BlockData } from '@/data/api'

const data = (o: Partial<BlockData> = {}): BlockData => ({
  id: 'b1', workspaceId: 'ws-plain', parentId: null, orderKey: 'a0', content: 'hello',
  properties: {}, references: [], createdAt: 1, updatedAt: 1, userUpdatedAt: 1,
  createdBy: 'u', updatedBy: 'u', deleted: false, ...o,
})

const createOp = (id: string): CompactedBlockOperation =>
  ({ kind: 'create', id, order: 0, payload: { id, workspace_id: 'ws-plain' } })

let sharedDb: TestDb
let env: TestDb
let observers: BlocksSyncedObserver[]
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db); env = sharedDb; observers = [] })
afterEach(() => { for (const o of observers) o.dispose() })

const BLOCK_COLS =
  'id, workspace_id, parent_id, order_key, content, properties_json, references_json, ' +
  'created_at, updated_at, user_updated_at, created_by, updated_by, deleted'
const seedLocalBlock = (d: BlockData) =>
  env.db.execute(`INSERT INTO blocks (${BLOCK_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, blockToRowParams(d))
const stageServerRow = (d: BlockData) =>
  env.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToRowParams(d))
const blocks = () =>
  env.db.getAll<{ id: string; content: string }>('SELECT id, content FROM blocks ORDER BY id')
const queueLen = async () => (await env.db.getAll('SELECT seq FROM blocks_synced_changes')).length

const restage = (ops: CompactedBlockOperation[]) =>
  __restageCreatedIdsForTest(env.db as unknown as AbstractPowerSyncDatabase, ops)

const constMat = (m: 'copy'): GetMaterializability => () => m
const startObserver = (): BlocksSyncedObserver => {
  const observer = startBlocksSyncedObserver({
    db: env.db,
    cache: new BlockCache(),
    handleStore: { invalidate: () => {} },
    deps: { getMaterializability: constMat('copy'), getCek: async () => null },
    throttleMs: 5,
  })
  observers.push(observer)
  return observer
}
const waitFor = async (cond: () => Promise<boolean>, ms = 3000): Promise<void> => {
  const t0 = Date.now()
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 15))
  }
}

describe('restageCreatedIds — enqueue shape', () => {
  // The staging-row gate only re-stages a created id that ALREADY has a
  // `blocks_synced` row (a phantom). Stage server rows for the ids under test —
  // and clear the queue the staging INSERT trigger enqueues, so the assertions
  // see restage's output alone.
  const stageServerRows = async (...ids: string[]) => {
    for (const id of ids) await stageServerRow(data({ id }))
    await env.db.execute('DELETE FROM blocks_synced_changes')
  }

  it('enqueues one upsert per create op with a staging row, ignoring patches and deletes', async () => {
    await stageServerRows('c1', 'c2')
    await restage([
      createOp('c1'),
      { kind: 'patch', id: 'p1', order: 1, payload: {} },
      { kind: 'delete', id: 'd1', order: 2 },
      createOp('c2'),
    ])
    const rows = await env.db.getAll<{ id: string; op: string }>(
      'SELECT id, op FROM blocks_synced_changes ORDER BY seq',
    )
    expect(rows).toEqual([{ id: 'c1', op: 'upsert' }, { id: 'c2', op: 'upsert' }])
  })

  it('skips a created id with no staging row (genuine-new insert — nothing to heal yet)', async () => {
    await stageServerRows('c1') // c1 staged (phantom); c2 has no server row yet
    await restage([createOp('c1'), createOp('c2')])
    const rows = await env.db.getAll<{ id: string; op: string }>(
      'SELECT id, op FROM blocks_synced_changes ORDER BY seq',
    )
    expect(rows).toEqual([{ id: 'c1', op: 'upsert' }])
  })

  it('no-ops when the batch has no create ops', async () => {
    await restage([{ kind: 'patch', id: 'p1', order: 0, payload: {} }])
    expect(await queueLen()).toBe(0)
  })

  it('excludes a create whose id also has a separate patch op (the patch echo reconciles it)', async () => {
    // A create + a SEPARATE patch for the same id (cross-tx; same-tx would fuse).
    // The patch is a real server write whose echo reconciles c1, so re-staging c1
    // would only risk a transient disk revert — exclude it. c2 (pure create) stays.
    await stageServerRows('c1', 'c2')
    await restage([
      createOp('c1'),
      { kind: 'patch', id: 'c1', order: 1, payload: {} },
      createOp('c2'),
    ])
    const rows = await env.db.getAll<{ id: string; op: string }>(
      'SELECT id, op FROM blocks_synced_changes ORDER BY seq',
    )
    expect(rows).toEqual([{ id: 'c2', op: 'upsert' }])
  })
})

describe('restage self-heals an insert-or-skip phantom (fix B, via the real observer)', () => {
  /** Post-race stuck state: the server row is staged (its staging change already
   *  consumed by the skip-stale'd race drain), the phantom local row is ahead,
   *  and ps_crud + the change queue are empty — nothing left to re-reconcile. */
  const seedStuckPhantom = async () => {
    await seedLocalBlock(data({ content: 'phantom (local)', updatedAt: 3000 }))
    await stageServerRow(data({ content: 'server truth', updatedAt: 2000 }))
    await env.db.execute('DELETE FROM blocks_synced_changes')
  }

  it('a re-staged created id wakes the observer and applies the server row over the phantom', async () => {
    await seedStuckPhantom()
    const observer = startObserver()
    await observer.flush()
    // Stuck: the idle observer does not heal on its own — no queued change, even
    // though blocks(3000) is ahead of blocks_synced(2000).
    expect(await blocks()).toEqual([{ id: 'b1', content: 'phantom (local)' }])

    await restage([createOp('b1')])

    // The direct blocks_synced_changes insert wakes onChange; ps_crud is empty
    // (non-pending), so the gate applies the older server row over the phantom.
    await waitFor(async () => (await blocks())[0]?.content === 'server truth')
  })

  it('re-staging a genuinely-new id (no staging row) enqueues nothing — the fresh local row survives', async () => {
    // A create the server actually accepted has no blocks_synced row yet, so the
    // staging-row gate enqueues nothing: no wake, no work, and the fresh local row
    // is untouched (its own later sync-down echo reconciles it).
    await seedLocalBlock(data({ content: 'fresh local insert', updatedAt: 5000 }))
    const observer = startObserver()
    await observer.flush()

    await restage([createOp('b1')])
    expect(await queueLen()).toBe(0) // gated out at enqueue time
    await observer.flush()

    expect(await blocks()).toEqual([{ id: 'b1', content: 'fresh local insert' }])
  })
})

// @vitest-environment node
/**
 * `Repo.syncViewGap()` — why this device's view of the graph is incomplete.
 *
 * The staged-rows clause asks a question the DRAIN also asks, so the two must
 * agree: a staging row the drain would discard as a no-op leaves the view
 * complete, and reporting it as a gap refuses work for no reason. The one that
 * matters in practice is a device's OWN upload echo — every local write comes
 * back down the sync stream and re-stages, carrying the stamp it was written
 * with (measured on a live client: identical `updated_at`).
 *
 * The agreement is `decideStagingRow`'s invariant I1 (`reconcile.ts`): equal
 * nonzero stamps ⟺ identical content, because the server strictly advances the
 * stamp on any content change. Those rows resolve `skip-stale` and change
 * nothing. I2's `0` sentinel is the documented exception — a 0-stamped local
 * row always yields — so it stays a gap.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams } from '@/data/blockSchema'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { decideStagingRow } from '@/data/internals/syncObserver/reconcile'
import { ChangeScope } from '@/data/api'
import type { BlockData } from '@/data/api'

const WS = 'ws1'

const syncedRow = (o: Partial<BlockData> = {}): BlockData => ({
  id: 'b1', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'v1',
  properties: {}, references: [], createdAt: 1, updatedAt: 1, userUpdatedAt: 1, createdBy: 'u',
  updatedBy: 'u', deleted: false, ...o,
})

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })

const makeRepo = () => {
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  return repo
}

/** Write the staging row through the EXACT statement PowerSync's sync-apply
 *  uses, so the capture trigger stages it the way a real arrival does. */
const deliver = (d: BlockData) =>
  sharedDb.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams(d))

/** A local `blocks` row with no processor run and no synced counterpart —
 *  the shape a row has mid-drain, and the only way to exercise one staged
 *  clause without a sibling clause firing first. */
const seedLocal = (id: string, updatedAt: number) =>
  sharedDb.db.writeTransaction(async tx => {
    await tx.execute(
      `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
         created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
       VALUES (?, ?, NULL, 'a0', 'v', '{}', 1, ?, ?, 'u', 'u', 0)`,
      [id, WS, updatedAt, updatedAt])
  })

const localStamp = async (id: string): Promise<number> =>
  (await sharedDb.db.getOptional<{updated_at: number}>(
    'SELECT updated_at FROM blocks WHERE id = ?', [id],
  ))!.updated_at

/** `n` benign staged rows: `blocks` and `blocks_synced` agree at the same
 *  nonzero stamp, so every one of them is an echo the drain would discard.
 *  Generated in three statements rather than 3n round-trips. */
const seedBenignBacklog = async (n: number) => {
  const gen = `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${n})`
  await sharedDb.db.execute(
    `${gen} INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
       properties_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
     SELECT 'bulk' || i, ?, NULL, 'a0', 'v', '{}', 1, 1000 + i, 1000 + i, 'u', 'u', 0 FROM seq`, [WS])
  await sharedDb.db.execute(
    `${gen} INSERT INTO blocks_synced (id, workspace_id, parent_id, order_key, content,
       properties_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
     SELECT 'bulk' || i, ?, NULL, 'a0', 'v', '{}', 1, 1000 + i, 1000 + i, 'u', 'u', 0 FROM seq`, [WS])
  await sharedDb.db.execute(
    `${gen} INSERT INTO blocks_synced_changes (id, op) SELECT 'bulk' || i, 'upsert' FROM seq`)
}

describe('agreement with the drain (invariant I1)', () => {
  // The SQL restates a rule `decideStagingRow` owns. This is the coupling: if
  // I1 moves and the SQL does not, the gate starts reporting "nothing to do"
  // while the drain is about to rewrite `blocks` — the stale-view write the
  // whole gate exists to prevent. The clauses with no `decideStagingRow`
  // input (a staged delete, a missing synced row) stay hand-written above.
  it.each([
    {local: 5, synced: 5},
    {local: 5, synced: 6},
    {local: 6, synced: 5},
    {local: 0, synced: 0},
  ])('matches skip-stale for local=$local synced=$synced', async ({local, synced}) => {
    const repo = makeRepo()
    await seedLocal('oracle', local)
    await deliver(syncedRow({id: 'oracle', updatedAt: synced}))

    const drainSkips = decideStagingRow('copy', synced, {
      localUpdatedAt: local, hasPendingUpload: false,
    }).kind === 'skip-stale'
    expect(await repo.syncViewGap() === null).toBe(drainSkips)
  })
})

describe('Repo.syncViewGap', () => {
  it('reports no gap when the only staged rows are this device\'s own echo', async () => {
    // THE case that decides whether a long uploading pass can finish: it
    // commits, its rows echo back, and they are staged for most of the run.
    const repo = makeRepo()
    await repo.tx(async tx => {
      await tx.create({workspaceId: WS, parentId: null, orderKey: 'a0', content: 'mine'})
    }, {scope: ChangeScope.BlockDefault})
    const [{id}] = await sharedDb.db.getAll<{id: string}>('SELECT id FROM blocks LIMIT 1')

    await deliver(syncedRow({id, content: 'mine', updatedAt: await localStamp(id)}))

    expect(await sharedDb.db.getAll('SELECT seq FROM blocks_synced_changes')).toHaveLength(1)
    expect(await repo.syncViewGap()).toBeNull()
  })

  it('reports a gap when a staged row carries a newer stamp than the local one', async () => {
    const repo = makeRepo()
    await repo.tx(async tx => {
      await tx.create({workspaceId: WS, parentId: null, orderKey: 'a0', content: 'mine'})
    }, {scope: ChangeScope.BlockDefault})
    const [{id}] = await sharedDb.db.getAll<{id: string}>('SELECT id FROM blocks LIMIT 1')

    await deliver(syncedRow({id, content: 'theirs', updatedAt: await localStamp(id) + 1}))

    expect(await repo.syncViewGap()).toMatch(/draining/)
  })

  it('reports a gap for a staged row this device has no local row for at all', async () => {
    const repo = makeRepo()
    await deliver(syncedRow({id: 'arrived', updatedAt: 5}))
    expect(await repo.syncViewGap()).toMatch(/draining/)
  })

  it('reports a gap when the local row is 0-stamped, which always yields (I2)', async () => {
    // A speculative deterministic-id mint. Equal stamps do NOT mean identical
    // content here, so the drain applies and the view really is incomplete.
    const repo = makeRepo()
    await seedLocal('minted', 0)
    await deliver(syncedRow({id: 'minted', updatedAt: 0}))
    expect(await repo.syncViewGap()).toMatch(/draining/)
  })

  it('reports no gap for a large all-echo backlog that stays within the scan bound', async () => {
    const repo = makeRepo()
    await seedBenignBacklog(2_000)
    expect(await repo.syncViewGap()).toBeNull()
  })

  it('reports a gap once the backlog outruns the scan bound, without scanning it', async () => {
    // The probe runs inside the backfill's write transaction and cannot
    // short-circuit on an all-echo queue, so it is bounded. Past the bound we
    // report rather than scan on: that much undrained material IS a real
    // materialization backlog, and yielding lets the drain catch up.
    //
    // 10k rows sounds slow and is not: 147-158ms measured solo, seeding
    // included, which keeps ~5x headroom under the 5000ms default even at the
    // ~6x p99.9 stretch a full gate run adds. No explicit budget, so a genuine
    // hang here still reports in 5s rather than 30.
    const repo = makeRepo()
    await seedBenignBacklog(10_001)
    expect(await repo.syncViewGap()).toMatch(/behind on materializing/)
  })

  it('reports a gap for a staged upsert with no synced row, which proves nothing', async () => {
    // Isolates the `s.id IS NULL` clause: the local row exists and is NOT
    // 0-stamped, so every sibling clause is quiet and only this one can fire.
    // Unprovable is treated as a gap on purpose — over-reporting is the safe
    // direction for a predicate whose callers refuse on it.
    const repo = makeRepo()
    await seedLocal('half-staged', 7)
    await sharedDb.db.execute(
      "INSERT INTO blocks_synced_changes (id, op) VALUES ('half-staged', 'upsert')",
    )
    expect(await repo.syncViewGap()).toMatch(/draining/)
  })

  it('reports a gap for a staged delete whose row still matches stamp-for-stamp', async () => {
    // Isolates the `c.op = 'delete'` clause: synced row present, local row
    // present, stamps equal — I1 would call this identical content and skip.
    // A delete is not a content change, so the stamp cannot speak for it.
    const repo = makeRepo()
    await deliver(syncedRow({id: 'doomed', updatedAt: 9}))
    await seedLocal('doomed', 9)
    await sharedDb.db.execute('DELETE FROM blocks_synced_changes')
    await sharedDb.db.execute(
      "INSERT INTO blocks_synced_changes (id, op) VALUES ('doomed', 'delete')",
    )
    expect(await repo.syncViewGap()).toMatch(/draining/)
  })

})

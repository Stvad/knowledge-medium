// @vitest-environment node
/**
 * `Repo.rematerializeWorkspace()` — the operator remedy for the durable arm of
 * {@link Repo.workspaceViewGap} (km-boj1).
 *
 * The gap those rows sit in is stable by construction: they reached the drain,
 * were not applied, and had their queue entry consumed, so nothing re-delivers
 * them and every one-way pass on the workspace refuses for as long as they are
 * there. This file drives the whole loop through the Repo surface — refusal,
 * remedy, refusal gone — because the parts are individually correct today and
 * it is their being unreachable from outside that was the bug.
 *
 * What the pass DOES to a row is `syncObserver/observer.test.ts`'s; what the
 * predicate counts is `syncViewGap.test.ts`'s. This one owns the seam.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams } from '@/data/blockSchema'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import type { BlockData } from '@/data/api'
import type { Materializability } from '@/sync/transform'
import { WORKSPACE_UNAPPLIED_COUNT_CAP } from '@/data/internals/syncObserver/reconcile'

const WS = 'ws1'

const syncedRow = (o: Partial<BlockData> = {}): BlockData => ({
  id: 'b1', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'v1',
  properties: {}, references: [], createdAt: 500, updatedAt: 900, userUpdatedAt: 900,
  createdBy: 'u', updatedBy: 'u', deleted: false, ...o,
})

let sharedDb: TestDb
const repos: Repo[] = []
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })
// The observer holds a live `db.onChange` subscription on the SHARED db, so a
// per-test Repo that starts one must dispose it (createTestRepo's module doc).
afterEach(() => { for (const repo of repos.splice(0)) repo.stopSyncObserver() })

const makeRepo = (materializability: Materializability = 'copy'): Repo => {
  const {repo} = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    startSyncObserver: true,
    syncObserverDeps: {
      getMaterializability: () => materializability,
      getCek: async () => null,
    },
  })
  repo.setActiveWorkspaceId(WS)
  repos.push(repo)
  return repo
}

const stage = (d: BlockData) =>
  sharedDb.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams(d))

/** The measured production shape, built the way it actually arises: `blocks`
 *  holds the row at the stamp-0 speculative-mint sentinel, the server's version
 *  is staged at a real stamp with byte-identical content, and the queue entry a
 *  drain would have judged it on is gone.
 *
 *  Built BEFORE the observer starts, in every test here. Staging a row under a
 *  running observer arms a throttled drain, and this fixture's next statement
 *  deletes the queue entry that drain is racing to consume — the winner decides
 *  whether the row is stranded or applied. */
const strandStampZeroMint = async (id: string) => {
  await sharedDb.db.execute(
    `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
       created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
     VALUES (?, ?, NULL, 'a0', 'v1', '{}', 0, 0, 0, 'u', 'u', 0)`, [id, WS])
  await stage(syncedRow({id}))
  await sharedDb.db.execute('DELETE FROM blocks_synced_changes')
}

/** `n` stranded rows in three statements rather than 3n round-trips — the
 *  same shape as {@link strandStampZeroMint}, at a size that crosses the
 *  refusal's count cap. */
const strandManyStampZeroMints = async (n: number) => {
  const gen = `WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${n})`
  await sharedDb.db.execute(
    `${gen} INSERT INTO blocks (id, workspace_id, parent_id, order_key, content,
       properties_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
     SELECT 'bulk' || i, ?, NULL, 'a0', 'v1', '{}', 0, 0, 0, 'u', 'u', 0 FROM seq`, [WS])
  await sharedDb.db.execute(
    `${gen} INSERT INTO blocks_synced (id, workspace_id, parent_id, order_key, content,
       properties_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
     SELECT 'bulk' || i, ?, NULL, 'a0', 'v1', '{}', 500, 900, 900, 'u', 'u', 0 FROM seq`, [WS])
  await sharedDb.db.execute('DELETE FROM blocks_synced_changes')
}

describe('Repo.rematerializeWorkspace', () => {
  it('closes a durable gap that nothing else on the device can reach', async () => {
    await strandStampZeroMint('stuck')
    const repo = makeRepo()
    // Not waiting for a drain — a settle barrier changes nothing here, which is
    // the property that makes this gap durable rather than a slow one.
    await repo.flushSyncObserver()
    expect(await repo.workspaceViewGap(WS)).toEqual({
      reason: expect.stringMatching(/rematerialize-workspace/), transient: false,
    })

    expect(await repo.rematerializeWorkspace(WS)).toMatchObject({
      workspaceId: WS, scope: 'unapplied',
      unappliedBefore: 1, unappliedAfter: 0,
      scanned: 1, applied: 1, resolved: 1,
      remainingGap: null,
    })
    expect(await repo.workspaceViewGap(WS)).toBeNull()
  })

  it('hands back the remaining gap when the pass could not apply the rows', async () => {
    // Re-materializing is not a way to make a refusal go away — a workspace
    // that is not materializable defers again, and the operator is told so in
    // the same sentence the next pass would have refused with.
    await strandStampZeroMint('locked')
    const repo = makeRepo('defer')
    await repo.flushSyncObserver()

    expect(await repo.rematerializeWorkspace(WS)).toMatchObject({
      unappliedBefore: 1, unappliedAfter: 1,
      scanned: 1, applied: 0, deferred: 1, resolved: 0,
      remainingGap: {transient: false},
    })
  })

  it('refuses on a client with no observer rather than reporting nothing to do', async () => {
    // Without an observer there is no rematerialization path at all, and the
    // honest answer is not a clean report over zero work done.
    await strandStampZeroMint('stuck')
    const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
    repo.setActiveWorkspaceId(WS)

    await expect(repo.rematerializeWorkspace(WS)).rejects.toThrow(/no sync observer/)
    expect((await repo.workspaceViewGap(WS))?.transient).toBe(false)
  })

  it('sizes the gap exactly, not clamped to the refusal\'s cap', async () => {
    // The refusal's count stops at WORKSPACE_UNAPPLIED_COUNT_CAP because it
    // spends the number on one sentence, where "some" and "all of them" are the
    // only distinction that pays. A before/after pair is a SUBTRACTION, and the
    // same cap there answers the one question the pair exists for wrongly: two
    // ends both past the cap read as a delta of zero however many flags moved,
    // and a clamped `before` reads as SMALLER than this pass's own uncapped
    // `resolved` — a state that cannot exist.
    const n = WORKSPACE_UNAPPLIED_COUNT_CAP + 5
    await strandManyStampZeroMints(n)
    const repo = makeRepo()

    const result = await repo.rematerializeWorkspace(WS)
    expect(result.unappliedBefore).toBe(n)
    expect(result.unappliedAfter).toBe(0)
    expect(result.resolved).toBe(n)
  }, 20_000)   // ~2k bulk-inserted rows through a real drain; measured ~1.5s solo

  it('sizes the REMAINING gap exactly too', async () => {
    // The `after` end needs its own scale case: in the test above every row is
    // repaired, so `unappliedAfter` is 0 under a capped read and an exact one
    // alike, and only `before` is pinned. Capped, a pass that repaired NOTHING
    // reports a phantom delta of 5 here (1005 -> 1000) — the same lie in the
    // same field, one end over.
    const n = WORKSPACE_UNAPPLIED_COUNT_CAP + 5
    await strandManyStampZeroMints(n)
    const repo = makeRepo('defer')

    const result = await repo.rematerializeWorkspace(WS)
    expect(result.unappliedBefore).toBe(n)
    expect(result.unappliedAfter).toBe(n)
    expect(result.resolved).toBe(0)
  }, 20_000)   // same fixture and cost as above

  it('re-judges every staged row under the wider scope', async () => {
    // The escape hatch for a flag that is itself wrong: `unapplied` trusts the
    // flag to name the work, `all` does not.
    await strandStampZeroMint('stuck')
    // Staged with its queue entry intact, so the observer's own drain applies
    // it — a row the flag has nothing to say about, which is the difference the
    // two scopes are being read for.
    await stage(syncedRow({id: 'also-staged'}))
    const repo = makeRepo()
    await repo.flushSyncObserver()

    expect(await repo.rematerializeWorkspace(WS, {scope: 'all'}))
      .toMatchObject({scope: 'all', scanned: 2, unappliedAfter: 0})
  })
})

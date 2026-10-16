// @vitest-environment node
/**
 * `Repo.syncDivergence()` — staged rows `blocks` does not hold, with nothing on
 * the device going to deliver them again.
 *
 * The drain lets go of a row by clearing its `needs_apply` flag and consuming
 * its queue entry. When that judgment was wrong — the old stamp-only skip
 * (#1163), or a skip for a pending upload whose echo never came (#1226) — the
 * row is stranded: no flag reports it, no queue entry re-drives it, and only an
 * `'all'` rescan re-judges it. This probe is the only reader that looks.
 *
 * What the drain does to a row is `syncObserver/materialize.test.ts`'s. This
 * file owns which rows the probe reports, and that its remedy clears them.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  BLOCK_STORAGE_COLUMNS,
  BLOCKS_SYNCED_RAW_TABLE,
  blockToSyncedRowParams,
} from '@/data/blockSchema'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import type { BlockData } from '@/data/api'
import type { Materializability } from '@/sync/transform'

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
afterEach(() => { for (const repo of repos.splice(0)) repo.stopSyncObserver() })

const makeRepo = (
  materializability: (workspaceId: string) => Materializability = () => 'copy',
  {startSyncObserver = false} = {},
): Repo => {
  const {repo} = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    startSyncObserver,
    syncObserverDeps: {getMaterializability: materializability, getCek: async () => null},
  })
  repo.setActiveWorkspaceId(WS)
  repos.push(repo)
  return repo
}

/** Through the statement PowerSync's sync-apply uses, so the row lands flagged
 *  and queued the way a real arrival does. */
const stage = (d: BlockData) =>
  sharedDb.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams(d))

/** A local `blocks` row holding exactly `d`'s synced columns. */
const seedLocalFrom = (d: BlockData) =>
  sharedDb.db.execute(
    `INSERT INTO blocks (${BLOCK_STORAGE_COLUMNS.map(column => column.name).join(', ')})
     VALUES (${BLOCK_STORAGE_COLUMNS.map(() => '?').join(', ')})`,
    blockToSyncedRowParams(d))

/** What the drain records once it has judged a row: flag clear, queue entry
 *  consumed. Done by hand so no drain runs — this file is about the reader. */
const letGo = async (id: string) => {
  await sharedDb.db.execute('UPDATE blocks_synced SET needs_apply = 0 WHERE id = ?', [id])
  await sharedDb.db.execute('DELETE FROM blocks_synced_changes WHERE id = ?', [id])
}

const queuePendingUpload = (id: string) =>
  sharedDb.db.execute(
    "INSERT INTO ps_crud (tx_id, data) VALUES (1, json_object('op','PATCH','type','blocks','id',?,'data',json_object()))",
    [id])

const strand = async (local: BlockData | null, staged: BlockData) => {
  if (local) await seedLocalFrom(local)
  await stage(staged)
  await letGo(staged.id)
}

const base = syncedRow()

describe('Repo.syncDivergence — what it reports', () => {
  it('reports nothing when blocks holds every staged row', async () => {
    // The echo of this device's own write, already judged: the steady state.
    await strand(base, base)
    expect(await makeRepo().syncDivergence()).toEqual([])
  })

  it.each([
    {kind: 'staged-newer', local: base, staged: {...base, updatedAt: 901, content: 'theirs'}},
    // #1163: a peer write that landed on this device's own stamp.
    {kind: 'same-stamp', local: base, staged: {...base, content: 'theirs'}},
    // #1162: the same, differing in a clear column.
    {kind: 'same-stamp', local: base, staged: {...base, userUpdatedAt: 899}},
    // Usually an acked local edit whose echo has not arrived; reported apart
    // because an `'all'` rescan would write the older staged row over it.
    {kind: 'local-newer', local: {...base, updatedAt: 901, content: 'mine'}, staged: base},
    {kind: 'missing', local: null, staged: base},
  ])('reports a $kind row', async ({kind, local, staged}) => {
    await strand(local, staged)
    expect(await makeRepo().syncDivergence()).toEqual([{
      workspaceId: WS,
      sealedColumnsCompared: true,
      unapplied: 0,
      stranded: {[kind]: {count: 1, example: 'b1'}},
    }])
  })

  it('counts each kind, names its smallest id as the example, and lists workspaces in id order', async () => {
    await strand(syncedRow({id: 'z'}), syncedRow({id: 'z', updatedAt: 901}))
    await strand(syncedRow({id: 'y'}), syncedRow({id: 'y', updatedAt: 901}))
    await strand(null, syncedRow({id: 'x'}))
    await strand(null, syncedRow({id: 'other', workspaceId: 'ws0'}))
    await stage(syncedRow({id: 'flagged', workspaceId: 'ws-a'}))
    await sharedDb.db.execute("DELETE FROM blocks_synced_changes WHERE id = 'flagged'")

    expect(await makeRepo().syncDivergence()).toEqual([
      {workspaceId: 'ws-a', sealedColumnsCompared: true, unapplied: 1, stranded: {}},
      {workspaceId: 'ws0', sealedColumnsCompared: true, unapplied: 0,
        stranded: {missing: {count: 1, example: 'other'}}},
      {workspaceId: WS, sealedColumnsCompared: true, unapplied: 0, stranded: {
        'staged-newer': {count: 2, example: 'y'},
        missing: {count: 1, example: 'x'},
      }},
    ])
  })

  it('compares sealed columns only in a workspace whose staged rows are plaintext', async () => {
    // Staged e2ee rows hold ciphertext where `blocks` holds plaintext, so a
    // sealed column always differs there and says nothing.
    await strand(syncedRow({id: 'p', workspaceId: 'plain'}),
      syncedRow({id: 'p', workspaceId: 'plain', content: 'theirs'}))
    await strand(syncedRow({id: 's', workspaceId: 'sealed'}),
      syncedRow({id: 's', workspaceId: 'sealed', content: 'enc:ciphertext'}))
    await strand(syncedRow({id: 'l', workspaceId: 'locked'}),
      syncedRow({id: 'l', workspaceId: 'locked', content: 'enc:ciphertext'}))
    const repo = makeRepo(ws => ({plain: 'copy', sealed: 'decrypt', locked: 'defer'} as const)[ws]!)

    expect(await repo.syncDivergence()).toEqual([{
      workspaceId: 'plain', sealedColumnsCompared: true, unapplied: 0,
      stranded: {'same-stamp': {count: 1, example: 'p'}},
    }])
  })

  it('still compares the clear columns of a workspace it cannot read sealed', async () => {
    await strand(base, {...base, content: 'enc:ciphertext', updatedAt: 901})
    expect(await makeRepo(() => 'decrypt').syncDivergence()).toEqual([{
      workspaceId: WS, sealedColumnsCompared: false, unapplied: 0,
      stranded: {'staged-newer': {count: 1, example: 'b1'}},
    }])
  })

  it('reports flagged rows as unapplied, not stranded', async () => {
    // The durable gap `workspaceViewGap` already refuses on — counted beside
    // the stranded rows, so one report says which rescan scope reaches both.
    await seedLocalFrom(base)
    await stage({...base, updatedAt: 901})
    await sharedDb.db.execute('DELETE FROM blocks_synced_changes')

    expect(await makeRepo().syncDivergence()).toEqual([{
      workspaceId: WS, sealedColumnsCompared: true, unapplied: 1, stranded: {},
    }])
  })
})

describe('Repo.syncDivergence — what it leaves alone', () => {
  // Each case first shows the row is NOT reported, then removes the one thing
  // that excuses it and shows it IS — so the exclusion, and not some other
  // clause, is what kept it out.
  const differing = {...base, updatedAt: 901, content: 'theirs'}

  it('a row still queued for the drain', async () => {
    await seedLocalFrom(base)
    await stage(differing)
    await sharedDb.db.execute('UPDATE blocks_synced SET needs_apply = 0')
    const repo = makeRepo()
    expect(await repo.syncDivergence()).toEqual([])

    await sharedDb.db.execute('DELETE FROM blocks_synced_changes')
    expect(await repo.syncDivergence()).toHaveLength(1)
  })

  it('a row with a local edit waiting to upload', async () => {
    await strand(base, differing)
    await queuePendingUpload('b1')
    // A blocks envelope with no `id` must not blank the whole answer: `NOT IN`
    // over a set holding NULL is never true.
    await sharedDb.db.execute(
      "INSERT INTO ps_crud (tx_id, data) VALUES (2, json_object('op','PUT','type','blocks'))")
    const repo = makeRepo()
    expect(await repo.syncDivergence()).toEqual([])

    await sharedDb.db.execute("DELETE FROM ps_crud WHERE json_extract(data, '$.id') = 'b1'")
    expect(await repo.syncDivergence()).toHaveLength(1)
  })

  it('a tombstone no reader can see on either side', async () => {
    await strand({...base, deleted: true}, {...differing, deleted: true})
    await strand(null, {...differing, id: 'gone', deleted: true})
    const repo = makeRepo()
    expect(await repo.syncDivergence()).toEqual([])

    await sharedDb.db.execute("UPDATE blocks SET deleted = 0 WHERE id = 'b1'")
    expect(await repo.syncDivergence()).toHaveLength(1)
  })

  it('a difference only in the local-only columns `blocks_synced` does not carry', async () => {
    await strand(base, base)
    await sharedDb.db.execute("UPDATE blocks SET reference_target_id = 'x' WHERE id = 'b1'")
    expect(await makeRepo().syncDivergence()).toEqual([])
  })
})

describe('Repo.syncDivergence — against the drain', () => {
  it('finds a row the drain let go of for an upload whose echo never came, and an all-rescan heals it', async () => {
    // The #1226 shape, built by the drain itself: a peer's newer row arrives
    // while a local edit is queued, the drain skips it for the pending upload
    // (clearing the flag and consuming the queue entry), and the upload then
    // leaves the queue with no echo to re-deliver anything.
    await seedLocalFrom(base)
    await queuePendingUpload('b1')
    await stage({...base, updatedAt: 901, content: 'theirs'})
    const repo = makeRepo(() => 'copy', {startSyncObserver: true})
    await repo.flushSyncObserver()
    await sharedDb.db.execute('DELETE FROM ps_crud')

    const flag = await sharedDb.db.get<{needs_apply: number}>(
      "SELECT needs_apply FROM blocks_synced WHERE id = 'b1'")
    expect(flag.needs_apply).toBe(0)
    expect(await repo.workspaceViewGap(WS)).toBeNull()
    expect(await repo.syncDivergence()).toEqual([{
      workspaceId: WS, sealedColumnsCompared: true, unapplied: 0,
      stranded: {'staged-newer': {count: 1, example: 'b1'}},
    }])

    expect(await repo.rematerializeWorkspace(WS, {scope: 'all'})).toMatchObject({applied: 1})
    expect(await repo.syncDivergence()).toEqual([])
  })
})

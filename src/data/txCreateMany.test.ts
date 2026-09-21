// @vitest-environment node
/**
 * `tx.createMany` — the batched door onto the same insert `tx.create` makes.
 *
 * The point of the method is what it does NOT repeat (one parent lookup per
 * distinct parent, one INSERT per chunk), so the tests here are about the
 * guarantees that must survive the batching: the two parent refusals, a parent
 * minted inside the same call, and the per-row `record` the same-tx processors
 * and the snapshot cache read.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'

const WS = 'ws-bulk'
const OTHER_WS = 'ws-other'

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
})

const seedRoot = async (id: string, workspaceId = WS): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({id, workspaceId, parentId: null, orderKey: 'a0', content: id})
  }, {scope: ChangeScope.BlockDefault})
}

const rowsOf = (parentId: string) =>
  sharedDb.db.getAll<{id: string; parent_id: string; content: string}>(
    'SELECT id, parent_id, content FROM blocks WHERE parent_id = ? ORDER BY id', [parentId],
  )

describe('tx.createMany', () => {
  it('inserts every row under an existing parent', async () => {
    await seedRoot('root')
    const ids = await repo.tx(tx => tx.createMany(
      [0, 1, 2].map(i => ({
        id: `c${i}`, workspaceId: WS, parentId: 'root', orderKey: `a${i}`, content: `child ${i}`,
      })),
    ), {scope: ChangeScope.BlockDefault})

    expect(ids).toEqual(['c0', 'c1', 'c2'])
    expect((await rowsOf('root')).map(r => r.content)).toEqual(['child 0', 'child 1', 'child 2'])
  })

  it('accepts a parent minted earlier in the SAME call', async () => {
    await seedRoot('root')
    await repo.tx(tx => tx.createMany([
      {id: 'mid', workspaceId: WS, parentId: 'root', orderKey: 'a0', content: 'mid'},
      {id: 'leaf', workspaceId: WS, parentId: 'mid', orderKey: 'a0', content: 'leaf'},
    ]), {scope: ChangeScope.BlockDefault})

    expect((await rowsOf('mid')).map(r => r.id)).toEqual(['leaf'])
  })

  it('refuses a parent that does not exist, writing nothing', async () => {
    await seedRoot('root')
    await expect(repo.tx(tx => tx.createMany([
      {id: 'ok', workspaceId: WS, parentId: 'root', orderKey: 'a0', content: 'ok'},
      {id: 'orphan', workspaceId: WS, parentId: 'nobody', orderKey: 'a0', content: 'orphan'},
    ]), {scope: ChangeScope.BlockDefault})).rejects.toThrow(/nobody/)

    expect(await rowsOf('root')).toEqual([])
  })

  it('refuses a parent in another workspace', async () => {
    await seedRoot('root')
    await seedRoot('foreign', OTHER_WS)
    await expect(repo.tx(tx => tx.createMany([
      {id: 'x', workspaceId: WS, parentId: 'foreign', orderKey: 'a0', content: 'x'},
    ]), {scope: ChangeScope.BlockDefault})).rejects.toThrow(/foreign/)
  })

  it('a forward reference to a parent later in the same call is refused', async () => {
    await seedRoot('root')
    // `leaf` names `mid`, which this call has not built yet at that point.
    await expect(repo.tx(tx => tx.createMany([
      {id: 'leaf', workspaceId: WS, parentId: 'mid', orderKey: 'a0', content: 'leaf'},
      {id: 'mid', workspaceId: WS, parentId: 'root', orderKey: 'a0', content: 'mid'},
    ]), {scope: ChangeScope.BlockDefault})).rejects.toThrow(/mid/)
  })

  it('names the colliding id rather than the chunk', async () => {
    await seedRoot('root')
    await repo.tx(tx => tx.create(
      {id: 'taken', workspaceId: WS, parentId: 'root', orderKey: 'a0', content: 'first'},
    ), {scope: ChangeScope.BlockDefault})

    await expect(repo.tx(tx => tx.createMany([
      {id: 'fresh', workspaceId: WS, parentId: 'root', orderKey: 'a1', content: 'fresh'},
      {id: 'taken', workspaceId: WS, parentId: 'root', orderKey: 'a2', content: 'again'},
    ]), {scope: ChangeScope.BlockDefault})).rejects.toThrow(/taken/)
  })

  it('records each row, so a same-tx read sees it like a per-row create', async () => {
    await seedRoot('root')
    const peeked = await repo.tx(async tx => {
      await tx.createMany([
        {id: 'p1', workspaceId: WS, parentId: 'root', orderKey: 'a0', content: 'one'},
        {id: 'p2', workspaceId: WS, parentId: 'root', orderKey: 'a1', content: 'two'},
      ])
      return [tx.peek('p1')?.content, tx.peek('p2')?.content]
    }, {scope: ChangeScope.BlockDefault})

    expect(peeked).toEqual(['one', 'two'])
  })

  it('refuses a batch spanning two workspaces, even on an unpinned transaction', async () => {
    // Pins the BEHAVIOUR, not the layer: `createMany`'s own check refuses at the
    // first row that disagrees, and with that check removed
    // `core.deriveReferenceTarget` refuses the same batch a moment later. This
    // passes either way by design — it is here so that a future edit which
    // removes BOTH is noticed.
    await seedRoot('root')
    await seedRoot('foreign', OTHER_WS)
    await expect(repo.tx(tx => tx.createMany([
      {id: 'here', workspaceId: WS, parentId: 'root', orderKey: 'a0', content: 'here'},
      {id: 'there', workspaceId: OTHER_WS, parentId: 'foreign', orderKey: 'a0', content: 'there'},
    ]), {scope: ChangeScope.BlockDefault})).rejects.toThrow(/tx pinned to workspace/)

    expect(await rowsOf('root')).toEqual([])
    expect(await rowsOf('foreign')).toEqual([])
  })

  it('is a no-op for an empty list', async () => {
    await seedRoot('root')
    expect(await repo.tx(tx => tx.createMany([]), {scope: ChangeScope.BlockDefault})).toEqual([])
  })
})

describe('tx.createMany pins only once it has written', () => {
  it('leaves the transaction unpinned when the batch is refused', async () => {
    // A refused batch writes nothing, so it must not decide the transaction's
    // workspace on the way out: a caller that catches the refusal would find a
    // later, valid write to another workspace rejected, and `afterCommit`
    // admitted for a transaction that never wrote.
    await seedRoot('root')
    await seedRoot('foreign', OTHER_WS)
    const pinnedAfterRefusal = await repo.tx(async tx => {
      await expect(tx.createMany([
        {id: 'never', workspaceId: WS, parentId: 'nobody', orderKey: 'a0', content: 'never'},
      ])).rejects.toThrow(/nobody/)
      return tx.meta.workspaceId
    }, {scope: ChangeScope.BlockDefault})

    expect(pinnedAfterRefusal).toBeNull()
  })

  it('pins to the batch it did write', async () => {
    await seedRoot('root')
    const pinned = await repo.tx(async tx => {
      await tx.createMany([
        {id: 'w1', workspaceId: WS, parentId: 'root', orderKey: 'a0', content: 'w1'},
      ])
      return tx.meta.workspaceId
    }, {scope: ChangeScope.BlockDefault})

    expect(pinned).toBe(WS)
  })
})

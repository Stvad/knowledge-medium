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
import { BULK_INSERT_ROWS_PER_STATEMENT } from '@/data/internals/txEngine'

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

  it('leaves it unpinned when the INSERT itself is refused, not just the preflight', async () => {
    // The preflight refusal above is caught before any statement runs, so it
    // passes however the pin is ordered. This one is refused by the insert
    // TRIGGER — the only case that can tell "pin after the statement that
    // wrote" from "pin on the way into the loop", which is a guard in the
    // right slot versus the wrong one.
    await seedRoot('doomed')
    await repo.tx(async tx => { await tx.delete('doomed') }, {scope: ChangeScope.BlockDefault})

    const pinnedAfterInsertRefusal = await repo.tx(async tx => {
      await expect(tx.createMany([
        {id: 'orphan', workspaceId: WS, parentId: 'doomed', orderKey: 'a0', content: 'orphan'},
      ])).rejects.toThrow()
      return tx.meta.workspaceId
    }, {scope: ChangeScope.BlockDefault})

    expect(pinnedAfterInsertRefusal).toBeNull()
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

describe('tx.createMany writes nothing on a refusal the caller swallows', () => {
  it('a duplicate anywhere in the batch leaves the earlier rows unwritten', async () => {
    // The batch is refused before any statement runs, so a caller that catches
    // the error and lets the transaction commit finds none of it. Learning
    // which id collided by re-inserting the chunk a row at a time instead put
    // every row before the duplicate into `blocks` on the way to the error —
    // and those rows never reached `record`, so they committed invisible to
    // the same-tx processors, the snapshot cache, undo and invalidation.
    await seedRoot('root')
    await repo.tx(tx => tx.create(
      {id: 'taken', workspaceId: WS, parentId: 'root', orderKey: 'a0', content: 'first'},
    ), {scope: ChangeScope.BlockDefault})

    await repo.tx(async tx => {
      await expect(tx.createMany([
        {id: 'before', workspaceId: WS, parentId: 'root', orderKey: 'a1', content: 'before'},
        {id: 'taken', workspaceId: WS, parentId: 'root', orderKey: 'a2', content: 'again'},
        {id: 'after', workspaceId: WS, parentId: 'root', orderKey: 'a3', content: 'after'},
      ])).rejects.toThrow(/taken/)
      // Swallowed on purpose: the transaction commits, and the question is
      // what it commits.
    }, {scope: ChangeScope.BlockDefault})

    expect((await rowsOf('root')).map(r => r.id)).toEqual(['taken'])
  })
})

describe('tx.createMany refuses a duplicate inside the batch itself', () => {
  it('names the repeated id, and writes nothing', async () => {
    // The existing-rows lookup cannot see this one: both rows are new, and the
    // collision is between them. Left to the INSERT it surfaces as a raw
    // constraint error rather than DuplicateIdError — and from a later chunk,
    // after earlier chunks have already been written.
    await seedRoot('root')
    await repo.tx(async tx => {
      await expect(tx.createMany([
        {id: 'twice', workspaceId: WS, parentId: 'root', orderKey: 'a0', content: 'one'},
        {id: 'twice', workspaceId: WS, parentId: 'root', orderKey: 'a1', content: 'two'},
      ])).rejects.toThrow(/twice/)
    }, {scope: ChangeScope.BlockDefault})

    expect(await rowsOf('root')).toEqual([])
  })
})

describe('tx.createMany across more than one INSERT statement', () => {
  // Derived from the constant, never a literal: the only production caller
  // batches on a row budget BELOW it, so a fixture sized by hand stops
  // crossing the boundary the moment either number moves — and everything
  // this describe covers happens only on the second chunk.
  const OVER_ONE_CHUNK = BULK_INSERT_ROWS_PER_STATEMENT + 5

  const rows = (n: number, parentId: string) =>
    Array.from({length: n}, (_, i) => ({
      id: `bulk-${String(i).padStart(4, '0')}`,
      workspaceId: WS, parentId, orderKey: `k${String(i).padStart(4, '0')}`, content: `row ${i}`,
    }))

  it('writes and records every row when the batch spans chunks', async () => {
    await seedRoot('root')
    const seen: (string | undefined)[] = []
    await repo.tx(async tx => {
      const ids = await tx.createMany(rows(OVER_ONE_CHUNK, 'root'))
      expect(ids).toHaveLength(OVER_ONE_CHUNK)
      // A row from the FIRST chunk and one from the last, read back inside the
      // same tx — this is the `record` the same-tx processors and the snapshot
      // cache see, and it is done per chunk rather than once at the end.
      seen.push((await tx.get(ids[0]!))?.content)
      seen.push((await tx.get(ids[OVER_ONE_CHUNK - 1]!))?.content)
    }, {scope: ChangeScope.BlockDefault})

    expect(seen).toEqual(['row 0', `row ${OVER_ONE_CHUNK - 1}`])
    expect(await rowsOf('root')).toHaveLength(OVER_ONE_CHUNK)
  })

  it('resolves a parent minted in an EARLIER chunk', async () => {
    // Distinct from the same-call forward-reference test above: that one
    // proves a parent is visible to a row in the SAME multi-row VALUES, which
    // the BEFORE-INSERT trigger handles. This one needs the previous
    // STATEMENT to have landed, which is a different mechanism.
    await seedRoot('root')
    const childOfFirst = {
      id: 'late-child', workspaceId: WS, parentId: 'bulk-0000',
      orderKey: 'zz', content: 'child of a row in chunk 1',
    }
    await repo.tx(async tx => {
      await tx.createMany([...rows(OVER_ONE_CHUNK, 'root'), childOfFirst])
    }, {scope: ChangeScope.BlockDefault})

    expect(await rowsOf('bulk-0000')).toEqual([
      expect.objectContaining({id: 'late-child', parent_id: 'bulk-0000'}),
    ])
  })

  it('records the earlier chunks even when a later one throws and the caller swallows it', async () => {
    // THE reason `record` is per chunk rather than once at the end. A
    // tombstoned parent is refused by the insert TRIGGER, which aborts that
    // STATEMENT only — so the chunks before it are still in the transaction.
    // If the caller catches and lets the tx commit, those rows land; unless
    // they were recorded, they land with no same-tx processor and no snapshot
    // having seen them.
    //
    // Asserted through `peek`, not `get`: `get` reads the transaction's DB and
    // would see the row whether or not it was recorded, which is what makes
    // this the only assertion that can tell the two orderings apart.
    await seedRoot('root')
    await seedRoot('doomed')
    await repo.tx(async tx => { await tx.delete('doomed') }, {scope: ChangeScope.BlockDefault})

    let peeked: string | null = null
    await repo.tx(async tx => {
      try {
        await tx.createMany([
          ...rows(OVER_ONE_CHUNK, 'root'),
          {id: 'orphan', workspaceId: WS, parentId: 'doomed',
           orderKey: 'zz', content: 'under a tombstone'},
        ])
      } catch { /* swallowed on purpose — the tx goes on to commit */ }
      peeked = tx.peek('bulk-0000')?.content ?? null
    }, {scope: ChangeScope.BlockDefault})

    expect(peeked).toBe('row 0')
    expect(await rowsOf('root')).toHaveLength(BULK_INSERT_ROWS_PER_STATEMENT)
    expect(await rowsOf('doomed')).toHaveLength(0)
  })
})

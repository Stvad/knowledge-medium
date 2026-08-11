// @vitest-environment node
/**
 * Core `moveBlocksTo` behavior: sequential `core.move` calls under one
 * `repo.undoGroup`, descendant pruning (defence in depth — see the
 * module doc on `moveBlocksTo`), and the cycle backstop for a
 * destination inside the movers' own subtree.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CycleError, ChangeScope } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { moveBlocksTo, PartialMoveError } from './moveBlocks.ts'

const WS = 'ws-1'

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({ db: sharedDb.db, user: { id: 'user-1' } }).repo
  repo.setActiveWorkspaceId(WS)
})

/** Seed a block directly (ungrouped tx) so seeding never lands in the
 *  undo stack the tests assert against. */
const seed = async (
  id: string,
  parentId: string | null,
  orderKey: string,
  content = id,
): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({ id, workspaceId: WS, parentId, orderKey, content })
  }, { scope: ChangeScope.BlockDefault, description: `seed ${id}` })
}

const childIds = async (parentId: string): Promise<string[]> => {
  const rows = await repo.db.getAll<{ id: string }>(
    'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id',
    [parentId],
  )
  return rows.map(r => r.id)
}

const parentOf = async (id: string): Promise<string | null> => {
  const row = await repo.db.getOptional<{ parent_id: string | null }>(
    'SELECT parent_id FROM blocks WHERE id = ?',
    [id],
  )
  return row?.parent_id ?? null
}

const depths = () => repo.undoManager.depths(ChangeScope.BlockDefault)

describe('moveBlocksTo', () => {
  it('moves N blocks contiguously under the destination, preserving input order', async () => {
    await seed('dest', null, 'a0')
    await seed('src', null, 'b0')
    await seed('c1', 'src', 'a0')
    await seed('c2', 'src', 'a1')
    await seed('c3', 'src', 'a2')
    // A pre-existing child of dest, so "contiguous" is actually exercised
    // rather than trivially true of an empty destination.
    await seed('already-there', 'dest', 'a0')

    const result = await moveBlocksTo(repo, ['c2', 'c1', 'c3'], 'dest')

    expect(result).toEqual({ moved: 3 })
    expect(await childIds('dest')).toEqual(['already-there', 'c2', 'c1', 'c3'])
    expect(await childIds('src')).toEqual([])
  })

  it('prunes a descendant when both it and its ancestor are in the set', async () => {
    await seed('dest', null, 'a0')
    await seed('a', null, 'b0')
    await seed('b', 'a', 'a0') // child of a

    const result = await moveBlocksTo(repo, ['a', 'b'], 'dest')

    // Only 'a' actually moves; 'b' rides along as a's child, not as a
    // separate move.
    expect(result).toEqual({ moved: 1 })
    expect(await childIds('dest')).toEqual(['a'])
    expect(await parentOf('b')).toBe('a')
  })

  it('one undo entry reverts the whole batch', async () => {
    await seed('dest', null, 'a0')
    await seed('src', null, 'b0')
    await seed('c1', 'src', 'a0')
    await seed('c2', 'src', 'a1')
    repo.undoManager.clear()

    await moveBlocksTo(repo, ['c1', 'c2'], 'dest')

    expect(depths()).toEqual({ undo: 1, redo: 0 })
    expect(await childIds('dest')).toEqual(['c1', 'c2'])

    expect(await repo.undo()).toBe(true)
    expect(await childIds('src')).toEqual(['c1', 'c2'])
    expect(await childIds('dest')).toEqual([])
  })

  it('refuses to move a block into its own descendant', async () => {
    await seed('a', null, 'a0')
    await seed('b', 'a', 'a0')

    await expect(moveBlocksTo(repo, ['a'], 'b')).rejects.toThrow(CycleError)
    expect(await parentOf('a')).toBeNull()
    expect(await parentOf('b')).toBe('a')
  })

  it('refuses to move a block into itself', async () => {
    await seed('a', null, 'a0')

    await expect(moveBlocksTo(repo, ['a'], 'a')).rejects.toThrow(CycleError)
    expect(await parentOf('a')).toBeNull()
  })

  it('reports how many moved when the batch fails part-way, and one undo reverts them', async () => {
    // 'x' moves into 'd' fine; 'p' then can't, because 'd' is its own
    // descendant. So move 1 commits and move 2 throws.
    await seed('x', null, 'a0')
    await seed('p', null, 'b0')
    await seed('d', 'p', 'a0')
    repo.undoManager.clear()

    const error = await moveBlocksTo(repo, ['x', 'p'], 'd').then(
      () => { throw new Error('expected the batch to fail part-way') },
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(PartialMoveError)
    expect((error as PartialMoveError).moved).toBe(1)
    expect((error as PartialMoveError).cause).toBeInstanceOf(CycleError)

    // The prefix really did commit — this is the state the bare
    // "failed" message used to hide.
    expect(await parentOf('x')).toBe('d')
    expect(await parentOf('p')).toBeNull()

    // ...and the committed prefix is recoverable with a single cmd-Z,
    // which is what the error message promises.
    expect(depths()).toEqual({ undo: 1, redo: 0 })
    expect(await repo.undo()).toBe(true)
    expect(await parentOf('x')).toBeNull()
  })

  it('is a no-op for an empty selection', async () => {
    await seed('dest', null, 'a0')
    const result = await moveBlocksTo(repo, [], 'dest')
    expect(result).toEqual({ moved: 0 })
  })
})

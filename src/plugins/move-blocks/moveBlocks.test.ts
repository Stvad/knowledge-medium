// @vitest-environment node
/**
 * Core `moveBlocksTo` behavior: sequential `core.move` calls under one
 * `repo.undoGroup`, descendant pruning (defence in depth — see the
 * module doc on `moveBlocksTo`), and the cycle backstop for a
 * destination inside the movers' own subtree.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Delegates to the real helper; individual tests reject it once to drive
// the post-commit accounting failure.
const isWithinSubtreeOfAnyMock = vi.hoisted(() => vi.fn())
const realIsWithinSubtreeOfAny = vi.hoisted(() => ({} as { current?: unknown })) as never
vi.mock('./blockSubtreeMembership.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('./blockSubtreeMembership.ts')>()
  ;(realIsWithinSubtreeOfAny as never as {current: unknown}).current = actual.isWithinSubtreeOfAny
  isWithinSubtreeOfAnyMock.mockImplementation(actual.isWithinSubtreeOfAny)
  return { ...actual, isWithinSubtreeOfAny: isWithinSubtreeOfAnyMock }
})
import { CycleError, ChangeScope } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { keyBetween } from '@/data/orderKey'
import { isCollapsedProp } from '@/data/properties.js'
import { moveBlocksTo, PartialMoveError } from './moveBlocks.ts'

const WS = 'ws-1'

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  isWithinSubtreeOfAnyMock.mockReset()
  isWithinSubtreeOfAnyMock.mockImplementation(
    (realIsWithinSubtreeOfAny as never as {current: never}).current)
  lastKeyByParent.clear()
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({ db: sharedDb.db, user: { id: 'user-1' } }).repo
  repo.setActiveWorkspaceId(WS)
})

/** Seed a block directly (ungrouped tx) so seeding never lands in the
 *  undo stack the tests assert against. Order keys are GENERATED via
 *  `keyBetween` rather than hand-written: hand-written stand-ins like
 *  'a0' are rejected by the real base62 format on any path that
 *  validates them (moving to the workspace root enumerates and
 *  re-keys its siblings, and blew up on exactly that). */
const lastKeyByParent = new Map<string, string | null>()

const seed = async (
  id: string,
  parentId: string | null,
  content = id,
): Promise<void> => {
  const bucket = parentId ?? '\u0000root'
  const orderKey = keyBetween(lastKeyByParent.get(bucket) ?? null, null)
  lastKeyByParent.set(bucket, orderKey)
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

const INTO_DEST = {parentId: 'dest', position: {kind: 'last'}} as const

const depths = () => repo.undoManager.depths(ChangeScope.BlockDefault)

describe('moveBlocksTo', () => {
  it('reports a source the transaction skipped, so callers can unselect it', async () => {
    // The row was gone by the time its own transaction ran (tombstoned, or
    // not present locally). It moved nothing and carried nothing, so it is
    // in neither `movedIds` nor `accountedIds` — but a caller holding UI
    // state still has to drop it, or multi-select shortcuts stay pointed
    // at a row that isn't there.
    await seed('dest', null)
    await seed('a', null)
    await seed('gone', null)
    await repo.block('gone').delete()

    const result = await moveBlocksTo(repo, ['a', 'gone'], INTO_DEST)

    expect(result.movedIds).toEqual(['a'])
    expect(result.skippedIds).toEqual(['gone'])
  })

  it('still returns the committed move when post-commit accounting fails', async () => {
    // `accountFor` runs after every transaction has committed. Letting its
    // failure escape made the caller take its generic-error branch, so the
    // relocated blocks stayed in the live selection and later multi-select
    // shortcuts could act on them at their new home.
    //
    // 'kid' is pruned (it rides along inside 'a'), which is the only shape
    // that reaches the ancestry read — an id that moved on its own
    // short-circuits before it.
    await seed('dest', null)
    await seed('a', null)
    await seed('kid', 'a')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    isWithinSubtreeOfAnyMock.mockRejectedValueOnce(new Error('db blipped'))

    const result = await moveBlocksTo(repo, ['a', 'kid'], INTO_DEST)

    expect(result.moved).toBe(1)
    expect(result.movedIds).toEqual(['a'])
    // Degraded, not lost: 'kid' is omitted, which under-reports coverage
    // and so errs toward keeping a cut retryable.
    expect(result.accountedIds).toEqual(['a'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('moves N blocks contiguously under the destination, preserving input order', async () => {
    await seed('dest', null)
    await seed('src', null)
    await seed('c1', 'src')
    await seed('c2', 'src')
    await seed('c3', 'src')
    // A pre-existing child of dest, so "contiguous" is actually exercised
    // rather than trivially true of an empty destination.
    await seed('already-there', 'dest')

    const result = await moveBlocksTo(repo, ['c2', 'c1', 'c3'], INTO_DEST)

    expect(result).toEqual({ moved: 3, movedIds: ['c2', 'c1', 'c3'], accountedIds: ['c2', 'c1', 'c3'], skippedIds: [] })
    expect(await childIds('dest')).toEqual(['already-there', 'c2', 'c1', 'c3'])
    expect(await childIds('src')).toEqual([])
  })

  it('prunes a descendant when both it and its ancestor are in the set', async () => {
    await seed('dest', null)
    await seed('a', null)
    await seed('b', 'a') // child of a

    const result = await moveBlocksTo(repo, ['a', 'b'], INTO_DEST)

    // Only 'a' actually moves; 'b' rides along as a's child, not as a
    // separate move.
    // 'b' is accounted for: it rode along inside 'a'. A caller that
    // subtracted only `movedIds` would treat it as left behind.
    expect(result).toEqual({ moved: 1, movedIds: ['a'], accountedIds: ['a', 'b'], skippedIds: [] })
    expect(await childIds('dest')).toEqual(['a'])
    expect(await parentOf('b')).toBe('a')
  })

  it('one undo entry reverts the whole batch', async () => {
    await seed('dest', null)
    await seed('src', null)
    await seed('c1', 'src')
    await seed('c2', 'src')
    repo.undoManager.clear()

    await moveBlocksTo(repo, ['c1', 'c2'], INTO_DEST)

    expect(depths()).toEqual({ undo: 1, redo: 0 })
    expect(await childIds('dest')).toEqual(['c1', 'c2'])

    expect(await repo.undo()).toBe(true)
    expect(await childIds('src')).toEqual(['c1', 'c2'])
    expect(await childIds('dest')).toEqual([])
  })

  it('refuses to move a block into its own descendant', async () => {
    await seed('a', null)
    await seed('b', 'a')

    await expect(moveBlocksTo(repo, ['a'], {parentId: 'b', position: {kind: 'last'}})).rejects.toThrow(CycleError)
    expect(await parentOf('a')).toBeNull()
    expect(await parentOf('b')).toBe('a')
  })

  it('refuses to move a block into itself', async () => {
    await seed('a', null)

    await expect(moveBlocksTo(repo, ['a'], {parentId: 'a', position: {kind: 'last'}})).rejects.toThrow(CycleError)
    expect(await parentOf('a')).toBeNull()
  })

  it('reports how many moved when the batch fails part-way, and one undo reverts them', async () => {
    // 'x' moves into 'd' fine; 'p' then can't, because 'd' is its own
    // descendant. So move 1 commits and move 2 throws.
    await seed('x', null)
    await seed('p', null)
    await seed('d', 'p')
    repo.undoManager.clear()

    const error = await moveBlocksTo(repo, ['x', 'p'], {parentId: 'd', position: {kind: 'last'}}).then(
      () => { throw new Error('expected the batch to fail part-way') },
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(PartialMoveError)
    expect((error as PartialMoveError).moved).toBe(1)
    // The ids, not just the count — the action layer needs them to take
    // the relocated prefix out of the ui-state selection.
    expect((error as PartialMoveError).movedIds).toEqual(['x'])
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

  // The ordering rule (see the module doc). `last` / `before` survive a
  // naive same-position-every-iteration loop; `first` / `after` do not —
  // they stack up backwards. All four are pinned so nobody "simplifies"
  // the chaining away and only notices on two of them.
  describe('preserves input order for every position kind', () => {
    beforeEach(async () => {
      await seed('dest', null)
      await seed('x1', 'dest')
      await seed('x2', 'dest')
      await seed('src', null)
      await seed('a', 'src')
      await seed('b', 'src')
      await seed('c', 'src')
    })

    it('last', async () => {
      await moveBlocksTo(repo, ['a', 'b', 'c'], {parentId: 'dest', position: {kind: 'last'}})
      expect(await childIds('dest')).toEqual(['x1', 'x2', 'a', 'b', 'c'])
    })

    it('first', async () => {
      await moveBlocksTo(repo, ['a', 'b', 'c'], {parentId: 'dest', position: {kind: 'first'}})
      expect(await childIds('dest')).toEqual(['a', 'b', 'c', 'x1', 'x2'])
    })

    it('before an anchor', async () => {
      await moveBlocksTo(repo, ['a', 'b', 'c'], {
        parentId: 'dest', position: {kind: 'before', siblingId: 'x2'},
      })
      expect(await childIds('dest')).toEqual(['x1', 'a', 'b', 'c', 'x2'])
    })

    it('after an anchor', async () => {
      await moveBlocksTo(repo, ['a', 'b', 'c'], {
        parentId: 'dest', position: {kind: 'after', siblingId: 'x1'},
      })
      expect(await childIds('dest')).toEqual(['x1', 'a', 'b', 'c', 'x2'])
    })
  })

  it('moves to the workspace root when parentId is null', async () => {
    await seed('src', null)
    await seed('a', 'src')

    await moveBlocksTo(repo, ['a'], {parentId: null, position: {kind: 'last'}})

    expect(await parentOf('a')).toBeNull()
  })

  // A user-initiated move into a folded destination would otherwise
  // report "Moved 1 block" while the row vanished from the source and
  // stayed hidden at the target — indistinguishable from data loss.
  // `core.move` deliberately doesn't reveal (it's the programmatic
  // primitive); this helper does, like `core.indent` already does.
  it('expands a collapsed destination so the moved blocks are visible', async () => {
    await seed('dest', null)
    await seed('src', null)
    await seed('a', 'src')
    await repo.block('dest').set(isCollapsedProp, true)
    expect(repo.block('dest').peekProperty(isCollapsedProp)).toBe(true)
    repo.undoManager.clear()

    await moveBlocksTo(repo, ['a'], INTO_DEST)

    await repo.block('dest').load()
    expect(repo.block('dest').peekProperty(isCollapsedProp)).toBe(false)
    expect(await childIds('dest')).toEqual(['a'])
    // The reveal joins the move's undo entry rather than adding its own.
    expect(depths()).toEqual({ undo: 1, redo: 0 })
  })

  // The reveal sits after the FIRST move, not after the loop: each move
  // commits its own tx, so an end-of-loop reveal is skipped by a
  // mid-batch failure and the blocks that DID land stay hidden — while
  // the error says "Moved 1 block".
  it('reveals a collapsed destination even when the batch fails part-way', async () => {
    // Destination 'd' is collapsed AND lives inside 'p'. Moving [x, p]
    // into it commits x, then throws CycleError on p — so the reveal has
    // to have happened before that failure, or x sits in 'd' invisibly
    // while the error claims a block moved.
    await seed('x', null)
    await seed('p', null)
    await seed('d', 'p')
    await repo.block('d').set(isCollapsedProp, true)

    await expect(
      moveBlocksTo(repo, ['x', 'p'], {parentId: 'd', position: {kind: 'last'}}),
    ).rejects.toThrow(PartialMoveError)

    await repo.block('d').load()
    expect(repo.block('d').peekProperty(isCollapsedProp)).toBe(false)
    expect(await childIds('d')).toEqual(['x'])
  })

  // The `load()` inside `revealDestination` is load-bearing and the test
  // above does NOT pin it: writing the collapse through `block().set()`
  // populates the facade cache, so `peekProperty` answers correctly even
  // with the load removed. Evicting the snapshot reproduces the real
  // path — a destination this session never rendered, which is exactly
  // what the picker's search hands back — where a cold `peek()` reports
  // `undefined` for a genuinely collapsed row and silently skips the
  // reveal. Without this test the line can be deleted with a green suite.
  it('reveals a collapsed destination that is not in the block cache', async () => {
    await seed('dest', null)
    await seed('src', null)
    await seed('a', 'src')
    await repo.block('dest').set(isCollapsedProp, true)
    repo.cache.deleteSnapshot('dest')
    expect(repo.block('dest').peek()).toBeUndefined() // precondition, proven

    await moveBlocksTo(repo, ['a'], INTO_DEST)

    await repo.block('dest').load()
    expect(repo.block('dest').peekProperty(isCollapsedProp)).toBe(false)
  })

  it('leaves an already-expanded destination untouched', async () => {
    await seed('dest', null)
    await seed('src', null)
    await seed('a', 'src')
    repo.undoManager.clear()

    await moveBlocksTo(repo, ['a'], INTO_DEST)

    expect(depths()).toEqual({ undo: 1, redo: 0 })
  })

  it('is a no-op for an empty selection', async () => {
    await seed('dest', null)
    const result = await moveBlocksTo(repo, [], INTO_DEST)
    expect(result).toEqual({ moved: 0, movedIds: [], accountedIds: [], skippedIds: [] })
  })

  it('skips a tombstoned block and does not count it as moved', async () => {
    // `core.move` deliberately permits relocating a tombstone
    // (materialization and undo replay need that), so a caller that
    // pre-filtered with a separate query would count a block deleted since
    // as moved — and report success for a batch that visibly did nothing.
    // The check therefore lives in the transaction that relocates.
    await seed('dest', null)
    await seed('live', null)
    await seed('dead', null)
    await repo.block('dead').delete()

    const result = await moveBlocksTo(repo, ['dead', 'live'], {
      parentId: 'dest', position: {kind: 'last'},
    })

    expect(result.moved).toBe(1)
    expect(result.movedIds).toEqual(['live'])
    expect(await childIds('dest')).toEqual(['live'])
  })

  it('reports nothing moved when every block is a tombstone', async () => {
    await seed('dest', null)
    await seed('dead', null)
    await repo.block('dead').delete()

    const result = await moveBlocksTo(repo, ['dead'], {
      parentId: 'dest', position: {kind: 'last'},
    })

    expect(result.moved).toBe(0)
    expect(result.movedIds).toEqual([])
  })
})

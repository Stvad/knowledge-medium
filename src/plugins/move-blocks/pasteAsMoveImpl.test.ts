// @vitest-environment node
/**
 * The register-validity matrix for `pasteAsMoveImpl` — the move-blocks
 * plugin's fill for core's `pasteAsMoveVerb` seam (`@/paste/moveOnPasteVerb.js`).
 * Calls the plain async function directly (no facet runtime needed — it's
 * not a hook, just `(input) => boolean`); the seam's own wiring
 * (`tryPasteAsMove` → `pasteAsMoveVerb.run` → this impl) is covered by the
 * `defaultShortcuts.test.ts` action-level tests, which also prove the
 * CALLER's text-paste fallback actually runs for each invalid case.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const showErrorMock = vi.hoisted(() => vi.fn())
const showInfoMock = vi.hoisted(() => vi.fn())
const showSuccessMock = vi.hoisted(() => vi.fn())
vi.mock('@/utils/toast.js', () => ({
  showError: showErrorMock,
  showInfo: showInfoMock,
  showSuccess: showSuccessMock,
}))

// Delegates to the REAL `moveBlocksTo` by default (set once below, after the
// actual module is available) — individual tests override it with
// `mockImplementationOnce` to simulate a `PartialMoveError` (or any other
// failure) without needing a real scenario that produces one.
const moveBlocksToMock = vi.hoisted(() => vi.fn())
vi.mock('./moveBlocks.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('./moveBlocks.ts')>()
  moveBlocksToMock.mockImplementation(actual.moveBlocksTo)
  return { ...actual, moveBlocksTo: moveBlocksToMock }
})

// Same shape, for driving a PRE-move read into a transient failure.
const liveBlockIdsMock = vi.hoisted(() => vi.fn())
vi.mock('@/data/blockLiveness.js', async importOriginal => {
  const actual = await importOriginal<typeof import('@/data/blockLiveness.js')>()
  liveBlockIdsMock.mockImplementation(actual.liveBlockIds)
  return { ...actual, liveBlockIds: liveBlockIdsMock }
})

import { ChangeScope } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { keyBetween } from '@/data/orderKey'
import { clearPendingMove, getPendingMove, setPendingMove } from '@/utils/pendingMove'
import type { PasteMoveTarget } from '@/paste/moveOnPasteVerb'
import { pasteAsMoveImpl } from './pasteAsMoveImpl.ts'
import { PartialMoveError } from './moveBlocks.ts'

const WS = 'ws-1'

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

const lastKeyByParent = new Map<string, string | null>()

const seed = async (id: string, parentId: string | null, content = id): Promise<void> => {
  const bucket = parentId ?? '__root__'
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
    'SELECT parent_id FROM blocks WHERE id = ?', [id],
  )
  return row?.parent_id ?? null
}

const INTO_DEST: PasteMoveTarget = { parentId: 'dest', position: { kind: 'last' } }

// The preflight's own refusal message, distinct from `CycleError`'s
// ("moving X under Y would create a cycle") — asserting on it (not just the
// call count) is what tells "the preflight refused" apart from "moveBlocksTo's
// OWN CycleError backstop refused instead", since both paths return `true`
// and call `showError` once. Without this, disabling the preflight's
// `parentId` branch entirely still passes every test here — the backstop
// silently launders the damage.
const CYCLE_MESSAGE = "Can't paste here — it's inside the block(s) you cut"

beforeEach(async () => {
  lastKeyByParent.clear()
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({ db: sharedDb.db, user: { id: 'user-1' } }).repo
  repo.setActiveWorkspaceId(WS)
  showErrorMock.mockClear()
  showInfoMock.mockClear()
  showSuccessMock.mockClear()
})

afterEach(() => { clearPendingMove() })

describe('pasteAsMoveImpl', () => {
  it('returns false and touches nothing when no move is pending', async () => {
    await seed('dest', null)
    expect(await pasteAsMoveImpl({ repo, target: INTO_DEST, clipboardText: 'whatever' })).toBe(false)
    expect(await childIds('dest')).toEqual([])
  })

  it('happy path: moves the blocks, preserves their ids, and clears the register', async () => {
    await seed('dest', null)
    await seed('src', null)
    await seed('a', 'src')
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })

    const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, clipboardText: 'a' })

    expect(result).toBe(true)
    expect(await childIds('dest')).toEqual(['a']) // same id — nothing minted
    expect(await childIds('src')).toEqual([])
    expect(getPendingMove()).toBeNull()
  })

  it('is a no-op fallback when the clipboard text no longer matches the register', async () => {
    await seed('dest', null)
    await seed('a', null)
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })

    const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, clipboardText: 'something else' })

    expect(result).toBe(false)
    expect(await childIds('dest')).toEqual([]) // no move happened
    expect(getPendingMove()).toBeNull() // stale register still gets cleared
  })

  // Cutting a genuinely EMPTY block records an empty `clipboardText` in the
  // register (see `cutBlockIdsToClipboard`). If `pasteAsMoveImpl` treated an
  // empty clipboardText as automatically invalid, that cut could never
  // complete — the block would stay marked forever.
  it('completes the move when both the register and the paste-time clipboard text are empty', async () => {
    await seed('dest', null)
    await seed('a', null, '')
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: '' })

    const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, clipboardText: '' })

    expect(result).toBe(true)
    expect(await childIds('dest')).toEqual(['a'])
    expect(getPendingMove()).toBeNull()
  })

  // Superseded by "partial tombstone survivors" below: a deleted id among
  // the pending ones no longer vetoes the whole batch — the survivors
  // still move. See that describe block for the current behavior.

  it('refuses (does not move, does not fall back) when the destination parent IS one of the moving blocks', async () => {
    await seed('a', null)
    await seed('b', 'a')
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })

    // "Paste inside a" while a itself is being moved.
    const result = await pasteAsMoveImpl({
      repo, target: { parentId: 'a', position: { kind: 'last' } }, clipboardText: 'a',
    })

    expect(result).toBe(true) // handled — caller must NOT also text-paste
    expect(showErrorMock).toHaveBeenCalledTimes(1)
    expect(showErrorMock).toHaveBeenCalledWith(CYCLE_MESSAGE)
    expect(await childIds('a')).toEqual(['b']) // unchanged: nothing moved into it
    // Register SURVIVES a refusal: dropping it would make the user's next
    // paste fall back to text and duplicate the still-present originals.
    expect(getPendingMove()?.blockIds).toEqual(['a'])
  })

  it('refuses when the destination parent is a DESCENDANT of a moving block', async () => {
    await seed('a', null)
    await seed('b', 'a')
    await seed('c', 'b') // c is a's grandchild
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })

    const result = await pasteAsMoveImpl({
      repo, target: { parentId: 'c', position: { kind: 'last' } }, clipboardText: 'a',
    })

    expect(result).toBe(true)
    expect(showErrorMock).toHaveBeenCalledTimes(1)
    expect(showErrorMock).toHaveBeenCalledWith(CYCLE_MESSAGE)
    expect(await childIds('c')).toEqual([])
    expect(getPendingMove()?.blockIds).toEqual(['a']) // survives — see above
  })

  it('refuses when the before/after anchor sibling IS one of the moving blocks', async () => {
    await seed('parent', null)
    await seed('a', 'parent')
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })

    // Paste "after a" — the anchor itself is the block being moved.
    const result = await pasteAsMoveImpl({
      repo, target: { parentId: 'parent', position: { kind: 'after', siblingId: 'a' } }, clipboardText: 'a',
    })

    expect(result).toBe(true)
    expect(showErrorMock).toHaveBeenCalledTimes(1)
    expect(showErrorMock).toHaveBeenCalledWith(CYCLE_MESSAGE)
    expect(await childIds('parent')).toEqual(['a']) // unchanged
    expect(getPendingMove()?.blockIds).toEqual(['a']) // survives — see above
  })

  it('does not refuse a destination that is merely a SIBLING of a moving block (not inside it)', async () => {
    await seed('dest', null)
    await seed('a', null)
    await seed('sibling', null)
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })

    const result = await pasteAsMoveImpl({
      repo, target: { parentId: null, position: { kind: 'after', siblingId: 'sibling' } }, clipboardText: 'a',
    })

    expect(result).toBe(true)
    expect(showErrorMock).not.toHaveBeenCalled()
    expect(getPendingMove()).toBeNull()
  })

  // The point of keeping the register on a refusal. If a mis-aimed paste
  // dropped it, this retry would find no pending move, fall back to a
  // text paste, and re-create the cut content as NEW blocks while the
  // originals (never deleted) stayed put — the exact duplication the
  // refusal exists to prevent, just one keystroke later.
  it('a refused paste can be retried at a valid destination and still moves', async () => {
    await seed('a', null)
    await seed('child', 'a')
    await seed('dest', null)
    setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })

    const refused = await pasteAsMoveImpl({
      repo, target: { parentId: 'a', position: { kind: 'last' } }, clipboardText: 'a',
    })
    expect(refused).toBe(true)
    expect(showErrorMock).toHaveBeenCalledWith(CYCLE_MESSAGE)

    const retried = await pasteAsMoveImpl({
      repo, target: { parentId: 'dest', position: { kind: 'last' } }, clipboardText: 'a',
    })

    expect(retried).toBe(true)
    // Moved, not duplicated: the SAME id is under dest, and it is gone
    // from the root rather than copied.
    expect(await childIds('dest')).toEqual(['a'])
    expect(getPendingMove()).toBeNull()
  })

  describe('cross-workspace paste (item C)', () => {
    it('falls back (returns false) but KEEPS the register when the pending move belongs to a different workspace', async () => {
      await seed('dest', null)
      await seed('a', null)
      setPendingMove({ blockIds: ['a'], workspaceId: 'ws-other', clipboardText: 'a' })

      const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, clipboardText: 'a' })

      expect(result).toBe(false)
      expect(await childIds('dest')).toEqual([])
      // The cut is still valid back in 'ws-other' — dropping it here would
      // both fail to paste anything useful AND silently destroy the cut.
      expect(getPendingMove()).toEqual({ blockIds: ['a'], workspaceId: 'ws-other', clipboardText: 'a' })
      expect(showInfoMock).toHaveBeenCalledTimes(1)
      expect(showInfoMock).toHaveBeenCalledWith("Can't move blocks across workspaces — pasted a copy instead")
    })

    it('DROPS a cross-workspace register whose sentinel no longer matches, instead of preserving it', async () => {
      // Cut in 'ws-other', then something else gets copied (in-app or from
      // another app), then a paste lands over here. The copy already killed
      // the cut — the workspace mismatch must not resurrect it, and the
      // "pasted a copy instead" toast would be a lie about content the
      // clipboard no longer holds.
      await seed('dest', null)
      await seed('a', null)
      setPendingMove({ blockIds: ['a'], workspaceId: 'ws-other', clipboardText: 'a' })

      const result = await pasteAsMoveImpl({
        repo,
        target: INTO_DEST,
        clipboardText: 'something else entirely',
      })

      expect(result).toBe(false)
      expect(getPendingMove()).toBeNull()
      expect(showInfoMock).not.toHaveBeenCalled()
    })

    it('a cross-workspace paste that keeps the register still lets a LATER same-workspace paste complete the move', async () => {
      await seed('dest', null)
      await seed('a', null)
      setPendingMove({ blockIds: ['a'], workspaceId: 'ws-other', clipboardText: 'a' })

      await pasteAsMoveImpl({ repo, target: INTO_DEST, clipboardText: 'a' })
      expect(getPendingMove()).not.toBeNull()

      repo.setActiveWorkspaceId('ws-other')
      const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, clipboardText: 'a' })

      expect(result).toBe(true)
      expect(await childIds('dest')).toEqual(['a'])
      expect(getPendingMove()).toBeNull()
    })
  })

  describe('the claimed register is only ever given back to nobody else', () => {
    it('keeps the claim when a PRE-move read rejects, rather than letting it escape past the claim', async () => {
      // `liveBlockIds` and the cycle probe run after the register has been
      // claimed and cleared. A transient DB failure there used to reject
      // straight out of the verb: register gone, blocks still in place, so
      // the next paste took the text path and duplicated them.
      await seed('dest', null)
      await seed('a', null)
      setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })

      liveBlockIdsMock.mockRejectedValueOnce(new Error('database is closed'))

      const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, clipboardText: 'a' })

      // Handled (no duplicating text paste), register intact, user told.
      expect(result).toBe(true)
      expect(getPendingMove()).toEqual({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })
      expect(await childIds('dest')).toEqual([])
      expect(showErrorMock).toHaveBeenCalledTimes(1)
    })

    it('does NOT bury a newer cut that arrived while the move was in flight', async () => {
      await seed('dest', null)
      await seed('a', null)
      await seed('b', null)
      setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })

      // The user cuts 'b' while this paste is still committing, then the
      // paste fails. Restoring 'a' unconditionally would lose 'b''s cut.
      moveBlocksToMock.mockImplementationOnce(async () => {
        setPendingMove({ blockIds: ['b'], workspaceId: WS, clipboardText: 'b' })
        throw new Error('move failed')
      })

      await pasteAsMoveImpl({ repo, target: INTO_DEST, clipboardText: 'a' })

      expect(getPendingMove()).toEqual({ blockIds: ['b'], workspaceId: WS, clipboardText: 'b' })
    })

    it('still restores the claim when nothing newer arrived (the control for the case above)', async () => {
      await seed('dest', null)
      await seed('a', null)
      setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })

      moveBlocksToMock.mockImplementationOnce(async () => { throw new Error('move failed') })

      await pasteAsMoveImpl({ repo, target: INTO_DEST, clipboardText: 'a' })

      expect(getPendingMove()).toEqual({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })
    })
  })

  describe('partial tombstone survivors (item 3)', () => {
    it('moves the LIVE survivors and shows a toast noting how many were already deleted', async () => {
      await seed('dest', null)
      await seed('a', null)
      await seed('b', null)
      await repo.block('b').delete()
      setPendingMove({ blockIds: ['a', 'b'], workspaceId: WS, clipboardText: 'a\nb' })

      const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, clipboardText: 'a\nb' })

      expect(result).toBe(true)
      // 'a' (still live) moved; 'b' (deleted) was skipped, not recreated.
      expect(await childIds('dest')).toEqual(['a'])
      expect(getPendingMove()).toBeNull()
      expect(showSuccessMock).toHaveBeenCalledTimes(1)
      expect(showSuccessMock).toHaveBeenCalledWith('Moved 1 block — 1 was already deleted and skipped')
    })

    it('falls back to a text paste (no toast) when EVERY pending id was deleted before the paste', async () => {
      await seed('dest', null)
      await seed('a', null)
      await repo.block('a').delete()
      setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })

      const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, clipboardText: 'a' })

      expect(result).toBe(false)
      expect(await childIds('dest')).toEqual([])
      expect(getPendingMove()).toBeNull()
      expect(showSuccessMock).not.toHaveBeenCalled()
      expect(showErrorMock).not.toHaveBeenCalled()
    })

    it('does not show the skip toast when nothing was actually skipped', async () => {
      await seed('dest', null)
      await seed('a', null)
      setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })

      await pasteAsMoveImpl({ repo, target: INTO_DEST, clipboardText: 'a' })

      expect(showSuccessMock).not.toHaveBeenCalled()
    })
  })

  describe('moveBlocksTo failures (item 4)', () => {
    it('keeps the register UNCHANGED when the move fails before anything commits (not a PartialMoveError)', async () => {
      await seed('dest2', null)
      await seed('a', null)
      await repo.block('dest2').delete() // moving into a deleted parent throws, nothing committed
      setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })

      const result = await pasteAsMoveImpl({
        repo, target: { parentId: 'dest2', position: { kind: 'last' } }, clipboardText: 'a',
      })

      expect(result).toBe(true)
      expect(showErrorMock).toHaveBeenCalledTimes(1)
      // Nothing moved — the whole set is exactly where it was, so the
      // register comes back untouched, not narrowed.
      expect(getPendingMove()).toEqual({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })
      expect(await parentOf('a')).toBeNull()
    })

    it('narrows the register to the ids that did NOT move on a PartialMoveError', async () => {
      await seed('dest', null)
      await seed('a', null)
      await seed('b', null)
      setPendingMove({ blockIds: ['a', 'b'], workspaceId: WS, clipboardText: 'a\nb' })

      moveBlocksToMock.mockImplementationOnce(async () => {
        throw new PartialMoveError(['a'], new Error('boom'))
      })

      const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, clipboardText: 'a\nb' })

      expect(result).toBe(true)
      expect(showErrorMock).toHaveBeenCalledTimes(1)
      // 'a' committed (per the simulated PartialMoveError) — it must NOT
      // stay in the register, or the next paste would re-move (duplicate
      // work) an id that's already at its destination. 'b' never moved and
      // must stay.
      expect(getPendingMove()).toEqual({ blockIds: ['b'], workspaceId: WS, clipboardText: 'a\nb' })
    })
  })

  describe('re-entrancy (item B)', () => {
    it('claims the register synchronously, so two overlapping pastes cannot both complete the same move', async () => {
      await seed('dest', null)
      await seed('dest2', null)
      await seed('a', null)
      setPendingMove({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })

      // Fired back-to-back with NO await between them — if the claim
      // weren't synchronous, both would read the same pending move and
      // both would attempt `moveBlocksTo`, sending 'a' to whichever
      // resolved last and leaving two undo entries.
      const p1 = pasteAsMoveImpl({ repo, target: INTO_DEST, clipboardText: 'a' })
      const p2 = pasteAsMoveImpl({
        repo, target: { parentId: 'dest2', position: { kind: 'last' } }, clipboardText: 'a',
      })

      const [r1, r2] = await Promise.all([p1, p2])

      // The first call's synchronous prologue claims the register before
      // the second call's prologue ever runs (JS has no interleaving
      // before the first `await`) — so the first always wins.
      expect(r1).toBe(true)
      expect(r2).toBe(false)
      expect(getPendingMove()).toBeNull()
      // 'a' landed under exactly one destination — not duplicated, not split.
      expect(await childIds('dest')).toEqual(['a'])
      expect(await childIds('dest2')).toEqual([])
    })
  })
})

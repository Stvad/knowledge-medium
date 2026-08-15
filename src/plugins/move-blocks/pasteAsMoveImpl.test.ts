// @vitest-environment node
/**
 * `pasteAsMoveImpl` — the move-blocks plugin's fill for core's
 * `pasteAsMoveVerb` seam (`@/paste/moveOnPasteVerb.js`). Calls the plain
 * async function directly (no facet runtime needed — it's just
 * `(input) => boolean`); the seam's wiring (`tryPasteAsMove` →
 * `pasteAsMoveVerb.run` → this impl) is covered by `defaultShortcuts.test.ts`,
 * which also proves the CALLER's text-paste fallback runs for each
 * declined case.
 *
 * This file used to be a register-VALIDITY matrix — is the pending move
 * still current, does the sentinel match, who owns the claim, does a
 * failure hand it back. None of that survives: the payload arrives already
 * resolved from the clipboard's own content, so validity isn't a question
 * this function can answer differently from its caller. What's left is
 * about THIS paste — wrong workspace, dead blocks, a cycle — and the write.
 *
 * `payload.intent` is gated in `tryPasteAsMove` (a copy never reaches
 * here), and covered by `moveOnPasteVerb.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const showErrorMock = vi.hoisted(() => vi.fn())
const showInfoMock = vi.hoisted(() => vi.fn())
const showSuccessMock = vi.hoisted(() => vi.fn())
vi.mock('@/utils/toast.js', () => ({
  showError: showErrorMock,
  showInfo: showInfoMock,
  showSuccess: showSuccessMock,
}))

// Delegates to the REAL `moveBlocksTo` by default — individual tests
// override it with `mockImplementationOnce` to simulate a
// `PartialMoveError` (or any other failure) without needing a real
// scenario that produces one. `realMoveBlocksTo` lets an override still
// commit a genuine prefix before it throws.
const moveBlocksToMock = vi.hoisted(() => vi.fn())
const realMoveBlocksTo = vi.hoisted(() => ({current: null as null | typeof import('./moveBlocks.ts')['moveBlocksTo']}))
vi.mock('./moveBlocks.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('./moveBlocks.ts')>()
  realMoveBlocksTo.current = actual.moveBlocksTo
  moveBlocksToMock.mockImplementation(actual.moveBlocksTo)
  return { ...actual, moveBlocksTo: moveBlocksToMock }
})

// Lets a PRE-move read be driven into a transient failure.
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
import type { PasteMoveTarget } from '@/paste/moveOnPasteVerb'
import {
  recallPayloadForText,
  rememberPayload,
  resetRememberedPayloads,
  type ClipboardPayload,
} from '@/paste/clipboardPayload'
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

/** A cut payload for `blockIds`, in the active workspace unless told
 *  otherwise. Note there is no clipboard TEXT here at all — resolving the
 *  payload against the clipboard already happened in the caller. */
// Each call is a distinct GESTURE, as a real cut is — two cuts of the same
// blocks are not the same cut, and both `completedCuts` and the in-flight
// guard key on that.
let cutSeq = 0
const cut = (
  blockIds: string[],
  workspaceId = WS,
): ClipboardPayload => ({ blockIds, workspaceId, intent: 'cut', cutId: `cut-${++cutSeq}` })

// The impl marks completed cuts in a process-global set; reset it so a
// test's cut isn't seen as already-spent by the next one.
beforeEach(() => { resetRememberedPayloads() })

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
  moveBlocksToMock.mockClear()
})

describe('pasteAsMoveImpl', () => {
  it('happy path: moves the blocks and preserves their ids', async () => {
    await seed('dest', null)
    await seed('src', null)
    await seed('a', 'src')

    const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, payload: cut(['a']) })

    expect(result).toBe('moved')
    expect(await childIds('dest')).toEqual(['a']) // same id — nothing minted
    expect(await childIds('src')).toEqual([])
  })

  it('a second paste of the same cut resolves as a COPY, so it cannot relocate again', async () => {
    // End-to-end across both halves: the impl marks the cut spent, and the
    // NEXT paste's `resolveClipboardPayload` is what sees that. Testing
    // only through the impl would prove nothing — it trusts the payload it
    // is handed, so it would move a second time and should.
    await seed('dest', null)
    await seed('a', null)
    const markdown = 'a'
    // One gesture, read twice — `cut()` mints a new one per call.
    const gesture = cut(['a'])
    rememberPayload(markdown, gesture)

    const first = recallPayloadForText(markdown)
    expect(first).toEqual(gesture)
    expect(await pasteAsMoveImpl({ repo, target: INTO_DEST, payload: first! })).toBe('moved')
    expect(await childIds('dest')).toEqual(['a'])

    // Same clipboard content, nothing else copied since.
    expect(recallPayloadForText(markdown)).toEqual({...gesture, intent: 'copy'})
  })

  it('a concurrent second paste of the same cut is swallowed, not run twice', async () => {
    // Both handlers resolve the same live cut — `markCutCompleted` hasn't
    // fired yet — so without a re-entrancy guard the second move relocates
    // the blocks straight off the destination the first just put them on.
    await seed('dest', null)
    await seed('dest2', null)
    await seed('a', null)
    const payload = cut(['a'])

    let releaseFirst = (): void => {}
    const firstMayProceed = new Promise<void>(resolve => { releaseFirst = resolve })
    let started = 0
    moveBlocksToMock.mockImplementationOnce(async (r, ids, t) => {
      started += 1
      await firstMayProceed
      return realMoveBlocksTo.current!(r, ids, t)
    })

    const first = pasteAsMoveImpl({ repo, target: INTO_DEST, payload })
    await vi.waitFor(() => { expect(started).toBe(1) })

    // Fired while the first is still inside its move.
    let second: unknown
    try {
      second = await pasteAsMoveImpl({
        repo, target: { parentId: 'dest2', position: { kind: 'last' } }, payload,
      })
    } finally {
      releaseFirst()
    }
    expect(second).toBe('refused') // consumed — no duplicating text paste
    expect(await first).toBe('moved')

    // The load-bearing assertion. Asserting only on the FINAL tree passes
    // either way: without the guard the second move puts 'a' in dest2 and
    // the first then pulls it back to dest, landing in the same place. The
    // observable difference is that the move ran twice at all.
    expect(moveBlocksToMock).toHaveBeenCalledTimes(1)
    expect(await childIds('dest')).toEqual(['a'])
    expect(await childIds('dest2')).toEqual([])
  })

  it('a fresh cut of the same blocks is not blocked by an older paste still in flight', async () => {
    // The in-flight guard keys on the gesture, not the blocks. Keying by
    // workspace+ids would collide the two and silently refuse the NEWER
    // cut while the older paste wins.
    await seed('dest', null)
    await seed('dest2', null)
    await seed('a', null)
    const older = cut(['a'])
    const newer = cut(['a']) // same blocks, different gesture

    let releaseOlder = (): void => {}
    const olderMayProceed = new Promise<void>(resolve => { releaseOlder = resolve })
    let started = 0
    moveBlocksToMock.mockImplementationOnce(async (r, ids, t) => {
      started += 1
      await olderMayProceed
      return realMoveBlocksTo.current!(r, ids, t)
    })

    const first = pasteAsMoveImpl({ repo, target: INTO_DEST, payload: older })
    await vi.waitFor(() => { expect(started).toBe(1) })

    try {
      const second = await pasteAsMoveImpl({
        repo, target: { parentId: 'dest2', position: { kind: 'last' } }, payload: newer,
      })
      expect(second).toBe('moved') // not refused as a collision
    } finally {
      // Release even on failure: an abandoned paste never runs its
      // `finally`, so its in-flight entry would leak into later tests.
      releaseOlder()
      await first
    }
  })

  describe('cycle refusals', () => {
    it('refuses when the destination parent IS one of the moving blocks', async () => {
      await seed('a', null)
      await seed('b', 'a')

      const result = await pasteAsMoveImpl({
        repo, target: { parentId: 'a', position: { kind: 'last' } }, payload: cut(['a']),
      })

      expect(result).toBe('refused') // consumed, but nothing moved
      expect(showErrorMock).toHaveBeenCalledExactlyOnceWith(CYCLE_MESSAGE)
      expect(await childIds('a')).toEqual(['b']) // unchanged
    })

    it('refuses when the destination parent is a DESCENDANT of a moving block', async () => {
      await seed('a', null)
      await seed('b', 'a')
      await seed('c', 'b')

      const result = await pasteAsMoveImpl({
        repo, target: { parentId: 'c', position: { kind: 'last' } }, payload: cut(['a']),
      })

      expect(result).toBe('refused')
      expect(showErrorMock).toHaveBeenCalledExactlyOnceWith(CYCLE_MESSAGE)
      expect(await childIds('c')).toEqual([])
    })

    it('refuses when the before/after anchor sibling IS one of the moving blocks', async () => {
      await seed('parent', null)
      await seed('a', 'parent')

      const result = await pasteAsMoveImpl({
        repo,
        target: { parentId: 'parent', position: { kind: 'after', siblingId: 'a' } },
        payload: cut(['a']),
      })

      expect(result).toBe('refused')
      expect(showErrorMock).toHaveBeenCalledExactlyOnceWith(CYCLE_MESSAGE)
    })

    it('allows a destination that is merely a SIBLING of a moving block', async () => {
      await seed('parent', null)
      await seed('a', 'parent')
      await seed('sibling', 'parent')

      const result = await pasteAsMoveImpl({
        repo, target: { parentId: 'sibling', position: { kind: 'last' } }, payload: cut(['a']),
      })

      expect(result).toBe('moved')
      expect(showErrorMock).not.toHaveBeenCalled()
      expect(await childIds('sibling')).toEqual(['a'])
    })

    it('a refused paste can simply be retried somewhere valid — the clipboard still holds the cut', async () => {
      await seed('dest', null)
      await seed('a', null)
      await seed('b', 'a')

      await pasteAsMoveImpl({
        repo, target: { parentId: 'a', position: { kind: 'last' } }, payload: cut(['a']),
      })
      // Nothing had to be "restored" for this to work: the payload is the
      // caller's, resolved from a clipboard the refusal never touched.
      const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, payload: cut(['a']) })

      expect(result).toBe('moved')
      expect(await childIds('dest')).toEqual(['a'])
    })
  })

  describe('cross-workspace paste', () => {
    it('falls back to a text paste, with a toast, and moves nothing', async () => {
      await seed('dest', null)
      await seed('a', null)

      const result = await pasteAsMoveImpl({
        repo, target: INTO_DEST, payload: cut(['a'], 'ws-other'),
      })

      expect(result).toBe('not-a-move')
      expect(await childIds('dest')).toEqual([])
      // Does not promise a copy landed — for an empty cut the text-paste
      // fallback inserts nothing.
      expect(showInfoMock).toHaveBeenCalledExactlyOnceWith(
        "Can't move blocks across workspaces",
      )
    })

    it('still completes once the paste happens in the payload\'s own workspace', async () => {
      await seed('dest', null)
      await seed('a', null)

      await pasteAsMoveImpl({ repo, target: INTO_DEST, payload: cut(['a'], 'ws-other') })
      repo.setActiveWorkspaceId('ws-other')
      const result = await pasteAsMoveImpl({
        repo, target: INTO_DEST, payload: cut(['a'], 'ws-other'),
      })

      expect(result).toBe('moved')
      expect(await childIds('dest')).toEqual(['a'])
    })
  })

  describe('blocks deleted between the cut and the paste', () => {
    it('moves the LIVE survivors and says how many were skipped', async () => {
      await seed('dest', null)
      await seed('a', null)
      await seed('b', null)
      await repo.block('b').delete()

      const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, payload: cut(['a', 'b']) })

      expect(result).toBe('moved')
      expect(await childIds('dest')).toEqual(['a'])
      expect(showSuccessMock).toHaveBeenCalledExactlyOnceWith(
        'Moved 1 block — 1 was skipped',
      )
    })

    it('falls back to a text paste, with no toast, when every id is gone', async () => {
      await seed('dest', null)
      await seed('a', null)
      await repo.block('a').delete()

      const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, payload: cut(['a']) })

      expect(result).toBe('not-a-move')
      expect(await childIds('dest')).toEqual([])
      expect(showSuccessMock).not.toHaveBeenCalled()
    })

    it('shows no skip toast when nothing was skipped', async () => {
      await seed('dest', null)
      await seed('a', null)

      await pasteAsMoveImpl({ repo, target: INTO_DEST, payload: cut(['a']) })

      expect(showSuccessMock).not.toHaveBeenCalled()
    })
  })

  it('does not spend the cut when every source was tombstoned after the liveness read', async () => {
    // The race the in-transaction check exists for: `liveBlockIds` said
    // the block was live, it was deleted before the move committed, and
    // `moveBlocksTo` skipped it. Reporting a move here would spend the cut
    // for a paste that visibly did nothing, and suppress the text
    // fallback too.
    await seed('dest', null)
    await seed('a', null)
    const markdown = 'a'
    const payload = cut(['a'])
    rememberPayload(markdown, payload)

    await repo.block('a').delete()
    liveBlockIdsMock.mockResolvedValueOnce(['a']) // stale: read before the delete

    const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, payload })

    expect(result).toBe('not-a-move') // caller text-pastes instead
    expect(await childIds('dest')).toEqual([])
    // Still a live cut — a later paste can still complete it.
    expect(recallPayloadForText(markdown)).toEqual(payload)
  })

  it('keeps the cut retryable when a block is merely UNSYNCED rather than deleted', async () => {
    // `liveBlockIds` keeps ids that are missing locally ("missing ≠
    // deleted"), and the move skips them in-transaction. Spending the cut
    // on the partial result would strand the absent block at its old
    // parent once it syncs, with every later paste downgraded to a copy.
    await seed('dest', null)
    await seed('here', null)
    const markdown = 'here+elsewhere'
    const payload = cut(['here', 'unsynced'])
    rememberPayload(markdown, payload)

    const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, payload })

    expect(result).toBe('moved')
    expect(await childIds('dest')).toEqual(['here'])
    // Still live: a paste after 'unsynced' arrives can finish the job.
    expect(recallPayloadForText(markdown)).toEqual(payload)
  })

  it('spends the cut once every block is accounted for', async () => {
    // The control for the case above.
    await seed('dest', null)
    await seed('a', null)
    const markdown = 'a'
    const payload = cut(['a'])
    rememberPayload(markdown, payload)

    expect(await pasteAsMoveImpl({ repo, target: INTO_DEST, payload })).toBe('moved')

    expect(recallPayloadForText(markdown)).toEqual({...payload, intent: 'copy'})
  })

  it('completes the cut when one root got reparented under another before the paste', async () => {
    // A and B were cut as separate roots; B became A's child in between
    // (a manual move, or a sync-applied reparent). `moveBlocksTo` prunes B
    // and carries it inside A's subtree, so it never appears in
    // `movedIds` — subtracting those directly would treat B as left
    // behind, never finish the cut, misreport it as skipped, and let every
    // later paste relocate both again.
    await seed('dest', null)
    await seed('a', null)
    await seed('b', null)
    const markdown = 'a+b'
    const payload = cut(['a', 'b'])
    rememberPayload(markdown, payload)

    // The reparent, after the cut.
    await repo.mutate.move({id: 'b', parentId: 'a', position: {kind: 'last'}})

    const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, payload })

    expect(result).toBe('moved')
    expect(await childIds('dest')).toEqual(['a'])
    expect(await parentOf('b')).toBe('a') // rode along inside 'a'
    // Spent, and no bogus "1 was skipped".
    expect(recallPayloadForText(markdown)).toEqual({...payload, intent: 'copy'})
    expect(showSuccessMock).not.toHaveBeenCalled()
  })

  describe('move failures', () => {
    it('handles a rejecting PREFLIGHT read instead of letting it escape', async () => {
      // The DOM paste handlers have already called `preventDefault` and
      // invoke this via `void`, so an escaping rejection discards the
      // paste outright: no move, no text paste, no toast. Invisible to a
      // green suite, because nothing asserts on a paste that did nothing.
      await seed('dest', null)
      await seed('a', null)
      liveBlockIdsMock.mockRejectedValueOnce(new Error('database is closed'))

      const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, payload: cut(['a']) })

      expect(result).toBe('refused') // handled — the caller must not text-paste
      expect(showErrorMock).toHaveBeenCalledTimes(1)
      expect(await childIds('dest')).toEqual([])
    })

    it('reports handled, with a toast, when the move fails before anything commits', async () => {
      await seed('dest', null)
      await seed('a', null)
      moveBlocksToMock.mockImplementationOnce(async () => { throw new Error('boom') })

      const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, payload: cut(['a']) })

      // `true` so the caller does NOT then text-paste, which would parse
      // the cut markdown into new blocks beside the untouched originals.
      expect(result).toBe('refused')
      expect(await childIds('dest')).toEqual([])
      expect(showErrorMock).toHaveBeenCalledTimes(1)
    })

    it('a PARTIAL failure is retryable by pasting again, and the retry lands the batch in order', async () => {
      // This replaces the old "narrow the register to the unmoved suffix"
      // path, which reordered the batch on retry (X,B,C,A instead of
      // X,A,B,C) because it dropped the continuation anchor. The clipboard
      // still holds the whole cut, so a retry just redoes all of it —
      // blocks already at the destination move to the same place again.
      await seed('dest', null)
      await seed('a', null)
      await seed('b', null)
      await seed('c', null)

      moveBlocksToMock.mockImplementationOnce(async (r, ids, target) => {
        // Commit a real prefix, then fail — the shape of a mid-batch tx
        // refusal.
        await realMoveBlocksTo.current!(r, [ids[0]], target)
        throw new PartialMoveError([ids[0]], new Error('interrupted'))
      })

      expect(await pasteAsMoveImpl({ repo, target: INTO_DEST, payload: cut(['a', 'b', 'c']) })).toBe('refused')
      expect(await childIds('dest')).toEqual(['a'])

      // The retry uses the same payload the clipboard still carries.
      expect(await pasteAsMoveImpl({ repo, target: INTO_DEST, payload: cut(['a', 'b', 'c']) })).toBe('moved')
      expect(await childIds('dest')).toEqual(['a', 'b', 'c'])
    })
  })
})

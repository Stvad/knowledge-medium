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
  rememberPayload,
  resetRememberedPayloads,
  resolveClipboardPayload,
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

const INTO_DEST: PasteMoveTarget = { parentId: 'dest', position: { kind: 'last' } }

/** A cut payload for `blockIds`, in the active workspace unless told
 *  otherwise. Note there is no clipboard TEXT here at all — resolving the
 *  payload against the clipboard already happened in the caller. */
const cut = (
  blockIds: string[],
  workspaceId = WS,
): ClipboardPayload => ({ blockIds, workspaceId, intent: 'cut' })

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

    expect(result).toBe(true)
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
    rememberPayload(markdown, cut(['a']))

    const first = resolveClipboardPayload(markdown, undefined)
    expect(first).toEqual(cut(['a']))
    expect(await pasteAsMoveImpl({ repo, target: INTO_DEST, payload: first! })).toBe(true)
    expect(await childIds('dest')).toEqual(['a'])

    // Same clipboard content, nothing else copied since.
    expect(resolveClipboardPayload(markdown, undefined)).toEqual({
      ...cut(['a']), intent: 'copy',
    })
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
    const second = await pasteAsMoveImpl({
      repo, target: { parentId: 'dest2', position: { kind: 'last' } }, payload,
    })
    expect(second).toBe(true) // handled — no duplicating text paste either

    releaseFirst()
    expect(await first).toBe(true)

    // The load-bearing assertion. Asserting only on the FINAL tree passes
    // either way: without the guard the second move puts 'a' in dest2 and
    // the first then pulls it back to dest, landing in the same place. The
    // observable difference is that the move ran twice at all.
    expect(moveBlocksToMock).toHaveBeenCalledTimes(1)
    expect(await childIds('dest')).toEqual(['a'])
    expect(await childIds('dest2')).toEqual([])
  })

  describe('cycle refusals', () => {
    it('refuses when the destination parent IS one of the moving blocks', async () => {
      await seed('a', null)
      await seed('b', 'a')

      const result = await pasteAsMoveImpl({
        repo, target: { parentId: 'a', position: { kind: 'last' } }, payload: cut(['a']),
      })

      expect(result).toBe(true) // handled — caller must NOT also text-paste
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

      expect(result).toBe(true)
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

      expect(result).toBe(true)
      expect(showErrorMock).toHaveBeenCalledExactlyOnceWith(CYCLE_MESSAGE)
    })

    it('allows a destination that is merely a SIBLING of a moving block', async () => {
      await seed('parent', null)
      await seed('a', 'parent')
      await seed('sibling', 'parent')

      const result = await pasteAsMoveImpl({
        repo, target: { parentId: 'sibling', position: { kind: 'last' } }, payload: cut(['a']),
      })

      expect(result).toBe(true)
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

      expect(result).toBe(true)
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

      expect(result).toBe(false)
      expect(await childIds('dest')).toEqual([])
      expect(showInfoMock).toHaveBeenCalledExactlyOnceWith(
        "Can't move blocks across workspaces — pasted a copy instead",
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

      expect(result).toBe(true)
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

      expect(result).toBe(true)
      expect(await childIds('dest')).toEqual(['a'])
      expect(showSuccessMock).toHaveBeenCalledExactlyOnceWith(
        'Moved 1 block — 1 was already deleted and skipped',
      )
    })

    it('falls back to a text paste, with no toast, when every id is gone', async () => {
      await seed('dest', null)
      await seed('a', null)
      await repo.block('a').delete()

      const result = await pasteAsMoveImpl({ repo, target: INTO_DEST, payload: cut(['a']) })

      expect(result).toBe(false)
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

      expect(result).toBe(true) // handled — the caller must not text-paste
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
      expect(result).toBe(true)
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

      expect(await pasteAsMoveImpl({ repo, target: INTO_DEST, payload: cut(['a', 'b', 'c']) })).toBe(true)
      expect(await childIds('dest')).toEqual(['a'])

      // The retry uses the same payload the clipboard still carries.
      expect(await pasteAsMoveImpl({ repo, target: INTO_DEST, payload: cut(['a', 'b', 'c']) })).toBe(true)
      expect(await childIds('dest')).toEqual(['a', 'b', 'c'])
    })
  })
})

// @vitest-environment happy-dom
/**
 * `cutBlockIdsToClipboard`'s clipboard/register plumbing — the parts
 * `copy.test.ts` (node env) explicitly excludes because they need a DOM
 * `navigator.clipboard`. Covers:
 *   - the happy path (write succeeds, register armed with the written
 *     markdown as the invalidation sentinel)
 *   - the write-refused fallback: read back whatever's ALREADY on the
 *     clipboard and use THAT as the sentinel, rather than skipping the
 *     invalidation check entirely
 *   - the total-failure case (write AND read both refused): no register,
 *     no silent "anything pastes as a move" landmine
 *   - normalizing an ancestor+descendant selection before serializing, so
 *     the clipboard markdown doesn't contain the descendant twice
 */
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const showErrorMock = vi.hoisted(() => vi.fn())
vi.mock('@/utils/toast.js', () => ({ showError: showErrorMock }))

import { ChangeScope } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { keyBetween } from '@/data/orderKey'
import { clearPendingMove, getPendingMove, setPendingMove } from '@/utils/pendingMove'
import { cutBlockIdsToClipboard } from '@/utils/copy'

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

beforeEach(async () => {
  lastKeyByParent.clear()
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({ db: sharedDb.db, user: { id: 'user-1' } }).repo
  repo.setActiveWorkspaceId(WS)
  showErrorMock.mockClear()
})

afterEach(() => {
  clearPendingMove()
  vi.unstubAllGlobals()
})

describe('cutBlockIdsToClipboard', () => {
  it('writes the serialized markdown and arms the register with it as the sentinel', async () => {
    await seed('a', null, 'hello')
    const write = vi.fn(async () => {})
    vi.stubGlobal('ClipboardItem', class {})
    vi.stubGlobal('navigator', { clipboard: { write } })

    const marked = await cutBlockIdsToClipboard(['a'], repo)

    expect(marked).toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    expect(getPendingMove()).toEqual({ blockIds: ['a'], workspaceId: WS, clipboardText: 'hello' })
  })

  it('falls back to reading back the existing clipboard as the sentinel when the write is refused', async () => {
    await seed('a', null, 'hello')
    const write = vi.fn(async () => { throw new DOMException('refused', 'NotAllowedError') })
    const readText = vi.fn(async () => 'whatever was already on the clipboard')
    vi.stubGlobal('ClipboardItem', class {})
    vi.stubGlobal('navigator', { clipboard: { write, readText } })

    const marked = await cutBlockIdsToClipboard(['a'], repo)

    expect(marked).toBe(true)
    // The register is still armed — with the READ-BACK text, not our own
    // markdown (which never reached the clipboard).
    expect(getPendingMove()).toEqual({
      blockIds: ['a'],
      workspaceId: WS,
      clipboardText: 'whatever was already on the clipboard',
    })
  })

  it('abandons the cut — no register, a toast — when BOTH the write and the read are refused', async () => {
    await seed('a', null, 'hello')
    const write = vi.fn(async () => { throw new DOMException('refused', 'NotAllowedError') })
    const readText = vi.fn(async () => { throw new DOMException('refused', 'NotAllowedError') })
    vi.stubGlobal('ClipboardItem', class {})
    vi.stubGlobal('navigator', { clipboard: { write, readText } })

    const marked = await cutBlockIdsToClipboard(['a'], repo)

    expect(marked).toBe(false)
    // No usable invalidation sentinel — arming the register anyway would
    // let literally ANY next paste, anywhere, complete as a move.
    expect(getPendingMove()).toBeNull()
    expect(showErrorMock).toHaveBeenCalledTimes(1)
  })

  it('normalizes an ancestor+descendant selection before serializing, so the descendant is not duplicated in the clipboard markdown', async () => {
    await seed('a', null, 'a')
    await seed('kid', 'a', 'kid')
    const write = vi.fn(async () => {})
    vi.stubGlobal('ClipboardItem', class {})
    vi.stubGlobal('navigator', { clipboard: { write } })

    // Selection holds BOTH the ancestor and its own descendant — possible
    // once `validateSelectionHierarchy`'s write-time invariant goes stale
    // (a sync-applied reparent after the selection was captured).
    const marked = await cutBlockIdsToClipboard(['a', 'kid'], repo)

    expect(marked).toBe(true)
    const pending = getPendingMove()
    // 'kid' must NOT appear twice: once nested under 'a', once again as
    // its own top-level entry.
    expect(pending?.clipboardText).toBe('- a\n  - kid')
    expect(pending?.blockIds).toEqual(['a']) // 'kid' pruned — it rides along under 'a'
  })

  it('arms the register only with roots that actually serialized, not every requested id', async () => {
    // 'a' serializes fine; 'ghost' doesn't exist and fails to serialize
    // (`serializeSelectedBlocks` catches per-root failures and silently
    // omits them from the clipboard text). Arming the register with BOTH
    // requested ids would relocate 'ghost' on the next paste even though
    // the clipboard never represented it.
    await seed('a', null, 'hello')
    const write = vi.fn(async () => {})
    vi.stubGlobal('ClipboardItem', class {})
    vi.stubGlobal('navigator', { clipboard: { write } })

    const marked = await cutBlockIdsToClipboard(['a', 'ghost'], repo)

    expect(marked).toBe(true)
    expect(getPendingMove()).toEqual({ blockIds: ['a'], workspaceId: WS, clipboardText: 'hello' })
  })

  // Two cuts can overlap: a cut awaits hierarchy validation, subtree
  // serialization and the clipboard write, so a second gesture can start
  // (and finish) while the first is still in flight. The loser must not
  // publish over the winner — in either direction.
  describe('overlapping cuts', () => {
    it('the older cut does not overwrite the newer cut\'s register when it finishes second', async () => {
      await seed('a', null, 'first cut')
      await seed('b', null, 'second cut')

      let releaseFirstWrite = (): void => {}
      const firstWriteLanded = new Promise<void>(resolve => { releaseFirstWrite = resolve })
      let writeCalls = 0
      const write = vi.fn(async () => {
        writeCalls += 1
        if (writeCalls === 1) await firstWriteLanded
      })
      vi.stubGlobal('ClipboardItem', class {})
      vi.stubGlobal('navigator', { clipboard: { write } })

      const older = cutBlockIdsToClipboard(['a'], repo)
      // Fence on the older cut actually being inside its write, so the
      // newer one is genuinely overlapping rather than merely sequenced
      // after it by the event loop.
      await vi.waitFor(() => { expect(writeCalls).toBe(1) })

      expect(await cutBlockIdsToClipboard(['b'], repo)).toBe(true)
      expect(getPendingMove()).toEqual({ blockIds: ['b'], workspaceId: WS, clipboardText: 'second cut' })

      releaseFirstWrite()
      expect(await older).toBe(false)
      expect(getPendingMove()).toEqual({ blockIds: ['b'], workspaceId: WS, clipboardText: 'second cut' })
    })

  })

  it('replaces (not merges with) an unrelated pending move, via the same clear-then-rearm ordering the write itself uses', async () => {
    setPendingMove({ blockIds: ['stale'], workspaceId: WS, clipboardText: 'stale' })
    await seed('a', null, 'a')
    const write = vi.fn(async () => {})
    vi.stubGlobal('ClipboardItem', class {})
    vi.stubGlobal('navigator', { clipboard: { write } })

    await cutBlockIdsToClipboard(['a'], repo)

    expect(getPendingMove()).toEqual({ blockIds: ['a'], workspaceId: WS, clipboardText: 'a' })
  })
})

// @vitest-environment happy-dom
/**
 * `cutBlockIdsToClipboard` — the parts `copy.test.ts` (node env) excludes
 * because they need a DOM `navigator.clipboard`.
 *
 * Most of what this file used to test is gone with the pending-move
 * register: a clipboard-write-refused sentinel, a read-back fallback, an
 * epoch, per-gesture tickets, and two describe blocks of overlapping-cut
 * ordering. Identity now travels on the clipboard
 * (`@/paste/clipboardPayload.js`), so "which cut is current" isn't a
 * question anyone asks and none of that machinery has a replacement to
 * test. What's left is what cut actually promises.
 */
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const showErrorMock = vi.hoisted(() => vi.fn())
vi.mock('@/utils/toast.js', () => ({ showError: showErrorMock }))

import { ChangeScope } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { keyBetween } from '@/data/orderKey'
import {
  decodePayloadHtml,
  recallPayloadForText,
  resetRememberedPayloads,
} from '@/paste/clipboardPayload'
import { cutBlockIdsToClipboard, writeTextToClipboard } from '@/utils/copy'

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

/** Captures what actually reached the OS clipboard, so the assertions read
 *  the written flavors rather than trusting the in-process table. */
const stubClipboard = () => {
  const written: Record<string, string>[] = []
  const write = vi.fn(async (items: ClipboardItem[]) => {
    const entry: Record<string, string> = {}
    for (const item of items) {
      for (const type of item.types) entry[type] = await (await item.getType(type)).text()
    }
    written.push(entry)
  })
  vi.stubGlobal('navigator', { clipboard: { write } })
  return { write, written }
}

beforeEach(async () => {
  lastKeyByParent.clear()
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({ db: sharedDb.db, user: { id: 'user-1' } }).repo
  repo.setActiveWorkspaceId(WS)
  showErrorMock.mockClear()
  resetRememberedPayloads()
})

afterEach(() => { vi.unstubAllGlobals() })

describe('cutBlockIdsToClipboard', () => {
  it('writes both flavors, with the cut identity carried in the html one', async () => {
    await seed('a', null, 'hello')
    const { written } = stubClipboard()

    expect(await cutBlockIdsToClipboard(['a'], repo)).toBe(true)

    expect(written).toHaveLength(1)
    expect(written[0]['text/plain']).toBe('hello')
    expect(decodePayloadHtml(written[0]['text/html'], written[0]['text/plain'])).toEqual({
      blockIds: ['a'], workspaceId: WS, intent: 'cut',
    })
  })

  it('also remembers the payload against the text, for paste paths that only see text/plain', async () => {
    await seed('a', null, 'hello')
    stubClipboard()

    await cutBlockIdsToClipboard(['a'], repo)

    expect(recallPayloadForText('hello')).toEqual({
      blockIds: ['a'], workspaceId: WS, intent: 'cut',
    })
  })

  it('abandons the cut, with a toast, when the clipboard write is refused', async () => {
    await seed('a', null, 'hello')
    const write = vi.fn(async () => { throw new DOMException('refused', 'NotAllowedError') })
    vi.stubGlobal('navigator', { clipboard: { write } })

    expect(await cutBlockIdsToClipboard(['a'], repo)).toBe(false)
    expect(showErrorMock).toHaveBeenCalledTimes(1)
  })

  it('a refused write leaves NO payload behind, even when the clipboard already held that exact text', async () => {
    // The subtle one. "The entry is for text that never reached the
    // clipboard, so nothing can match it" is false when the clipboard
    // ALREADY holds this markdown — the user copied these blocks a moment
    // ago. Remembering before the await made a cancelled cut still
    // completable, so the payload is recorded only after the write lands.
    await seed('a', null, 'hello')
    const write = vi.fn(async () => { throw new DOMException('refused', 'NotAllowedError') })
    vi.stubGlobal('navigator', { clipboard: { write } })

    expect(await cutBlockIdsToClipboard(['a'], repo)).toBe(false)

    // 'hello' is exactly what the clipboard would still be holding.
    expect(recallPayloadForText('hello')).toBeNull()
  })

  it('a later plain-text copy of the SAME text stops resolving to the cut', async () => {
    // Duplicate one-liners are ordinary in an outline, so "cut a block
    // saying `hello`, then `y c` another block also saying `hello`" is a
    // real sequence. Without recording the plain write, the next paste
    // moves the cut block instead of inserting what was just copied.
    await seed('a', null, 'hello')
    const write = vi.fn(async () => {})
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { write, writeText } })

    await cutBlockIdsToClipboard(['a'], repo)
    expect(recallPayloadForText('hello')).not.toBeNull()

    await writeTextToClipboard('hello')

    expect(recallPayloadForText('hello')).toBeNull()
  })

  it('reports failure, with a toast, when a PREFLIGHT read rejects', async () => {
    // `$mod+x` has already claimed the gesture and a rejected action
    // promise is only logged, so an escaping serialization failure means
    // the user sees nothing at all — no toast, no clipboard, no hint the
    // cut didn't happen.
    await seed('a', null, 'hello')
    stubClipboard()

    // 'ghost' alone can't serialize, so serializeSelectedBlocks throws.
    expect(await cutBlockIdsToClipboard(['ghost'], repo)).toBe(false)
    expect(showErrorMock).toHaveBeenCalledTimes(1)
  })

  it('normalizes an ancestor+descendant selection, so the descendant is neither duplicated in the markdown nor listed in the payload', async () => {
    await seed('a', null, 'a')
    await seed('kid', 'a', 'kid')
    const { written } = stubClipboard()

    // Both an ancestor and its own descendant — reachable once
    // `validateSelectionHierarchy`'s write-time invariant goes stale (a
    // sync-applied reparent after the selection was captured).
    expect(await cutBlockIdsToClipboard(['a', 'kid'], repo)).toBe(true)

    expect(written[0]['text/plain']).toBe('- a\n  - kid')
    // 'kid' rides along inside 'a'; listing it as its own root would move
    // it twice.
    expect(decodePayloadHtml(written[0]['text/html'], written[0]['text/plain'])?.blockIds).toEqual(['a'])
  })

  it('carries only the roots that actually serialized', async () => {
    // 'ghost' doesn't exist, so it's absent from the markdown. Carrying it
    // anyway would relocate it on paste as though the clipboard had ever
    // represented it.
    await seed('a', null, 'hello')
    const { written } = stubClipboard()

    expect(await cutBlockIdsToClipboard(['a', 'ghost'], repo)).toBe(true)

    expect(decodePayloadHtml(written[0]['text/html'], written[0]['text/plain'])?.blockIds).toEqual(['a'])
  })

  it('leaves the blocks exactly where they are — a cut with no paste changes nothing', async () => {
    await seed('a', null, 'hello')
    stubClipboard()

    await cutBlockIdsToClipboard(['a'], repo)

    const row = await repo.db.getOptional<{ parent_id: string | null; deleted: number }>(
      'SELECT parent_id, deleted FROM blocks WHERE id = ?', ['a'],
    )
    expect(row).toEqual({ parent_id: null, deleted: 0 })
  })

  // The scenario that cost four review rounds under the register, now with
  // nothing guarding it but the design itself.
  it('two overlapping cuts each stay resolvable, in either completion order', async () => {
    await seed('a', null, 'first cut')
    await seed('b', null, 'second cut')
    stubClipboard()

    const older = cutBlockIdsToClipboard(['a'], repo)
    const newer = cutBlockIdsToClipboard(['b'], repo)
    expect(await older).toBe(true)
    expect(await newer).toBe(true)

    // Whichever text the OS ended up holding resolves to ITS own blocks.
    // No ordering, no supersession, no ticket — the text is the key.
    expect(recallPayloadForText('first cut')?.blockIds).toEqual(['a'])
    expect(recallPayloadForText('second cut')?.blockIds).toEqual(['b'])
  })
})

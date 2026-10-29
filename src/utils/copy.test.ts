// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { armCut, disarmCut, getArmedCut, matchArmedCut } from '@/paste/armedCut'
import { createSharedBlockActions } from '@/shortcuts/blockActions'
import type { BlockShortcutDependencies } from '@/shortcuts/types'
import { copyBlockIdsToClipboard, cutBlockIdsToClipboard } from './copy'

const WS = 'ws-1'

let sharedDb: TestDb
let repo: Repo
let clipboardText: string | null
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
  disarmCut()
  clipboardText = null
  // `ClipboardItem` holds Blobs; keep the text so the test can paste it back.
  vi.stubGlobal('ClipboardItem', class {
    constructor(readonly items: Record<string, Blob>) {}
  })
  vi.stubGlobal('navigator', {clipboard: {
    write: vi.fn(async ([item]: [{items: Record<string, Blob>}]) => {
      clipboardText = await item.items['text/plain'].text()
    }),
  }})
  await repo.tx(async tx => {
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Page'})
    await tx.create({id: 'a', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: 'A'})
    await tx.create({id: 'b', workspaceId: WS, parentId: 'page', orderKey: 'a1', content: 'B'})
  }, {scope: ChangeScope.BlockDefault})
})
afterEach(() => vi.unstubAllGlobals())

describe('cutBlockIdsToClipboard', () => {
  it('arms the cut for exactly the text it wrote, and deletes nothing', async () => {
    await cutBlockIdsToClipboard(['a', 'b'], repo)

    expect(getArmedCut()?.rootIds).toEqual(['a', 'b'])
    expect((await matchArmedCut(clipboardText!, WS))?.kind).toBe('match')
    expect((await repo.block('a').load())?.deleted).toBe(false)
  })

  it('arms nothing when the clipboard refuses the write', async () => {
    vi.stubGlobal('navigator', {clipboard: {write: vi.fn(async () => { throw new Error('NotAllowedError') })}})

    await expect(cutBlockIdsToClipboard(['a'], repo)).rejects.toThrow('NotAllowedError')
    expect(getArmedCut()).toBeNull()
  })
})

describe('copyBlockIdsToClipboard', () => {
  it('disarms a cut: the clipboard no longer holds it', async () => {
    await armCut('- A', {workspaceId: WS, rootIds: ['a']})

    await copyBlockIdsToClipboard(['a'], repo)

    // Same text as the cut, which is exactly the case that must not move.
    expect(clipboardText).toBe('A')
    expect(getArmedCut()).toBeNull()
  })

  it('keeps the cut armed when the copy is refused', async () => {
    await armCut('- A', {workspaceId: WS, rootIds: ['a']})
    vi.stubGlobal('navigator', {clipboard: {write: vi.fn(async () => { throw new Error('NotAllowedError') })}})

    await expect(copyBlockIdsToClipboard(['b'], repo)).rejects.toThrow('NotAllowedError')
    expect(getArmedCut()?.rootIds).toEqual(['a'])
  })
})

describe('block copy actions (copy ref, embed, link, content)', () => {
  it('disarm a cut once their text is on the clipboard', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', {clipboard: {writeText}})
    await armCut('- A', {workspaceId: WS, rootIds: ['a']})
    const {copyBlockRef} = createSharedBlockActions({repo})

    await copyBlockRef.handler({block: repo.block('a')} as BlockShortcutDependencies, {} as never)

    expect(writeText).toHaveBeenCalledWith('((a))')
    await vi.waitFor(() => expect(getArmedCut()).toBeNull())
  })
})

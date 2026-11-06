// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { armCut, disarmCut, getArmedCut, matchArmedCut } from '@/paste/armedCut'
import { createSharedBlockActions } from '@/shortcuts/blockActions'
import type { BlockShortcutDependencies } from '@/shortcuts/types'
import { copyBlockIdsToClipboard, cutBlockIdsToClipboard, writeTextToClipboard } from './copy'

const WS = 'ws-1'

let sharedDb: TestDb
let repo: Repo
let clipboardText: string | null
let clipboardHtml: string | null
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
  disarmCut()
  clipboardText = null
  clipboardHtml = null
  // `ClipboardItem` holds Blobs, or promises of them; keep the text so the
  // test can paste it back.
  vi.stubGlobal('ClipboardItem', class {
    constructor(readonly items: Record<string, Blob | Promise<Blob>>) {}
  })
  vi.stubGlobal('navigator', {clipboard: {
    write: vi.fn(async ([item]: [{items: Record<string, Blob | Promise<Blob>>}]) => {
      clipboardText = await (await item.items['text/plain']).text()
      clipboardHtml = item.items['text/html'] ? await (await item.items['text/html']).text() : null
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

  it('refuses an empty cut: nothing written, nothing armed', async () => {
    await repo.tx(tx => tx.create({id: 'blank', workspaceId: WS, parentId: 'page', orderKey: 'a2', content: ''}),
      {scope: ChangeScope.BlockDefault})

    expect(await cutBlockIdsToClipboard(['blank'], repo)).toBe('empty')
    expect(clipboardText).toBeNull()
    expect(getArmedCut()).toBeNull()
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

describe('the clipboard item a copy writes', () => {
  const addMultiLineBlock = () => repo.tx(
    tx => tx.create({id: 'multi', workspaceId: WS, parentId: 'page', orderKey: 'a2', content: 'one\ntwo'}),
    {scope: ChangeScope.BlockDefault},
  )

  it('is text/plain alone for an outline the text reproduces', async () => {
    await copyBlockIdsToClipboard(['page'], repo)

    expect(clipboardText).toBe('- Page\n  - A\n  - B')
    expect(clipboardHtml).toBeNull()
  })

  it('adds the html when the text would not reproduce it, leaving the text as it was', async () => {
    await addMultiLineBlock()
    await copyBlockIdsToClipboard(['page'], repo)

    expect(clipboardText).toBe('- Page\n  - A\n  - B\n  - one\n    two')
    expect(clipboardHtml).toContain('km-outline')
  })

  it('is the same for a cut, so a paste elsewhere still rebuilds it', async () => {
    await addMultiLineBlock()
    await cutBlockIdsToClipboard(['multi'], repo)

    expect(clipboardText).toBe('one\ntwo')
    expect(clipboardHtml).toContain('km-outline')
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

describe('writeTextToClipboard (every other clipboard writer in the app)', () => {
  it('disarms a cut once the text is written', async () => {
    vi.stubGlobal('navigator', {clipboard: {writeText: vi.fn(async () => {})}})
    await armCut('((a))', {workspaceId: WS, rootIds: ['a']})

    await writeTextToClipboard('((a))')

    expect(getArmedCut()).toBeNull()
  })

  it('keeps the cut armed when the write is refused', async () => {
    vi.stubGlobal('navigator', {clipboard: {writeText: vi.fn(async () => { throw new Error('NotAllowedError') })}})
    await armCut('((a))', {workspaceId: WS, rootIds: ['a']})

    await expect(writeTextToClipboard('((a))')).rejects.toThrow('NotAllowedError')
    expect(getArmedCut()?.rootIds).toEqual(['a'])
  })

  it('starts the write at the call, for text that is not known yet', async () => {
    let resolve!: (text: string) => void
    const written = writeTextToClipboard(new Promise<string>(r => { resolve = r }))
    expect(navigator.clipboard.write).toHaveBeenCalledTimes(1)

    resolve('((a))')
    await written
    expect(clipboardText).toBe('((a))')
  })

  it('leaves the clipboard and the cut as they were when the text never comes', async () => {
    await armCut('((a))', {workspaceId: WS, rootIds: ['a']})

    await expect(writeTextToClipboard(Promise.reject(new Error('no thread')))).rejects.toThrow()
    expect(clipboardText).toBeNull()
    expect(getArmedCut()?.rootIds).toEqual(['a'])
  })
})

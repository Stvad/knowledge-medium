// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { clipboardHtmlFor, clipboardTextFor } from '../clipboardOutline'
import { readAsyncClipboard } from '../clipboard'
import { pasteFromClipboard } from '../operations'

const item = (contents: Record<string, string>) => ({
  types: Object.keys(contents),
  getType: async (type: string) => new Blob([contents[type]], {type}),
})

const stubRead = (contents: Record<string, string>) =>
  vi.stubGlobal('navigator', {clipboard: {
    read: async () => [item(contents)],
    readText: async () => { throw new Error('read() answered, so readText() is not needed') },
  }})

afterEach(() => vi.unstubAllGlobals())

describe('readAsyncClipboard', () => {
  it('reads both the text and the html', async () => {
    stubRead({'text/plain': 'text', 'text/html': '<p>text</p>'})
    expect(await readAsyncClipboard()).toEqual({text: 'text', html: '<p>text</p>'})
  })

  it('reads an image-only clipboard as nothing', async () => {
    stubRead({'image/png': 'bytes'})
    expect(await readAsyncClipboard()).toEqual({text: '', html: undefined})
  })

  it('falls back to the text when read() is refused', async () => {
    vi.stubGlobal('navigator', {clipboard: {
      read: async () => { throw new Error('NotAllowedError') },
      readText: async () => 'text',
    }})
    expect(await readAsyncClipboard()).toEqual({text: 'text'})
  })

  it('reports a refused readText() too', async () => {
    vi.stubGlobal('navigator', {clipboard: {
      read: async () => { throw new Error('NotAllowedError') },
      readText: async () => { throw new Error('refused') },
    }})
    await expect(readAsyncClipboard()).rejects.toThrow('refused')
  })
})

describe('pasteFromClipboard on this app\'s own copy', () => {
  const WS = 'ws-1'
  let db: TestDb
  let repo: Repo
  beforeAll(async () => { db = await createTestDb() })
  afterAll(async () => { await db.cleanup() })
  beforeEach(async () => {
    await resetTestDb(db.db)
    repo = createTestRepo({db: db.db, user: {id: 'user-1'}}).repo
    await repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Root'})
      await tx.create({id: 'target', workspaceId: WS, parentId: 'root', orderKey: 'a0', content: 'Target'})
    }, {scope: ChangeScope.BlockDefault})
  })

  const contentsUnder = async (id: string) =>
    (await repo.query.subtree({id}).load()).map(row => [row.depth, row.content])

  it('rebuilds the copied outline with no paste event', async () => {
    const entries = [{depth: 0, content: 'a\nb'}, {depth: 1, content: '  c  '}]
    const text = clipboardTextFor(entries)
    stubRead({'text/plain': text, 'text/html': clipboardHtmlFor(entries, text)!})

    const [pasted] = await pasteFromClipboard(repo.block('target'), repo, {scopeRootId: 'root'})

    expect(await contentsUnder(pasted.id)).toEqual([[0, 'a\nb'], [1, '  c  ']])
  })

  it('pastes a lone empty block, whose text is empty', async () => {
    const entries = [{depth: 0, content: ''}]
    stubRead({'text/plain': '', 'text/html': clipboardHtmlFor(entries, '')!})

    const pasted = await pasteFromClipboard(repo.block('target'), repo, {scopeRootId: 'root'})

    expect(pasted.map(block => block.peek()?.content)).toEqual([''])
  })

  it('pastes nothing from a clipboard with neither text nor html', async () => {
    stubRead({'image/png': 'bytes'})
    expect(await pasteFromClipboard(repo.block('target'), repo, {scopeRootId: 'root'})).toEqual([])
  })
})

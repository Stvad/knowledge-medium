// @vitest-environment node

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorView } from '@codemirror/view'
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { insertReferences, pickAndInsertImages, pickImagesIntoBlock } from './insertImage.js'

// A disconnected editor (dom.isConnected === false) drives insertReferences down
// its editor-unmounted fallback, which appends to the block. The live-editor
// branch instead reads the view's current selection — see liveEditorAt below.
const disconnectedEditor = { dom: { isConnected: false } } as unknown as EditorView

// Minimal live-editor stub: records dispatched changes and reports a selection.
// insertReferences' live branch reads only `state.selection.main`, `dispatch`,
// and `focus`, so this is enough to assert WHERE the insert lands.
const liveEditorAt = (pos: number) => {
  const dispatched: Array<{ changes: { from: number; to: number; insert: string } }> = []
  const view = {
    dom: { isConnected: true },
    state: { selection: { main: { from: pos, to: pos } } },
    dispatch: (spec: { changes: { from: number; to: number; insert: string } }) => {
      dispatched.push(spec)
    },
    focus: () => {},
  } as unknown as EditorView
  return { view, dispatched }
}

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => {
  sharedDb = await createTestDb()
})
afterAll(async () => {
  await sharedDb.cleanup()
})

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  let now = 1700_000_000_000
  let id = 0
  ;({ repo } = createTestRepo({
    db: sharedDb.db,
    user: { id: 'user-1' },
    now: () => ++now,
    newId: () => `generated-${++id}`,
  }))
})

const makeBlock = async (id: string, content?: string, types?: string[]) => {
  await repo.tx(
    tx => tx.create({
      id, workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content,
      properties: types ? { types } : undefined,
    }),
    { scope: ChangeScope.BlockDefault, description: 'create' },
  )
  return repo.block(id)
}

const rawContent = async (id: string): Promise<string> =>
  (await sharedDb.db.get<{ content: string }>('SELECT content FROM blocks WHERE id = ?', [id])).content

describe('insertReferences — editor-unmounted fallback (appends)', () => {
  it('appends references on a new line after existing content', async () => {
    const block = await makeBlock('b1', 'hello')
    await insertReferences(disconnectedEditor, block, ['((a))'])
    expect((await block.load())?.content).toBe('hello\n((a))')
  })

  it('writes just the references into an empty block (no leading newline)', async () => {
    const block = await makeBlock('b2', '')
    await insertReferences(disconnectedEditor, block, ['((a))', '((b))'])
    expect((await block.load())?.content).toBe('((a))\n((b))')
  })

  it('does NOT write to a deleted block', async () => {
    const block = await makeBlock('b3', 'keep')
    await block.delete()

    await insertReferences(disconnectedEditor, block, ['((a))'])
    expect(await block.load()).toBeNull()
    expect(await rawContent('b3')).toBe('keep')
  })

  it.each(['html-document', 'extension'])('leaves %s source as written', async type => {
    const source = '<pre>\n  keep\n</pre>\n\n'
    const block = await makeBlock('src', source, [type])
    await block.load()

    await insertReferences(disconnectedEditor, block, ['((a))'])
    expect(await rawContent('src')).toBe(source)
  })
})

describe('picking images into a source block', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['at the caret', (block: Block) => pickAndInsertImages({ editorView: liveEditorAt(0).view, block })],
    ['by appending', pickImagesIntoBlock],
  ])('refuses %s before the picker opens', async (_name, pick) => {
    const createElement = vi.fn(() => {
      throw new Error('the picker opened')
    })
    vi.stubGlobal('document', { createElement })
    const block = await makeBlock('doc', '<p>x</p>', ['html-document'])
    await block.load()

    await pick(block)
    expect(createElement).not.toHaveBeenCalled()
  })
})

describe('insertReferences — live editor (inserts at the current selection)', () => {
  it('inserts at the editor live selection, not a stale pre-picker offset', async () => {
    const block = await makeBlock('b4', 'abcdef')
    // The doc/selection moved while the picker was open; insertReferences must
    // read the editor's CURRENT caret (7), not any earlier snapshot.
    const { view, dispatched } = liveEditorAt(7)
    await insertReferences(view, block, ['((a))'])
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].changes).toMatchObject({ from: 7, to: 7, insert: '((a))' })
  })
})

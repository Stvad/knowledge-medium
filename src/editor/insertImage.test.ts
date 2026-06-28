// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { EditorView } from '@codemirror/view'
import { ChangeScope } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { insertReferences } from './insertImage.js'

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

const makeBlock = async (id: string, content?: string) => {
  await repo.tx(
    tx => tx.create({ id, workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content }),
    { scope: ChangeScope.BlockDefault, description: 'create' },
  )
  return repo.block(id)
}

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

  it('does NOT write to a deleted block (guard bails before deref)', async () => {
    const block = await makeBlock('b3', 'keep')
    await block.delete()

    // Without the `if (!data) return` guard, `data.content` would throw on the
    // deleted row (load() resolves null); with it, this is a clean no-op and the
    // block stays deleted.
    await expect(insertReferences(disconnectedEditor, block, ['((a))'])).resolves.toBeUndefined()
    expect(await block.load()).toBeNull()
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

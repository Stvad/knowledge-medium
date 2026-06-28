// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { EditorView } from '@codemirror/view'
import { ChangeScope } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { insertReferencesAtCaret } from './insertImage.js'

// A disconnected editor forces insertReferencesAtCaret down its direct-write
// fallback (the path taken when the editor unmounted while the OS picker was
// open). `dom.isConnected` is the only field that branch reads, so a tiny stub
// is enough — the live-editor branch needs a real CodeMirror view we don't build
// here and isn't what these tests cover.
const disconnectedEditor = { dom: { isConnected: false } } as unknown as EditorView

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

describe('insertReferencesAtCaret — editor-unmounted fallback', () => {
  it('writes references at the caret into a still-live block', async () => {
    await repo.tx(
      tx => tx.create({ id: 'b1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'hello' }),
      { scope: ChangeScope.BlockDefault, description: 'create' },
    )
    const block = repo.block('b1')

    await insertReferencesAtCaret(disconnectedEditor, block, { from: 5, to: 5 }, ['((a))'])

    expect((await block.load())?.content).toBe('hello((a))')
  })

  it('does NOT resurrect a deleted block (no image-only overwrite)', async () => {
    await repo.tx(
      tx => tx.create({ id: 'b2', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'keep' }),
      { scope: ChangeScope.BlockDefault, description: 'create' },
    )
    const block = repo.block('b2')
    await block.delete()

    await insertReferencesAtCaret(disconnectedEditor, block, { from: 0, to: 4 }, ['((a))'])

    // The guard bailed: the tombstone stays gone instead of coming back carrying
    // only the image reference. (Before the guard, the `?? ''` overwrite wrote
    // '((a))' into the deleted row, resurrecting it.)
    expect(await block.load()).toBeNull()
  })
})

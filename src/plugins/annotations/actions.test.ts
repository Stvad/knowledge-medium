// @vitest-environment happy-dom
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {EditorSelection, EditorState} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {ChangeScope} from '@/data/api'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {editorContentFlushFacet} from '@/editor/contentFlush.js'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {anchorFromEditor, submitComposer} from './actions'
import {resolveAnchor} from './anchor'
import {annotationsDataExtension} from './dataExtension'
import {THREAD_IDS_FOR_BLOCK_QUERY} from './queries'
import {threadAnchorOf} from './schema'
import {closeComposer, openComposer, peekComposer, updateComposer} from './uiStore'

const WS = 'ws'
const TEXT = 'We moved the launch to Thursday because the vendor slipped.'
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let repo: Repo
let view: EditorView | null = null
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: {id: 'alex'}, extensions: [referencesDataExtension, annotationsDataExtension]}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(tx => tx.create({id: 'B', workspaceId: WS, parentId: null, orderKey: 'a0', content: TEXT}), opts)
})
afterEach(() => {
  view?.destroy()
  view = null
  closeComposer('B')
})

/** An editor over B whose persistence is BlockEditor's shape: edits wait in a
 *  debounce until something flushes them. */
const editorOnB = () => {
  let pending: string | null = null
  view = new EditorView({
    state: EditorState.create({
      doc: TEXT,
      extensions: [
        editorContentFlushFacet.of(() => {
          if (pending === null) return
          void repo.mutate.setContent({id: 'B', content: pending})
          pending = null
        }),
        EditorView.updateListener.of(update => {
          if (update.docChanged) pending = update.state.doc.toString()
        }),
      ],
    }),
  })
  return view
}

const select = (editor: EditorView, quote: string) => {
  const from = editor.state.doc.toString().indexOf(quote)
  editor.dispatch({selection: EditorSelection.single(from, from + quote.length)})
}

const threadsOnB = () => repo.query[THREAD_IDS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'B'}).load()

describe('commenting on an editor selection', () => {
  it('anchors an edit still waiting in the debounce against what the editor shows', async () => {
    const editor = editorOnB()
    editor.dispatch({changes: {from: 0, insert: 'Update: '}})
    expect((await repo.load('B'))!.content).toBe(TEXT)

    select(editor, 'Thursday')
    openComposer('B', anchorFromEditor(editor))
    updateComposer('B', {draft: 'Is Thursday confirmed?'})
    expect(await submitComposer(repo, 'B')).toBe(true)

    const [threadId] = await threadsOnB()
    const anchor = threadAnchorOf((await repo.load(threadId))!)
    if (anchor.kind !== 'range') throw new Error('expected a range anchor')
    expect(anchor.quoteStart).toBe(31)
    expect(resolveAnchor((await repo.load('B'))!.content, anchor).state).toBe('exact')
    expect(peekComposer('B')).toBeUndefined()
  })

  it('refuses when the target changed under the selection, keeping the draft', async () => {
    const editor = editorOnB()
    select(editor, 'Thursday')
    openComposer('B', anchorFromEditor(editor))
    updateComposer('B', {draft: 'Is Thursday confirmed?'})

    await repo.tx(tx => tx.update('B', {content: `Elsewhere: ${TEXT}`}), opts)
    expect(await submitComposer(repo, 'B')).toBe(false)
    expect(await threadsOnB()).toEqual([])
    expect(peekComposer('B')).toMatchObject({draft: 'Is Thursday confirmed?', error: expect.stringMatching(/changed/)})

    // Reselecting re-aims the composer and keeps the draft.
    openComposer('B', null)
    expect(peekComposer('B')).toMatchObject({anchor: null, draft: 'Is Thursday confirmed?', error: null})
    expect(await submitComposer(repo, 'B')).toBe(true)
    expect(await threadsOnB()).toHaveLength(1)
  })

  it('writes nothing for an empty draft', async () => {
    openComposer('B', null)
    updateComposer('B', {draft: '   '})
    expect(await submitComposer(repo, 'B')).toBe(false)
    expect(await threadsOnB()).toEqual([])
  })

  it('comments on the whole block when nothing is selected', () => {
    const editor = editorOnB()
    editor.dispatch({selection: EditorSelection.single(5)})
    expect(anchorFromEditor(editor)).toBeNull()
  })
})

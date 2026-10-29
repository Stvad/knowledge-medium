// @vitest-environment happy-dom
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {EditorSelection, EditorState} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {ChangeScope} from '@/data/api'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {editorContentFlushFacet} from '@/editor/contentFlush.js'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {backlinkRenderScopeId, panelRenderScopeId} from '@/utils/renderScope.js'
import {focusedBlockLocationProp, isEditingProp} from '@/data/properties.js'
import {anchorFromEditor, annotationActions, COMMENT_ON_BLOCK_ACTION_ID, COMMENT_ON_SELECTION_ACTION_ID, submitComposer} from './actions'
import {resolveAnchor} from './anchor'
import {annotationsDataExtension} from './dataExtension'
import {THREAD_IDS_FOR_BLOCK_QUERY} from './queries'
import {threadAnchorOf} from './schema'
import {closeComposer, openComposer, peekComposer, updateComposer, viewKey} from './uiStore'

const WS = 'ws'
const TEXT = 'We moved the launch to Thursday because the vendor slipped.'
const opts = {scope: ChangeScope.BlockDefault}
const KEY = viewKey(undefined, 'B')
const PANEL = panelRenderScopeId('p', 'page')

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
  closeComposer(KEY)
  closeComposer(viewKey(PANEL, 'B'))
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
    openComposer(KEY, 'B', anchorFromEditor(editor))
    updateComposer(KEY, {draft: 'Is Thursday confirmed?'})
    expect(await submitComposer(repo, KEY)).toBe(true)

    const [threadId] = await threadsOnB()
    const anchor = threadAnchorOf((await repo.load(threadId))!)
    if (anchor.kind !== 'range') throw new Error('expected a range anchor')
    expect(anchor.quoteStart).toBe(31)
    expect(resolveAnchor((await repo.load('B'))!.content, anchor).state).toBe('exact')
    expect(peekComposer(KEY)).toBeUndefined()
  })

  it('refuses when the target changed under the selection, keeping the draft', async () => {
    const editor = editorOnB()
    select(editor, 'Thursday')
    openComposer(KEY, 'B', anchorFromEditor(editor))
    updateComposer(KEY, {draft: 'Is Thursday confirmed?'})

    await repo.tx(tx => tx.update('B', {content: `Elsewhere: ${TEXT}`}), opts)
    expect(await submitComposer(repo, KEY)).toBe(false)
    expect(await threadsOnB()).toEqual([])
    expect(peekComposer(KEY)).toMatchObject({draft: 'Is Thursday confirmed?', error: expect.stringMatching(/changed/)})

    // Reselecting re-aims the composer and keeps the draft.
    openComposer(KEY, 'B', null)
    expect(peekComposer(KEY)).toMatchObject({anchor: null, draft: 'Is Thursday confirmed?', error: null})
    expect(await submitComposer(repo, KEY)).toBe(true)
    expect(await threadsOnB()).toHaveLength(1)
  })

  it('writes one thread when a second submit lands while the first is in flight', async () => {
    openComposer(KEY, 'B', null)
    updateComposer(KEY, {draft: 'Once'})
    expect(await Promise.all([submitComposer(repo, KEY), submitComposer(repo, KEY)])).toEqual([true, false])
    expect(await threadsOnB()).toHaveLength(1)
  })

  it('writes nothing for an empty draft', async () => {
    openComposer(KEY, 'B', null)
    updateComposer(KEY, {draft: '   '})
    expect(await submitComposer(repo, KEY)).toBe(false)
    expect(await threadsOnB()).toEqual([])
  })

  it('opens the composer only on an outline block, where it can render', async () => {
    const commentOnBlock = annotationActions.find(action => action.id === COMMENT_ON_BLOCK_ACTION_ID)!
    const deps = {block: repo.block('B'), uiStateBlock: repo.block('B')}
    const nested = backlinkRenderScopeId(PANEL, 'x')
    await commentOnBlock.handler({...deps, renderScopeId: nested} as never, new CustomEvent('test'))
    expect(peekComposer(viewKey(nested, 'B'))).toBeUndefined()
    await commentOnBlock.handler({...deps, renderScopeId: PANEL} as never, new CustomEvent('test'))
    expect(peekComposer(viewKey(PANEL, 'B'))).toMatchObject({targetId: 'B', anchor: null})
  })

  it('leaves edit mode when it opens the composer, so later keys cannot reach the editor', async () => {
    await repo.tx(async tx => {
      await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'b0', content: ''})
      await tx.setProperty('ui', focusedBlockLocationProp, {blockId: 'B', renderScopeId: PANEL})
      await tx.setProperty('ui', isEditingProp, true)
    }, {scope: ChangeScope.UiState})
    const editor = editorOnB()
    select(editor, 'Thursday')
    const commentOnSelection = annotationActions.find(action => action.id === COMMENT_ON_SELECTION_ACTION_ID)!
    await commentOnSelection.handler({block: repo.block('B'), uiStateBlock: repo.block('ui'), renderScopeId: PANEL, editorView: editor} as never, new CustomEvent('test'))
    expect(peekComposer(viewKey(PANEL, 'B'))?.anchor?.quote).toBe('Thursday')
    await vi.waitFor(async () => expect((await repo.load('ui'))!.properties[isEditingProp.name]).toBe(false))
  })

  it('comments on the whole block when nothing is selected', () => {
    const editor = editorOnB()
    editor.dispatch({selection: EditorSelection.single(5)})
    expect(anchorFromEditor(editor)).toBeNull()
  })
})

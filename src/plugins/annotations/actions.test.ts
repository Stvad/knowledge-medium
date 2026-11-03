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
import {backlinkRenderScopeId, panelRenderScopeId, surfaceRenderScopeId} from '@/utils/renderScope.js'
import {focusedBlockLocationProp, isEditingProp} from '@/data/properties.js'
import {
  anchorOf,
  annotationActions,
  COMMENT_ON_BLOCK_ACTION_ID,
  COMMENT_ON_SELECTION_ACTION_ID,
  COPY_REFERENCE_TO_SELECTION_ACTION_ID,
  commentOnTarget,
  copyReferenceToTarget,
  highlightTarget,
  rangeFromEditor,
  submitComposer,
} from './actions'
import {resolveAnchor} from './anchor'
import {annotationsDataExtension} from './dataExtension'
import {THREAD_IDS_FOR_BLOCK_QUERY} from './queries'
import {threadAnchorOf} from './schema'
import {createThread} from './threads'
import {closeComposer, openComposer, peekComposer, peekPendingReanchor, releasePendingReanchor, startReanchor, updateComposer, viewKey} from './uiStore'

const clipboard = vi.hoisted(() => ({write: vi.fn<(text: string) => Promise<void>>()}))
const toasts = vi.hoisted(() => ({info: vi.fn(), error: vi.fn()}))

vi.mock('@/utils/copy.js', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/copy.js')>(),
  writeTextToClipboard: clipboard.write,
}))

vi.mock('@/utils/toast.js', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/toast.js')>(),
  showInfo: toasts.info,
  showError: toasts.error,
}))

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
  startReanchor(null)
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
  it.each([['Comment', commentOnTarget], ['Highlight', highlightTarget]] as const)(
    '%s refuses a nested target and runs on the outline', async (_label, step) => {
      const renderScopeId = backlinkRenderScopeId(PANEL, 'x')
      const from = TEXT.indexOf('Thursday')
      const target = {block: repo.block('B'), renderScopeId, range: {content: TEXT, from, to: from + 'Thursday'.length}}
      expect(await step(target)).toBe(false)
      expect(peekComposer(viewKey(renderScopeId, 'B'))).toBeUndefined()
      expect(await threadsOnB()).toEqual([])
      expect(await step({...target, renderScopeId: PANEL})).toBe(true)
    },
  )

  it('anchors an edit still waiting in the debounce against what the editor shows', async () => {
    const editor = editorOnB()
    editor.dispatch({changes: {from: 0, insert: 'Update: '}})
    expect((await repo.load('B'))!.content).toBe(TEXT)

    select(editor, 'Thursday')
    openComposer(KEY, 'B', anchorOf(rangeFromEditor(editor)))
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
    openComposer(KEY, 'B', anchorOf(rangeFromEditor(editor)))
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

  it('keeps the draft as submitted while the submit is in flight', async () => {
    openComposer(KEY, 'B', null)
    updateComposer(KEY, {draft: 'Once'})
    const submitted = submitComposer(repo, KEY)
    updateComposer(KEY, {draft: 'Once, and more typed meanwhile'})
    expect(peekComposer(KEY)?.draft).toBe('Once')
    expect(await submitted).toBe(true)
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

  it('re-anchors a pending thread from the editor of its target in a card, where no composer opens', async () => {
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'x'})
    const commentOnSelection = annotationActions.find(action => action.id === COMMENT_ON_SELECTION_ACTION_ID)!
    const editor = editorOnB()
    select(editor, 'Thursday')
    const inCard = {block: repo.block('B'), uiStateBlock: repo.block('B'), renderScopeId: surfaceRenderScopeId('margin', PANEL, 'T'), editorView: editor}
    expect(commentOnSelection.isVisible!(inCard as never)).toBe(false)

    startReanchor({threadId, targetId: 'B'})
    expect(commentOnSelection.isVisible!(inCard as never)).toBe(true)
    await commentOnSelection.handler(inCard as never, new CustomEvent('test'))
    expect((await repo.load(threadId))!.content).toBe('Thursday')
    expect(peekPendingReanchor()).toBeNull()
  })

  it('opens a composer, leaving a pending thread alone, in a block that is not its target', async () => {
    await repo.tx(tx => tx.create({id: 'C', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Another block entirely.'}), opts)
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'x'})
    startReanchor({threadId, targetId: 'B'})
    const commentOnSelection = annotationActions.find(action => action.id === COMMENT_ON_SELECTION_ACTION_ID)!
    view = new EditorView({state: EditorState.create({doc: 'Another block entirely.'})})
    view.dispatch({selection: EditorSelection.single(0, 7)})
    await commentOnSelection.handler({block: repo.block('C'), uiStateBlock: repo.block('C'), renderScopeId: PANEL, editorView: view} as never, new CustomEvent('test'))
    expect(peekComposer(viewKey(PANEL, 'C'))?.anchor?.quote).toBe('Another')
    expect((await repo.load(threadId))!.content).toBe('')
    expect(peekPendingReanchor()).toEqual({threadId, targetId: 'B'})
    closeComposer(viewKey(PANEL, 'C'))
  })

  it('ends a pending re-anchor with the card that shows it, not with another thread\u2019s', () => {
    startReanchor({threadId: 'T', targetId: 'B'})
    releasePendingReanchor('U')
    expect(peekPendingReanchor()).toEqual({threadId: 'T', targetId: 'B'})
    releasePendingReanchor('T')
    expect(peekPendingReanchor()).toBeNull()
  })
})

describe('copying a reference to a selection', () => {
  beforeEach(() => {
    clipboard.write.mockReset().mockResolvedValue(undefined)
    toasts.info.mockReset()
    toasts.error.mockReset()
  })

  const target = (from: number, to: number) => ({block: repo.block('B'), renderScopeId: undefined, range: {content: TEXT, from, to}})
  const thursday = TEXT.indexOf('Thursday')

  it('quotes what the editor shows, in a backlink entry too, where commenting does not run', async () => {
    const editor = editorOnB()
    editor.dispatch({changes: {from: 0, insert: 'Update: '}})
    select(editor, 'Thursday')
    const copy = annotationActions.find(action => action.id === COPY_REFERENCE_TO_SELECTION_ACTION_ID)!
    const deps = {block: repo.block('B'), uiStateBlock: repo.block('B'), renderScopeId: backlinkRenderScopeId(PANEL, 'x'), editorView: editor}

    await copy.handler(deps as never, new CustomEvent('test'))

    const [threadId] = await threadsOnB()
    expect(clipboard.write).toHaveBeenCalledWith(`((${threadId}))`)
    const anchor = threadAnchorOf((await repo.load(threadId))!)
    if (anchor.kind !== 'range') throw new Error('expected a range anchor')
    expect(anchor).toMatchObject({quote: 'Thursday', quoteStart: 31})
    expect(resolveAnchor((await repo.load('B'))!.content, anchor).state).toBe('exact')
  })

  it('copies nothing for an empty selection', async () => {
    expect(await copyReferenceToTarget(target(thursday, thursday))).toBe(false)
    expect(toasts.info).toHaveBeenCalled()
    expect(clipboard.write).not.toHaveBeenCalled()
    expect(await threadsOnB()).toEqual([])
  })

  it('keeps the highlight when the browser refuses the clipboard, and the retry reuses it', async () => {
    clipboard.write.mockRejectedValueOnce(new DOMException('Document is not focused.', 'NotAllowedError'))

    expect(await copyReferenceToTarget(target(thursday, thursday + 'Thursday'.length))).toBe(false)
    expect(toasts.error).toHaveBeenCalled()
    const [threadId] = await threadsOnB()
    expect(threadId).toBeDefined()

    expect(await copyReferenceToTarget(target(thursday, thursday + 'Thursday'.length))).toBe(true)
    expect(clipboard.write).toHaveBeenLastCalledWith(`((${threadId}))`)
  })
})

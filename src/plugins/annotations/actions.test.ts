// @vitest-environment happy-dom
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {EditorSelection, EditorState} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {ChangeScope} from '@/data/api'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo, childrenOf} from '@/data/test/createTestRepo'
import {editorContentFlushFacet} from '@/editor/contentFlush.js'
import {ActionContextTypes} from '@/shortcuts/types.js'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {backlinkRenderScopeId, panelRenderScopeId, surfaceRenderScopeId} from '@/utils/renderScope.js'
import {focusedBlockLocationProp, isEditingBlock, isEditingProp} from '@/data/properties.js'
import {
  annotationActions,
  COMMENT_ON_BLOCK_ACTION_ID,
  COMMENT_ON_SELECTION_ACTION_ID,
  COPY_REFERENCE_TO_SELECTION_ACTION_ID,
  commentOnTarget,
  copyReferenceToTarget,
  highlightTarget,
  rangeFromEditor,
} from './actions'
import {resolveAnchor} from './anchor'
import {annotationsDataExtension} from './dataExtension'
import {THREAD_IDS_FOR_BLOCK_QUERY} from './queries'
import {threadAnchorOf} from './schema'
import {createThread, missingTarget} from './threads'
import {cardRenderScopeId, peekPendingReanchor, releasePendingReanchor, setMarginShowing, startReanchor} from './uiStore'

const clipboard = vi.hoisted(() => ({write: vi.fn<(text: string | Promise<string>) => Promise<void>>()}))
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
  await repo.tx(async tx => {
    await tx.create({id: 'B', workspaceId: WS, parentId: null, orderKey: 'a0', content: TEXT})
    // The panel: its UI state is its own row.
    await tx.create({id: 'p', workspaceId: WS, parentId: null, orderKey: 'a1', content: ''})
  }, opts)
  toasts.error.mockClear()
})
afterEach(() => {
  view?.destroy()
  view = null
  startReanchor(null)
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

describe.each([ActionContextTypes.NORMAL_MODE, ActionContextTypes.EDIT_MODE_CM])('block comment toggle availability in %s', context => {
  const action = () => annotationActions.find(action => action.id === 'annotations.toggleBlockComments' && action.context === context)!
  const deps = (renderScopeId: string) => ({block: repo.block('B'), uiStateBlock: repo.block('p'), renderScopeId})

  afterEach(() => setMarginShowing('p', false))

  it('offers and dispatches the toggle on the outline', () => {
    expect(action().isVisible!(deps(PANEL))).toBe(true)
    expect(action().canDispatch!(deps(PANEL))).toBe(true)
  })

  it('does not offer or dispatch the toggle on a nested surface with no inline comments', () => {
    const nested = deps(backlinkRenderScopeId(PANEL, 'x'))
    expect(action().isVisible!(nested)).toBe(false)
    expect(action().canDispatch!(nested)).toBe(false)
  })

  it('does not offer or dispatch an inline toggle while that panel draws its comments in the margin', () => {
    setMarginShowing('p', true)
    expect(action().isVisible!(deps(PANEL))).toBe(false)
    expect(action().canDispatch!(deps(PANEL))).toBe(false)
    const otherPanel = deps(panelRenderScopeId('other-panel', 'page'))
    expect(action().isVisible!(otherPanel)).toBe(true)
    expect(action().canDispatch!(otherPanel)).toBe(true)
  })
})

describe('commenting on an editor selection', () => {
  it.each([['Comment', commentOnTarget], ['Highlight', highlightTarget]] as const)(
    '%s refuses a nested target and runs on the outline', async (_label, step) => {
      const renderScopeId = backlinkRenderScopeId(PANEL, 'x')
      const from = TEXT.indexOf('Thursday')
      const target = {block: repo.block('B'), renderScopeId, range: {content: TEXT, from, to: from + 'Thursday'.length}}
      expect(await step(target)).toBe(false)
      expect(await threadsOnB()).toEqual([])
      expect(await step({...target, renderScopeId: PANEL})).toBe(true)
    },
  )

  it('anchors an edit still waiting in the debounce against what the editor shows', async () => {
    const editor = editorOnB()
    editor.dispatch({changes: {from: 0, insert: 'Update: '}})
    expect((await repo.load('B'))!.content).toBe(TEXT)

    select(editor, 'Thursday')
    expect(await commentOnTarget({block: repo.block('B'), renderScopeId: PANEL, range: rangeFromEditor(editor)})).toBe(true)

    const [threadId] = await threadsOnB()
    const anchor = threadAnchorOf((await repo.load(threadId))!)
    if (anchor.kind !== 'range') throw new Error('expected a range anchor')
    expect(anchor.quoteStart).toBe(31)
    expect(resolveAnchor((await repo.load('B'))!.content, anchor).state).toBe('exact')
  })

  it('writes nothing when the target changed under the selection, and says why', async () => {
    const editor = editorOnB()
    select(editor, 'Thursday')
    const range = rangeFromEditor(editor)

    await repo.tx(tx => tx.update('B', {content: `Elsewhere: ${TEXT}`}), opts)
    expect(await commentOnTarget({block: repo.block('B'), renderScopeId: PANEL, range})).toBe(false)
    expect(await threadsOnB()).toEqual([])
    expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/changed/))
  })

  it('starts a comment only on an outline block, where its card can render', async () => {
    const commentOnBlock = annotationActions.find(action => action.id === COMMENT_ON_BLOCK_ACTION_ID)!
    const deps = {block: repo.block('B'), uiStateBlock: repo.block('p')}
    await commentOnBlock.handler({...deps, renderScopeId: backlinkRenderScopeId(PANEL, 'x')} as never, new CustomEvent('test'))
    expect(await threadsOnB()).toEqual([])
    await commentOnBlock.handler({...deps, renderScopeId: PANEL} as never, new CustomEvent('test'))
    const [threadId] = await threadsOnB()
    expect(threadAnchorOf((await repo.load(threadId))!)).toEqual({kind: 'block'})
  })

  it('moves edit mode from the target to the new comment, so later keys cannot reach the target', async () => {
    await repo.tx(async tx => {
      await tx.setProperty('p', focusedBlockLocationProp, {blockId: 'B', renderScopeId: PANEL})
      await tx.setProperty('p', isEditingProp, true)
    }, {scope: ChangeScope.UiState})
    const editor = editorOnB()
    select(editor, 'Thursday')
    const commentOnSelection = annotationActions.find(action => action.id === COMMENT_ON_SELECTION_ACTION_ID)!
    await commentOnSelection.handler({block: repo.block('B'), uiStateBlock: repo.block('p'), renderScopeId: PANEL, editorView: editor} as never, new CustomEvent('test'))
    const [threadId] = await threadsOnB()
    const [comment] = await childrenOf(repo, threadId)
    expect(isEditingBlock(repo.block('p'), comment.id, cardRenderScopeId('comments', PANEL, threadId))).toBe(true)
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

  it('starts a comment, leaving a pending thread alone, in a block that is not its target', async () => {
    await repo.tx(tx => tx.create({id: 'C', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Another block entirely.'}), opts)
    const {threadId} = await createThread(repo, {targetId: 'B', anchor: null, comment: 'x'})
    startReanchor({threadId, targetId: 'B'})
    const commentOnSelection = annotationActions.find(action => action.id === COMMENT_ON_SELECTION_ACTION_ID)!
    view = new EditorView({state: EditorState.create({doc: 'Another block entirely.'})})
    view.dispatch({selection: EditorSelection.single(0, 7)})
    await commentOnSelection.handler({block: repo.block('C'), uiStateBlock: repo.block('C'), renderScopeId: PANEL, editorView: view} as never, new CustomEvent('test'))
    const [onC] = await repo.query[THREAD_IDS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'C'}).load()
    expect((await repo.load(onC))!.content).toBe('Another')
    expect((await repo.load(threadId))!.content).toBe('')
    expect(peekPendingReanchor()).toEqual({threadId, targetId: 'B'})
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
    // Like the browser's write, it settles with the text it was handed.
    clipboard.write.mockReset().mockImplementation(async text => { await text })
    toasts.info.mockReset()
    toasts.error.mockReset()
  })

  const target = (from: number, to: number) => ({block: repo.block('B'), renderScopeId: undefined, range: {content: TEXT, from, to}})
  const thursday = TEXT.indexOf('Thursday')
  /** The text the last write put on the clipboard. */
  const copiedText = async () => await clipboard.write.mock.lastCall![0]

  it('quotes what the editor shows, in a backlink entry too, where commenting does not run', async () => {
    const editor = editorOnB()
    editor.dispatch({changes: {from: 0, insert: 'Update: '}})
    select(editor, 'Thursday')
    const copy = annotationActions.find(action => action.id === COPY_REFERENCE_TO_SELECTION_ACTION_ID)!
    const deps = {block: repo.block('B'), uiStateBlock: repo.block('B'), renderScopeId: backlinkRenderScopeId(PANEL, 'x'), editorView: editor}

    await copy.handler(deps as never, new CustomEvent('test'))

    const [threadId] = await threadsOnB()
    expect(await copiedText()).toBe(`((${threadId}))`)
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
    expect(await copiedText()).toBe(`((${threadId}))`)
  })

  it('shows why a highlight can\u2019t be made, and not that the clipboard refused', async () => {
    const onMissing = {...target(thursday, thursday + 'Thursday'.length), block: repo.block('missing')}

    expect(await copyReferenceToTarget(onMissing)).toBe(false)
    expect(toasts.error.mock.calls).toEqual([[missingTarget('missing').message]])
  })

  it('starts the clipboard write in the gesture, before the highlight it names exists', async () => {
    const copied = copyReferenceToTarget(target(thursday, thursday + 'Thursday'.length))
    expect(clipboard.write).toHaveBeenCalledTimes(1)

    expect(await copied).toBe(true)
    const [threadId] = await threadsOnB()
    expect(await copiedText()).toBe(`((${threadId}))`)
  })
})

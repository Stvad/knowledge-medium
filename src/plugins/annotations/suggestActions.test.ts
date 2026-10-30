// @vitest-environment happy-dom
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {EditorSelection, EditorState} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {ChangeScope} from '@/data/api'
import {focusedBlockLocationProp, isEditingProp} from '@/data/properties.js'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {backlinkRenderScopeId, panelRenderScopeId} from '@/utils/renderScope.js'
import {submitComposer} from './actions'
import {annotationsDataExtension} from './dataExtension'
import {THREAD_IDS_FOR_BLOCK_QUERY} from './queries'
import {threadReplacementOf} from './schema'
import {openSuggestionComposer, suggestEditAction} from './suggestActions'
import {closeComposer, openComposer, peekComposer, updateComposer, viewKey} from './uiStore'

const WS = 'ws'
const TEXT = 'We moved the launch to Thursday because the vendor slipped.'
const opts = {scope: ChangeScope.BlockDefault}
const PANEL = panelRenderScopeId('p', 'page')
const KEY = viewKey(PANEL, 'B')

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
    await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'b0', content: ''})
  }, opts)
})
afterEach(() => {
  view?.destroy()
  view = null
  closeComposer(KEY)
})

const editorSelecting = (quote: string) => {
  view = new EditorView({state: EditorState.create({doc: TEXT})})
  const from = TEXT.indexOf(quote)
  view.dispatch({selection: EditorSelection.single(from, from + quote.length)})
  return view
}

const suggest = (editor: EditorView, renderScopeId = PANEL) => suggestEditAction.handler(
  {block: repo.block('B'), uiStateBlock: repo.block('ui'), renderScopeId, editorView: editor} as never,
  new CustomEvent('test'),
)

const threadsOnB = () => repo.query[THREAD_IDS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'B'}).load()

describe('suggesting an edit to a selection', () => {
  it('opens the composer with the replacement prefilled, and leaves edit mode', async () => {
    await repo.tx(async tx => {
      await tx.setProperty('ui', focusedBlockLocationProp, {blockId: 'B', renderScopeId: PANEL})
      await tx.setProperty('ui', isEditingProp, true)
    }, {scope: ChangeScope.UiState})
    await suggest(editorSelecting('Thursday'))
    expect(peekComposer(KEY)).toMatchObject({targetId: 'B', anchor: {quote: 'Thursday', quoteStart: 23}, replacement: 'Thursday', draft: ''})
    await vi.waitFor(async () => expect((await repo.load('ui'))!.properties[isEditingProp.name]).toBe(false))
  })

  it('needs a selection, and an outline block, where the composer renders', async () => {
    view = new EditorView({state: EditorState.create({doc: TEXT})})
    await suggest(view)
    expect(peekComposer(KEY)).toBeUndefined()

    const nested = backlinkRenderScopeId(PANEL, 'x')
    expect(suggestEditAction.isVisible!({renderScopeId: nested} as never)).toBe(false)
    await suggest(editorSelecting('Thursday'), nested)
    expect(peekComposer(viewKey(nested, 'B'))).toBeUndefined()
  })

  it('opens from a raw range of the text, widened to whole reference spans, as a read-mode trigger would', () => {
    const content = 'See [[Launch plan]] for dates.'
    expect(openSuggestionComposer('B', PANEL, {content, from: 8, to: 12})).toBe(true)
    expect(peekComposer(KEY)).toMatchObject({anchor: {quote: '[[Launch plan]]', quoteStart: 4}, replacement: '[[Launch plan]]'})
    expect(openSuggestionComposer('C', PANEL, {content, from: 3, to: 3})).toBe(false)
    expect(peekComposer(viewKey(PANEL, 'C'))).toBeUndefined()
  })

  it('writes a suggestion with no comment, and with one', async () => {
    await suggest(editorSelecting('Thursday'))
    updateComposer(KEY, {replacement: 'Thursday 9am'})
    expect(await submitComposer(repo, KEY)).toBe(true)
    const [bare] = await threadsOnB()
    expect(threadReplacementOf((await repo.load(bare))!)).toBe('Thursday 9am')
    expect(await repo.block(bare).children.load()).toEqual([])

    await suggest(editorSelecting('vendor'))
    updateComposer(KEY, {replacement: 'supplier', draft: 'Per the contract.'})
    expect(await submitComposer(repo, KEY)).toBe(true)
    const withComment = (await threadsOnB()).find(id => id !== bare)!
    expect((await repo.block(withComment).children.load()).map(child => child.content)).toEqual(['Per the contract.'])
  })

  it('submits nothing for an empty replacement, and refuses an unchanged one, keeping the composer', async () => {
    await suggest(editorSelecting('Thursday'))
    updateComposer(KEY, {replacement: ''})
    expect(await submitComposer(repo, KEY)).toBe(false)
    updateComposer(KEY, {replacement: 'Thursday'})
    expect(await submitComposer(repo, KEY)).toBe(false)
    expect(peekComposer(KEY)).toMatchObject({replacement: 'Thursday', error: expect.stringMatching(/same as the quoted text/)})
    expect(await threadsOnB()).toEqual([])
  })

  it('keeps the replacement as submitted while the submit is in flight', async () => {
    await suggest(editorSelecting('Thursday'))
    updateComposer(KEY, {replacement: 'Thursday 9am'})
    const submitted = submitComposer(repo, KEY)
    updateComposer(KEY, {replacement: 'Thursday 9am, and more typed meanwhile'})
    expect(peekComposer(KEY)?.replacement).toBe('Thursday 9am')
    expect(await submitted).toBe(true)
  })

  it('keeps a typed replacement when the composer is re-aimed, and drops it for a comment', async () => {
    await suggest(editorSelecting('Thursday'))
    updateComposer(KEY, {replacement: 'Thursday 9am'})
    await suggest(editorSelecting('Thursday because'))
    expect(peekComposer(KEY)).toMatchObject({anchor: {quote: 'Thursday because'}, replacement: 'Thursday 9am'})
    openComposer(KEY, 'B', null)
    expect(peekComposer(KEY)?.replacement).toBeUndefined()
  })
})

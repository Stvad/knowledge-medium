// @vitest-environment happy-dom
/**
 * The real source editor against the boundary the block shortcuts listen on:
 * `HotkeyReconciler` reads keydown on window, in the bubble phase, so a key that
 * reaches window here would split, re-nest or merge the document in the app.
 */
import {Suspense} from 'react'
import {cleanup, render} from '@testing-library/react'
import {EditorView} from '@codemirror/view'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope, type User} from '@/data/api'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {Repo} from '@/data/repo'
import {resolveFacetRuntimeSync} from '@/facets/facet'
import {AppRuntimeContextProvider} from '@/extensions/runtimeContext'
import {ActiveContextsProvider} from '@/shortcuts/ActiveContexts'
import {BlockContextProvider} from '@/context/block'
import {RepoContext} from '@/context/repo'
import {HtmlSourceEditor} from '../HtmlDocumentContent.tsx'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}
const BLOCK = 'html-document-block'
/** A panel row is its own ui-state block, so the real globalState hooks read it. */
const PANEL = 'panel'
const SOURCE = '<p>hi</p>'

vi.mock('@/components/Login.tsx', () => ({useUser: () => USER}))

describe('the HTML source editor', () => {
  let sharedDb: TestDb
  let repo: Repo
  let reachedWindow: string[] = []
  const onWindowKey = (event: KeyboardEvent) => reachedWindow.push(event.key)

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })

  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    repo = createTestRepo({db: sharedDb.db, user: USER}).repo
    repo.setActiveWorkspaceId(WS)
    await repo.tx(async tx => {
      await tx.create({id: PANEL, workspaceId: WS, parentId: null, orderKey: 'a0', content: ''})
      await tx.create({id: BLOCK, workspaceId: WS, parentId: null, orderKey: 'a1', content: SOURCE})
    }, {scope: ChangeScope.BlockDefault, description: 'html source editor fixture'})
    reachedWindow = []
    window.addEventListener('keydown', onWindowKey)
  })

  afterEach(() => {
    window.removeEventListener('keydown', onWindowKey)
    cleanup()
  })

  const openEditorAt = async (caret: number): Promise<EditorView> => {
    render(
      <RepoContext value={repo}>
        <AppRuntimeContextProvider value={resolveFacetRuntimeSync([])}>
          <ActiveContextsProvider>
            <Suspense fallback={null}>
              <BlockContextProvider initialValue={{panelId: PANEL}}>
                <HtmlSourceEditor block={repo.block(BLOCK)}/>
              </BlockContextProvider>
            </Suspense>
          </ActiveContextsProvider>
        </AppRuntimeContextProvider>
      </RepoContext>,
    )
    const view = await vi.waitFor(() => {
      const content = document.querySelector<HTMLElement>('.cm-content')
      const found = content && EditorView.findFromDOM(content)
      if (!found) throw new Error('editor not mounted')
      return found
    })
    view.dispatch({selection: {anchor: caret}})
    return view
  }

  const press = (view: EditorView, key: string, init: KeyboardEventInit = {}) =>
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true, ...init}))

  const doc = (view: EditorView) => view.state.doc.toString()

  it.each<[string, KeyboardEventInit]>([
    ['Enter', {}],
    ['Shift+Enter', {shiftKey: true}],
  ])('%s adds a line and stays in the editor', async (_name, init) => {
    const view = await openEditorAt('<p>'.length)
    press(view, 'Enter', init)
    expect(doc(view)).toBe('<p>\n  hi</p>')
    expect(reachedWindow).toEqual([])
  })

  it('Tab and Shift+Tab re-indent the line and stay in the editor', async () => {
    const view = await openEditorAt(0)
    press(view, 'Tab')
    expect(doc(view)).toBe(`  ${SOURCE}`)
    press(view, 'Tab', {shiftKey: true})
    expect(doc(view)).toBe(SOURCE)
    expect(reachedWindow).toEqual([])
  })

  it.each([
    ['Backspace', 'mid-source', 1, 'p>hi</p>'],
    ['Backspace', 'at the start', 0, SOURCE],
    ['Delete', 'mid-source', 0, 'p>hi</p>'],
    ['Delete', 'at the end', SOURCE.length, SOURCE],
  ])('%s %s only edits the source', async (key, _where, caret, after) => {
    const view = await openEditorAt(caret)
    press(view, key)
    expect(doc(view)).toBe(after)
    expect(reachedWindow).toEqual([])
  })

  it.each<[string, KeyboardEventInit]>([
    ['Enter', {metaKey: true}],
    ['Escape', {}],
    ['ArrowUp', {}],
  ])('%s %j still reaches the app shortcuts', async (key, init) => {
    const view = await openEditorAt(1)
    press(view, key, init)
    expect(reachedWindow).toEqual([key])
  })
})

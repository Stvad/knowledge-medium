// @vitest-environment happy-dom
/**
 * The real extension editor against the boundary the block shortcuts listen on:
 * `HotkeyReconciler` reads keydown on window, in the bubble phase, so a key that
 * reaches window here would split, re-nest or merge the block in the app.
 */
import { Suspense } from 'react'
import { cleanup, render } from '@testing-library/react'
import { completionStatus, snippet, startCompletion } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import { BlockContextProvider } from '@/context/block'
import { RepoContext } from '@/context/repo'
import { ExtensionEditor } from '@/components/renderer/CodeMirrorExtensionBlockRenderer.tsx'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}
const BLOCK = 'extension-block'
/** A panel row is its own ui-state block, so the real globalState hooks read it. */
const PANEL = 'panel'
const SOURCE = 'const alpha = 1\nalp'

vi.mock('@/components/Login.tsx', () => ({useUser: () => USER}))

describe('the extension source editor keeps the outline-edit keys', () => {
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
    }, {scope: ChangeScope.BlockDefault, description: 'extension editor fixture'})
    reachedWindow = []
    window.addEventListener('keydown', onWindowKey)
  })

  afterEach(() => {
    window.removeEventListener('keydown', onWindowKey)
    cleanup()
    vi.restoreAllMocks()
  })

  const openEditorAt = async (caret: number): Promise<EditorView> => {
    render(
      <RepoContext value={repo}>
        <AppRuntimeContextProvider value={resolveFacetRuntimeSync([])}>
          <ActiveContextsProvider>
            <Suspense fallback={null}>
              <BlockContextProvider initialValue={{panelId: PANEL}}>
                <ExtensionEditor block={repo.block(BLOCK)}/>
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

  it('Enter adds a line and stays in the editor', async () => {
    const view = await openEditorAt(5)
    press(view, 'Enter')
    expect(doc(view)).toMatch(/^const\n\s*alpha = 1\nalp$/)
    expect(reachedWindow).toEqual([])
  })

  it('Shift+Enter adds a line and stays in the editor', async () => {
    const view = await openEditorAt(5)
    press(view, 'Enter', {shiftKey: true})
    expect(doc(view)).toMatch(/^const\n\s*alpha = 1\nalp$/)
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
    ['Backspace', 'mid-source', 5, 'cons alpha = 1\nalp'],
    ['Backspace', 'at the start', 0, SOURCE],
    ['Delete', 'mid-source', 5, 'constalpha = 1\nalp'],
    ['Delete', 'at the end', SOURCE.length, SOURCE],
  ])('%s %s only edits the source', async (key, _where, caret, after) => {
    const view = await openEditorAt(caret)
    press(view, key)
    expect(doc(view)).toBe(after)
    expect(reachedWindow).toEqual([])
  })

  // The editor's own keymap keeps deciding what a key does, ahead of the fallback.
  it('Enter accepts an open completion instead of adding a line', async () => {
    const view = await openEditorAt(SOURCE.length)
    startCompletion(view)
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'))
    // CodeMirror ignores an accept for 75ms after the list opens.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_000)
    press(view, 'Enter')
    expect(doc(view)).toBe('const alpha = 1\nalpha')
    expect(reachedWindow).toEqual([])
  })

  it('Tab moves to the next snippet field instead of indenting', async () => {
    const view = await openEditorAt(SOURCE.length)
    snippet('${first} ${second}')(view, null, SOURCE.length, SOURCE.length)
    const beforeTab = doc(view)
    press(view, 'Tab')
    const {main} = view.state.selection
    expect(doc(view)).toBe(beforeTab)
    expect(view.state.sliceDoc(main.from, main.to)).toBe('second')
    expect(reachedWindow).toEqual([])
  })

  it.each<[string, KeyboardEventInit]>([
    ['Enter', {metaKey: true}],
    ['Enter', {ctrlKey: true}],
    ['Enter', {altKey: true}],
    ['Escape', {}],
    ['ArrowUp', {}],
  ])('%s %j still reaches the app shortcuts', async (key, init) => {
    const view = await openEditorAt(5)
    press(view, key, init)
    expect(reachedWindow).toEqual([key])
  })
})

/**
 * A real block's UI against the boundary the block shortcuts listen on:
 * `HotkeyReconciler` reads keydown on window, in the bubble phase, so a key that
 * reaches window here would split, re-nest or merge the block in the app.
 *
 * A test file using this still mocks `@/components/Login.tsx` itself, because
 * `vi.mock` only hoists from the file it's written in.
 */
import { Suspense, type ComponentType, type ReactElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import type { Block } from '@/data/block'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { resolveFacetRuntimeSync, type AppExtension } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import { BlockContextProvider } from '@/context/block'
import { RepoContext } from '@/context/repo'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}
export const SOURCE_BLOCK = 'source-block'
/** A panel row is its own ui-state block, so the real globalState hooks read it. */
const PANEL = 'panel'

/** Registers the suite's lifecycle hooks, so call it inside `describe`. */
export const setupBlockUi = (source: string, extensions: AppExtension = []) => {
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
      await tx.create({id: SOURCE_BLOCK, workspaceId: WS, parentId: null, orderKey: 'a1', content: source})
    }, {scope: ChangeScope.BlockDefault, description: 'source block fixture'})
    reachedWindow = []
    window.addEventListener('keydown', onWindowKey)
  })

  afterEach(() => {
    window.removeEventListener('keydown', onWindowKey)
    cleanup()
    vi.restoreAllMocks()
  })

  const mount = (ui: (block: Block) => ReactElement) =>
    render(
      <RepoContext value={repo}>
        <AppRuntimeContextProvider value={resolveFacetRuntimeSync(extensions)}>
          <ActiveContextsProvider>
            <Suspense fallback={null}>
              <BlockContextProvider initialValue={{panelId: PANEL}}>
                {ui(repo.block(SOURCE_BLOCK))}
              </BlockContextProvider>
            </Suspense>
          </ActiveContextsProvider>
        </AppRuntimeContextProvider>
      </RepoContext>,
    )

  const openEditorAt = async (Editor: ComponentType<{block: Block}>, caret: number): Promise<EditorView> => {
    mount(block => <Editor block={block}/>)
    const view = await vi.waitFor(() => {
      const content = document.querySelector<HTMLElement>('.cm-content')
      const found = content && EditorView.findFromDOM(content)
      if (!found) throw new Error('editor not mounted')
      return found
    })
    view.dispatch({selection: {anchor: caret}})
    return view
  }

  return {mount, openEditorAt, reachedWindow: () => reachedWindow}
}

export const press = (view: EditorView, key: string, init: KeyboardEventInit = {}) =>
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true, ...init}))

export const docOf = (view: EditorView) => view.state.doc.toString()

// @vitest-environment jsdom
// CodeMirror needs selectionchange delivered after its DOM update; happy-dom
// dispatches it synchronously from Selection.collapse.
/**
 * A cross-block navigation stores the caret placement for its target block.
 * The source editor's debounced selection write can fire at any point of that
 * navigation, and must never replace the target's placement.
 */
import { Suspense } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { ChangeScope, type User } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { editorSelection, focusBlock } from '@/data/properties'
import { outlineRenderScopeId } from '@/utils/renderScope'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import { BlockContextProvider } from '@/context/block'
import { RepoContext, useRepo } from '@/context/repo'
import { useInEditMode } from '@/data/globalState'
import { BlockEditor } from '@/components/BlockEditor'
import { getDefaultActions } from '@/shortcuts/defaultShortcuts'
import { enterEditModeForBlock } from '@/extensions/blockInteraction'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionTrigger,
} from '@/shortcuts/types'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}
/** A panel row is its own ui-state block, so the real globalState hooks read it. */
const PANEL = 'panel'
const ROOT = 'root'
const A_CONTENT = 'first line'

vi.mock('@/components/Login.tsx', () => ({useUser: () => USER}))

/** Debounced calls whose timer has not expired yet. */
const armedDebounces = vi.hoisted(() => new Set<{flush: () => void}>())

/** lodash's `debounce`, except its timer expires only on
 *  `expireDebounceTimers`, so a test picks the instant the editor's pending
 *  writes fire. */
vi.mock('lodash-es', async importOriginal => {
  const actual = await importOriginal<typeof import('lodash-es')>()
  const debounce = <A extends unknown[]>(fn: (...args: A) => unknown) => {
    let pending: A | undefined
    const debounced = Object.assign((...args: A) => {
      pending = args
      armedDebounces.add(debounced)
    }, {
      flush: () => {
        armedDebounces.delete(debounced)
        const args = pending
        pending = undefined
        if (args) fn(...args)
      },
      cancel: () => {
        armedDebounces.delete(debounced)
        pending = undefined
      },
    })
    return debounced
  }
  return {...actual, debounce}
})

const expireDebounceTimers = () => {
  for (const debounced of [...armedDebounces]) debounced.flush()
}

/** The outline's edit-mode shape: a block shows its editor only while it owns
 *  edit mode, so moving edit mode unmounts one editor as it mounts the next. */
function EditorWhileEditing({blockId}: {blockId: string}) {
  const repo = useRepo()
  const inEditMode = useInEditMode(blockId)
  return (
    <div data-testid={`row-${blockId}`}>
      {inEditMode && <BlockEditor block={repo.block(blockId)}/>}
    </div>
  )
}

const editorViewOf = (blockId: string): EditorView | null => {
  const dom = document.querySelector(`[data-testid="row-${blockId}"] .cm-editor`)
  return dom instanceof HTMLElement ? EditorView.findFromDOM(dom) : null
}

const editModeAction = (repo: Repo, id: string): ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> => {
  const action = getDefaultActions({repo}).find(
    (candidate): candidate is ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> =>
      candidate.id === id && candidate.context === ActionContextTypes.EDIT_MODE_CM,
  )
  if (!action) throw new Error(`Action not found: ${id}`)
  return action
}

describe('cross-block navigation keeps the caret placement it stores', () => {
  let sharedDb: TestDb
  let repo: Repo

  beforeAll(async () => {
    // jsdom has no layout; CodeMirror measures text through these.
    Object.assign(Range.prototype, {
      getClientRects: () => [],
      getBoundingClientRect: () => new DOMRect(),
    })
    sharedDb = await createTestDb()
  })
  afterAll(async () => { await sharedDb.cleanup() })

  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    repo = createTestRepo({db: sharedDb.db, user: USER}).repo
    repo.setActiveWorkspaceId(WS)
    await repo.tx(async tx => {
      await tx.create({id: PANEL, workspaceId: WS, parentId: null, orderKey: 'a0', content: ''})
      await tx.create({id: ROOT, workspaceId: WS, parentId: null, orderKey: 'b0', content: 'root'})
    }, {scope: ChangeScope.BlockDefault, description: 'navigation selection fixture'})
    await repo.mutate.createChild({parentId: ROOT, id: 'block-a', content: A_CONTENT})
    await repo.mutate.createChild({parentId: ROOT, id: 'block-b', content: 'second'})
  })

  afterEach(() => {
    cleanup()
    armedDebounces.clear()
    vi.restoreAllMocks()
  })

  const renderEditors = () => render(
    <RepoContext value={repo}>
      <AppRuntimeContextProvider value={resolveFacetRuntimeSync([])}>
        <ActiveContextsProvider>
          <Suspense fallback={null}>
            {['block-a', 'block-b'].map(blockId => (
              <BlockContextProvider
                key={blockId}
                initialValue={{panelId: PANEL, renderScopeId: outlineRenderScopeId(blockId)}}
              >
                <EditorWhileEditing blockId={blockId}/>
              </BlockContextProvider>
            ))}
          </Suspense>
        </ActiveContextsProvider>
      </AppRuntimeContextProvider>
    </RepoContext>,
  )

  /** Expires the pending debounce timers inside the navigation's first
   *  ui-state transaction — after it starts, before it commits, the instant a
   *  focus check against the cache cannot see it — and holds that transaction
   *  until the write they fire has been requested. Hands back that write. */
  const fireEditorWritesInsideTheNavigationTx = () => {
    const realTx = repo.tx.bind(repo)
    let navigationTxSeen = false
    let racingWrite: Promise<unknown> | undefined
    vi.spyOn(repo, 'tx').mockImplementation((fn, opts) => {
      if (opts.scope !== ChangeScope.UiState) return realTx(fn, opts)
      if (!navigationTxSeen) {
        navigationTxSeen = true
        return realTx(async tx => {
          expireDebounceTimers()
          await vi.waitFor(() => expect(racingWrite).toBeDefined())
          return fn(tx)
        }, opts)
      }
      const result = realTx(fn, opts)
      racingWrite ??= result
      return result
    })
    return {racingWrite: () => racingWrite}
  }

  /** Runs a shortcut the way the source editor's keydown would. */
  const pressInEditor = (action: string) =>
    (source: string, sourceView: EditorView) => editModeAction(repo, action).handler({
      block: repo.block(source),
      editorView: sourceView,
      uiStateBlock: repo.block(PANEL),
      scopeRootId: ROOT,
    }, {preventDefault: vi.fn()} as unknown as ActionTrigger)

  // Each moves the caret to a block whose editor is not mounted yet, so the
  // target's editor places it from the stored selection alone.
  it.each([
    {gesture: 'ArrowLeft at a block start', navigate: pressInEditor('move_left_from_cm_start'),
      source: 'block-b', caret: 0, target: 'block-a', start: A_CONTENT.length},
    {gesture: 'ArrowRight at a block end', navigate: pressInEditor('move_right_from_cm_end'),
      source: 'block-a', caret: A_CONTENT.length, target: 'block-b', start: 0},
    {gesture: 'Backspace merging into the previous block', navigate: pressInEditor('delete_empty_block_cm'),
      source: 'block-b', caret: 0, target: 'block-a', start: A_CONTENT.length},
    {gesture: 'a click into another block', navigate: () => enterEditModeForBlock(
      repo.block('block-b'), repo.block(PANEL), outlineRenderScopeId('block-b'), {start: 3}),
      source: 'block-a', caret: 5, target: 'block-b', start: 3},
  ])('$gesture: the source editor\'s pending selection write, firing mid-navigation, does not replace the target\'s', async ({navigate, source, caret, target, start}) => {
    await focusBlock(repo.block(PANEL), source, {edit: true, renderScopeId: outlineRenderScopeId(source)})
    renderEditors()
    await vi.waitFor(() => expect(editorViewOf(source)).not.toBeNull())
    const sourceView = editorViewOf(source)!
    // A caret move arms the source editor's debounced selection write.
    act(() => sourceView.dispatch({selection: {anchor: 3}}))
    act(() => sourceView.dispatch({selection: {anchor: caret}}))

    const race = fireEditorWritesInsideTheNavigationTx()
    await act(() => navigate(source, sourceView))
    expect(race.racingWrite(), 'the source editor\'s selection write never fired').toBeDefined()
    await act(() => race.racingWrite())

    await vi.waitFor(() => expect(editorViewOf(target)).not.toBeNull())
    expect(editorViewOf(target)!.state.selection.main.head).toBe(start)
    expect(repo.block(PANEL).peekProperty(editorSelection)).toEqual({blockId: target, start})
    // The first case measured 1.1-1.3s alone: it pays the cold editor mount.
  }, 20_000)
})

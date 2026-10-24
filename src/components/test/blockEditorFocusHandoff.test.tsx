// @vitest-environment happy-dom
/**
 * Pins BlockEditor's in-commit focus (the comment on its focus effect has the
 * rule). Frames are held for the whole test, which is the order a key typed
 * during an editor swap sees: the swap's commit, then queued input, then the
 * next frame.
 */
import { Suspense } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { ChangeScope, type User } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import {
  focusBlock,
  focusedBlockLocationProp,
  isEditingProp,
} from '@/data/properties'
import { outlineRenderScopeId } from '@/utils/renderScope'
import { resolveFacetRuntimeSync, type FacetRuntime } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { actionContextsFacet } from '@/extensions/core'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import { BlockContextProvider } from '@/context/block'
import { useInEditMode } from '@/data/globalState'
import { BlockEditor } from '@/components/BlockEditor'

const UI_STATE = 'ui-state'

const {testGlobals, testRepo} = vi.hoisted(() => {
  const testGlobals = {repo: undefined as Repo | undefined}
  const testRepo = (): Repo => {
    if (!testGlobals.repo) throw new Error('test repo not initialised')
    return testGlobals.repo
  }
  return {testGlobals, testRepo}
})

vi.mock('@/context/repo.tsx', () => ({
  useRepo: testRepo,
}))

vi.mock('@/data/globalState.ts', async () => {
  const {useBlockContext} = await vi.importActual<typeof import('@/context/block')>('@/context/block')
  const {useHandle, usePropertyValue} = await vi.importActual<typeof import('@/hooks/block')>('@/hooks/block')
  const properties = await vi.importActual<typeof import('@/data/properties')>('@/data/properties')
  const uiStateBlock = () => testRepo().block(UI_STATE)
  const useLocationMatch = (blockId: string, requireEditing: boolean): boolean => {
    const {renderScopeId} = useBlockContext()
    return useHandle(uiStateBlock(), {
      selector: doc => {
        const location = properties.focusedBlockLocationFromProperties(doc?.properties)
        return location?.blockId === blockId &&
          location.renderScopeId === renderScopeId &&
          (!requireEditing || Boolean(doc?.properties[properties.isEditingProp.name]))
      },
    })
  }
  return {
    useUIStateBlock: uiStateBlock,
    useUIStateProperty: <T,>(schema: import('@/data/api').PropertySchema<T>) =>
      usePropertyValue(uiStateBlock(), schema),
    useIsEditing: () => usePropertyValue(uiStateBlock(), properties.isEditingProp),
    useInFocus: (blockId: string) => useLocationMatch(blockId, false),
    useInEditMode: (blockId: string) => useLocationMatch(blockId, true),
    useIsSelected: () => false,
  }
})

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}

let heldFrames: FrameRequestCallback[] = []
const runHeldFrames = () => act(() => {
  const frames = heldFrames
  heldFrames = []
  for (const frame of frames) frame(performance.now())
})

/** The outline's edit-mode shape: a block shows its editor only while it owns
 *  edit mode, so moving edit mode unmounts one editor as it mounts the next. */
function EditorWhileEditing({blockId}: {blockId: string}) {
  const inEditMode = useInEditMode(blockId)
  return (
    <div data-testid={`row-${blockId}`}>
      {inEditMode && <BlockEditor block={testRepo().block(blockId)}/>}
    </div>
  )
}

const editorOf = (blockId: string): EditorView | null => {
  const dom = document.querySelector<HTMLElement>(`[data-testid="row-${blockId}"] .cm-editor`)
  return dom ? EditorView.findFromDOM(dom) : null
}

/** What the browser does with a typed character: the focused editor gets it,
 *  and with nothing editable focused it goes nowhere. */
const typeIntoFocusedEditor = (text: string): boolean => {
  const editorDom = document.activeElement?.closest<HTMLElement>('.cm-editor')
  const view = editorDom ? EditorView.findFromDOM(editorDom) : null
  if (!view) return false
  view.dispatch({...view.state.replaceSelection(text), userEvent: 'input.type'})
  return true
}

describe('BlockEditor focus when edit mode moves to another block', () => {
  let sharedDb: TestDb
  let repo: Repo
  let runtime: FacetRuntime

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })

  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    repo = createTestRepo({db: sharedDb.db, user: USER}).repo
    repo.setActiveWorkspaceId(WS)
    testGlobals.repo = repo
    runtime = resolveFacetRuntimeSync(
      defaultActionContextConfigs.map(context => actionContextsFacet.of(context)),
    )
    heldFrames = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(frame => {
      heldFrames.push(frame)
      return heldFrames.length
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    await repo.tx(async tx => {
      await tx.create({
        id: UI_STATE,
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        content: '',
        properties: {
          [focusedBlockLocationProp.name]: focusedBlockLocationProp.codec.encode({
            blockId: 'block-a',
            renderScopeId: outlineRenderScopeId('block-a'),
          }),
          [isEditingProp.name]: isEditingProp.codec.encode(true),
        },
      })
      await tx.create({id: 'block-a', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'first'})
      await tx.create({id: 'block-b', workspaceId: WS, parentId: null, orderKey: 'b1', content: ''})
    }, {scope: ChangeScope.BlockDefault, description: 'focus handoff fixture'})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    testGlobals.repo = undefined
  })

  it('a key typed right after the swap lands in the newly focused editor', async () => {
    render(
      <AppRuntimeContextProvider value={runtime}>
        <ActiveContextsProvider>
          <Suspense fallback={null}>
            {['block-a', 'block-b'].map(blockId => (
              <BlockContextProvider key={blockId} initialValue={{renderScopeId: outlineRenderScopeId(blockId)}}>
                <EditorWhileEditing blockId={blockId}/>
              </BlockContextProvider>
            ))}
          </Suspense>
        </ActiveContextsProvider>
      </AppRuntimeContextProvider>,
    )
    await vi.waitFor(() => expect(editorOf('block-a')).not.toBeNull())
    // Precondition: block A is being edited and owns focus, so the typing model
    // below routes to an editor when one is focused.
    await runHeldFrames()
    expect(document.activeElement?.closest('.cm-editor')).toBe(editorOf('block-a')?.dom)

    await act(async () => {
      await focusBlock(repo.block(UI_STATE), 'block-b', {
        edit: true,
        renderScopeId: outlineRenderScopeId('block-b'),
      })
    })
    await vi.waitFor(() => expect(editorOf('block-b')).not.toBeNull())
    expect(editorOf('block-a')).toBeNull()

    expect(typeIntoFocusedEditor('x'), 'the key was dropped: nothing editable had focus once the new editor mounted').toBe(true)
    await runHeldFrames()

    expect(editorOf('block-b')?.state.doc.toString()).toBe('x')
    expect(repo.block('block-a').peek()?.content).toBe('first')
  })
})

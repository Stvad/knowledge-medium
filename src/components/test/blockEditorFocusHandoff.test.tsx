// @vitest-environment happy-dom
/**
 * Pins BlockEditor's same-task focus (the comment on its focus effect has the
 * rule). Frames are held for the whole test, and a task armed in the swap
 * commit must not have run by the time the new editor takes focus: that is the
 * order a key typed during an editor swap sees — the swap, then queued input,
 * then later tasks and the next frame.
 */
import { Suspense, useLayoutEffect } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { focusBlock } from '@/data/properties'
import { outlineRenderScopeId } from '@/utils/renderScope'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import { BlockContextProvider } from '@/context/block'
import { RepoContext, useRepo } from '@/context/repo'
import { useInEditMode } from '@/data/globalState'
import { BlockEditor } from '@/components/BlockEditor'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}
/** A panel row is its own ui-state block, so the real globalState hooks read it. */
const PANEL = 'panel'

vi.mock('@/components/Login.tsx', () => ({useUser: () => USER}))

let heldFrames: FrameRequestCallback[] = []
const runHeldFrames = () => act(() => {
  const frames = heldFrames
  heldFrames = []
  for (const frame of frames) frame(performance.now())
})

/** Set once any task queued from the swap commit has run. */
let laterTaskRan = false

/** The outline's edit-mode shape: a block shows its editor only while it owns
 *  edit mode, so moving edit mode unmounts one editor as it mounts the next. */
function EditorWhileEditing({blockId}: {blockId: string}) {
  const repo = useRepo()
  const inEditMode = useInEditMode(blockId)
  useLayoutEffect(() => {
    if (!inEditMode) return
    laterTaskRan = false
    const markRan = () => { laterTaskRan = true }
    setTimeout(markRan)
    setImmediate(markRan)
  }, [inEditMode])
  return (
    <div data-testid={`row-${blockId}`}>
      {inEditMode && <BlockEditor block={repo.block(blockId)}/>}
    </div>
  )
}

const editorDomOf = (blockId: string) =>
  document.querySelector(`[data-testid="row-${blockId}"] .cm-editor`)
/** Where the browser delivers a typed key: the focused editor, or nowhere. */
const focusedEditorDom = () => document.activeElement?.closest('.cm-editor') ?? null

const editBlock = (repo: Repo, blockId: string) =>
  focusBlock(repo.block(PANEL), blockId, {edit: true, renderScopeId: outlineRenderScopeId(blockId)})

describe('BlockEditor focus when edit mode moves to another block', () => {
  let sharedDb: TestDb
  let repo: Repo

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })

  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    repo = createTestRepo({db: sharedDb.db, user: USER}).repo
    repo.setActiveWorkspaceId(WS)
    heldFrames = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(frame => {
      heldFrames.push(frame)
      return heldFrames.length
    })

    await repo.tx(async tx => {
      await tx.create({id: PANEL, workspaceId: WS, parentId: null, orderKey: 'a0', content: ''})
      await tx.create({id: 'block-a', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'first'})
      await tx.create({id: 'block-b', workspaceId: WS, parentId: null, orderKey: 'b1', content: ''})
    }, {scope: ChangeScope.BlockDefault, description: 'focus handoff fixture'})
    await editBlock(repo, 'block-a')
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('the newly mounted editor owns focus before any later task or frame runs', async () => {
    render(
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
    await vi.waitFor(() => expect(editorDomOf('block-a')).not.toBeNull())
    // Precondition, with A's frames run too: the harness can focus an editor,
    // so the failures below are about WHEN the new editor focuses.
    await runHeldFrames()
    expect(focusedEditorDom()).toBe(editorDomOf('block-a'))

    let laterTaskRanBeforeFocus: boolean | undefined
    const recordFocus = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (laterTaskRanBeforeFocus === undefined && target?.closest('[data-testid="row-block-b"]')) {
        laterTaskRanBeforeFocus = laterTaskRan
      }
    }
    document.addEventListener('focusin', recordFocus)

    await act(() => editBlock(repo, 'block-b'))
    await vi.waitFor(() => expect(editorDomOf('block-b')).not.toBeNull())
    document.removeEventListener('focusin', recordFocus)
    expect(editorDomOf('block-a')).toBeNull()

    expect(focusedEditorDom(), 'a key typed now is dropped: nothing editable has focus')
      .toBe(editorDomOf('block-b'))
    expect(laterTaskRanBeforeFocus, 'the new editor focused in a later task, after queued keys were dispatched')
      .toBe(false)
  })
})

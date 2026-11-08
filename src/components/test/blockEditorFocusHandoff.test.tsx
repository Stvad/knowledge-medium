// @vitest-environment happy-dom
/**
 * Pins editor focus through block swaps and the Help opener. Frames are held
 * so tests drive the deferred blur decision after each focus transfer.
 */
import { Suspense, useLayoutEffect } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { focusBlock, isEditingProp } from '@/data/properties'
import { outlineRenderScopeId } from '@/utils/renderScope'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import { BlockContextProvider } from '@/context/block'
import { RepoContext, useRepo } from '@/context/repo'
import { useInEditMode } from '@/data/globalState'
import { BlockEditor } from '@/components/BlockEditor'
import { ShortcutHelpHeaderItem } from '@/plugins/shortcut-help/HeaderItem.tsx'
import { shortcutHelpToggle } from '@/plugins/shortcut-help/toggleStore.ts'

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

describe('BlockEditor focus handoffs', () => {
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
    shortcutHelpToggle.close()
    vi.restoreAllMocks()
  })

  const renderEditors = () => render(
    <RepoContext value={repo}>
      <AppRuntimeContextProvider value={resolveFacetRuntimeSync([])}>
        <ActiveContextsProvider>
          <ShortcutHelpHeaderItem/>
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

  it('the newly mounted editor owns focus before any later task or frame runs', async () => {
    renderEditors()
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

  it('keeps edit mode through a mouse press before Help opens', async () => {
    renderEditors()
    await vi.waitFor(() => expect(editorDomOf('block-a')).not.toBeNull())
    await runHeldFrames()
    expect(focusedEditorDom()).toBe(editorDomOf('block-a'))

    const help = screen.getByRole('button', {name: 'Help'})
    // happy-dom does not perform mousedown's native focus transfer.
    if (fireEvent.mouseDown(help, {button: 0})) act(() => help.focus())
    await runHeldFrames()
    await act(() => repo.tx(async () => {}, {
      scope: ChangeScope.BlockDefault, description: 'fence deferred editor blur',
    }))

    expect(repo.block(PANEL).peekProperty(isEditingProp)).toBe(true)
    expect(focusedEditorDom()).toBe(editorDomOf('block-a'))
    fireEvent.mouseUp(help)
    fireEvent.click(help)
    expect(shortcutHelpToggle.isOpen()).toBe(true)
  })
})

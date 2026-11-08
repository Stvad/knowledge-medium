// @vitest-environment happy-dom
/**
 * Pins that a real editor's pending text commits ahead of each write that moves
 * focus off it, in the order the upload queue will see them.
 */
import { Suspense } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import {
  editorSelection,
  exitEditModeForBlock,
  focusBlock,
  setIsEditing,
} from '@/data/properties'
import { navigateInPanel } from '@/utils/panelHistory'
import { deletePanelRow } from '@/utils/panelLayoutProjection'
import { commitSelectionRange } from '@/utils/selection'
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
const PANEL = 'panel'
const SOURCE_SCOPE = outlineRenderScopeId('block-a')
const TARGET_SCOPE = outlineRenderScopeId('block-b')
const TARGET = {blockId: 'block-b', renderScopeId: TARGET_SCOPE}

vi.mock('@/components/Login.tsx', () => ({useUser: () => USER}))

function EditorWhileEditing({blockId}: {blockId: string}) {
  const repo = useRepo()
  const inEditMode = useInEditMode(blockId)
  return <div data-testid={`row-${blockId}`}>{inEditMode && <BlockEditor block={repo.block(blockId)}/>}</div>
}

/** happy-dom fires selectionchange synchronously from the DOM selection
 *  CodeMirror writes mid-update, which re-enters that update. */
const swallowSelectionChange = (event: Event) => event.stopImmediatePropagation()

const editorDomOf = (blockId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="row-${blockId}"] .cm-editor`)

describe('a block editor saves its text before focus leaves it', () => {
  let sharedDb: TestDb
  let repo: Repo

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })

  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    window.addEventListener('selectionchange', swallowSelectionChange, true)
    repo = createTestRepo({db: sharedDb.db, user: USER}).repo
    repo.setActiveWorkspaceId(WS)
    await repo.tx(async tx => {
      await tx.create({id: PANEL, workspaceId: WS, parentId: null, orderKey: 'a0', content: ''})
      await tx.create({id: 'block-a', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'first'})
      await tx.create({id: 'block-b', workspaceId: WS, parentId: null, orderKey: 'b1', content: 'second'})
    }, {scope: ChangeScope.BlockDefault, description: 'save before leaving fixture'})
    await focusBlock(repo.block(PANEL), 'block-a', {edit: true, renderScopeId: SOURCE_SCOPE})
  })

  afterEach(() => {
    cleanup()
    window.removeEventListener('selectionchange', swallowSelectionChange, true)
  })

  const panel = () => repo.block(PANEL)

  /** Mount the editor, then type past the stored row: the debounce now holds
   *  both a content write and a selection write. */
  const typeInSource = async (text: string) => {
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
    const view = EditorView.findFromDOM(editorDomOf('block-a')!)!
    const end = view.state.doc.length
    act(() => view.dispatch({changes: {from: end, insert: text}, selection: {anchor: end + text.length}}))
  }

  /** Commit order, as the upload queue will see it. */
  const committed = async (): Promise<string[]> =>
    (await sharedDb.db.getAll<{description: string}>(
      'SELECT description FROM command_events ORDER BY rowid',
    )).map(row => row.description)

  const expectContentCommittedBefore = async (leaveWrite: string) => {
    const order = await vi.waitFor(async () => {
      const committedSoFar = await committed()
      expect(committedSoFar).toContain('set content on block-a')
      expect(committedSoFar).toContain(leaveWrite)
      return committedSoFar
    })
    expect(order.lastIndexOf('set content on block-a')).toBeLessThan(order.lastIndexOf(leaveWrite))
    expect(repo.block('block-a').peek()?.content).toBe('first typed')
  }

  const selectInto = (clearEditing: boolean) => commitSelectionRange({
    uiStateBlock: panel(),
    anchorBlockId: 'block-a',
    targetLocation: TARGET,
    selectedBlockIds: ['block-a', 'block-b'],
    clearEditing,
  })

  const leaveWrites: ReadonlyArray<[name: string, description: string, leave: () => Promise<unknown>]> = [
    ['focusBlock to another block', 'focus block', () =>
      focusBlock(panel(), 'block-b', {edit: true, renderScopeId: TARGET_SCOPE})],
    ['setIsEditing(false)', 'set property isEditing on panel', async () => setIsEditing(panel(), false)],
    ['exitEditModeForBlock', 'exit edit mode', () => exitEditModeForBlock(panel(), 'block-a', SOURCE_SCOPE)],
    ['navigateInPanel', 'navigate in panel', () => navigateInPanel(panel(), 'block-b')],
    ['a selection write that clears editing', 'extend selection', () => selectInto(true)],
    ['a selection write that keeps the edit flag', 'extend selection', () => selectInto(false)],
    ['closing the panel', 'close panel', () => deletePanelRow(repo, PANEL)],
  ]

  it.each(leaveWrites)('%s', async (_name, description, leave) => {
    await typeInSource(' typed')
    await act(leave)
    await expectContentCommittedBefore(description)
  })

  it('leaves a pending selection behind, so the navigation keeps its target selection', async () => {
    await typeInSource(' typed')
    await act(async () => {
      await panel().set(editorSelection, {blockId: 'block-b', start: 2})
      await focusBlock(panel(), 'block-b', {edit: true, renderScopeId: TARGET_SCOPE})
    })
    await vi.waitFor(() => expect(editorDomOf('block-b')).not.toBeNull())
    // Every write queued so far has committed behind this fence.
    await repo.tx(async () => {}, {scope: ChangeScope.UiState, description: 'fence'})
    expect(panel().peekProperty(editorSelection)).toEqual({blockId: 'block-b', start: 2})
  })

  it('a writer that skips the flush still saves, as the editor unmounts', async () => {
    await typeInSource(' typed')
    expect(repo.block('block-a').peek()?.content).toBe('first')
    cleanup()
    // The unmount's write is queued ahead of this fence.
    await repo.tx(async () => {}, {scope: ChangeScope.UiState, description: 'fence'})
    expect(repo.block('block-a').peek()?.content).toBe('first typed')
  })
})

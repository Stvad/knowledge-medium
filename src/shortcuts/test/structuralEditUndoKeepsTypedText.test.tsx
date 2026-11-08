// @vitest-environment happy-dom
/**
 * Pins that undoing a split, a merge or a multi-line paste keeps the text typed
 * just before it, while the editor's content write was still debounced.
 */
import { Suspense } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo, isBlockDeleted } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { focusBlock } from '@/data/properties'
import { outlineRenderScopeId } from '@/utils/renderScope'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import { BlockContextProvider } from '@/context/block'
import { RepoContext, useRepo } from '@/context/repo'
import { useInEditMode } from '@/data/globalState'
import { CodeMirrorContentRenderer } from '@/components/renderer/CodeMirrorContentRenderer'
import { getDefaultActions } from '@/shortcuts/defaultShortcuts'
import { pasteDecisionVerb } from '@/paste/decision'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionTrigger,
  type CodeMirrorEditModeDependencies,
} from '@/shortcuts/types'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}
const PANEL = 'panel'
const ROOT = 'root'
const SCOPE = outlineRenderScopeId(ROOT)

vi.mock('@/components/Login.tsx', () => ({useUser: () => USER}))

function EditorWhileEditing({blockId}: {blockId: string}) {
  const repo = useRepo()
  const inEditMode = useInEditMode(blockId)
  return (
    <div data-testid={`row-${blockId}`}>
      {inEditMode && <CodeMirrorContentRenderer block={repo.block(blockId)}/>}
    </div>
  )
}

/** happy-dom fires selectionchange synchronously from the DOM selection
 *  CodeMirror writes mid-update, which re-enters that update. */
const swallowSelectionChange = (event: Event) => event.stopImmediatePropagation()

const editorDomOf = (blockId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="row-${blockId}"] .cm-editor`)

const dispatchPaste = (target: Element, text: string) => {
  const event = new Event('paste', {bubbles: true, cancelable: true})
  Object.defineProperty(event, 'clipboardData', {
    value: {getData: (type: string) => type === 'text/plain' ? text : ''},
  })
  target.dispatchEvent(event)
}

describe('undoing a structural edit keeps the text typed just before it', () => {
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
      await tx.create({id: ROOT, workspaceId: WS, parentId: null, orderKey: 'b0', content: 'Root'})
      await tx.create({id: 'block-a', workspaceId: WS, parentId: ROOT, orderKey: 'a0', content: 'first'})
      await tx.create({id: 'block-b', workspaceId: WS, parentId: ROOT, orderKey: 'a1', content: 'second'})
    }, {scope: ChangeScope.BlockDefault, description: 'structural undo fixture'})
  })

  afterEach(() => {
    cleanup()
    window.removeEventListener('selectionchange', swallowSelectionChange, true)
  })

  const panel = () => repo.block(PANEL)
  const content = (id: string) => repo.block(id).peek()?.content
  const children = async () => (await repo.block(ROOT).childIds.load())

  /** Open `blockId` in a real editor and type `text` at its end, leaving the
   *  caret at document offset `caret` (the end by default). The content write
   *  is still inside its debounce when this returns. */
  const typeInto = async (
    blockId: string,
    text: string,
    caret?: number,
    runtime = resolveFacetRuntimeSync([]),
  ): Promise<EditorView> => {
    await focusBlock(panel(), blockId, {edit: true, renderScopeId: SCOPE})
    render(
      <RepoContext value={repo}>
        <AppRuntimeContextProvider value={runtime}>
          <ActiveContextsProvider>
            <Suspense fallback={null}>
              {['block-a', 'block-b'].map(id => (
                <BlockContextProvider key={id} initialValue={{panelId: PANEL, renderScopeId: SCOPE, scopeRootId: ROOT}}>
                  <EditorWhileEditing blockId={id}/>
                </BlockContextProvider>
              ))}
            </Suspense>
          </ActiveContextsProvider>
        </AppRuntimeContextProvider>
      </RepoContext>,
    )
    await vi.waitFor(() => expect(editorDomOf(blockId)).not.toBeNull())
    const view = EditorView.findFromDOM(editorDomOf(blockId)!)!
    const stored = view.state.doc.toString()
    const end = stored.length
    act(() => view.dispatch({
      changes: {from: end, insert: text},
      selection: {anchor: caret ?? end + text.length},
    }))
    expect(content(blockId)).toBe(stored)
    return view
  }

  const runEditAction = async (id: string, blockId: string, editorView: EditorView) => {
    const action = getDefaultActions({repo}).find(
      (candidate): candidate is ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> =>
        candidate.id === id && candidate.context === ActionContextTypes.EDIT_MODE_CM,
    )
    if (!action) throw new Error(`Action not found: ${id}`)
    await act(() => action.handler({
      block: repo.block(blockId),
      editorView,
      uiStateBlock: panel(),
      scopeRootId: ROOT,
      renderScopeId: SCOPE,
    } satisfies CodeMirrorEditModeDependencies, {preventDefault: vi.fn()} as unknown as ActionTrigger))
  }

  const undo = async () => { await act(async () => { expect(await repo.undo()).toBe(true) }) }
  const redo = async () => { await act(async () => { expect(await repo.redo()).toBe(true) }) }

  it('Enter mid-block', async () => {
    const view = await typeInto('block-a', ' typed', 'first type'.length)

    await runEditAction('split_block_cm', 'block-a', view)
    const [splitOff] = await children()
    expect(content(splitOff)).toBe('first type')
    expect(content('block-a')).toBe('d')

    await undo()
    expect(content('block-a')).toBe('first typed')
    expect(await children()).toEqual(['block-a', 'block-b'])

    await redo()
    expect(await children()).toEqual([splitOff, 'block-a', 'block-b'])
    expect(content(splitOff)).toBe('first type')
    expect(content('block-a')).toBe('d')
  })

  it('Backspace at the start of a block, merging it up', async () => {
    const view = await typeInto('block-b', ' typed', 0)

    await runEditAction('delete_empty_block_cm', 'block-b', view)
    expect(content('block-a')).toBe('firstsecond typed')
    expect(await isBlockDeleted(repo, 'block-b')).toBe(true)

    await undo()
    expect(content('block-b')).toBe('second typed')
    expect(content('block-a')).toBe('first')
    expect(await isBlockDeleted(repo, 'block-b')).toBe(false)

    await redo()
    expect(content('block-a')).toBe('firstsecond typed')
    expect(await isBlockDeleted(repo, 'block-b')).toBe(true)
  })

  it('Delete at the end of a block, merging the next one in', async () => {
    const view = await typeInto('block-a', ' typed')

    await runEditAction('merge_next_block_cm', 'block-a', view)
    expect(content('block-a')).toBe('first typedsecond')
    expect(await isBlockDeleted(repo, 'block-b')).toBe(true)

    await undo()
    expect(content('block-a')).toBe('first typed')
    expect(content('block-b')).toBe('second')
    expect(await isBlockDeleted(repo, 'block-b')).toBe(false)

    await redo()
    expect(content('block-a')).toBe('first typedsecond')
    expect(await isBlockDeleted(repo, 'block-b')).toBe(true)
  })

  const pasteMultiline = async (chord?: KeyboardEventInit) => {
    const editable = editorDomOf('block-a')!.querySelector('.cm-content')!
    act(() => {
      if (chord) editable.dispatchEvent(new KeyboardEvent('keydown', {...chord, bubbles: true}))
      dispatchPaste(editable, 'x\ny')
    })
    await vi.waitFor(async () => expect(await children()).toHaveLength(3))
    expect(content('block-a')).toBe('first typedx')

    await undo()
    expect(content('block-a')).toBe('first typed')
    expect(await children()).toEqual(['block-a', 'block-b'])

    await redo()
    expect(content('block-a')).toBe('first typedx')
    expect(await children()).toHaveLength(3)
  }

  it('a multi-line paste', async () => {
    await typeInto('block-a', ' typed')
    await pasteMultiline()
  })

  it('a plain-text-chord paste that a paste decision splits', async () => {
    const splitsEveryPaste = pasteDecisionVerb.decorator(() => () => ({kind: 'split'}), {source: 'test'})
    await typeInto('block-a', ' typed', undefined, resolveFacetRuntimeSync([splitsEveryPaste]))
    await pasteMultiline({key: 'V', metaKey: true, shiftKey: true})
  })
})

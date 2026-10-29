// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import type { Block } from '@/data/block'
import { focusedBlockLocationProp, topLevelBlockIdProp } from '@/data/properties'
import { outlineRenderScopeId } from '@/utils/renderScope'
import { defaultEditorInteractionExtension } from '@/editor/defaultInteractions'
import { actionContextsFacet } from '@/extensions/core'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { BlockContextProvider } from '@/context/block'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import type { FacetRuntime } from '@/facets/facet'
import {
  pasteArmedCut,
  pasteEditModeMultilineText,
  resolvePasteWithMediaCapture,
} from '@/paste/operations'
import { CodeMirrorContentRenderer } from '../CodeMirrorContentRenderer'

const repoRef = vi.hoisted(() => ({current: undefined as Repo | undefined}))
const uiStateBlockRef = vi.hoisted(() => ({current: undefined as Block | undefined}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!repoRef.current) throw new Error('test repo not initialised')
    return repoRef.current
  },
}))

vi.mock('@/data/globalState.ts', async () => {
  const actual = await vi.importActual<typeof import('@/data/globalState.js')>('@/data/globalState.ts')
  const properties = await vi.importActual<typeof import('@/data/properties')>('@/data/properties')
  const uiStateBlock = () => {
    if (!uiStateBlockRef.current) throw new Error('test UI state block not initialised')
    return uiStateBlockRef.current
  }
  return {
    ...actual,
    useUIStateBlock: uiStateBlock,
    useUIStateProperty: <T,>(schema: import('@/data/api').PropertySchema<T>): [T, (value: T) => void] => {
      const block = uiStateBlock()
      return [
        block.peekProperty(schema) ?? schema.defaultValue,
        (value: T) => { void block.set(schema, value) },
      ]
    },
    useInFocus: (blockId: string): boolean => properties.isFocusedBlock(uiStateBlock(), blockId),
    useInEditMode: (blockId: string): boolean =>
      properties.isFocusedBlock(uiStateBlock(), blockId) &&
      Boolean(uiStateBlock().peekProperty(properties.isEditingProp)),
    useIsSelected: (): boolean => false,
    useIsEditing: (): [boolean, (value: boolean) => void] => [
      Boolean(uiStateBlock().peekProperty(properties.isEditingProp)),
      (value: boolean) => { void uiStateBlock().set(properties.isEditingProp, value) },
    ],
  }
})

vi.mock('@/paste/operations.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('@/paste/operations')>()
  return {
    // pasteChordIntent and the planners stay real: the keydown latch and the
    // text-insertion plan are part of the path under test.
    ...actual,
    pasteArmedCut: vi.fn(async () => null),
    pasteEditModeMultilineText: vi.fn(async () => null),
    resolvePasteWithMediaCapture: vi.fn(async (_runtime: unknown, request: {text: string}) => ({
      decision: {kind: 'split' as const},
      text: request.text,
    })),
  }
})

const dispatchPaste = (target: Element, text: string): Event => {
  const event = new Event('paste', {bubbles: true, cancelable: true})
  Object.defineProperty(event, 'clipboardData', {
    value: {getData: (type: string) => type === 'text/plain' ? text : ''},
  })
  target.dispatchEvent(event)
  return event
}

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

describe('CodeMirrorContentRenderer armed-cut paste', () => {
  let repo: Repo
  let runtime: FacetRuntime

  beforeEach(async () => {
    vi.mocked(pasteArmedCut).mockClear()
    vi.mocked(pasteEditModeMultilineText).mockClear()
    vi.mocked(resolvePasteWithMediaCapture).mockClear()

    await resetTestDb(sharedDb.db)
    repo = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      newId: () => crypto.randomUUID(),
      extensions: [
        defaultEditorInteractionExtension,
        ...defaultActionContextConfigs.map(context => actionContextsFacet.of(context)),
      ],
    }).repo
    runtime = repo.facetRuntime!
    repo.setActiveWorkspaceId('ws-1')
    repoRef.current = repo

    await repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'Root'})
      await tx.create({id: 'block-1', workspaceId: 'ws-1', parentId: 'root', orderKey: 'a0', content: 'Block'})
      await tx.create({
        id: 'ui-state',
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'a1',
        properties: {
          [focusedBlockLocationProp.name]: focusedBlockLocationProp.codec.encode({
            blockId: 'block-1',
            renderScopeId: outlineRenderScopeId('root'),
          }),
          [topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('root'),
        },
      })
    }, {scope: ChangeScope.BlockDefault, description: 'create armed-cut paste fixture'})
    uiStateBlockRef.current = repo.block('ui-state')
  })

  afterEach(() => {
    cleanup()
    repoRef.current = undefined
    uiStateBlockRef.current = undefined
  })

  const renderEditor = () => {
    const view = render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockContextProvider initialValue={{scopeRootId: 'root'}}>
          <ActiveContextsProvider>
            <CodeMirrorContentRenderer block={repo.block('block-1')} />
          </ActiveContextsProvider>
        </BlockContextProvider>
      </AppRuntimeContextProvider>,
    )
    const content = view.container.querySelector<HTMLElement>('.cm-content')
    expect(content).toBeTruthy()
    const editorView = EditorView.findFromDOM(view.container)
    expect(editorView?.state.doc.toString()).toBe('Block')
    return {content: content!, editorView: editorView!}
  }

  it('moves the cut blocks and pastes no text when an armed cut resolves as moved', async () => {
    vi.mocked(pasteArmedCut).mockResolvedValueOnce({kind: 'moved', blocks: [repo.block('block-1')]})
    const {content, editorView} = renderEditor()

    act(() => { dispatchPaste(content, '- cut text') })

    await vi.waitFor(() => expect(pasteArmedCut).toHaveBeenCalledTimes(1))
    expect(pasteArmedCut).toHaveBeenCalledWith('- cut text', repo.block('block-1'), repo, {scopeRootId: 'root'})
    // A cut leaves the originals in place, so a text paste here would duplicate them.
    // Every mock here is already resolved, so one macrotask runs the handler's
    // whole continuation; the absence checks below can't run before it.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(editorView.state.doc.toString()).toBe('Block')
    expect(resolvePasteWithMediaCapture).not.toHaveBeenCalled()
    expect(pasteEditModeMultilineText).not.toHaveBeenCalled()
  })

  it('pastes nothing when the armed cut is refused', async () => {
    vi.mocked(pasteArmedCut).mockResolvedValueOnce({kind: 'refused'})
    const {content, editorView} = renderEditor()

    act(() => { dispatchPaste(content, '- cut text') })

    await vi.waitFor(() => expect(pasteArmedCut).toHaveBeenCalledTimes(1))
    // Every mock here is already resolved, so one macrotask runs the handler's
    // whole continuation; the absence checks below can't run before it.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(editorView.state.doc.toString()).toBe('Block')
    expect(resolvePasteWithMediaCapture).not.toHaveBeenCalled()
    expect(pasteEditModeMultilineText).not.toHaveBeenCalled()
  })

  it('falls through to the normal text paste when no cut is armed', async () => {
    const {content} = renderEditor()

    act(() => { dispatchPaste(content, 'plain') })

    await vi.waitFor(() => expect(resolvePasteWithMediaCapture).toHaveBeenCalledTimes(1))
    expect(pasteArmedCut).toHaveBeenCalledTimes(1)
  })

  it('skips the armed cut on the plain-text chord (Cmd+Shift+V)', async () => {
    const {content, editorView} = renderEditor()

    act(() => {
      content.dispatchEvent(new KeyboardEvent('keydown', {key: 'V', metaKey: true, shiftKey: true, bubbles: true}))
      dispatchPaste(content, 'plain')
    })

    await vi.waitFor(() => expect(editorView.state.doc.toString()).toContain('plain'))
    expect(pasteArmedCut).not.toHaveBeenCalled()
    expect(resolvePasteWithMediaCapture).toHaveBeenCalledTimes(1)
  })

  it('persists text typed within the content debounce before completing a cut', async () => {
    // The move replaces a blank target, judged on the STORED row, so unflushed
    // typing in an empty block would be deleted with it.
    let storedWhenMoveRan: string | undefined
    vi.mocked(pasteArmedCut).mockImplementationOnce(async (_text, target) => {
      // Queued behind any flushed write, as the real move's tx is.
      await repo.tx(async tx => { storedWhenMoveRan = (await tx.get(target.id))?.content },
        {scope: ChangeScope.BlockDefault, description: 'read the stored target'})
      return {kind: 'refused'}
    })
    const {content, editorView} = renderEditor()

    act(() => {
      editorView.dispatch({changes: {from: editorView.state.doc.length, insert: ' typed'}})
      dispatchPaste(content, '- cut text')
    })

    await vi.waitFor(() => expect(storedWhenMoveRan).toBe('Block typed'))
  })
})

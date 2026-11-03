// @vitest-environment happy-dom

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {EditorState} from '@codemirror/state'
import {EditorView} from '@codemirror/view'
import {act, cleanup, render, screen, waitFor, within} from '@testing-library/react'
import {useEffect} from 'react'
import type {ReactNode} from 'react'
import {ChangeScope} from '@/data/api'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {BlockContextProvider} from '@/context/block'
import {kernelPropertyUiExtension} from '@/components/propertyEditors/typesPropertyUi'
import {kernelValuePresetsExtension} from '@/components/propertyEditors/kernelValuePresets'
import {DefaultBlockRenderer} from '@/components/renderer/DefaultBlockRenderer'
import {defaultEditorInteractionExtension} from '@/editor/defaultInteractions'
import {defaultRenderersExtension} from '@/extensions/defaultRenderers'
import {actionContextsFacet, actionsFacet} from '@/extensions/core'
import {AppRuntimeContextProvider} from '@/extensions/runtimeContext'
import {ActiveContextsProvider, useActiveContextsDispatch} from '@/shortcuts/ActiveContexts'
import {HotkeyReconciler} from '@/shortcuts/HotkeyReconciler'
import {defaultActionContextConfigs} from '@/shortcuts/defaultContexts'
import {ActionContextTypes} from '@/shortcuts/types'
import {panelRenderScopeId} from '@/utils/renderScope'
import {plainOutlinerPlugin} from '@/plugins/plain-outliner'
import {referencesPlugin} from '@/plugins/references'
import {backlinksPlugin} from '@/plugins/backlinks'
import {addComment} from './addComment'
import {annotationsPlugin} from './index'

const WS = 'ws'
const BLOCK = 'A paragraph with a comment thread.'
const COMMENT = 'Keep this note attached to the paragraph.'
const TOGGLE_ACTION_ID = 'annotations.toggleBlockComments'
const repoRef = vi.hoisted(() => ({current: undefined as Repo | undefined}))
const uiStateBlockRef = vi.hoisted(() => ({current: undefined as import('@/data/block').Block | undefined}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!repoRef.current) throw new Error('test repo not initialised')
    return repoRef.current
  },
}))

vi.mock('@/components/util/LazyViewportMount.tsx', () => ({
  LazyViewportMount: ({children}: {children: ReactNode}) => <>{children}</>,
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
    useUIStateProperty: <T,>(schema: import('@/data/api').PropertySchema<T>): [T, (value: T) => void] => [
      uiStateBlock().peekProperty(schema) ?? schema.defaultValue,
      (value: T) => { void uiStateBlock().set(schema, value) },
    ],
    useInFocus: (blockId: string): boolean => properties.isFocusedBlock(uiStateBlock(), blockId),
    useInEditMode: (): boolean => false,
    useIsSelected: (): boolean => false,
  }
})

describe('the block comments toggle action', () => {
  let db: TestDb
  let repo: Repo

  beforeAll(async () => { db = await createTestDb() })
  afterAll(async () => { await db.cleanup() })

  beforeEach(async () => {
    await resetTestDb(db.db)
    repo = createTestRepo({
      db: db.db,
      user: {id: 'alex', name: 'Alex'},
      extensions: [
        kernelPropertyUiExtension,
        kernelValuePresetsExtension,
        defaultEditorInteractionExtension,
        defaultRenderersExtension,
        plainOutlinerPlugin,
        referencesPlugin,
        backlinksPlugin,
        ...defaultActionContextConfigs.map(config => actionContextsFacet.of(config)),
        annotationsPlugin,
      ],
    }).repo
    repoRef.current = repo
    repo.setActiveWorkspaceId(WS)
    await repo.tx(async tx => {
      await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Notes'})
      await tx.create({id: 'target', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: BLOCK})
      await tx.create({id: 'ui-state', workspaceId: WS, parentId: null, orderKey: 'a1'})
    }, {scope: ChangeScope.BlockDefault})
    uiStateBlockRef.current = repo.block('ui-state')
    await addComment(repo, {targetId: 'target', comment: COMMENT})
  })

  afterEach(() => {
    cleanup()
    repoRef.current = undefined
    uiStateBlockRef.current = undefined
  })

  const actionFor = (context: typeof ActionContextTypes.NORMAL_MODE | typeof ActionContextTypes.EDIT_MODE_CM) => {
    const actions = repo.facetRuntime!.read(actionsFacet)
    return actions.find(action => action.id === TOGGLE_ACTION_ID && action.context === context)
  }

  const invoke = async (
    context: typeof ActionContextTypes.NORMAL_MODE | typeof ActionContextTypes.EDIT_MODE_CM,
    deps: Record<string, unknown>,
  ) => {
    const action = actionFor(context)
    if (!action) throw new Error(`Missing ${context} contribution for ${TOGGLE_ACTION_ID}`)
    await act(async () => action.handler(deps as never, new KeyboardEvent('keydown')))
  }

  const panel = (id: string, node: ReactNode) => (
    <div data-testid={id}>
      <BlockContextProvider initialValue={{panelId: id, scopeRootId: 'page', renderScopeId: panelRenderScopeId(id, 'page')}}>
        {node}
      </BlockContextProvider>
    </div>
  )

  const Activate = ({context, dependencies}: {context: typeof ActionContextTypes.NORMAL_MODE | typeof ActionContextTypes.EDIT_MODE_CM; dependencies: Record<string, unknown>}) => {
    const dispatch = useActiveContextsDispatch()
    useEffect(() => {
      dispatch.activate(context, dependencies as never)
      return () => dispatch.deactivate(context)
    }, [dispatch, context, dependencies])
    return null
  }

  it.each([ActionContextTypes.NORMAL_MODE, ActionContextTypes.EDIT_MODE_CM])('toggles comments for the focused block in its render scope only in %s', async context => {
    const firstScope = panelRenderScopeId('first-panel', 'page')
    const editor = context === ActionContextTypes.EDIT_MODE_CM ? new EditorView({state: EditorState.create({doc: BLOCK})}) : null
    const editorHost = editor ? document.body.appendChild(document.createElement('div')) : null
    if (editor && editorHost) editorHost.append(editor.dom)
    const deps = {block: repo.block('target'), uiStateBlock: repo.block('ui-state'), renderScopeId: firstScope, ...(editor ? {editorView: editor} : {})}
    const {container} = render(
      <AppRuntimeContextProvider value={repo.facetRuntime!}>
        <ActiveContextsProvider>
          <HotkeyReconciler/>
          <Activate context={context} dependencies={deps}/>
          {panel('first-panel', <DefaultBlockRenderer block={repo.block('target')}/>)}
          {panel('second-panel', <DefaultBlockRenderer block={repo.block('target')}/>)}
        </ActiveContextsProvider>
      </AppRuntimeContextProvider>,
    )
    const firstPanel = within(screen.getByTestId('first-panel'))
    const secondPanel = within(screen.getByTestId('second-panel'))
    let expanded = false
    const pressToggle = () => {
      const event = new KeyboardEvent('keydown', {key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true})
      act(() => (editor?.contentDOM ?? window).dispatchEvent(event))
      expect(event.defaultPrevented).toBe(true)
      expanded = !expanded
    }

    try {
      expect(firstPanel.queryByText(COMMENT)).toBeNull()
      expect(secondPanel.queryByText(COMMENT)).toBeNull()
      pressToggle()
      expect(await firstPanel.findByText(COMMENT)).toBeTruthy()
      expect(secondPanel.queryByText(COMMENT)).toBeNull()
      pressToggle()
      await waitFor(() => expect(firstPanel.queryByText(COMMENT)).toBeNull())
      expect(secondPanel.queryByText(COMMENT)).toBeNull()
      expect(container.querySelectorAll('[data-testid="comment-thread"]')).toHaveLength(0)
    } finally {
      if (expanded) pressToggle()
      editor?.destroy()
      editorHost?.remove()
    }
  })

  it('keeps the active editor draft, caret, and focus when toggled in edit mode', async () => {
    const editor = new EditorView({state: EditorState.create({doc: BLOCK})})
    const host = document.createElement('div')
    document.body.append(host)
    host.append(editor.dom)
    editor.dispatch({changes: {from: 0, insert: 'Draft: '}, selection: {anchor: 12}})
    editor.focus()
    const selection = editor.state.selection.main
    const deps = {
      block: repo.block('target'),
      uiStateBlock: repo.block('ui-state'),
      renderScopeId: panelRenderScopeId('editor-panel', 'page'),
      editorView: editor,
    }
    let expanded = false

    try {
      expect(actionFor(ActionContextTypes.EDIT_MODE_CM)).toBeDefined()
      await invoke(ActionContextTypes.EDIT_MODE_CM, deps)
      expanded = true
      expect(editor.state.doc.toString()).toBe(`Draft: ${BLOCK}`)
      expect(editor.state.selection.main).toEqual(selection)
      expect(document.activeElement).toBe(editor.contentDOM)

      await invoke(ActionContextTypes.EDIT_MODE_CM, deps)
      expanded = false
      expect(editor.state.doc.toString()).toBe(`Draft: ${BLOCK}`)
      expect(editor.state.selection.main).toEqual(selection)
      expect(document.activeElement).toBe(editor.contentDOM)
    } finally {
      if (expanded) await invoke(ActionContextTypes.EDIT_MODE_CM, deps)
      editor.destroy()
      host.remove()
    }
  })
})

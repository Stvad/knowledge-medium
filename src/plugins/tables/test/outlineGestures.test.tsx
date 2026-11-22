// @vitest-environment happy-dom
import { Suspense, useEffect } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { ChangeScope, seedProperty, type User } from '@/data/api'
import { definitionSeedsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { editorSelection, focusBlock, isEditingProp, peekFocusedBlockLocation, selectionStateProp } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync, type AppExtension, type FacetRuntime } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { actionContextsFacet, actionsFacet } from '@/extensions/core'
import { defaultRenderersExtension } from '@/extensions/defaultRenderers'
import { defaultEditorInteractionExtension } from '@/editor/defaultInteractions'
import { ActiveContextsProvider, useActiveContextsState, type ActiveContextsMap } from '@/shortcuts/ActiveContexts'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts'
import { getDefaultActionGroups } from '@/shortcuts/defaultShortcuts'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler'
import { ActionContextTypes } from '@/shortcuts/types'
import { runActionById } from '@/shortcuts/runAction'
import { invokeAction } from '@/shortcuts/actionDispatch'
import { getEffectiveActions } from '@/shortcuts/effectiveActions'
import { TOGGLE_BLOCK_SELECTION_ACTION_ID } from '@/extensions/blockSelectionAction'
import { useActionContext } from '@/shortcuts/useActionContext'
import { BlockContextProvider } from '@/context/block'
import { PropertyDisplayScopeContext } from '@/context/propertyDisplay'
import { RepoContext } from '@/context/repo'
import { BlockComponent } from '@/components/BlockComponent'
import { __resetLazyMountCachesForTesting } from '@/components/util/LazyViewportMount'
import { __resetLazyMountRegistryForTesting } from '@/components/util/lazyMountRegistry'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { plainOutlinerPlugin } from '@/plugins/plain-outliner'
import { vimNormalModePlugin } from '@/plugins/vim-normal-mode'
import * as toast from '@/utils/toast'
import { turnIntoTable } from '../convert'
import { tablesPlugin } from '../index'
import { CELL_CONTROL_SELECTOR } from '../controller'
import { gridOfHost, tableRenderScopeId } from '../registry'

const USER: User = {id: 'test-user', name: 'Test user'}
vi.mock('@/components/Login.tsx', () => ({useUser: () => USER}))

const WS = 'tables-outline-gestures'
const PANEL = 'panel'
const HOST = 'host'
const PARENT_SCOPE = 'tables-gestures'
const SCOPE = tableRenderScopeId(PARENT_SCOPE, HOST)
const done = seedProperty({seedKey: 'test/property/tables-gesture-done', revision: 1,
  name: 'gesture:done', preset: 'boolean', changeScope: ChangeScope.BlockDefault})
const tags = seedProperty({seedKey: 'test/property/tables-gesture-tags', revision: 1,
  name: 'gesture:tags', preset: 'string-list', changeScope: ChangeScope.BlockDefault})

let db: TestDb
let repo: Repo
let runtime: FacetRuntime
const configureRuntime = (...extra: AppExtension[]) => {
  const defaults = getDefaultActionGroups({repo})
  runtime = resolveFacetRuntimeSync([
    kernelDataExtension, kernelPropertyUiExtension, kernelValuePresetsExtension,
    defaultRenderersExtension, plainOutlinerPlugin, defaultEditorInteractionExtension, tablesPlugin,
    defaultActionContextConfigs.map(config => actionContextsFacet.of(config, {source: 'test'})),
    [...defaults.globalActions, ...defaults.normalModeActions, ...defaults.editModeCMActions]
      .map(action => actionsFacet.of(action)),
    definitionSeedsFacet.of(tags, {source: 'test'}),
    definitionSeedsFacet.of(done, {source: 'test'}),
    ...extra,
  ])
  repo.setFacetRuntime(runtime)
}
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
// happy-dom fires selectionchange inside CodeMirror's own update.
const swallowSelectionChange = (event: Event) => event.stopImmediatePropagation()
afterEach(async () => {
  window.removeEventListener('selectionchange', swallowSelectionChange, true)
  vi.restoreAllMocks()
  cleanup()
  // An unmounted cell editor finishes its edit on a timer; let it write before the reset.
  await act(() => new Promise(resolve => setTimeout(resolve)))
  vi.unstubAllGlobals()
  __resetLazyMountRegistryForTesting()
  __resetLazyMountCachesForTesting()
})
beforeEach(async () => {
  window.addEventListener('selectionchange', swallowSelectionChange, true)
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
  }))
  await resetTestDb(db.db)
  await db.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
       encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'test', ?, 1, 1, 'none', NULL, 'children')`, [WS, USER.id])
  repo = createTestRepo({db: db.db, user: USER, newId: () => crypto.randomUUID()}).repo
  configureRuntime()
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: PANEL, workspaceId: WS, parentId: null, orderKey: 'a0', content: ''})
    await tx.create({id: HOST, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Table'})
    await tx.create({id: 'row-0', workspaceId: WS, parentId: HOST, orderKey: 'a0', content: 'first'})
    await tx.create({id: 'row-1', workspaceId: WS, parentId: HOST, orderKey: 'a1', content: 'second'})
  }, {scope: ChangeScope.BlockDefault})
  await waitFor(() => expect(repo.propertySchemas.has(tags.name) && repo.propertySchemas.has(done.name)).toBe(true))
  await repo.awaitSeedMaterialization()
  await repo.block('row-0').set(tags, ['alpha', 'beta'])
  await repo.awaitReprojections()
  await turnIntoTable(repo, HOST)
  repo.undoManager.clear()
})

let activeContexts: ActiveContextsMap = new Map()
const ContextProbe = () => {
  const contexts = useActiveContextsState()
  useEffect(() => { activeContexts = contexts }, [contexts])
  return null
}
const GlobalShortcuts = () => { useActionContext(ActionContextTypes.GLOBAL); return null }

const mount = () => render(
  <RepoContext value={repo}>
    <AppRuntimeContextProvider value={runtime}>
      <ActiveContextsProvider>
        <HotkeyReconciler/>
        <ContextProbe/>
        <Suspense fallback={null}>
          <BlockContextProvider initialValue={{panelId: PANEL, renderScopeId: PARENT_SCOPE, scopeRootId: HOST}}>
            <GlobalShortcuts/>
            <PropertyDisplayScopeContext value={{childBacked: true, workspace: 'non-hidden', panel: 'inherit'}}>
              <BlockComponent blockId={HOST}/>
            </PropertyDisplayScopeContext>
          </BlockContextProvider>
        </Suspense>
      </ActiveContextsProvider>
    </AppRuntimeContextProvider>
  </RepoContext>,
)

const ui = () => repo.block(PANEL)

/** The live (non-deleted) children of `parentId`, in order, as content. */
const contentsUnder = async (parentId: string) => (await db.db.getAll<{content: string}>(
  'SELECT content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id', [parentId],
)).map(row => row.content)

const memberIds = async () => (await db.db.getAll<{id: string}>(
  `SELECT value.id FROM blocks value JOIN blocks field ON field.id = value.parent_id
    WHERE field.parent_id = 'row-0' AND field.is_field_form = 1 AND value.deleted = 0 AND field.deleted = 0
    ORDER BY value.order_key, value.id`)).map(row => row.id)

/** The host's rows: its children that are neither its view nor a field row. */
const rowsUnderHost = async () => (await db.db.getAll<{id: string}>(
  `SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 AND is_field_form IS NOT 1
     AND properties_json NOT LIKE '%tables:view%' ORDER BY order_key, id`, [HOST])).map(row => row.id)

const fieldRowId = async () => (await db.db.get<{id: string}>(
  "SELECT id FROM blocks WHERE parent_id = 'row-0' AND is_field_form = 1 AND deleted = 0")).id

/** The editor the table shows on `blockId`, once its edit-mode keys are live. */
const editorOn = async (blockId: string) => {
  const view = await waitFor(() => {
    const node = document.querySelector<HTMLElement>(`[data-table-grid] [data-block-id="${blockId}"] .cm-editor`)
    expect(node).not.toBeNull()
    return EditorView.findFromDOM(node!)!
  })
  await waitFor(() => expect((activeContexts.get(ActionContextTypes.EDIT_MODE_CM) as {block?: {id: string}})?.block?.id).toBe(blockId))
  return view
}

/** Open an editor on `blockId` in the table, with the caret at `at`. */
const editAt = async (blockId: string, at: 'start' | 'end') => {
  const length = (await repo.load(blockId))?.content.length ?? 0
  await act(async () => {
    await ui().set(editorSelection, {blockId, start: at === 'start' ? 0 : length})
    await focusBlock(ui(), blockId, {edit: true, renderScopeId: SCOPE})
  })
  const view = await editorOn(blockId)
  await waitFor(() => expect(view.state.selection.main.head).toBe(at === 'start' ? 0 : length))
  return view
}

const press = (view: EditorView, key: string, options: {shiftKey?: boolean} = {}) => {
  fireEvent.keyDown(view.contentDOM, {key, code: key, ...options})
}

const focused = () => peekFocusedBlockLocation(ui())

describe('a list cell draws its members as outline blocks', () => {
  it('shows each member with a bullet, not as a bare cell value', async () => {
    mount()
    const [alpha] = await waitFor(async () => {
      const ids = await memberIds()
      expect(document.querySelector(`[data-table-grid] [data-block-id="${ids[0]}"]`)).not.toBeNull()
      return ids
    })
    const shell = document.querySelector(`[data-table-grid] [data-block-id="${alpha}"]`)!
    expect(shell.closest('[data-table-value]')).toBeNull()
    expect(shell.closest('[data-table-list]')).not.toBeNull()
  })

  it('Enter at the end of a member adds the next member, edited in the table', async () => {
    mount()
    const [alpha] = await memberIds()
    const view = await editAt(alpha!, 'end')
    press(view, 'Enter')
    await waitFor(async () => expect(await contentsUnder(await fieldRowId())).toEqual(['alpha', '', 'beta']))
    const created = (await memberIds())[1]!
    await waitFor(() => expect(focused()).toEqual({blockId: created, renderScopeId: SCOPE}))
    expect(ui().peekProperty(isEditingProp)).toBe(true)
  })

  it('Backspace on an empty member removes it and edits the member above', async () => {
    const field = await fieldRowId()
    const blank = await repo.mutate.createChild({parentId: field, content: '', position: {kind: 'last'}})
    mount()
    const [alpha, beta] = await memberIds()
    const view = await editAt(blank!, 'start')
    press(view, 'Backspace')
    await waitFor(async () => expect(await memberIds()).toEqual([alpha, beta]))
    await waitFor(() => expect(focused()).toEqual({blockId: beta, renderScopeId: SCOPE}))
  })

  it('Backspace on an empty first member removes it and returns to the row', async () => {
    const field = await fieldRowId()
    const blank = await repo.mutate.createChild({parentId: field, content: '', position: {kind: 'first'}})
    mount()
    const view = await editAt(blank!, 'start')
    press(view, 'Backspace')
    await waitFor(async () => expect(await contentsUnder(field)).toEqual(['alpha', 'beta']))
    await waitFor(() => expect(focused()).toEqual({blockId: 'row-0', renderScopeId: SCOPE}))
  })

  it('Backspace at the start of a member merges it into the one above, with no refusal', async () => {
    const error = vi.spyOn(toast, 'showError')
    mount()
    const [alpha, beta] = await memberIds()
    const view = await editAt(beta!, 'start')
    press(view, 'Backspace')
    await waitFor(async () => expect(await memberIds()).toEqual([alpha]))
    expect((await repo.load(alpha!))?.content).toBe('alphabeta')
    await waitFor(() => expect(focused()?.blockId).toBe(alpha))
    // The merged member's editor tears down after the merge; that is not a refused edit.
    await act(async () => { await focusBlock(ui(), 'row-1', {renderScopeId: SCOPE}) })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(error).not.toHaveBeenCalled()
  })

  it('Tab nests a member under the one above, and the cell shows it', async () => {
    mount()
    const [alpha, beta] = await memberIds()
    const view = await editAt(beta!, 'end')
    press(view, 'Tab')
    await waitFor(async () => expect((await repo.load(beta!))?.parentId).toBe(alpha))
    await waitFor(() => expect(document.querySelector(
      `[data-table-list] [data-block-id="${alpha}"] [data-block-id="${beta}"]`)).not.toBeNull())
    // Nested, it is still in the cell: Escape leaves for the row.
    press(await editorOn(beta!), 'Escape')
    await waitFor(() => expect(focused()).toEqual({blockId: 'row-0', renderScopeId: SCOPE}))
  })

  it('Escape leaves the cell for its row', async () => {
    mount()
    const [alpha] = await memberIds()
    const view = await editAt(alpha!, 'end')
    press(view, 'Escape')
    await waitFor(() => expect(focused()).toEqual({blockId: 'row-0', renderScopeId: SCOPE}))
  })

  it('ArrowDown moves between members, and past the last member to the next row', async () => {
    mount()
    const [alpha, beta] = await memberIds()
    let view = await editAt(alpha!, 'end')
    press(view, 'ArrowDown')
    await waitFor(() => expect(focused()).toEqual({blockId: beta, renderScopeId: SCOPE}))
    // One line: ArrowDown leaves it wherever the step left the caret.
    view = await editorOn(beta!)
    press(view, 'ArrowDown')
    await waitFor(() => expect(focused()).toEqual({blockId: 'row-1', renderScopeId: SCOPE}))
  })

  it('ArrowUp from the first member leaves the cell upwards, not onto the hidden field row', async () => {
    mount()
    const [alpha] = await memberIds()
    const view = await editAt(alpha!, 'start')
    press(view, 'ArrowUp')
    await waitFor(() => expect(focused()?.blockId).toBe(HOST))
  })
})

describe('the grid around a list cell', () => {
  it('Backspace in an empty new member of an unset list leaves the list unset', async () => {
    mount()
    await waitFor(() => expect(document.querySelector('[data-table-row="row-1"]')).not.toBeNull())
    await act(async () => { gridOfHost(PARENT_SCOPE, HOST)!.focusCell('row-1', 1, true) })
    const draft = await waitFor(async () => {
      const id = (await db.db.getAll<{id: string}>(
        `SELECT value.id FROM blocks value JOIN blocks field ON field.id = value.parent_id
          WHERE field.parent_id = 'row-1' AND field.is_field_form = 1 AND value.deleted = 0`))[0]?.id
      expect(id).toBeDefined()
      return id!
    })
    press(await editorOn(draft), 'Backspace')
    await waitFor(() => expect(focused()).toEqual({blockId: 'row-1', renderScopeId: SCOPE}))
    await waitFor(async () => expect(await db.db.getAll(
      "SELECT id FROM blocks WHERE parent_id = 'row-1' AND is_field_form = 1 AND deleted = 0")).toEqual([]))
    expect(repo.block('row-1').peek()?.properties).not.toHaveProperty(tags.name)
  })

  it('focus an outline verb puts on a cell’s field row goes to its row', async () => {
    mount()
    const field = await fieldRowId()
    await waitFor(() => expect(document.querySelector('[data-table-list]')).not.toBeNull())
    await act(async () => { await focusBlock(ui(), field, {edit: true, renderScopeId: SCOPE}) })
    await waitFor(() => expect(focused()).toEqual({blockId: 'row-0', renderScopeId: SCOPE}))
    expect(ui().peekProperty(isEditingProp)).toBe(false)
  })

  it('Ctrl-click starts no block selection on a member, as it does elsewhere', async () => {
    mount()
    const [alpha] = await memberIds()
    await waitFor(() => expect(document.querySelector(`[data-table-list] [data-block-id="${alpha}"]`)).not.toBeNull())
    // The pointer path dispatches the click's action with the clicked block's deps.
    const toggle = getEffectiveActions(runtime).find(action => action.id === TOGGLE_BLOCK_SELECTION_ACTION_ID)!
    const click = (blockId: string, renderScopeId: string) => act(async () => {
      await invokeAction(runtime, {action: toggle, trigger: new PointerEvent('click', {ctrlKey: true}),
        deps: {block: repo.block(blockId), uiStateBlock: ui(), renderScopeId, scopeRootId: HOST} as never})
    })
    await click(alpha!, SCOPE)
    expect(ui().peekProperty(selectionStateProp)?.selectedBlockIds ?? []).toEqual([])
    // The same click outside the grid's scope selects.
    await click(alpha!, PARENT_SCOPE)
    expect(ui().peekProperty(selectionStateProp)?.selectedBlockIds).toEqual([alpha])
  })

  it('Shift+ArrowDown at the end of the last member starts no block selection', async () => {
    mount()
    const [, beta] = await memberIds()
    const view = await editAt(beta!, 'end')
    press(view, 'ArrowDown', {shiftKey: true})
    // The base action would have selected `beta` and left edit mode by now.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
    expect(ui().peekProperty(selectionStateProp)?.selectedBlockIds ?? []).toEqual([])
    expect(ui().peekProperty(isEditingProp)).toBe(true)
  })
})

describe('a table nested in a list member', () => {
  it('a click on the inner table’s member reaches it, past the outer cell', async () => {
    const [alpha] = await memberIds()
    await repo.tx(async tx => {
      await tx.create({id: 'inner', workspaceId: WS, parentId: alpha!, orderKey: 'a0', content: 'Inner'})
      await tx.create({id: 'inner-row', workspaceId: WS, parentId: 'inner', orderKey: 'a0', content: 'inner row'})
    }, {scope: ChangeScope.BlockDefault})
    await repo.block('inner-row').set(tags, ['gamma'])
    await repo.awaitReprojections()
    await turnIntoTable(repo, 'inner')
    mount()
    const gamma = await waitFor(() => {
      const node = [...document.querySelectorAll('[data-table-row="inner-row"] [data-table-list] [data-block-id]')]
        .find(element => element.textContent?.includes('gamma'))
      expect(node).toBeDefined()
      return node!
    })
    // The outer cell's capture handler would stop it before the member's own click handling.
    let reached = false
    gamma.addEventListener('click', () => { reached = true })
    fireEvent.click(gamma)
    expect(reached).toBe(true)
    expect(focused()?.blockId).not.toBe('row-0')
  })

  it('opening the outer list cell opens a member, not the inner table’s control', async () => {
    const [alpha] = await memberIds()
    await repo.tx(async tx => {
      await tx.create({id: 'inner', workspaceId: WS, parentId: alpha!, orderKey: 'a0', content: 'Inner'})
      await tx.create({id: 'inner-row', workspaceId: WS, parentId: 'inner', orderKey: 'a0', content: 'inner row'})
    }, {scope: ChangeScope.BlockDefault})
    await repo.block('inner-row').set(done, true)
    await repo.awaitReprojections()
    await turnIntoTable(repo, 'inner')
    mount()
    const control = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(`[data-table-row="inner-row"] ${CELL_CONTROL_SELECTOR}`)
      expect(node).not.toBeNull()
      return node!
    })
    const [, beta] = await memberIds()
    await act(async () => { gridOfHost(PARENT_SCOPE, HOST)!.focusCell('row-0', 1, true) })
    // A string list opens its last member.
    await waitFor(() => expect(focused()).toEqual({blockId: beta, renderScopeId: SCOPE}))
    expect(ui().peekProperty(isEditingProp)).toBe(true)
    expect(document.activeElement).not.toBe(control)
  })

  it('an inner table’s control belongs to the inner grid alone', async () => {
    const [alpha] = await memberIds()
    await repo.tx(async tx => {
      await tx.create({id: 'inner', workspaceId: WS, parentId: alpha!, orderKey: 'a0', content: 'Inner'})
      await tx.create({id: 'inner-row', workspaceId: WS, parentId: 'inner', orderKey: 'a0', content: 'inner row'})
    }, {scope: ChangeScope.BlockDefault})
    await repo.block('inner-row').set(done, true)
    await repo.awaitReprojections()
    await turnIntoTable(repo, 'inner')
    mount()
    const control = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(`[data-table-row="inner-row"] ${CELL_CONTROL_SELECTOR}`)
      expect(node).not.toBeNull()
      return node!
    })
    act(() => { control.focus() })
    // Each grid takes a focused control as its own synchronously: only the inner one may.
    expect(gridOfHost(SCOPE, 'inner')!.isInControl()).toBe(true)
    expect(gridOfHost(PARENT_SCOPE, HOST)!.isInControl()).toBe(false)
  })
})

describe('normal mode on a list member', () => {
  // Without spatial navigation: its vertical move walks the laid-out DOM, which
  // happy-dom does not lay out. The browser check covers it.
  beforeEach(() => configureRuntime(vimNormalModePlugin({repo})))

  /** Focus `blockId` in the table without editing it, and run vim's `actionId` on it through
   *  the dispatch path (with every wrap), as its key would. */
  const normalRun = async (blockId: string, actionId: string) => {
    await act(async () => { await focusBlock(ui(), blockId, {renderScopeId: SCOPE}) })
    await waitFor(() => expect((activeContexts.get(ActionContextTypes.NORMAL_MODE) as {block?: {id: string}})?.block?.id).toBe(blockId))
    await act(async () => { await runActionById(actionId, new KeyboardEvent('keydown')) })
  }

  it('down moves to the next member, and from the last member to the next row', async () => {
    mount()
    const [alpha, beta] = await memberIds()
    await normalRun(alpha!, 'move_down')
    await waitFor(() => expect(focused()).toEqual({blockId: beta, renderScopeId: SCOPE}))
    await normalRun(beta!, 'move_down')
    await waitFor(() => expect(focused()).toEqual({blockId: 'row-1', renderScopeId: SCOPE}))
  })

  it('up from the first member leaves the cell for the row above', async () => {
    mount()
    const [alpha] = await memberIds()
    await normalRun(alpha!, 'move_up')
    await waitFor(() => expect(focused()?.blockId).toBe(HOST))
  })

  it('create-below adds a member below, not a row', async () => {
    mount()
    const [alpha] = await memberIds()
    await normalRun(alpha!, 'create_block_below_and_edit')
    await waitFor(async () => expect(await contentsUnder(await fieldRowId())).toEqual(['alpha', '', 'beta']))
    expect(await rowsUnderHost()).toEqual(['row-0', 'row-1'])
  })

  it('enter-edit edits the member itself', async () => {
    mount()
    const [alpha] = await memberIds()
    await normalRun(alpha!, 'enter_edit_mode')
    await waitFor(() => expect(ui().peekProperty(isEditingProp)).toBe(true))
    expect(focused()).toEqual({blockId: alpha, renderScopeId: SCOPE})
  })
})

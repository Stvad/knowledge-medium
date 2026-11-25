// @vitest-environment happy-dom
import { Suspense, useEffect } from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import * as structuralEdits from '@/data/structuralEditPolicy'
import { ChangeScope, seedProperty, type User } from '@/data/api'
import { definitionSeedsFacet, queryableFieldsFacet, refTargetComparablePropertiesFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { editorSelection, focusBlock, isCollapsedProp, isEditingProp, typesProp, peekFocusedBlockLocation, selectionStateProp } from '@/data/properties'
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
import { dailyNotesDataExtension } from '@/plugins/daily-notes/dataExtension'
import { getOrCreateDailyNote } from '@/plugins/daily-notes/dailyNotes'
import { DAILY_NOTE_TYPE, dayValuePresetCore } from '@/plugins/daily-notes/schema'
import * as toast from '@/utils/toast'
import { disarmCut, getArmedCut } from '@/paste/armedCut'
import { pasteArmedCut } from '@/paste/operations'
import { HTML_DOCUMENT_TYPE } from '@/data/blockTypes'
import { propertyDisplayProp } from '@/data/propertyDisplayMode'
import { turnIntoTable } from '../convert'
import { addColumn } from '../columns'
import { viewQuery } from '../model'
import { openQueryValue } from '../query/queryValue'
import { materializePropertySeeds, propertyDefinitionBlockId } from '@/data/definitionSeeds'
import { tablesPlugin } from '../index'
import { CELL_CONTROL_SELECTOR } from '../controller'
import { gridOfHost, tableNotesScopeId, tableRenderScopeId } from '../registry'
import { queryProp } from '../schema'

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

const mount = (childBacked = true) => render(
  <RepoContext value={repo}>
    <AppRuntimeContextProvider value={runtime}>
      <ActiveContextsProvider>
        <HotkeyReconciler/>
        <ContextProbe/>
        <Suspense fallback={null}>
          <BlockContextProvider initialValue={{panelId: PANEL, renderScopeId: PARENT_SCOPE, scopeRootId: HOST}}>
            <GlobalShortcuts/>
            <PropertyDisplayScopeContext value={{childBacked, workspace: 'non-hidden', panel: 'inherit'}}>
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

/** The host's children's properties, in order. */
const children = async (parentId: string) => (await db.db.getAll<{properties_json: string}>(
  'SELECT properties_json FROM blocks WHERE parent_id = ? AND deleted = 0 AND is_field_form IS NOT 1 ORDER BY order_key, id',
  [parentId])).map(row => row.properties_json)

const fieldRowId = async () => (await db.db.get<{id: string}>(
  "SELECT id FROM blocks WHERE parent_id = 'row-0' AND is_field_form = 1 AND deleted = 0")).id

/** The editor the table shows on `blockId`, once its edit-mode keys are live. */
const editorOn = async (blockId: string) => {
  const view = await waitFor(() => {
    const node = document.querySelector<HTMLElement>(`[data-block-id="${blockId}"] .cm-editor`)
    expect(node).not.toBeNull()
    return EditorView.findFromDOM(node!)!
  })
  await waitFor(() => expect((activeContexts.get(ActionContextTypes.EDIT_MODE_CM) as {block?: {id: string}})?.block?.id).toBe(blockId))
  return view
}

/** Open an editor on `blockId` in the table, with the caret at `at`. */
const editAt = async (blockId: string, at: 'start' | 'end', renderScopeId = SCOPE) => {
  const length = (await repo.load(blockId))?.content.length ?? 0
  await act(async () => {
    await ui().set(editorSelection, {blockId, start: at === 'start' ? 0 : length})
    await focusBlock(ui(), blockId, {edit: true, renderScopeId})
  })
  const view = await editorOn(blockId)
  await waitFor(() => expect(view.state.selection.main.head).toBe(at === 'start' ? 0 : length))
  return view
}

const press = (view: EditorView, key: string, options: {shiftKey?: boolean} = {}) => {
  fireEvent.keyDown(view.contentDOM, {key, code: key, ...options})
}

const focused = () => peekFocusedBlockLocation(ui())

it.each([
  {storage: 'old property bags', childBacked: false, readOnly: false},
  {storage: 'read-only workspace', childBacked: true, readOnly: true},
])('links stored days and legacy daily-note refs in $storage', async ({childBacked, readOnly}) => {
  const day = seedProperty({
    seedKey: 'test/property/tables-gesture-day', revision: 1, name: 'gesture:day',
    preset: dayValuePresetCore, changeScope: ChangeScope.BlockDefault,
  })
  const legacy = seedProperty({
    seedKey: 'test/property/tables-gesture-legacy-day', revision: 1, name: 'gesture:legacy-day',
    preset: 'optional-ref', config: {targetTypes: [DAILY_NOTE_TYPE]}, changeScope: ChangeScope.BlockDefault,
  })
  configureRuntime(dailyNotesDataExtension, [day, legacy].map(seed => definitionSeedsFacet.of(seed, {source: 'test'})))
  await repo.whenPropertyDefinitionsReady(WS)
  await materializePropertySeeds(repo, WS, [day, legacy])
  const [viewId] = await repo.query.typedBlockIds(viewQuery(HOST, WS)).load()
  await addColumn(repo, viewId!, propertyDefinitionBlockId(WS, day.seedKey))
  await addColumn(repo, viewId!, propertyDefinitionBlockId(WS, legacy.seedKey))
  const target = await getOrCreateDailyNote(repo, WS, '2026-01-06')
  const title = (await target.load())!.content
  await target.setContent('Trip planning')
  await repo.awaitProcessors()
  if (!childBacked) await db.db.execute("UPDATE workspaces SET properties_migration = 'cell' WHERE id = ?", [WS])
  await db.db.execute("UPDATE blocks SET properties_json = json_patch(properties_json, ?), updated_at = updated_at + 1 WHERE id = 'row-0'",
    [JSON.stringify({[day.name]: target.id, [legacy.name]: target.id})])
  await repo.load('row-0')
  expect(repo.block('row-0').peek()?.properties).toMatchObject({[day.name]: target.id, [legacy.name]: target.id})
  repo.setReadOnly(readOnly)

  mount(childBacked)
  await waitFor(() => {
    const cells = document.querySelector(`[data-table-row="row-0"]`)!
    const days = [...cells.querySelectorAll('a')].filter(link => link.textContent === title)
    expect(days.map(link => link.getAttribute('href'))).toEqual([`#${WS}/${target.id}`, `#${WS}/${target.id}`])
    expect(days.map(link => link.getAttribute('title'))).toEqual(['Trip planning', 'Trip planning'])
    expect(cells.textContent).not.toContain(target.id)
    expect(cells.querySelector('[aria-label="Change day"], [aria-label="Choose day"]')).toBeNull()
  })
})

// The mounted grid and all three sort transitions take about a second locally.
it('cycles the daily note reference header through date order and outline order', async () => {
  const planned = seedProperty({
    seedKey: 'test/property/tables-gesture-planned', revision: 1,
    name: 'gesture:planned', preset: 'optional-ref', changeScope: ChangeScope.BlockDefault,
    config: {targetTypes: [DAILY_NOTE_TYPE]},
  })
  configureRuntime(dailyNotesDataExtension, definitionSeedsFacet.of(planned, {source: 'test'}))
  await repo.whenPropertyDefinitionsReady(WS)
  await materializePropertySeeds(repo, WS, [planned])
  const earlier = await getOrCreateDailyNote(repo, WS, '2026-01-04')
  const later = await getOrCreateDailyNote(repo, WS, '2026-01-06')
  await repo.tx(async tx => {
    await tx.setProperty('row-0', planned, later.id)
    await tx.setProperty('row-1', planned, earlier.id)
    await tx.create({id: 'row-2', workspaceId: WS, parentId: HOST, orderKey: 'a0V', content: 'unscheduled'})
  }, {scope: ChangeScope.BlockDefault})
  const [viewId] = await repo.query.typedBlockIds(viewQuery(HOST, WS)).load()
  const columnId = await addColumn(repo, viewId!, propertyDefinitionBlockId(WS, planned.seedKey))

  mount()
  const header = await waitFor(() => {
    const column = document.querySelector(`[data-table-column="${columnId}"]`)
    expect(column).not.toBeNull()
    return column!
  })
  const label = header.querySelector('[data-table-column-drag]')!
  const order = () => [...document.querySelectorAll<HTMLElement>('[data-table-row]')].map(row => row.dataset.tableRow)
  await waitFor(() => expect(order()).toEqual(['row-0', 'row-2', 'row-1']))
  const clickHeader = () => {
    const pointer = {pointerId: 1, button: 0, clientX: 10}
    fireEvent.pointerDown(label, pointer)
    fireEvent.pointerUp(label, pointer)
  }
  clickHeader()
  await waitFor(() => {
    expect(header).toHaveAttribute('aria-sort', 'ascending')
    expect(order()).toEqual(['row-1', 'row-0', 'row-2'])
  })
  const replaceTarget = (property: string | undefined) => act(() => {
    repo.setRuntimeContributions(refTargetComparablePropertiesFacet, 'test-override',
      property ? [{targetType: DAILY_NOTE_TYPE, property}] : [], {workspaceId: WS})
  })
  replaceTarget(tags.name)
  await waitFor(() => {
    expect(header).not.toHaveAttribute('aria-sort')
    expect(order()).toEqual(['row-0', 'row-2', 'row-1'])
  })
  replaceTarget(undefined)
  await waitFor(() => {
    expect(header).toHaveAttribute('aria-sort', 'ascending')
    expect(order()).toEqual(['row-1', 'row-0', 'row-2'])
  })
  clickHeader()
  await waitFor(() => {
    expect(header).toHaveAttribute('aria-sort', 'descending')
    expect(order()).toEqual(['row-0', 'row-1', 'row-2'])
  })
  clickHeader()
  await waitFor(() => {
    expect(header).not.toHaveAttribute('aria-sort')
    expect(order()).toEqual(['row-0', 'row-2', 'row-1'])
  })
  await act(async () => {
    await repo.block(HOST).set(queryProp, `childof=self ${planned.name}>=2026-01-05`)
  })
  await waitFor(() => expect(order()).toEqual(['row-0']))
  replaceTarget(tags.name)
  await waitFor(() => {
    expect(document.querySelector('[data-table-query-errors]')).not.toBeNull()
    expect(new Set(order())).toEqual(new Set(['row-0', 'row-1', 'row-2']))
  })
}, 20_000)

it('reparses a mounted table when a queryable field becomes available', async () => {
  await repo.block(HOST).set(queryProp, 'childof=self score>=1')
  mount()
  await waitFor(() => expect(document.querySelector('[data-table-query-errors]')).not.toBeNull())
  act(() => {
    repo.setRuntimeContributions(queryableFieldsFacet, 'test-override', [{
      name: 'score',
      value: alias => ({sql: `CASE WHEN ${alias}.id = ? THEN 1 ELSE 0 END`, params: ['row-1']}),
      encode: operand => Number(operand),
      dependencies: [workspaceId => ({kind: 'workspace', workspaceId})],
    }], {workspaceId: WS})
  })
  await waitFor(() => {
    expect(document.querySelector('[data-table-query-errors]')).toBeNull()
    expect([...document.querySelectorAll<HTMLElement>('[data-table-row]')].map(row => row.dataset.tableRow)).toEqual(['row-1'])
  })
})

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

describe('a row draws its children', () => {
  const note = () => repo.mutate.createChild({parentId: 'row-0', content: 'a note', position: {kind: 'last'}})

  it('Delete at the end of the last note in a plain table keeps the next row intact', async () => {
    const id = (await note())!
    mount()
    const editor = await editAt(id, 'end')
    await act(async () => {
      await runActionById('merge_next_block_cm', new KeyboardEvent('keydown', {key: 'Delete'}))
    })
    expect(editor.state.doc.toString()).toBe('a note')
    expect(await repo.load(id)).toMatchObject({content: 'a note', parentId: 'row-0'})
    expect(await repo.load('row-1')).toMatchObject({content: 'second', parentId: HOST})
  })

  it('under its cells, once each, and its expand toggle hides them', async () => {
    const id = await note()
    mount()
    await waitFor(() => expect(document.querySelector(`[data-table-row="row-0"] [data-table-notes] [data-block-id="${id}"]`)).not.toBeNull())
    // Its property rows are its cells, not notes.
    expect(document.querySelector(`[data-table-notes] [data-block-id="${await fieldRowId()}"]`)).toBeNull()
    await act(async () => { await repo.block('row-0').set(isCollapsedProp, true) })
    await waitFor(() => expect(document.querySelector(`[data-table-notes] [data-block-id="${id}"]`)).toBeNull())
  })

  it('draws a list member once while it is edited', async () => {
    await note()
    mount()
    const [alpha] = await memberIds()
    await editAt(alpha!, 'end')
    expect(document.querySelectorAll(`[data-block-id="${alpha}"]`)).toHaveLength(1)
  })

  it('ArrowDown from a row’s text enters its children, and from the last one goes to the next row', async () => {
    const id = await note()
    const second = await note()
    mount()
    press(await editAt('row-0', 'end'), 'ArrowDown')
    await waitFor(() => expect(focused()).toEqual({blockId: id, renderScopeId: SCOPE}))
    press(await editorOn(id!), 'ArrowDown')
    await waitFor(() => expect(focused()).toEqual({blockId: second, renderScopeId: SCOPE}))
    expect(ui().peekProperty(isEditingProp)).toBe(true)
    press(await editorOn(second!), 'ArrowDown')
    await waitFor(() => expect(focused()).toEqual({blockId: 'row-1', renderScopeId: SCOPE}))
    expect(ui().peekProperty(isEditingProp)).toBe(false)
  })

  it.each([false, true])('ArrowDown from the final query note with an outside row: %s', async hasOutsideRow => {
    const note = await repo.mutate.createChild({parentId: 'row-1', content: 'A note', position: {kind: 'last'}})
    if (!hasOutsideRow) {
      await repo.tx(tx => tx.move('row-0', {parentId: null, orderKey: 'a2'}), {scope: ChangeScope.BlockDefault})
    }
    await db.db.execute("UPDATE blocks SET created_at = 100000 WHERE id = 'row-1'")
    await repo.block(HOST).set(queryProp, 'created<2000-01-01')
    await repo.awaitReprojections()
    mount()
    const notesScope = tableNotesScopeId(SCOPE, 'row-1')
    press(await editAt(note!, 'end', notesScope), 'ArrowDown')
    const expected = hasOutsideRow ? {blockId: 'row-0', renderScopeId: PARENT_SCOPE} : {blockId: 'row-1', renderScopeId: SCOPE}
    await waitFor(() => expect(focused()).toEqual(expected))
    expect(ui().peekProperty(isEditingProp)).toBe(hasOutsideRow)
  })

  it('ArrowDown from a row’s text enters its first child even when the row shows its property rows', async () => {
    const id = await note()
    await repo.block('row-0').set(propertyDisplayProp, 'all')
    mount()
    press(await editAt('row-0', 'end'), 'ArrowDown')
    await waitFor(() => expect(focused()).toEqual({blockId: id, renderScopeId: SCOPE}))
    expect(ui().peekProperty(isEditingProp)).toBe(true)
  })

  it('at the row cap, Enter still adds a first child under a row whose children show', async () => {
    await note()
    mount()
    const view = await editAt('row-0', 'end')
    vi.spyOn(gridOfHost(PARENT_SCOPE, HOST)!, 'allowsNewRow').mockReturnValue(false)
    press(view, 'Enter')
    await waitFor(async () => expect(await contentsUnder('row-0')).toEqual(expect.arrayContaining(['', 'a note'])))
    expect(await rowsUnderHost()).toEqual(['row-0', 'row-1'])
  })

  it('ArrowUp from the next row’s text edits the last child shown above it', async () => {
    const id = await note()
    mount()
    press(await editAt('row-1', 'start'), 'ArrowUp')
    await waitFor(() => expect(focused()).toEqual({blockId: id, renderScopeId: SCOPE}))
    expect(ui().peekProperty(isEditingProp)).toBe(true)
  })

  it('ArrowUp from its first child edits the row’s text even when the row shows its property rows', async () => {
    const id = await note()
    await repo.block('row-0').set(propertyDisplayProp, 'all')
    mount()
    press(await editAt(id!, 'start'), 'ArrowUp')
    await waitFor(() => expect(focused()).toEqual({blockId: 'row-0', renderScopeId: SCOPE}))
    expect(ui().peekProperty(isEditingProp)).toBe(true)
  })

  it('ArrowUp from its first child edits the row’s text', async () => {
    const id = await note()
    mount()
    press(await editAt(id!, 'start'), 'ArrowUp')
    await waitFor(() => expect(focused()).toEqual({blockId: 'row-0', renderScopeId: SCOPE}))
    expect(ui().peekProperty(isEditingProp)).toBe(true)
  })

  it('a child’s own Enter and Tab are the outline’s', async () => {
    const id = await note()
    mount()
    press(await editAt(id!, 'end'), 'Enter')
    await waitFor(async () => expect(await contentsUnder('row-0')).toEqual(expect.arrayContaining(['a note', ''])))
    const created = await waitFor(() => {
      const blockId = focused()?.blockId
      expect(blockId).not.toBe(id)
      return blockId!
    })
    press(await editorOn(created), 'Tab')
    await waitFor(async () => expect((await repo.load(created))?.parentId).toBe(id))
  })
})

describe('the outline’s verbs between rows', () => {
  const contentOf = async (id: string) => (await repo.load(id))?.content

  it('Enter at the end of the host title puts the first row after the view', async () => {
    mount()
    press(await editAt(HOST, 'end', PARENT_SCOPE), 'Enter')
    await waitFor(async () => expect(await rowsUnderHost()).toHaveLength(3))
    const [created, ...previous] = await rowsUnderHost()
    expect(previous).toEqual(['row-0', 'row-1'])
    expect((await children(HOST))[0]).toContain('tables:view')
    await waitFor(() => expect(focused()).toEqual({blockId: created, renderScopeId: SCOPE}))
  })

  it('refuses a mid-text split of the table title when shown as the editing root', async () => {
    mount()
    const view = await editAt(HOST, 'start', PARENT_SCOPE)
    act(() => { view.dispatch({selection: {anchor: 2}}) })
    await act(async () => { await runActionById('split_block_cm', new KeyboardEvent('keydown', {key: 'Enter'})) })
    expect(await rowsUnderHost()).toEqual(['row-0', 'row-1'])
    expect(await contentOf(HOST)).toBe('Table')
    expect(view.state.doc.toString()).toBe('Table')
  })

  it('Enter at the end of a row’s text adds the next row', async () => {
    mount()
    press(await editAt('row-0', 'end'), 'Enter')
    await waitFor(async () => expect(await rowsUnderHost()).toHaveLength(3))
    const [, created, second] = await rowsUnderHost()
    expect(second).toBe('row-1')
    await waitFor(() => expect(focused()).toEqual({blockId: created, renderScopeId: SCOPE}))
    expect(ui().peekProperty(isEditingProp)).toBe(true)
  })

  it('Enter on an empty row creates another row beside it', async () => {
    await repo.block('row-0').setContent('')
    mount()
    press(await editAt('row-0', 'end'), 'Enter')
    await waitFor(async () => expect(await rowsUnderHost()).toHaveLength(3))
    const [first, created, second] = await rowsUnderHost()
    expect([first, second]).toEqual(['row-0', 'row-1'])
    await waitFor(() => expect(focused()).toEqual({blockId: created, renderScopeId: SCOPE}))
  })

  it.each([
    ['create_block_above_and_edit', 0],
    ['create_block_below_and_edit', 1],
  ] as const)('Vim %s places a grid row even when the current row has notes', async (actionId, index) => {
    configureRuntime(vimNormalModePlugin({repo}))
    await repo.mutate.createChild({parentId: 'row-0', content: 'Note'})
    mount()
    await act(async () => { await focusBlock(ui(), 'row-0', {renderScopeId: SCOPE}) })
    await waitFor(() => expect(activeContexts.get(ActionContextTypes.NORMAL_MODE)).toMatchObject({
      block: {id: 'row-0'}, renderScopeId: SCOPE,
    }))
    await act(async () => { await runActionById(actionId, new KeyboardEvent('keydown')) })

    const rows = await rowsUnderHost()
    const created = rows[index]
    expect(rows.filter(id => id !== created)).toEqual(['row-0', 'row-1'])
    expect(await contentOf(created!)).toBe('')
    expect(await contentsUnder('row-0')).toContain('Note')
    await waitFor(() => expect(focused()).toEqual({blockId: created, renderScopeId: SCOPE}))
  })

  describe('Enter on a foreign query row', () => {
    const source = '0190a0c0-0000-7000-8000-0000000000aa'
    beforeEach(async () => {
      await repo.tx(async tx => {
        await tx.create({id: source, workspaceId: WS, parentId: null, orderKey: 'a2', content: 'source'})
        await tx.move('row-1', {parentId: source, orderKey: 'a0'})
      }, {scope: ChangeScope.BlockDefault})
      await db.db.execute("UPDATE blocks SET created_at = 100000 WHERE id = 'row-1'")
      await repo.block(HOST).set(queryProp, `childof=((${source})) created<2000-01-01`)
      await repo.awaitReprojections()
    })

    it('backfills and holds the new row in the grid when the query excludes it', async () => {
      mount()
      press(await editAt('row-1', 'end'), 'Enter')
      const target = await waitFor(() => {
        const location = focused()
        expect(location).toMatchObject({renderScopeId: SCOPE})
        expect(location?.blockId).not.toBe('row-1')
        return location!.blockId
      })
      expect(await repo.load(target)).toMatchObject({parentId: source, content: ''})
      expect(await contentsUnder(source)).toEqual(['second', ''])
      expect(await rowsUnderHost()).toEqual(['row-0'])
      await waitFor(() => expect(document.querySelector(`[data-table-row="${target}"][data-table-unmatched]`)).not.toBeNull())
    })

    it('inserts a query row when the caret moves while its Enter write waits', async () => {
      mount()
      const view = await editAt('row-1', 'end')
      let announce!: () => void
      let release!: () => void
      const queued = new Promise<void>(resolve => { announce = resolve })
      const write = new Promise<void>(resolve => { release = resolve })
      const runTx = repo.tx.bind(repo)
      vi.spyOn(repo, 'tx').mockImplementation(async (...args: Parameters<Repo['tx']>) => {
        if (args[1].description === 'new table row') {
          announce()
          await write
        }
        return runTx(...args)
      })

      await act(async () => {
        const entering = runActionById('split_block_cm', new KeyboardEvent('keydown', {key: 'Enter'}))
        await queued
        view.dispatch({selection: {anchor: 2}})
        release()
        await entering
      })

      expect(await contentsUnder(source)).toEqual(['second', ''])
      expect(await rowsUnderHost()).toEqual(['row-0'])
      const location = focused()
      expect(location).toMatchObject({renderScopeId: SCOPE})
      expect(location?.blockId).not.toBe('row-1')
      expect(await repo.load(location!.blockId)).toMatchObject({parentId: source, content: ''})
      expect(view.state.selection.main.head).toBe(2)
    })

    it('inserts under the foreign result when its notes show', async () => {
      const note = await repo.mutate.createChild({parentId: 'row-1', content: 'existing note'})
      mount()
      press(await editAt('row-1', 'end'), 'Enter')
      const notesScope = tableNotesScopeId(SCOPE, 'row-1')
      const target = await waitFor(() => {
        const location = focused()
        expect(location).toMatchObject({renderScopeId: notesScope})
        expect(location?.blockId).not.toBe(note)
        return location!.blockId
      })
      expect(await repo.load(target)).toMatchObject({parentId: 'row-1', content: ''})
      expect(await contentsUnder('row-1')).toEqual(['', 'existing note'])
      expect(await contentsUnder(source)).toEqual(['second'])
    })

    it('refuses mid-text split without changing the result or its notes', async () => {
      mount()
      const view = await editAt('row-1', 'start')
      act(() => { view.dispatch({selection: {anchor: 3}}) })
      await act(async () => { await runActionById('split_block_cm', new KeyboardEvent('keydown', {key: 'Enter'})) })
      expect(await contentsUnder(source)).toEqual(['second'])
      expect(await contentsUnder('row-1')).toEqual([])
      expect(view.state.doc.toString()).toBe('second')
      expect(view.state.selection.main.head).toBe(3)
    })

    it('cuts notes only within their foreign result and leaves the result itself in place', async () => {
      configureRuntime(vimNormalModePlugin({repo}))
      const first = (await repo.mutate.createChild({parentId: 'row-1', content: 'First note'}))!
      const last = (await repo.mutate.createChild({parentId: 'row-1', content: 'Last note'}))!
      const info = vi.spyOn(toast, 'showInfo')
      class CapturedClipboardItem {
        constructor(readonly items: Record<string, Blob>) {}
      }
      let clipboardText = ''
      const write = vi.fn(async ([item]: CapturedClipboardItem[]) => {
        clipboardText = await item.items['text/plain'].text()
      })
      vi.stubGlobal('ClipboardItem', CapturedClipboardItem)
      vi.stubGlobal('navigator', {platform: 'Linux', clipboard: {write}})
      disarmCut()
      mount()

      const cutByKey = async (blockId: string, renderScopeId: string) => {
        await act(async () => { await focusBlock(ui(), blockId, {renderScopeId}) })
        await waitFor(() => expect(activeContexts.get(ActionContextTypes.NORMAL_MODE)).toMatchObject({
          block: {id: blockId}, renderScopeId,
        }))
        const shell = document.querySelector(`[data-block-shell][data-block-id="${blockId}"]`)!
        fireEvent.keyDown(shell, {key: 'x', code: 'KeyX', ctrlKey: true})
      }

      try {
        await cutByKey('row-1', SCOPE)
        await waitFor(() => expect(info).toHaveBeenCalledWith('Cut this result from its outline.'))
        expect(write).not.toHaveBeenCalled()
        expect(getArmedCut()).toBeNull()

        const notesScope = tableNotesScopeId(SCOPE, 'row-1')
        await cutByKey(first, notesScope)
        await waitFor(() => expect(getArmedCut()).toMatchObject({rootIds: [first], foreignRootId: 'row-1'}))

        expect((await pasteArmedCut(clipboardText, repo.block(source), repo))?.kind).toBe('refused')
        expect(await contentsUnder(source)).toEqual(['second'])
        expect(await contentsUnder('row-1')).toEqual(['First note', 'Last note'])

        expect((await pasteArmedCut(clipboardText, repo.block(last), repo, {scopeRootId: 'row-1', renderScopeId: notesScope}))?.kind)
          .toBe('moved')
        expect(await contentsUnder('row-1')).toEqual(['Last note', 'First note'])
      } finally {
        disarmCut()
      }
    })
  })

  it('Enter in the middle of a row’s text splits it into two rows', async () => {
    mount()
    const view = await editAt('row-1', 'start')
    act(() => { view.dispatch({selection: {anchor: 3}}) })
    press(view, 'Enter')
    await waitFor(async () => expect(await rowsUnderHost()).toHaveLength(3))
    const [, head, tail] = await rowsUnderHost()
    expect([await contentOf(head!), tail, await contentOf(tail!)]).toEqual(['sec', 'row-1', 'ond'])
  })

  it('refuses a row split at the cap before cutting editor text', async () => {
    mount()
    const view = await editAt('row-1', 'start')
    vi.spyOn(gridOfHost(PARENT_SCOPE, HOST)!, 'allowsNewRow').mockReturnValue(false)
    act(() => { view.dispatch({selection: {anchor: 3}}) })
    await act(async () => { await runActionById('split_block_cm', new KeyboardEvent('keydown', {key: 'Enter'})) })
    expect(await rowsUnderHost()).toEqual(['row-0', 'row-1'])
    expect(await contentOf('row-1')).toBe('second')
    expect(view.state.doc.toString()).toBe('second')
  })

  it('Tab nests a row under the row above, where it shows as its child', async () => {
    mount()
    press(await editAt('row-1', 'end'), 'Tab')
    await waitFor(async () => expect((await repo.load('row-1'))?.parentId).toBe('row-0'))
    await waitFor(() => expect(document.querySelector('[data-table-row="row-0"] [data-table-notes] [data-block-id="row-1"]')).not.toBeNull())
    expect(focused()).toEqual({blockId: 'row-1', renderScopeId: SCOPE})
  })

  it('Tab on the first row nests it nowhere', async () => {
    mount()
    const view = await editAt('row-0', 'end')
    const nest = vi.spyOn(structuralEdits, 'indentDrawnBlock')
    press(view, 'Tab')
    await waitFor(() => expect(nest).toHaveBeenCalledWith(repo.block('row-0'), expect.anything()))
    await act(() => nest.mock.results[0]!.value)
    expect((await repo.load('row-0'))?.parentId).toBe(HOST)
  })

  it.each([
    {label: 'empty Enter adds a sibling note', action: 'split_block_cm', key: 'Enter', promote: false, atCap: false},
    {label: 'Shift+Tab promotes a note to the next row', action: 'edit.cm.outdent_block', key: 'Tab', promote: true, atCap: false},
    {label: 'Shift+Tab keeps the note under its row at capacity', action: 'edit.cm.outdent_block', key: 'Tab', promote: false, atCap: true},
  ])('$label in a plain grid', async ({action, key, promote, atCap}) => {
    const note = (await repo.mutate.createChild({parentId: 'row-0', position: {kind: 'last'}}))!
    mount()
    const view = await editAt(note, 'end')
    expect(view.state.doc.length).toBe(0)
    expect(activeContexts.get(ActionContextTypes.EDIT_MODE_CM)).toMatchObject({scopeRootId: 'row-0', renderScopeId: SCOPE})
    if (atCap) vi.spyOn(gridOfHost(PARENT_SCOPE, HOST)!, 'allowsNewRow').mockReturnValue(false)

    await act(async () => { await runActionById(action, new KeyboardEvent('keydown', {key, shiftKey: key === 'Tab'})) })

    expect(await rowsUnderHost()).toEqual(promote ? ['row-0', note, 'row-1'] : ['row-0', 'row-1'])
    expect((await repo.load(note))?.parentId).toBe(promote ? HOST : 'row-0')
    const notes = await repo.query.childIds({id: 'row-0', propertyChildren: 'none'}).load()
    if (key === 'Enter') {
      const sibling = focused()?.blockId
      expect(sibling).toBeDefined()
      expect(sibling).not.toBe(note)
      expect(notes).toEqual([note, sibling])
      expect(await repo.load(sibling!)).toMatchObject({parentId: 'row-0', content: ''})
    } else {
      expect(notes).toEqual(promote ? [] : [note])
    }
  })

  it('Backspace at the start of a row merges it into the row above', async () => {
    mount()
    press(await editAt('row-1', 'start'), 'Backspace')
    await waitFor(async () => expect(await rowsUnderHost()).toEqual(['row-0']))
    expect(await contentOf('row-0')).toBe('firstsecond')
    await waitFor(() => expect(focused()).toEqual({blockId: 'row-0', renderScopeId: SCOPE}))
  })

  it('Backspace at the start of a row merges it into the last child shown above it', async () => {
    const child = await repo.mutate.createChild({parentId: 'row-0', content: 'note', position: {kind: 'last'}})
    mount()
    press(await editAt('row-1', 'start'), 'Backspace')
    await waitFor(async () => expect(await contentOf(child!)).toBe('notesecond'))
  })

  it('a row with values is not merged away', async () => {
    mount()
    await waitFor(() => expect(document.querySelector('[data-table-row="row-0"]')).not.toBeNull())
    await act(async () => { await repo.mutate.move({id: 'row-0', parentId: HOST, position: {kind: 'after', siblingId: 'row-1'}}) })
    await waitFor(async () => expect(await rowsUnderHost()).toEqual(['row-1', 'row-0']))
    const info = vi.spyOn(toast, 'showInfo')
    press(await editAt('row-0', 'start'), 'Backspace')
    await waitFor(() => expect(info).toHaveBeenCalled())
    expect(await rowsUnderHost()).toEqual(['row-1', 'row-0'])
  })

  it('an empty row whose children are collapsed merges them up, never deletes them', async () => {
    const child = await repo.mutate.createChild({parentId: 'row-1', content: 'kept', position: {kind: 'last'}})
    await repo.block('row-1').set(isCollapsedProp, true)
    await repo.block('row-1').setContent('')
    mount()
    press(await editAt('row-1', 'start'), 'Backspace')
    await waitFor(async () => expect(await rowsUnderHost()).toEqual(['row-0']))
    expect((await repo.load(child!))?.parentId).toBe('row-0')
  })

  it('a row whose only property is its collapse flag still merges', async () => {
    await repo.block('row-1').set(isCollapsedProp, false)
    expect(repo.block('row-1').peek()?.properties).toHaveProperty(isCollapsedProp.name)
    mount()
    press(await editAt('row-1', 'start'), 'Backspace')
    await waitFor(async () => expect(await rowsUnderHost()).toEqual(['row-0']))
  })

  it('Enter in the middle of a row whose children show still splits it into two rows', async () => {
    await repo.mutate.createChild({parentId: 'row-1', content: 'note', position: {kind: 'last'}})
    mount()
    const view = await editAt('row-1', 'start')
    act(() => { view.dispatch({selection: {anchor: 3}}) })
    press(view, 'Enter')
    await waitFor(async () => expect(await rowsUnderHost()).toHaveLength(3))
    expect(await contentsUnder('row-1')).toEqual(['note'])
  })

  // Refused merges: the outline's own refusals, and a nested table's machinery.
  /** Backspace in the focused editor, awaited through every wrap to the outline's handler. */
  const backspace = () => act(async () => {
    await runActionById('delete_empty_block_cm', new KeyboardEvent('keydown', {key: 'Backspace'}))
  })

  const refusedMerge = async (setup: () => Promise<string>) => {
    const target = await setup()
    const before = await contentOf(target)
    mount()
    await editAt('row-1', 'start')
    // The refusal makes no write: run the key's action through its wraps and await it, then compare.
    await backspace()
    expect(await rowsUnderHost()).toEqual(['row-0', 'row-1'])
    expect(await contentOf(target)).toBe(before)
  }

  it('merges no row into a block holding source', () => refusedMerge(async () => {
    const id = await repo.mutate.createChild({parentId: 'row-0', content: '<p>doc</p>', position: {kind: 'last'}})
    await repo.block(id!).set(typesProp, [HTML_DOCUMENT_TYPE])
    return id!
  }))

  it('merges no row across a nested table ending the row above, into its title or its machinery', () => refusedMerge(async () => {
    const id = await repo.mutate.createChild({parentId: 'row-0', content: 'Nested', position: {kind: 'last'}})
    await turnIntoTable(repo, id!)
    return id!
  }))

  it.each(['empty row', 'nonempty row', 'empty note'] as const)('keeps new text during a pending Backspace on the %s', async kind => {
    const isNote = kind === 'empty note'
    const parentId = isNote ? 'row-1' : HOST
    const id = isNote ? (await repo.mutate.createChild({parentId, content: ''}))! : 'row-1'
    if (kind === 'empty row') await repo.block(id).setContent('')
    const updated = ((await repo.load(id))?.content ?? '') + 'typed'

    mount()
    const view = await editAt(id, 'start')
    let announce!: () => void
    let release!: () => void
    const ready = new Promise<void>(resolve => { announce = resolve })
    const resumed = new Promise<void>(resolve => { release = resolve })
    const place = structuralEdits.memberMergePlacement
    vi.spyOn(structuralEdits, 'memberMergePlacement').mockImplementationOnce(async (...args) => {
      announce()
      await resumed
      return place(...args)
    })

    await act(async () => {
      const pending = runActionById('delete_empty_block_cm', new KeyboardEvent('keydown', {key: 'Backspace'}))
      await ready
      view.dispatch({changes: {from: view.state.doc.length, insert: 'typed'}, selection: {anchor: 0}})
      await repo.block(id).setContent(updated)
      release()
      await pending
    })

    expect((await repo.load(id))?.content).toBe(updated)
    expect((await repo.load(id))?.parentId).toBe(parentId)
    expect(await contentOf('row-0')).toBe('first')
    expect(focused()).toEqual({blockId: id, renderScopeId: SCOPE})
  })

  it('deletes an empty leaf after a nested table and focuses its title in the outer grid', async () => {
    const note = (await repo.mutate.createChild({parentId: 'row-0', content: 'Nested', position: {kind: 'last'}}))!
    const inner = (await repo.mutate.createChild({parentId: note, content: 'Inner row'}))!
    await turnIntoTable(repo, note)
    await repo.block('row-1').setContent('')
    mount()
    await editAt('row-1', 'start')

    await backspace()

    expect(await repo.load('row-1')).toBeNull()
    expect(await repo.load(inner)).toMatchObject({parentId: note, content: 'Inner row'})
    expect(focused()).toEqual({blockId: note, renderScopeId: SCOPE})
  })

  it('merges no row into the query of a nested table ending the row above', () => refusedMerge(async () => {
    const id = await repo.mutate.createChild({parentId: 'row-0', content: 'Nested', position: {kind: 'last'}})
    await turnIntoTable(repo, id!)
    await materializePropertySeeds(repo, WS, [queryProp])
    const valueId = await openQueryValue(repo, id!, propertyDefinitionBlockId(WS, queryProp.seedKey))
    await repo.block(valueId).setContent('[[Nested]]')
    return valueId
  }))

  it('ArrowUp from a row’s text edits a nested table’s title above it, not its rows', async () => {
    const id = await repo.mutate.createChild({parentId: 'row-0', content: 'Nested', position: {kind: 'last'}})
    await repo.mutate.createChild({parentId: id!, content: 'inner row', position: {kind: 'last'}})
    await turnIntoTable(repo, id!)
    mount()
    press(await editAt('row-1', 'start'), 'ArrowUp')
    await waitFor(() => expect(focused()).toEqual({blockId: id, renderScopeId: SCOPE}))
    expect(ui().peekProperty(isEditingProp)).toBe(true)
  })

  it('merges no row with children into a collapsed row above with children', () => refusedMerge(async () => {
    const above = await repo.mutate.createChild({parentId: 'row-0', content: 'n0', position: {kind: 'last'}})
    await repo.mutate.createChild({parentId: 'row-1', content: 'n1', position: {kind: 'last'}})
    await repo.block('row-0').set(isCollapsedProp, true)
    return above!
  }))

  it('moves a row above the row before it, and never above the first row', async () => {
    mount()
    await editAt('row-1', 'end')
    // The chord is $mod+Shift+ArrowUp; by id, as its key would run it.
    await act(async () => { await runActionById('move_block_up_cm', new KeyboardEvent('keydown')) })
    await waitFor(async () => expect(await rowsUnderHost()).toEqual(['row-1', 'row-0']))
    await editorOn('row-1')
    await act(async () => { await runActionById('move_block_up_cm', new KeyboardEvent('keydown')) })
    expect(await rowsUnderHost()).toEqual(['row-1', 'row-0'])
    expect((await children(HOST))[0]).toContain('tables:view')
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

  it('opening a list cell opens a member, not a member’s own property control', async () => {
    const [alpha, beta] = await memberIds()
    await repo.block(alpha!).set(done, true)
    // Rows draw their subtree with property display `none`; the member's own setting draws its property rows.
    await repo.block(alpha!).set(propertyDisplayProp, 'all')
    await repo.awaitReprojections()
    mount()
    const control = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(
        `[data-table-list] [data-block-id="${alpha}"] [data-property-value-row] :is(input, button, select)`)
      expect(node).not.toBeNull()
      return node!
    })
    await act(async () => { gridOfHost(PARENT_SCOPE, HOST)!.focusCell('row-0', 1, true) })
    await waitFor(() => expect(focused()).toEqual({blockId: beta, renderScopeId: SCOPE}))
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

  it('sideways on a row’s child is the outline’s, not a column move', async () => {
    const moveLeft = vi.fn()
    configureRuntime(vimNormalModePlugin({repo}), actionsFacet.of({
      id: 'move_left', description: 'stand-in for spatial navigation', context: ActionContextTypes.NORMAL_MODE,
      handler: moveLeft, defaultBinding: {keys: 'h'},
    }))
    const child = await repo.mutate.createChild({parentId: 'row-0', content: 'a note', position: {kind: 'last'}})
    mount()
    await normalRun(child!, 'move_left')
    expect(moveLeft).toHaveBeenCalled()
    expect(focused()).toEqual({blockId: child, renderScopeId: SCOPE})
  })

  it('enter-edit edits the member itself', async () => {
    mount()
    const [alpha] = await memberIds()
    await normalRun(alpha!, 'enter_edit_mode')
    await waitFor(() => expect(ui().peekProperty(isEditingProp)).toBe(true))
    expect(focused()).toEqual({blockId: alpha, renderScopeId: SCOPE})
  })
})

describe('the outline around a table', () => {
  /** The host on a page, with a block after it, the page the scope root. */
  const mountPage = async () => {
    await repo.tx(async tx => {
      await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a2', content: 'page'})
      await tx.move(HOST, {parentId: 'page', orderKey: 'a0'})
      await tx.create({id: 'after', workspaceId: WS, parentId: 'page', orderKey: 'a1', content: 'after'})
    }, {scope: ChangeScope.BlockDefault})
    render(
      <RepoContext value={repo}>
        <AppRuntimeContextProvider value={runtime}>
          <ActiveContextsProvider>
            <HotkeyReconciler/>
            <ContextProbe/>
            <Suspense fallback={null}>
              <BlockContextProvider initialValue={{panelId: PANEL, renderScopeId: PARENT_SCOPE, scopeRootId: 'page'}}>
                <PropertyDisplayScopeContext value={{childBacked: true, workspace: 'non-hidden', panel: 'inherit'}}>
                  <BlockComponent blockId="page"/>
                </PropertyDisplayScopeContext>
              </BlockContextProvider>
            </Suspense>
          </ActiveContextsProvider>
        </AppRuntimeContextProvider>
      </RepoContext>,
    )
  }

  it('Down from the last row without spatial navigation exits to the following outline block', async () => {
    await mountPage()
    await act(async () => { await focusBlock(ui(), 'row-1', {renderScopeId: SCOPE}) })
    const grid = await waitFor(() => {
      const grid = gridOfHost(PARENT_SCOPE, HOST)
      expect(grid?.rows.at(-1)).toBe('row-1')
      return grid!
    })
    expect(grid.command('down')).toBe(true)
    await waitFor(() => expect(focused()).toEqual({blockId: 'after', renderScopeId: PARENT_SCOPE}))
  })

  it('Backspace at the start of the block after a table merges it into nothing above', async () => {
    await mountPage()
    await act(async () => {
      await ui().set(editorSelection, {blockId: 'after', start: 0})
      await focusBlock(ui(), 'after', {edit: true, renderScopeId: PARENT_SCOPE})
    })
    const node = await waitFor(() => {
      const editor = document.querySelector<HTMLElement>('[data-block-id="after"] .cm-editor')
      expect(editor).not.toBeNull()
      return editor!
    })
    await waitFor(() => expect((activeContexts.get(ActionContextTypes.EDIT_MODE_CM) as {block?: {id: string}})?.block?.id).toBe('after'))
    const machinery = await db.db.getAll<{id: string; content: string}>(
      'SELECT id, content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY id', [HOST])
    expect(EditorView.findFromDOM(node)!.state.selection.main.head).toBe(0)
    await act(async () => {
      await runActionById('delete_empty_block_cm', new KeyboardEvent('keydown', {key: 'Backspace'}))
    })
    expect(await repo.load('after')).toMatchObject({content: 'after'})
    expect(await db.db.getAll('SELECT id, content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY id', [HOST]))
      .toEqual(machinery)
  })
})

it('focuses both occurrences of a query result and keeps each occurrence’s gestures', async () => {
  configureRuntime(vimNormalModePlugin({repo}))
  const middle = crypto.randomUUID()
  await repo.tx(async tx => {
    await tx.create({id: middle, parentId: 'row-0', workspaceId: WS, orderKey: 'a1', content: 'Middle'})
    await tx.create({id: 'leaf', parentId: middle, workspaceId: WS, orderKey: 'a1', content: 'Leaf'})
    await tx.create({id: 'direct', parentId: 'row-0', workspaceId: WS, orderKey: 'a2', content: 'Direct child'})
  }, {scope: ChangeScope.BlockDefault})
  await db.db.execute("UPDATE blocks SET created_at = 100000 WHERE id = 'row-0'")
  await db.db.execute("UPDATE blocks SET created_at = 200000 WHERE id = 'leaf'")
  await db.db.execute("UPDATE blocks SET created_at = 300000 WHERE id = 'direct'")
  await repo.block(HOST).set(queryProp, 'created<2000-01-01')
  await repo.awaitReprojections()
  mount()
  const notesScope = tableNotesScopeId(SCOPE, 'row-0')
  await waitFor(() => {
    const shells = [...document.querySelectorAll<HTMLElement>('[data-block-shell][data-block-id="leaf"]')]
    expect(shells.map(shell => shell.dataset.renderScopeId)).toEqual([notesScope, SCOPE])
    expect(shells[0]?.closest('[data-table-notes]')).not.toBeNull()
    const direct = [...document.querySelectorAll<HTMLElement>('[data-block-shell][data-block-id="direct"]')]
    expect(direct.map(shell => shell.dataset.renderScopeId)).toEqual([SCOPE])
  })

  const focusLeafAndMoveUp = async (renderScopeId: string) => {
    await act(async () => { await focusBlock(ui(), 'leaf', {renderScopeId}) })
    await waitFor(() => expect(activeContexts.get(ActionContextTypes.NORMAL_MODE)).toMatchObject({
      block: {id: 'leaf'}, renderScopeId,
    }))
    await act(async () => { await runActionById('move_up', new KeyboardEvent('keydown')) })
  }
  await focusLeafAndMoveUp(notesScope)
  await waitFor(() => expect(focused()).toEqual({blockId: middle, renderScopeId: notesScope}))
  await waitFor(() => expect(activeContexts.get(ActionContextTypes.NORMAL_MODE)).toMatchObject({
    block: {id: middle}, renderScopeId: notesScope,
  }))
  await act(async () => { await runActionById('move_up', new KeyboardEvent('keydown')) })
  await waitFor(() => expect(focused()).toEqual({blockId: 'row-0', renderScopeId: SCOPE}))
  await focusLeafAndMoveUp(SCOPE)
  await waitFor(() => expect(focused()).toEqual({blockId: 'row-0', renderScopeId: SCOPE}))

  press(await editAt(middle, 'end', notesScope), 'ArrowDown')
  await waitFor(() => expect(focused()).toEqual({blockId: 'leaf', renderScopeId: notesScope}))
  expect(ui().peekProperty(isEditingProp)).toBe(true)
  const editor = await editAt('leaf', 'start', notesScope)
  act(() => { editor.dispatch({selection: {anchor: 2}}) })
  press(editor, 'Enter')
  await waitFor(async () => expect(await contentsUnder(middle)).toEqual(['Le', 'af']))
  expect(focused()?.renderScopeId).toBe(notesScope)
})

it('merges sibling notes within a query row and keeps the editor in their scope', async () => {
  const top = await repo.mutate.createChild({parentId: 'row-0', content: 'First note', position: {kind: 'last'}})
  const bottom = await repo.mutate.createChild({parentId: 'row-0', content: 'Second note', position: {kind: 'last'}})
  await db.db.execute("UPDATE blocks SET created_at = 100000 WHERE id = 'row-0'")
  await repo.block(HOST).set(queryProp, 'created<2000-01-01')
  await repo.awaitReprojections()
  mount()
  const notesScope = tableNotesScopeId(SCOPE, 'row-0')
  press(await editAt(bottom!, 'start', notesScope), 'Backspace')
  await waitFor(async () => expect(await repo.load(top!)).toMatchObject({content: 'First noteSecond note'}))
  expect(await repo.load(bottom!)).toBeNull()
  await waitFor(() => expect(focused()).toEqual({blockId: top, renderScopeId: notesScope}))
  expect(ui().peekProperty(isEditingProp)).toBe(true)
})

it('refuses to start selection on a query row or its notes', async () => {
  configureRuntime(vimNormalModePlugin({repo}))
  const note = await repo.mutate.createChild({parentId: 'row-0', content: 'A note', position: {kind: 'last'}})
  await db.db.execute("UPDATE blocks SET created_at = 100000 WHERE id = 'row-0'")
  await repo.block(HOST).set(queryProp, 'created<2000-01-01')
  await repo.awaitReprojections()
  mount()

  const trySelection = async (blockId: string, renderScopeId: string) => {
    await act(async () => { await focusBlock(ui(), blockId, {renderScopeId}) })
    await waitFor(() => expect(activeContexts.get(ActionContextTypes.NORMAL_MODE)).toMatchObject({
      block: {id: blockId}, renderScopeId,
    }))
    await act(async () => { await runActionById('select_focused_block_and_start_selection', new KeyboardEvent('keydown')) })
    expect(ui().peekProperty(selectionStateProp)?.selectedBlockIds ?? []).toEqual([])
  }
  await trySelection('row-0', SCOPE)
  await trySelection(note!, tableNotesScopeId(SCOPE, 'row-0'))
})

it('Vim gg from query row notes focuses the owner row drawn in the grid', async () => {
  configureRuntime(vimNormalModePlugin({repo}))
  const note = await repo.mutate.createChild({parentId: 'row-0', content: 'A note', position: {kind: 'last'}})
  await db.db.execute("UPDATE blocks SET created_at = 100000 WHERE id = 'row-0'")
  await repo.block(HOST).set(queryProp, 'created<2000-01-01')
  await repo.awaitReprojections()
  mount()
  const notesScope = tableNotesScopeId(SCOPE, 'row-0')
  await act(async () => { await focusBlock(ui(), note!, {renderScopeId: notesScope}) })
  await waitFor(() => expect(activeContexts.get(ActionContextTypes.NORMAL_MODE)).toMatchObject({
    block: {id: note}, renderScopeId: notesScope, scopeRootId: 'row-0',
  }))
  await act(async () => { await runActionById('jump_to_first_visible_block', new KeyboardEvent('keydown')) })
  await waitFor(() => expect(focused()?.blockId).toBe('row-0'))
  expect(focused()).toEqual({blockId: 'row-0', renderScopeId: SCOPE})
  const rowScope = gridOfHost(PARENT_SCOPE, HOST)!.rowSurface('row-0')
  const deps = {block: repo.block('row-0'), uiStateBlock: ui(), ...rowScope}
  const first = getEffectiveActions(runtime).find(action => action.id === 'jump_to_first_visible_block')!
  const last = getEffectiveActions(runtime).find(action => action.id === 'jump_to_last_visible_block')!

  // A grid row itself has a shell in its own scope, despite the declared grid owner.
  await focusBlock(ui(), note!, {renderScopeId: notesScope})
  await invokeAction(runtime, {action: first, deps, trigger: new KeyboardEvent('keydown')})
  await waitFor(() => expect(focused()?.blockId).toBe('row-0'))
  expect(focused()).toEqual({blockId: 'row-0', renderScopeId: SCOPE})

  // A dispatched jump may outlive the removal of the final rendered note.
  await act(async () => {
    await repo.block('row-0').set(isCollapsedProp, true)
    await focusBlock(ui(), note!, {renderScopeId: notesScope})
    const noteDeps = {...deps, block: repo.block(note!), renderScopeId: notesScope}
    await invokeAction(runtime, {action: last, deps: noteDeps, trigger: new KeyboardEvent('keydown')})
  })
  await waitFor(() => expect(focused()).toEqual({blockId: 'row-0', renderScopeId: SCOPE}))
})

// @vitest-environment happy-dom
import {Suspense, useEffect} from 'react'
import {ActionContextTypes, type BlockShortcutDependencies} from '@/shortcuts/types'
import {getDefaultActionGroups} from '@/shortcuts/defaultShortcuts'
import {useActionContext} from '@/shortcuts/useActionContext'
import {commandPaletteAction} from '@/plugins/command-palette'
import {commandPaletteToggle} from '@/plugins/command-palette/toggleStore'
import {HotkeyReconciler} from '@/shortcuts/HotkeyReconciler'
import {vimNormalModeInteractionExtension} from '@/plugins/vim-normal-mode'
import {vimNormalModeActionsExtension} from '@/plugins/vim-normal-mode/actions'
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope, seedProperty, seedType, type User} from '@/data/api'
import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets'
import {getOrCreatePropertiesPage} from '@/data/propertiesPage'
import {kernelDataExtension} from '@/data/kernelDataExtension'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {resolveFacetRuntimeSync, type FacetRuntime} from '@/facets/facet'
import {AppRuntimeContextProvider} from '@/extensions/runtimeContext'
import {actionContextsFacet, actionsFacet} from '@/extensions/core'
import {defaultRenderersExtension} from '@/extensions/defaultRenderers'
import {ActiveContextsProvider, useActiveContextsState, type ActiveContextsMap} from '@/shortcuts/ActiveContexts'
import {defaultActionContextConfigs} from '@/shortcuts/defaultContexts'
import {BlockContextProvider} from '@/context/block'
import {PropertyDisplayScopeContext} from '@/context/propertyDisplay'
import {RepoContext} from '@/context/repo'
import {BlockComponent} from '@/components/BlockComponent'
import {__resetLazyMountCachesForTesting} from '@/components/util/LazyViewportMount'
import {__resetLazyMountRegistryForTesting} from '@/components/util/lazyMountRegistry'
import {kernelPropertyUiExtension} from '@/components/propertyEditors/typesPropertyUi'
import {kernelValuePresetsExtension} from '@/components/propertyEditors/kernelValuePresets'
import {plainOutlinerPlugin} from '@/plugins/plain-outliner'
import {focusBlock, isCollapsedProp, isEditingProp, peekFocusedBlockLocation, topLevelBlockIdProp, typesProp} from '@/data/properties'
import {EditorView} from '@codemirror/view'
import {CompletionContext} from '@codemirror/autocomplete'
import {flushEditorContent} from '@/editor/contentFlush'
import {propertyCompletionSource} from '../autocomplete'
import * as propertyCreation from '@/data/propertyRowCreation'
import * as properties from '@/data/properties'
import {choosePropertyField} from '@/data/propertyRowCreation'
import {propertyRowsPlugin} from '../index'
import {editorAutocompleteExtension} from '@/editor/autocomplete'
import {acceptCompletion, startCompletion} from '@codemirror/autocomplete'
import {defaultEditorInteractionExtension} from '@/editor/defaultInteractions'
import {blockChildrenFooterFacet} from '@/extensions/blockInteraction'

const normalCommand = vi.fn()
const USER: User = {id: 'test-user', name: 'Test user'}
vi.mock('@/components/Login.tsx', () => ({useUser: () => USER}))

const WS = 'property-creation-test'
const PANEL = 'panel'
const OWNER = 'owner'
const NOTE = 'note'
const plain = seedProperty({seedKey: 'test/property/creation-plain', revision: 1,
  name: 'creation:plain', preset: 'string', changeScope: ChangeScope.BlockDefault})
const hidden = seedProperty({seedKey: 'test/property/creation-hidden', revision: 1,
  name: 'creation:hidden', preset: 'string', hidden: true, changeScope: ChangeScope.BlockDefault})
const outlineHidden = seedProperty({seedKey: 'test/property/creation-outline-hidden', revision: 1,
  name: 'creation:outline-hidden', preset: 'string', hideInOutline: true, changeScope: ChangeScope.BlockDefault})
const list = seedProperty({seedKey: 'test/property/creation-list', revision: 1,
  name: 'creation:list', preset: 'string-list', changeScope: ChangeScope.BlockDefault})
const props = [plain, hidden, outlineHidden, list]
const expectedType = seedType({seedKey: 'test/type/creation-expected', revision: 1,
  id: 'test:creation-expected', label: 'Expected fields', properties: props})
const TestFooter = () => <div data-testid="children-footer-marker">footer marker</div>

let db: TestDb
let repo: Repo
let runtime: FacetRuntime
const configureRuntime = (vim = true) => {
  const defaults = getDefaultActionGroups({repo})
  runtime = resolveFacetRuntimeSync([
    kernelDataExtension, kernelPropertyUiExtension, kernelValuePresetsExtension, editorAutocompleteExtension,
    defaultRenderersExtension, propertyRowsPlugin, plainOutlinerPlugin, defaultEditorInteractionExtension,
    ...(vim ? [vimNormalModeInteractionExtension, vimNormalModeActionsExtension({repo})] : []),
    blockChildrenFooterFacet.of(() => TestFooter, {source: 'test-footer'}),
    defaultActionContextConfigs.map(config => actionContextsFacet.of(config, {source: 'test'})),
    [...defaults.globalActions, ...defaults.normalModeActions, ...defaults.editModeCMActions, commandPaletteAction].map(action => actionsFacet.of(action)),
    actionsFacet.of({id: 'test:normal-command', context: ActionContextTypes.NORMAL_MODE, description: 'Test normal command', defaultBinding: {keys: 'q'}, handler: normalCommand}),
    props.map(prop => definitionSeedsFacet.of(prop, {source: 'test'})),
    typeSeedsFacet.of(expectedType, {source: 'test'}),
  ])
  repo.setFacetRuntime(runtime)
}
const swallowSelectionChange = (event: Event) => event.stopImmediatePropagation()
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
afterEach(() => {
  vi.restoreAllMocks()
  commandPaletteToggle.close()
  cleanup()
  window.removeEventListener('selectionchange', swallowSelectionChange, true)
  vi.unstubAllGlobals()
  __resetLazyMountRegistryForTesting()
  __resetLazyMountCachesForTesting()
})
beforeEach(async () => {
  normalCommand.mockClear()
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
    await tx.create({id: OWNER, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'owner'})
    await tx.create({id: NOTE, workspaceId: WS, parentId: OWNER, orderKey: 'a0', content: 'Existing note'})
    await tx.setProperty(OWNER, typesProp, [expectedType.id])
  }, {scope: ChangeScope.BlockDefault})
  await waitFor(() => {
    expect(repo.types.has(expectedType.id)).toBe(true)
    for (const prop of props) expect(repo.propertySchemas.has(prop.name)).toBe(true)
  })
  await repo.awaitSeedMaterialization()
  await repo.awaitReprojections()
  repo.undoManager.clear()
})

let activeContexts: ActiveContextsMap = new Map()
const ContextProbe = () => {
  const contexts = useActiveContextsState()
  useEffect(() => { activeContexts = contexts }, [contexts])
  return null
}
const GlobalShortcuts = () => { useActionContext(ActionContextTypes.GLOBAL); return null }
const mount = (mode: 'all' | 'non-hidden' | 'none' = 'non-hidden', root = OWNER, isReference = false) => render(
  <RepoContext value={repo}>
    <AppRuntimeContextProvider value={runtime}>
      <ActiveContextsProvider>
        <HotkeyReconciler/>
        <ContextProbe/>
        <Suspense fallback={null}>
          <BlockContextProvider initialValue={{panelId: PANEL, renderScopeId: 'creation-test', scopeRootId: root, isReference}}>
            <GlobalShortcuts/>
            <PropertyDisplayScopeContext value={{childBacked: true, workspace: mode, panel: 'inherit'}}>
              <BlockComponent blockId={root}/>
            </PropertyDisplayScopeContext>
          </BlockContextProvider>
        </Suspense>
      </ActiveContextsProvider>
    </AppRuntimeContextProvider>
  </RepoContext>,
)

const ownerDescendants = async () => db.db.getAll<{
  id: string; parent_id: string | null; order_key: string; content: string;
  properties_json: string; reference_target_id: string | null; is_field_form: number;
}>(
  `WITH RECURSIVE descendants(id) AS (
     SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0
     UNION ALL SELECT child.id FROM blocks child JOIN descendants parent ON child.parent_id = parent.id
       WHERE child.deleted = 0
   ) SELECT b.id, b.parent_id, b.order_key, b.content, b.properties_json, b.reference_target_id, b.is_field_form
     FROM blocks b JOIN descendants d ON d.id = b.id ORDER BY b.parent_id, b.order_key, b.id`, [OWNER])
describe('ordinary property creation in the outline', () => {
  it.each(['all', 'non-hidden'] as const)('renders only stored fields in %s without materializing missing type fields', async mode => {
    await repo.block(OWNER).set(list, ['saved member'])
    const before = await ownerDescendants()
    const beforeProperties = {...repo.block(OWNER).peek()!.properties}
    expect(repo.types.get(expectedType.id)?.properties?.map(schema => schema.name)).toContain(plain.name)
    expect(beforeProperties).not.toHaveProperty(plain.name)
    mount(mode)
    await screen.findByText('saved member')
    await screen.findAllByTestId('children-footer-marker')
    expect(screen.queryByLabelText(`Enter ${plain.name}`)).toBeNull()
    expect(document.querySelector('[data-property-ghost]')).toBeNull()
    expect(await ownerDescendants()).toEqual(before)
    expect(repo.block(OWNER).peek()!.properties).toEqual(beforeProperties)
  })

  it.each(['i', 'a', 'o', 'Enter'])('normal-mode %s uses ordinary field-row commands', async key => {
    await repo.block(OWNER).set(list, ['saved'])
    const field = await db.db.get<{id: string}>("SELECT parent_id AS id FROM blocks WHERE content = 'saved' AND deleted = 0")
    await repo.block(PANEL).set(topLevelBlockIdProp, OWNER)
    mount('all')
    await act(async () => { await focusBlock(repo.block(PANEL), field.id, {renderScopeId: 'creation-test'}) })
    await waitFor(() => expect((activeContexts.get(ActionContextTypes.NORMAL_MODE) as BlockShortcutDependencies)?.block.id).toBe(field.id))
    expect(screen.queryByLabelText(`Enter ${list.name}`)).toBeNull()
    const before = await ownerDescendants()
    fireEvent.keyDown(document.querySelector(`[data-block-id="${field.id}"]`)!, {key, code: key === 'Enter' ? 'Enter' : `Key${key.toUpperCase()}`})
    if (key === 'o') {
      await waitFor(async () => {
        const id = peekFocusedBlockLocation(repo.block(PANEL))?.blockId
        expect(id).not.toBe(field.id)
        expect((await repo.load(id!))?.parentId).toBe(field.id)
        expect(document.querySelector(`[data-block-id="${id}"] .cm-content`)).not.toBeNull()
      })
      expect(await repo.query.children({id: field.id, propertyChildren: 'all'}).load()).toHaveLength(2)
    } else {
      if (key !== 'Enter') await waitFor(() => expect(document.querySelector(`[data-block-id="${field.id}"] .cm-content`)?.textContent).toBe(repo.block(field.id).peek()?.content))
      else expect(repo.block(PANEL).peekProperty(isEditingProp)).toBe(false)
      expect(await ownerDescendants()).toEqual(before)
    }
  })

  it('normal-mode o beside an empty scalar creates an ordinary sibling', async () => {
    const source = await repo.mutate.createChild({parentId: OWNER, content: '::'})
    await choosePropertyField(repo.block(OWNER), plain, repo.block(source), '::', () => true)
    await repo.block(PANEL).set(topLevelBlockIdProp, OWNER)
    mount('all')
    await act(async () => { await focusBlock(repo.block(PANEL), source, {renderScopeId: 'creation-test'}) })
    await waitFor(() => expect((activeContexts.get(ActionContextTypes.NORMAL_MODE) as BlockShortcutDependencies)?.block.id).toBe(source))
    fireEvent.keyDown(document.querySelector(`[data-block-id="${source}"]`)!, {key: 'o', code: 'KeyO'})
    await waitFor(() => expect(document.querySelector('.cm-content')).not.toBeNull())
    const focused = peekFocusedBlockLocation(repo.block(PANEL))!.blockId
    expect(focused).not.toBe(source)
    expect((await repo.load(focused))?.parentId).toBe(OWNER)
    expect(await repo.query.children({id: source, propertyChildren: 'all'}).load()).toEqual([])
  })

  it.each([false, true])('choosing an existing populated list creates and focuses an ordinary member (collapsed: %s)', async collapsed => {
    await repo.block(OWNER).set(list, ['saved'])
    const definition = repo.propertySchemaResolverFor(WS).resolve(list.name)
    if (definition.status !== 'resolved') throw new Error('Missing list definition')
    const field = await db.db.get<{id: string}>("SELECT id FROM blocks WHERE reference_target_id = ? AND is_field_form = 1 AND deleted = 0", [definition.schema.fieldId])
    if (collapsed) await repo.block(field.id).set(isCollapsedProp, true)
    const source = await repo.mutate.createChild({parentId: OWNER, content: `::${list.name}`})
    repo.undoManager.clear()
    mount('all')
    await act(async () => { await focusBlock(repo.block(PANEL), source, {edit: true, renderScopeId: 'creation-test'}) })
    const view = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(`[data-block-id="${source}"] .cm-editor`)
      expect(node).not.toBeNull()
      return EditorView.findFromDOM(node!)!
    })
    act(() => { view.focus(); view.dispatch({selection: {anchor: view.state.doc.length}}); startCompletion(view) })
    await screen.findByRole('option', {name: list.name})
    await waitFor(() => expect(acceptCompletion(view)).toBe(true))
    await waitFor(() => expect(peekFocusedBlockLocation(repo.block(PANEL))?.blockId).not.toBe(source))
    const memberId = peekFocusedBlockLocation(repo.block(PANEL))!.blockId
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector(`[data-block-id="${memberId}"] .cm-content`)))
    expect((await repo.load(memberId))?.parentId).toBe(field.id)
    expect((await repo.load(memberId))?.content).toBe('')
    expect(await repo.block(OWNER).get(list)).toEqual(['saved', ''])
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(1)
  })

  it.each(['block', 'scope'])('does not take focus back after applying a completion when the user changed %s', async kind => {
    const sourceId = await repo.mutate.createChild({parentId: OWNER, content: '::creation:plain'})
    mount('all')
    await act(async () => { await focusBlock(repo.block(PANEL), sourceId, {edit: true, renderScopeId: 'creation-test'}) })
    const view = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(`[data-block-id="${sourceId}"] .cm-content`)
      expect(node).not.toBeNull()
      return EditorView.findFromDOM(node!)!
    })
    act(() => { view.dispatch({selection: {anchor: view.state.doc.length}}) })
    const completion = await propertyCompletionSource({repo, block: repo.block(sourceId), childBacked: true, uiStateBlock: repo.block(PANEL), renderScopeId: 'creation-test'})(new CompletionContext(view.state, view.state.doc.length, false))
    const original = propertyCreation.choosePropertyField
    vi.spyOn(propertyCreation, 'choosePropertyField').mockImplementation(async (...args) => {
      const target = await original(...args)
      await focusBlock(repo.block(PANEL), kind === 'block' ? NOTE : sourceId, {renderScopeId: kind === 'scope' ? 'other-scope' : 'creation-test'})
      return target
    })
    const exit = vi.spyOn(properties, 'exitEditModeForBlock').mockResolvedValue()
    const apply = completion!.options[0].apply
    expect(typeof apply).toBe('function')
    await act(async () => {
      if (typeof apply === 'function') await apply(view, completion!.options[0], 0, view.state.doc.length)
    })
    expect(exit).not.toHaveBeenCalled()
    expect(peekFocusedBlockLocation(repo.block(PANEL))).toEqual({blockId: kind === 'block' ? NOTE : sourceId, renderScopeId: kind === 'scope' ? 'other-scope' : 'creation-test'})
  })

  it('preserves text typed while an existing field choice waits on its source check', async () => {
    await repo.block(OWNER).set(list, ['saved'])
    const id = await repo.mutate.createChild({parentId: OWNER, content: '::'})
    mount('all')
    await act(async () => { await focusBlock(repo.block(PANEL), id, {edit: true, renderScopeId: 'creation-test'}) })
    await waitFor(() => expect(document.querySelector(`[data-block-id="${id}"] .cm-editor`)).not.toBeNull())
    const editor = document.querySelector<HTMLElement>(`[data-block-id="${id}"] .cm-editor`)!
    const view = EditorView.findFromDOM(editor)!
    view.dispatch({selection: {anchor: 2}})
    const source = propertyCompletionSource({repo, childBacked: true, block: repo.block(id), uiStateBlock: repo.block(PANEL), renderScopeId: 'creation-test'})
    const result = await source(new CompletionContext(view.state, 2, false))
    const option = result?.options.find(candidate => candidate.label === list.name)
    if (!option || typeof option.apply !== 'function') throw new Error('List completion option did not resolve')
    let release!: () => void
    let signalEntered!: () => void
    let signalFinished!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { signalEntered = resolve })
    const finished = new Promise<void>(resolve => { signalFinished = resolve })
    const original = repo.tx.bind(repo)
    const spy = vi.spyOn(repo, 'tx').mockImplementation(async (...args: Parameters<Repo['tx']>) => {
      if (args[1]?.description !== 'Choose property field') return original(...args)
      signalEntered()
      try { await gate; return await original(...args) }
      finally { signalFinished() }
    })
    try {
      option.apply(view, option, 0, 2)
      await entered
      act(() => { view.dispatch({changes: {from: 2, insert: 'new user text'}, selection: {anchor: 15}, userEvent: 'input.type'}) })
      release()
      await finished
      await act(async () => { flushEditorContent(view) })
      await waitFor(async () => expect(await db.db.getOptional('SELECT content, deleted FROM blocks WHERE id = ?', [id]))
        .toEqual({content: '::new user text', deleted: 0}))
    } finally {
      release()
      spy.mockRestore()
    }
  })

  it('opens native completion and an ordinary first child', async () => {
    const id = await repo.mutate.createChild({parentId: OWNER, content: ''})
    mount('none')
    await act(async () => { await focusBlock(repo.block(PANEL), id, {edit: true, renderScopeId: 'creation-test'}) })
    await waitFor(() => expect(document.querySelector(`[data-block-id="${id}"] .cm-editor`)).not.toBeNull())
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(`[data-block-id="${id}"] .cm-editor`)!)!
    act(() => { view.focus(); view.dispatch({changes: {from: 0, insert: '::creation:plain'}, selection: {anchor: 16}, userEvent: 'input.type'}) })
    await screen.findByRole('option', {name: plain.name})
    await waitFor(() => { expect(acceptCompletion(view)).toBe(true) })
    const childId = await waitFor(() => {
      const field = repo.block(id)
      const children = field.repo.query.childIds({id, hydrate: true, propertyChildren: 'all'})
      return children.load().then(rows => {
        expect(rows).toHaveLength(1)
        return rows[0]!
      })
    })
    await waitFor(() => expect(peekFocusedBlockLocation(repo.block(PANEL))?.blockId).toBe(childId))
    expect((await repo.load(id))?.isFieldForm).toBe(true)
    expect(await repo.query.children({id, propertyChildren: 'all'}).load()).toHaveLength(1)
  })

  it('automatic Create is accepted from prose and one undo restores the text and removes the definition', async () => {
    await getOrCreatePropertiesPage(repo, WS)
    const text = '::some prose'
    const id = await repo.mutate.createChild({parentId: OWNER, content: text})
    mount('all')
    await act(async () => { await focusBlock(repo.block(PANEL), id, {edit: true, renderScopeId: 'creation-test'}) })
    const view = await waitFor(() => {
      const node = document.querySelector<HTMLElement>(`[data-block-id="${id}"] .cm-editor`)
      expect(node).not.toBeNull()
      return EditorView.findFromDOM(node!)!
    })
    repo.undoManager.clear()
    act(() => {
      view.focus()
      view.dispatch({changes: {from: text.length - 1, to: text.length, insert: 'e'}, selection: {anchor: text.length}, userEvent: 'input.type'})
    })
    await screen.findByRole('option', {name: 'Create “some prose”'})
    await waitFor(() => expect(acceptCompletion(view)).toBe(true))
    await waitFor(() => expect(peekFocusedBlockLocation(repo.block(PANEL))?.blockId).not.toBe(id))
    const child = peekFocusedBlockLocation(repo.block(PANEL))!.blockId
    expect((await repo.load(child))?.parentId).toBe(id)
    const definitionId = repo.block(id).peek()!.referenceTargetId!
    expect(definitionId).toBeTruthy()
    expect(repo.propertySchemas.has('some prose')).toBe(true)
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(1)
    await act(async () => { await repo.undo() })
    await waitFor(() => expect(repo.propertySchemas.has('some prose')).toBe(false))
    expect((await repo.load(id))?.content).toBe(text)
    expect(await db.db.getOptional('SELECT id FROM blocks WHERE id = ? AND deleted = 0', [definitionId])).toBeNull()
  })

  it('creates a text property from the menu and accepts plain words without an invalid marker', async () => {
    await getOrCreatePropertiesPage(repo, WS)
    const name = 'New outline text'
    const words = 'plain words as the first value'
    const id = await repo.mutate.createChild({parentId: OWNER, content: ''})
    mount('all')
    await act(async () => { await focusBlock(repo.block(PANEL), id, {edit: true, renderScopeId: 'creation-test'}) })
    const view = await waitFor(() => {
      const editor = document.querySelector<HTMLElement>(`[data-block-id="${id}"] .cm-editor`)
      expect(editor).not.toBeNull()
      return EditorView.findFromDOM(editor!)!
    })
    expect(repo.propertySchemas.has(name)).toBe(false)
    act(() => {
      view.focus()
      view.dispatch({changes: {from: 0, insert: `::${name}`}, selection: {anchor: name.length + 2}, userEvent: 'input.type'})
      startCompletion(view)
    })
    await screen.findByRole('option', {name: `Create “${name}”`})
    await waitFor(() => expect(acceptCompletion(view)).toBe(true))
    const childId = await waitFor(() => {
      const focused = peekFocusedBlockLocation(repo.block(PANEL))?.blockId
      expect(focused).not.toBe(id)
      return focused!
    })
    await waitFor(() => expect(document.querySelector(`[data-block-id="${childId}"] .cm-content`)).not.toBeNull())
    const editor = document.querySelector<HTMLElement>(`[data-block-id="${childId}"] .cm-content`)!
    const childView = EditorView.findFromDOM(editor)!
    await act(async () => { childView.dispatch({changes: {from: 0, insert: words}, selection: {anchor: words.length}, userEvent: 'input.type'}); flushEditorContent(childView) })
    await waitFor(() => expect(repo.block(OWNER).peek()?.properties[name]).toBe(words))
    const [value] = await repo.query.children({id, propertyChildren: 'all'}).load()
    expect(value.content).toBe(words)
    await act(async () => { await properties.exitEditModeForBlock(repo.block(PANEL), value.id, 'creation-test') })
    await waitFor(() => expect(document.querySelector(`[data-block-id="${value.id}"] .cm-editor`)).toBeNull())
    await waitFor(() => expect(document.querySelector(`[data-block-id="${value.id}"] .markdown-content`)?.textContent).toBe(words))
    expect(document.querySelector(`[data-block-id="${value.id}"] [data-invalid-property-value]`)).toBeNull()
  })

  it.each([false, true])('list member Enter creates an ordinary block (member root: %s)', async memberRoot => {
    await repo.block(OWNER).set(list, ['saved'])
    const definition = repo.propertySchemaResolverFor(WS).resolve(list.name)
    if (definition.status !== 'resolved') throw new Error('Missing definition')
    const fields = await repo.query.children({id: OWNER, propertyChildren: 'all'}).load()
    const field = fields.find(row => row.referenceTargetId === definition.schema.fieldId)!
    const [value] = await repo.query.children({id: field.id, propertyChildren: 'all'}).load()
    await repo.block(PANEL).set(topLevelBlockIdProp, memberRoot ? value.id : OWNER)
    mount('all', memberRoot ? value.id : OWNER)
    await act(async () => { await focusBlock(repo.block(PANEL), value.id, {edit: true, renderScopeId: 'creation-test'}) })
    const view = await waitFor(() => {
      const dom = document.querySelector<HTMLElement>(`[data-block-id="${value.id}"] .cm-editor`)
      expect(dom).not.toBeNull()
      return EditorView.findFromDOM(dom!)!
    })
    act(() => { view.dispatch({selection: {anchor: view.state.doc.length}}) })
    expect(screen.queryByLabelText(`Enter ${list.name}`)).toBeNull()
    await waitFor(() => expect((activeContexts.get(ActionContextTypes.EDIT_MODE_CM) as BlockShortcutDependencies)?.block.id).toBe(value.id))
    fireEvent.keyDown(view.contentDOM, {key: 'Enter', code: 'Enter'})
    const created = await waitFor(async () => {
      const focusedId = peekFocusedBlockLocation(repo.block(PANEL))?.blockId
      expect(focusedId).toBeTruthy()
      expect(focusedId).not.toBe(value.id)
      const row = await repo.load(focusedId!)
      expect(row?.parentId).toBe(memberRoot ? value.id : field.id)
      expect(row?.content).toBe('')
      return row!
    })
    await waitFor(() => expect(document.querySelector(`[data-block-id="${created.id}"] .cm-content`)).not.toBeNull())
    expect(await repo.block(OWNER).get(list)).toEqual(memberRoot ? ['saved'] : ['saved', ''])
  })


})

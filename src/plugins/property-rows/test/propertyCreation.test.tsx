// @vitest-environment happy-dom
import {Suspense, useEffect} from 'react'
import {focusPickedPlaceholder} from '@/utils/outlinePlaceholderNavigation'
import {ActionContextTypes, type BlockShortcutDependencies} from '@/shortcuts/types'
import {HotkeyReconciler} from '@/shortcuts/HotkeyReconciler'
import {vimNormalModeInteractionExtension} from '@/plugins/vim-normal-mode'
import {vimNormalModeActionsExtension} from '@/plugins/vim-normal-mode/actions'
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope, seedProperty, seedType, type User} from '@/data/api'
import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets'
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
import {editorSelection, focusBlock, isCollapsedProp, isEditingProp, peekFocusedBlockLocation, topLevelBlockIdProp, typesProp} from '@/data/properties'
import {EditorView} from '@codemirror/view'
import {CompletionContext} from '@codemirror/autocomplete'
import {flushEditorContent} from '@/editor/contentFlush'
import {handlePropertyValueEnter, propertyCompletionSource} from '../autocomplete'
import * as propertyCreation from '@/data/propertyRowCreation'
import * as toast from '@/utils/toast'
import {choosePropertyField, insertPropertyValue} from '@/data/propertyRowCreation'
import * as blockInteraction from '@/extensions/blockInteraction'
import {propertyRowsPlugin} from '../index'
import {editorAutocompleteExtension} from '@/editor/autocomplete'
import {acceptCompletion} from '@codemirror/autocomplete'
import {defaultEditorInteractionExtension} from '@/editor/defaultInteractions'
import {blockChildrenFooterFacet, isInteractiveContentEvent} from '@/extensions/blockInteraction'

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
const swallowSelectionChange = (event: Event) => event.stopImmediatePropagation()
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
afterEach(() => {
  vi.restoreAllMocks()
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
  runtime = resolveFacetRuntimeSync([
    kernelDataExtension, kernelPropertyUiExtension, kernelValuePresetsExtension, editorAutocompleteExtension,
    defaultRenderersExtension, propertyRowsPlugin, plainOutlinerPlugin, defaultEditorInteractionExtension,
    vimNormalModeInteractionExtension, vimNormalModeActionsExtension({repo}),
    blockChildrenFooterFacet.of(() => TestFooter, {source: 'test-footer'}),
    defaultActionContextConfigs.map(config => actionContextsFacet.of(config, {source: 'test'})),
    actionsFacet.of({id: 'test:normal-command', context: ActionContextTypes.NORMAL_MODE, description: 'Test normal command', defaultBinding: {keys: 'q'}, handler: normalCommand}),
    props.map(prop => definitionSeedsFacet.of(prop, {source: 'test'})),
    typeSeedsFacet.of(expectedType, {source: 'test'}),
  ])
  repo.setFacetRuntime(runtime)
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
const mount = (mode: 'all' | 'non-hidden' | 'none' = 'non-hidden', root = OWNER, isReference = false) => render(
  <RepoContext value={repo}>
    <AppRuntimeContextProvider value={runtime}>
      <ActiveContextsProvider>
        <HotkeyReconciler/>
        <ContextProbe/>
        <Suspense fallback={null}>
          <BlockContextProvider initialValue={{panelId: PANEL, renderScopeId: 'creation-test', scopeRootId: root, isReference}}>
            <PropertyDisplayScopeContext value={{childBacked: true, workspace: mode, panel: 'inherit'}}>
              <BlockComponent blockId={root}/>
            </PropertyDisplayScopeContext>
          </BlockContextProvider>
        </Suspense>
      </ActiveContextsProvider>
    </AppRuntimeContextProvider>
  </RepoContext>,
)

const ghostNames = () => [...document.querySelectorAll<HTMLElement>('[data-property-ghost="true"] span')]
  .map(element => element.textContent)
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
const settle = () => screen.findByText('Existing note')
const typePlaceholderText = (target: HTMLElement, text: string) => {
  target.textContent += text
  fireEvent.input(target, {inputType: 'insertText', data: text, isComposing: false})
}

describe('expected property placeholders in the outline', () => {
  it('normal-mode navigation passes empty fields and ghosts without writing', async () => {
    const scalar = await repo.mutate.createChild({parentId: OWNER, content: '::'})
    await choosePropertyField(repo.block(OWNER), plain, repo.block(scalar))
    const listScaffold = await repo.mutate.createChild({parentId: OWNER, content: '::'})
    await choosePropertyField(repo.block(OWNER), list, repo.block(listScaffold))
    await insertPropertyValue(repo.block(OWNER), list, 'member')
    const below = await repo.mutate.createChild({parentId: OWNER, content: 'Below fields'})
    await repo.block(PANEL).set(topLevelBlockIdProp, OWNER)
    mount('all')
    await screen.findByText('Below fields')
    await act(async () => { await focusBlock(repo.block(PANEL), scalar, {renderScopeId: 'creation-test'}) })
    const before = await ownerDescendants()
    expect(document.activeElement?.hasAttribute('data-property-placeholder')).toBe(false)
    for (let i = 0; i < 3; i++) {
      const current = peekFocusedBlockLocation(repo.block(PANEL))!.blockId
      await waitFor(() => expect((activeContexts.get(ActionContextTypes.NORMAL_MODE) as BlockShortcutDependencies)?.block.id).toBe(current))
      fireEvent.keyDown(document.querySelector(`[data-block-id="${current}"]`)!, {key: 'j', code: 'KeyJ'})
      await waitFor(() => expect(peekFocusedBlockLocation(repo.block(PANEL))?.blockId).not.toBe(current))
      expect(document.activeElement?.hasAttribute('data-property-placeholder')).toBe(false)
    }
    expect(peekFocusedBlockLocation(repo.block(PANEL))?.blockId).toBe(below)
    expect(await ownerDescendants()).toEqual(before)
  })

  it.each(['i', 'a', 'o', 'Enter'])('normal-mode %s keeps the field-row key semantics', async key => {
    await repo.block(OWNER).set(list, ['saved'])
    await repo.block(PANEL).set(topLevelBlockIdProp, OWNER)
    mount('all')
    const placeholder = await screen.findByLabelText(`Enter ${list.name}`)
    const fieldId = placeholder.getAttribute('data-property-placeholder')!
    await act(async () => { await focusBlock(repo.block(PANEL), fieldId, {renderScopeId: 'creation-test'}) })
    await waitFor(() => expect((activeContexts.get(ActionContextTypes.NORMAL_MODE) as BlockShortcutDependencies)?.block.id).toBe(fieldId))
    const before = await ownerDescendants()
    fireEvent.keyDown(document.querySelector(`[data-block-id="${fieldId}"]`)!, {key, code: key === 'Enter' ? 'Enter' : `Key${key.toUpperCase()}`})
    if (key === 'o') await waitFor(() => expect(document.activeElement).toBe(placeholder))
    else if (key !== 'Enter') await waitFor(() => expect(document.querySelector(`[data-block-id="${fieldId}"] .cm-content`)?.textContent).toBe(repo.block(fieldId).peek()?.content))
    else expect(repo.block(PANEL).peekProperty(isEditingProp)).toBe(false)
    expect(await ownerDescendants()).toEqual(before)
  })

  it('Escape from a ghost focuses the last drawn child, then j moves on normally', async () => {
    const child = await repo.mutate.createChild({parentId: OWNER, content: 'Last child'})
    mount('all')
    const ghost = await screen.findByLabelText(`Enter ${plain.name}`)
    await act(async () => { ghost.focus() })
    fireEvent.keyDown(ghost, {key: 'Escape', code: 'Escape'})
    await waitFor(() => expect(peekFocusedBlockLocation(repo.block(PANEL))?.blockId).toBe(child))
    expect(document.activeElement).not.toBe(ghost)
    expect((await repo.load(OWNER))?.deleted).toBe(false)
  })

  it('ignores whitespace-only first input without opening a transaction', async () => {
    mount('all')
    const ghost = await screen.findByLabelText(`Enter ${plain.name}`)
    await act(async () => { ghost.focus() })
    const tx = vi.spyOn(repo, 'tx')
    try {
      act(() => { typePlaceholderText(ghost, '  ') })
      expect(tx).not.toHaveBeenCalled()
    } finally { tx.mockRestore() }
  })

  it('hides both expected and existing value placeholders in read-only mode', async () => {
    await repo.block(OWNER).set(list, ['saved'])
    const editable = mount('all')
    await screen.findByLabelText(`Enter ${plain.name}`)
    await screen.findByLabelText(`Enter ${list.name}`)
    editable.unmount()
    repo.setReadOnly(true)
    mount('all')
    await screen.findByText('saved')
    expect(document.querySelector('[data-property-placeholder]')).toBeNull()
  })

  it('does not put expected fields into a reference rendering', async () => {
    mount('all', OWNER, true)
    await settle()
    expect(document.querySelector('[data-property-ghost]')).toBeNull()
  })

  it('keeps rejected first input and reports one error for the whole word', async () => {
    mount('all')
    const target = await screen.findByLabelText(`Enter ${plain.name}`)
    await act(async () => { target.focus() })
    const error = vi.spyOn(toast, 'showError').mockReturnValue(0)
    const insert = vi.spyOn(propertyCreation, 'insertPropertyValue').mockRejectedValue(new Error('Test refusal'))
    act(() => { typePlaceholderText(target, 'x'); typePlaceholderText(target, 'y') })
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1))
    expect(insert).toHaveBeenCalledTimes(1)
    expect(target.textContent).toBe('xy')
    expect(document.activeElement).toBe(target)
  })

  it('renders typed fields by display tier after existing children, without adding structural children', async () => {
    mount('non-hidden')
    await settle()
    const structuralBefore = await repo.runQuery('core.childIds', {id: OWNER})
    await waitFor(() => expect(ghostNames()).toEqual(['creation:plain', 'creation:list']))
    const note = screen.getByText('Existing note')
    const lastGhost = document.querySelector('[data-property-ghost="true"]')!
    expect(note.compareDocumentPosition(lastGhost) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(await repo.runQuery('core.childIds', {id: OWNER})).toEqual(structuralBefore)
    expect(await db.db.getOptional("SELECT id FROM blocks WHERE content = 'Enter value…'")).toBeNull()
  })

  it('includes hidden and outline-hidden fields in all, and draws none in none mode', async () => {
    const all = mount('all')
    await settle()
    const structuralBefore = await repo.runQuery('core.childIds', {id: OWNER})
    await waitFor(() => expect(ghostNames()).toEqual(props.map(prop => prop.name)))
    all.unmount()
    mount('none')
    await settle()
    expect(ghostNames()).toEqual([])
    expect(await repo.runQuery('core.childIds', {id: OWNER})).toEqual(structuralBefore)
  })

  it('shows ghosts on a collapsed focal root without changing collapse, and hides them on a nonfocal collapse', async () => {
    await repo.block(OWNER).set(isCollapsedProp, true)
    await repo.block(PANEL).set(topLevelBlockIdProp, OWNER)
    const focal = mount('all')
    await waitFor(() => expect(document.querySelector(`[data-block-id="${OWNER}"]`)).not.toBeNull())
    await waitFor(() => expect(ghostNames()).toEqual(props.map(prop => prop.name)))
    expect(await repo.block(OWNER).get(isCollapsedProp)).toBe(true)
    focal.unmount()

    await repo.block(PANEL).set(topLevelBlockIdProp, undefined)
    mount('all')
    await waitFor(() => expect(document.querySelector(`[data-block-id="${OWNER}"]`)).not.toBeNull())
    expect(ghostNames()).toEqual([])
    expect(await repo.block(OWNER).get(isCollapsedProp)).toBe(true)
  })

  it('places expected ghosts before later child-footer contributions', async () => {
    mount('non-hidden')
    await settle()
    await waitFor(() => expect(ghostNames()).toEqual(['creation:plain', 'creation:list']))
    const lastGhost = [...document.querySelectorAll('[data-property-ghost="true"]')].at(-1)!
    const footer = [...document.querySelectorAll<HTMLElement>('[data-testid="children-footer-marker"]')]
      .find(marker => marker.closest<HTMLElement>('[data-block-id]')?.dataset.blockId === OWNER)!
    expect(lastGhost.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('excludes a real placeholder click from block pointer gestures', async () => {
    mount('all')
    const placeholder = await screen.findByRole('textbox', {name: `Enter ${plain.name}`})
    const shell = placeholder.closest<HTMLElement>('[data-block-id]')!
    const bullet = shell.querySelector<HTMLElement>('[data-block-bullet]')!
    expect(isInteractiveContentEvent({target: placeholder})).toBe(true)
    expect(isInteractiveContentEvent({target: bullet})).toBe(true)
    await act(async () => { fireEvent.click(placeholder) })
    expect(await repo.block(PANEL).get(isEditingProp)).toBe(false)
  })

  it('focusing, navigating and pressing Enter writes no data', async () => {
    mount('all')
    const first = await screen.findByRole('textbox', {name: `Enter ${plain.name}`})
    const before = await ownerDescendants()
    await act(async () => {
      first.focus()
      fireEvent.keyDown(first, {key: 'ArrowDown'})
      fireEvent.keyDown(first, {key: 'ArrowUp'})
      fireEvent.keyDown(first, {key: 'Enter'})
      await focusBlock(repo.block(PANEL), OWNER, {renderScopeId: 'creation-test'})
    })
    expect(await ownerDescendants()).toEqual(before)
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(0)
  })

  it('waits for compositionEnd before creating one Unicode value', async () => {
    const insert = vi.spyOn(propertyCreation, 'insertPropertyValue')
    mount('non-hidden')
    const target = await screen.findByRole('textbox', {name: `Enter ${plain.name}`})
    const before = await ownerDescendants()
    await act(async () => {
      target.focus()
      target.textContent = '日本語'
      fireEvent.input(target, {inputType: 'insertCompositionText', data: '日本語', isComposing: true})
    })
    expect(await ownerDescendants()).toEqual(before)
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(0)

    expect(insert).not.toHaveBeenCalled()
    await act(async () => { fireEvent.compositionEnd(target, {data: '日本語'}) })
    await waitFor(async () => expect((await ownerDescendants()).map(row => row.content)).toContain('日本語'))
    const created = await ownerDescendants()
    expect(created.filter(row => row.content === '日本語')).toHaveLength(1)
    await waitFor(() => expect([...document.querySelectorAll('.cm-content')].some(node => node.textContent === '日本語')).toBe(true))
    const editor = [...document.querySelectorAll<HTMLElement>('.cm-content')].find(node => node.textContent === '日本語')!
    expect(EditorView.findFromDOM(editor)!.state.selection.main.anchor).toBe('日本語'.length)
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(1)
  })

  it('keeps command keys on the mounted input through every handoff stage', async () => {
    mount('all')
    const target = await screen.findByLabelText(`Enter ${plain.name}`)
    const barriers = Array.from({length: 2}, () => {
      let release!: () => void
      let entered!: () => void
      return {gate: new Promise<void>(resolve => { release = resolve }), hit: new Promise<void>(resolve => { entered = resolve }), release: () => release(), entered: () => entered()}
    })
    const originalTx = repo.tx.bind(repo)
    const txSpy = vi.spyOn(repo, 'tx').mockImplementation(async (...args: Parameters<Repo['tx']>) => {
      const result = await originalTx(...args)
      if (args[1]?.description === 'Enter property value') { barriers[0].entered(); await barriers[0].gate }
      return result
    })
    const panel = repo.block(PANEL)
    const originalSet = panel.set.bind(panel)
    const setSpy = vi.spyOn(panel, 'set').mockImplementation(async (schema, value) => {
      if (schema.name === editorSelection.name) { barriers[1].entered(); await barriers[1].gate }
      return originalSet(schema, value)
    })
    try {
      await act(async () => { target.focus() })
      await waitFor(() => expect(activeContexts.has(ActionContextTypes.PROPERTY_EDITING)).toBe(true))
      fireEvent.keyDown(target, {key: 'q', code: 'KeyQ'})
      await act(async () => { typePlaceholderText(target, 'x') })
      for (const barrier of barriers) {
        await barrier.hit
        expect(target.isConnected).toBe(true)
        expect(document.activeElement).toBe(target)
        fireEvent.keyDown(document.activeElement!, {key: 'q', code: 'KeyQ'})
        expect(normalCommand).not.toHaveBeenCalled()
        await act(async () => { typePlaceholderText(target, 'y'); barrier.release() })
      }
      await waitFor(() => expect(document.activeElement?.classList.contains('cm-content')).toBe(true))
      await waitFor(() => expect(document.querySelector('.cm-content')?.textContent).toBe('xyy'))
      fireEvent.keyDown(document.activeElement!, {key: 'q', code: 'KeyQ'})
      expect(normalCommand).not.toHaveBeenCalled()
      await waitFor(async () => expect(await repo.block(OWNER).get(plain)).toBe('xyy'))
      expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(1)
      await act(async () => { await repo.undo() })
      expect(repo.block(OWNER).peek()?.properties).not.toHaveProperty(plain.name)
    } finally { barriers.forEach(barrier => barrier.release()); txSpy.mockRestore(); setSpy.mockRestore() }
  })

  it('places the first editor caret at the end when content grows during activation', async () => {
    mount('non-hidden')
    const target = await screen.findByRole('textbox', {name: `Enter ${plain.name}`})
    let release!: () => void
    let signalSelectionWrite!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const selectionWriteStarted = new Promise<void>(resolve => { signalSelectionWrite = resolve })
    const panel = repo.block(PANEL)
    const originalSet = panel.set.bind(panel)
    const setSpy = vi.spyOn(panel, 'set').mockImplementation(async (schema, value) => {
      if (schema.name === editorSelection.name) {
        signalSelectionWrite()
        await gate
      }
      return originalSet(schema, value)
    })
    try {
      await act(async () => { target.focus(); typePlaceholderText(target, 'h') })
      await selectionWriteStarted
      const value = (await ownerDescendants()).find(row => row.content === 'h')
      expect(value).toBeDefined()

      // More queued typing lands in the block while the first editor activation
      // is paused before it commits its initial selection.
      await repo.block(value!.id).setContent('hello')
      release()

      await waitFor(() => expect(document.querySelector(`[data-block-id="${value!.id}"] .cm-content`)?.textContent).toBe('hello'))
      const content = document.querySelector<HTMLElement>(`[data-block-id="${value!.id}"] .cm-content`)!
      const view = EditorView.findFromDOM(content)!
      expect(view.state.selection.main.anchor).toBe('hello'.length)
    } finally {
      release()
      setSpy.mockRestore()
    }
  })

  it.each([
    ['first character', async (target: HTMLElement) => typePlaceholderText(target, 'x'), 'x'],
    ['paste', async (target: HTMLElement) => fireEvent.paste(target, {clipboardData: {getData: () => 'pasted'}}), 'pasted'],
  ])('typing by %s creates a populated field in one undo step and opens its ordinary editor', async (_label, input, text) => {
    mount('non-hidden')
    const target = await screen.findByRole('textbox', {name: `Enter ${plain.name}`})
    const before = await ownerDescendants()
    await act(async () => { target.focus(); await input(target) })
    await waitFor(async () => expect((await ownerDescendants()).length).toBe(before.length + 2))
    await waitFor(() => expect([...document.querySelectorAll('.cm-content')].some(node => node.textContent === text)).toBe(true))
    const editor = [...document.querySelectorAll<HTMLElement>('.cm-content')].find(node => node.textContent === text)!
    const view = EditorView.findFromDOM(editor)!
    expect(view.state.doc.toString()).toBe(text)
    expect(view.state.selection.main.anchor).toBe(text.length)
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(1)
    await act(async () => { await repo.undo() })
    expect(await ownerDescendants()).toEqual(before)
  })

  it('keeps rapid keystrokes in order while the first create transaction is pending', async () => {
    mount('non-hidden')
    const target = await screen.findByRole('textbox', {name: `Enter ${plain.name}`})
    const before = await ownerDescendants()
    await act(async () => {
      target.focus()
      typePlaceholderText(target, 'x')
      typePlaceholderText(target, 'y')
    })
    await waitFor(async () => expect((await ownerDescendants()).map(row => row.content)).toContain('xy'))
    const created = await ownerDescendants()
    const fieldId = repo.propertySchemaResolverFor(WS).resolve(plain.name)
    if (fieldId.status !== 'resolved') throw new Error(`Property field did not resolve: ${plain.name}`)
    const field = created.find(row => row.is_field_form === 1 && row.reference_target_id === fieldId.schema.fieldId)
    expect(field).toBeDefined()
    const values = created.filter(row => row.parent_id === field!.id)
    expect(values).toHaveLength(1)
    expect(values[0]!.content).toBe('xy')
    expect(values.every(row => row.content.trim().length > 0)).toBe(true)
    await waitFor(() => expect([...document.querySelectorAll('.cm-content')].some(node => node.textContent === 'xy')).toBe(true))
    const editor = [...document.querySelectorAll<HTMLElement>('.cm-content')].find(node => node.textContent === 'xy')!
    const view = EditorView.findFromDOM(editor)!
    expect(view.state.selection.main.anchor).toBe(2)
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(1)
    await act(async () => { await repo.undo() })
    expect(await ownerDescendants()).toEqual(before)
  })

  it('creates a distinct member each time the existing list placeholder is revisited', async () => {
    await repo.block(OWNER).set(list, ['saved'])
    repo.undoManager.clear()
    mount('all')
    let target = await screen.findByLabelText(`Enter ${list.name}`)
    await act(async () => { target.focus(); typePlaceholderText(target, 'x') })
    await waitFor(async () => expect(await repo.block(OWNER).get(list)).toEqual(['saved', 'x']))
    await waitFor(() => expect([...document.querySelectorAll('.cm-content')].some(node => node.textContent === 'x')).toBe(true))
    target = await screen.findByLabelText(`Enter ${list.name}`)
    await act(async () => { target.focus(); typePlaceholderText(target, 'y') })
    await waitFor(async () => expect(await repo.block(OWNER).get(list)).toEqual(['saved', 'x', 'y']))
    const field = await db.db.get<{id: string}>(
      "SELECT id FROM blocks WHERE reference_target_id = ? AND is_field_form = 1 AND deleted = 0", [
        (repo.propertySchemaResolverFor(WS).resolve(list.name) as {status: 'resolved'; schema: {fieldId: string}}).schema.fieldId,
      ])
    expect(await repo.query.children({id: field.id, propertyChildren: 'all'}).load()).toHaveLength(3)
  })

  it('focuses the value placeholder when choosing a collapsed existing list field', async () => {
    await repo.block(OWNER).set(list, ['saved'])
    const field = await db.db.get<{id: string}>("SELECT parent_id AS id FROM blocks WHERE content = 'saved' AND deleted = 0")
    await repo.block(field.id).set(isCollapsedProp, true)
    const source = await repo.mutate.createChild({parentId: OWNER, content: '::'})
    mount('all')
    await settle()
    await act(async () => {
      const picked = await choosePropertyField(repo.block(OWNER), list, repo.block(source))
      await focusBlock(repo.block(PANEL), picked.fieldRowId, {edit: false, renderScopeId: 'creation-test'})
      focusPickedPlaceholder(picked.fieldRowId, 'creation-test', () => true)
    })
    const target = await screen.findByLabelText(`Enter ${list.name}`)
    expect(document.activeElement).toBe(target)
  })

  it('keeps focus on another placeholder when value creation finishes', async () => {
    mount('all')
    const first = await screen.findByLabelText(`Enter ${plain.name}`)
    const second = await screen.findByLabelText(`Enter ${list.name}`)
    let release!: () => void
    let signalEntered!: () => void
    let signalCallbackDone!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { signalEntered = resolve })
    const callbackDone = new Promise<void>(resolve => { signalCallbackDone = resolve })
    const original = repo.tx.bind(repo)
    const enterEditSpy = vi.spyOn(blockInteraction, 'enterEditModeForBlock')
    const originalGroup = repo.undoGroup.bind(repo)
    const groupSpy = vi.spyOn(repo, 'undoGroup').mockImplementation(async callback => {
      try { return await originalGroup(callback) } finally { signalCallbackDone() }
    })
    const spy = vi.spyOn(repo, 'tx').mockImplementation(async (...args: Parameters<Repo['tx']>) => {
      const result = await original(...args)
      if (args[1]?.description === 'Enter property value') {
        signalEntered()
        await gate
      }
      return result
    })
    try {
      await act(async () => { first.focus(); typePlaceholderText(first, 'x') })
      await entered
      expect(first.isConnected).toBe(true)
      await act(async () => { second.focus() })
      expect(document.activeElement).toBe(second)
      release()
      await act(async () => { await callbackDone })
      expect(enterEditSpy).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(second)
      expect(await repo.block(PANEL).get(isEditingProp)).toBe(false)
      expect(peekFocusedBlockLocation(repo.block(PANEL))?.blockId).toBe(OWNER)
    } finally {
      release()
      spy.mockRestore()
      groupSpy.mockRestore()
      enterEditSpy.mockRestore()
    }
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

  it('opens native completion while typing and converts the same block without an empty value', async () => {
    const id = await repo.mutate.createChild({parentId: OWNER, content: ''})
    mount('none')
    await act(async () => { await focusBlock(repo.block(PANEL), id, {edit: true, renderScopeId: 'creation-test'}) })
    await waitFor(() => expect(document.querySelector(`[data-block-id="${id}"] .cm-editor`)).not.toBeNull())
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(`[data-block-id="${id}"] .cm-editor`)!)!
    act(() => { view.focus(); view.dispatch({changes: {from: 0, insert: '::creation:plain'}, selection: {anchor: 16}, userEvent: 'input.type'}) })
    await screen.findByRole('option', {name: plain.name})
    await waitFor(() => { expect(acceptCompletion(view)).toBe(true) })
    const placeholder = await screen.findByRole('textbox', {name: `Enter ${plain.name}`})
    await waitFor(() => expect(document.activeElement).toBe(placeholder))
    expect((await repo.load(id))?.isFieldForm).toBe(true)
    expect(await repo.query.children({id, propertyChildren: 'all'}).load()).toEqual([])
  })

  it.each([false, true])('only hands list Enter to a placeholder in the rendered document (member root: %s)', async memberRoot => {
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
    const placeholder = screen.queryByLabelText(`Enter ${list.name}`)
    expect(Boolean(placeholder)).toBe(!memberRoot)
    const before = await ownerDescendants()
    const event = new KeyboardEvent('keydown', {key: 'Enter', cancelable: true})
    let handled = false
    await act(async () => {
      handled = handlePropertyValueEnter({repo, block: repo.block(value.id), uiStateBlock: repo.block(PANEL), renderScopeId: 'creation-test'}, event, view)
    })
    expect(handled).toBe(!memberRoot)
    expect(event.defaultPrevented).toBe(!memberRoot)
    expect(await ownerDescendants()).toEqual(before)
    if (memberRoot) expect(peekFocusedBlockLocation(repo.block(PANEL))?.blockId).toBe(value.id)
    else await waitFor(() => expect(document.activeElement).toBe(placeholder))
  })

  it('keeps selection of an existing list field from writing or appending an empty member', async () => {
    await repo.block(OWNER).set(list, ['saved'])
    repo.undoManager.clear()
    mount('all')
    const fieldPlaceholder = await screen.findByLabelText(`Enter ${list.name}`)
    const before = await ownerDescendants()
    await act(async () => {
      fieldPlaceholder.focus()
      fireEvent.keyDown(fieldPlaceholder, {key: 'Enter'})
    })
    expect(await ownerDescendants()).toEqual(before)
    expect(await repo.block(OWNER).get(list)).toEqual(['saved'])
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(0)
  })
  it.each([
    {key: 'ArrowDown', isComposing: true}, {key: 'ArrowUp', isComposing: true},
    {key: 'Enter', isComposing: true}, {key: 'Enter', keyCode: 229},
  ])('leaves $key to the active input method', async options => {
    mount('all')
    const placeholder = await screen.findByRole('textbox', {name: `Enter ${plain.name}`})
    await act(async () => { placeholder.focus() })
    const before = await ownerDescendants()
    const event = new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...options})
    act(() => { placeholder.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(placeholder)
    expect(await ownerDescendants()).toEqual(before)
  })

})

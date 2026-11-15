// @vitest-environment happy-dom
import {Suspense} from 'react'
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
import {actionContextsFacet} from '@/extensions/core'
import {defaultRenderersExtension} from '@/extensions/defaultRenderers'
import {ActiveContextsProvider} from '@/shortcuts/ActiveContexts'
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
import {focusBlock, typesProp} from '@/data/properties'
import {EditorView} from '@codemirror/view'
import {propertyRowsPlugin} from '../index'

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

let db: TestDb
let repo: Repo
let runtime: FacetRuntime
const swallowSelectionChange = (event: Event) => event.stopImmediatePropagation()
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
afterEach(() => {
  cleanup()
  window.removeEventListener('selectionchange', swallowSelectionChange, true)
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
  runtime = resolveFacetRuntimeSync([
    kernelDataExtension, kernelPropertyUiExtension, kernelValuePresetsExtension,
    defaultRenderersExtension, propertyRowsPlugin, plainOutlinerPlugin,
    defaultActionContextConfigs.map(config => actionContextsFacet.of(config, {source: 'test'})),
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

const mount = (mode: 'all' | 'non-hidden' | 'none' = 'non-hidden') => render(
  <RepoContext value={repo}>
    <AppRuntimeContextProvider value={runtime}>
      <ActiveContextsProvider>
        <Suspense fallback={null}>
          <BlockContextProvider initialValue={{panelId: PANEL, renderScopeId: 'creation-test'}}>
            <PropertyDisplayScopeContext value={{childBacked: true, workspace: mode, panel: 'inherit'}}>
              <BlockComponent blockId={OWNER}/>
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

describe('expected property placeholders in the outline', () => {
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

  it.each([
    ['first character', async (target: HTMLElement) => fireEvent.keyDown(target, {key: 'x'}), 'x'],
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
      fireEvent.keyDown(target, {key: 'x'})
      fireEvent.keyDown(target, {key: 'y'})
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
    for (let step = 0; step < 4 && repo.undoManager.depths(ChangeScope.BlockDefault).undo > 0; step++) {
      await act(async () => { await repo.undo() })
      if (await ownerDescendants().then(rows => rows.length === before.length)) break
    }
    expect(await ownerDescendants()).toEqual(before)
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
})

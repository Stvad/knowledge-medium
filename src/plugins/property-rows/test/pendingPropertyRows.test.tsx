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
import type {PropertyDisplaySetting} from '@/data/propertyDisplayMode'
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
import {focusedBlockLocationFromProperties, typesProp, isCollapsedProp} from '@/data/properties'
import {showError} from '@/utils/toast'
import {beginInlineProperty} from '@/components/propertyPanel/inlinePropertyFlow'
import {propertyRowsPlugin} from '../index'

const USER: User = {id: 'test-user', name: 'Test user'}
vi.mock('@/components/Login.tsx', () => ({useUser: () => USER}))
vi.mock('@/utils/toast', () => ({showError: vi.fn()}))

const WS = 'test-workspace'
const PANEL = 'panel'
const OWNER = 'owner'
const NOTE = 'note'
const textProp = seedProperty({seedKey: 'test/property/pending-text', revision: 1,
  name: 'draft:text', preset: 'string', changeScope: ChangeScope.BlockDefault})
const hiddenProp = seedProperty({seedKey: 'test/property/pending-hidden', revision: 1,
  name: 'draft:hidden', preset: 'string', hidden: true, changeScope: ChangeScope.BlockDefault})
const outlineHiddenProp = seedProperty({seedKey: 'test/property/pending-outline-hidden', revision: 1,
  name: 'draft:outline-hidden', preset: 'string', hideInOutline: true, changeScope: ChangeScope.BlockDefault})
const numberProp = seedProperty({seedKey: 'test/property/pending-number', revision: 1,
  name: 'draft:number', preset: 'optional-number', changeScope: ChangeScope.BlockDefault})
const expectedProps = [textProp, hiddenProp, outlineHiddenProp, numberProp]
const expectedType = seedType({seedKey: 'test/type/pending-properties', revision: 1,
  id: 'test:pending-properties', label: 'Expected properties', properties: expectedProps})

let db: TestDb
let repo: Repo
let runtime: FacetRuntime
// happy-dom's synchronous selectionchange re-enters CodeMirror's own update.
const swallowSelectionChange = (event: Event) => event.stopImmediatePropagation()
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
afterEach(async () => {
  cleanup()
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  await repo.tx(async () => {}, {scope: ChangeScope.UiState})
  window.removeEventListener('selectionchange', swallowSelectionChange, true)
  vi.unstubAllGlobals()
  __resetLazyMountRegistryForTesting()
  __resetLazyMountCachesForTesting()
})

beforeEach(async () => {
  window.addEventListener('selectionchange', swallowSelectionChange, true)
  vi.mocked(showError).mockClear()
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
  }))
  await resetTestDb(db.db)
  await db.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
       encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'Test', ?, 1, 1, 'none', NULL, 'children')`, [WS, USER.id])
  repo = createTestRepo({db: db.db, user: USER, newId: () => crypto.randomUUID()}).repo
  runtime = resolveFacetRuntimeSync([
    kernelDataExtension, kernelPropertyUiExtension, kernelValuePresetsExtension,
    defaultRenderersExtension, propertyRowsPlugin, plainOutlinerPlugin,
    defaultActionContextConfigs.map(config => actionContextsFacet.of(config, {source: 'test'})),
    expectedProps.map(prop => definitionSeedsFacet.of(prop, {source: 'test'})),
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
    for (const prop of expectedProps) expect(repo.propertySchemas.has(prop.name)).toBe(true)
  })
  await repo.awaitSeedMaterialization()
  await repo.awaitReprojections()
  repo.undoManager.clear()
})

const mount = (mode: PropertyDisplaySetting = 'non-hidden') => render(
  <RepoContext value={repo}>
    <AppRuntimeContextProvider value={runtime}>
      <ActiveContextsProvider>
        <Suspense fallback={null}>
          <BlockContextProvider initialValue={{panelId: PANEL, renderScopeId: 'pending-test'}}>
            <PropertyDisplayScopeContext value={{childBacked: true, workspace: mode, panel: 'inherit'}}>
              <BlockComponent blockId={OWNER}/>
            </PropertyDisplayScopeContext>
          </BlockContextProvider>
        </Suspense>
      </ActiveContextsProvider>
    </AppRuntimeContextProvider>
  </RepoContext>,
)

const rowCount = async () => (await db.db.get<{count: number}>('SELECT COUNT(*) AS count FROM blocks')).count
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-pending-property-row="true"]')]
const rowNames = () => rows().map(row => row.dataset.propertyName)
const input = (name = textProp.name) => screen.getByRole('textbox', {name: `Value for ${name}`})
const waitForOutline = async () => { await screen.findByText('Existing note') }

describe('expected property ghost rows in the outline', () => {
  it('opens the add-field draft beneath a collapsed owner', async () => {
    await repo.block(OWNER).set(isCollapsedProp, true)
    mount('none')
    await act(async () => { await beginInlineProperty({owner: repo.block(OWNER), schema: textProp,
      ui: repo.block(PANEL), scope: 'pending-test'}) })
    expect(screen.getByRole('textbox', {name: 'Value for draft:text'})).toBeVisible()
  })

  it('renders unset expected fields without writing rows or adding structural children', async () => {
    const count = await rowCount()
    const beforeIds = await repo.block(OWNER).childIds.load()
    const beforeChildren = await repo.block(OWNER).children.load()
    const beforeStructural = await repo.query.children({id: OWNER, propertyChildren: 'all'}).load()
    mount()
    await screen.findByRole('textbox', {name: `Value for ${textProp.name}`})
    expect(await rowCount()).toBe(count)
    expect(await repo.block(OWNER).childIds.load()).toEqual(beforeIds)
    expect(await repo.block(OWNER).children.load()).toEqual(beforeChildren)
    expect(await repo.query.children({id: OWNER, propertyChildren: 'all'}).load()).toEqual(beforeStructural)
    expect(rows().every(row => !row.hasAttribute('data-block-id') && !row.hasAttribute('data-block-shell'))).toBe(true)
  })

  it('hides expected rows in mode none after proving they render in non-hidden', async () => {
    const view = mount()
    await screen.findByRole('textbox', {name: `Value for ${textProp.name}`})
    view.unmount()
    mount('none')
    await waitForOutline()
    expect(rows()).toEqual([])
  })

  it('applies both hidden and hide-in-outline tiers in non-hidden mode', async () => {
    mount()
    await screen.findByRole('textbox', {name: `Value for ${textProp.name}`})
    expect(rowNames()).toEqual([textProp.name, numberProp.name])
  })

  it('shows every expected field in all mode', async () => {
    mount('all')
    await screen.findByRole('textbox', {name: `Value for ${hiddenProp.name}`})
    expect(rowNames()).toEqual(expectedProps.map(prop => prop.name))
  })

  it('commits a ghost through the writer as one field, one value and one undo step', async () => {
    const count = await rowCount()
    mount()
    await screen.findByRole('textbox', {name: `Value for ${textProp.name}`})
    expect(await rowCount()).toBe(count)
    await act(async () => { input().focus() })
    fireEvent.change(input(), {target: {value: 'committed text'}})
    await act(async () => { fireEvent.keyDown(input(), {key: 'Enter'}) })
    await waitFor(() => expect(repo.block(OWNER).peekProperty(textProp)).toBe('committed text'))
    const ownerChildren = await repo.query.children({id: OWNER, propertyChildren: 'all'}).load()
    const fields = ownerChildren.filter(row => {
      if (!row.isFieldForm || !row.referenceTargetId) return false
      const resolved = repo.propertySchemaResolverFor(WS).resolveField(row.referenceTargetId)
      return resolved.status === 'resolved' && resolved.schema.name === textProp.name
    })
    expect(fields).toHaveLength(1)
    const children = await repo.block(fields[0].id).children.load()
    expect(children).toHaveLength(1)
    expect(children[0].content).toBe('committed text')
    await waitFor(() => expect(focusedBlockLocationFromProperties(repo.block(PANEL).peek()?.properties)?.blockId).toBe(children[0].id))
    const events = await db.db.getAll<{tx_id: string}>('SELECT DISTINCT tx_id FROM row_events WHERE block_id IN (?, ?)', [fields[0].id, children[0].id])
    expect(events).toHaveLength(1)
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(1)
    await act(async () => { await repo.undo(ChangeScope.BlockDefault) })
    expect(repo.block(OWNER).peekProperty(textProp)).toBeUndefined()
    expect((await repo.query.children({id: OWNER, propertyChildren: 'all'}).load()).some(row => row.id === fields[0].id)).toBe(false)
  })

  it('refuses undecodable input visibly and retains the draft without creating rows', async () => {
    mount()
    await screen.findByRole('textbox', {name: `Value for ${numberProp.name}`})
    const count = await rowCount()
    fireEvent.change(input(numberProp.name), {target: {value: 'not a number'}})
    await act(async () => { fireEvent.keyDown(input(numberProp.name), {key: 'Enter'}) })
    await waitFor(() => expect(showError).toHaveBeenCalled())
    expect(input(numberProp.name)).toHaveValue('not a number')
    expect(await rowCount()).toBe(count)
    expect(repo.block(OWNER).peekProperty(numberProp)).toBeUndefined()
  })

  it.each(['blur', 'Escape'])('leaves no stored row when an empty ghost is abandoned by %s', async gesture => {
    mount()
    await screen.findByRole('textbox', {name: `Value for ${textProp.name}`})
    const count = await rowCount()
    await act(async () => {
      if (gesture === 'blur') fireEvent.blur(input())
      else fireEvent.keyDown(input(), {key: 'Escape'})
    })
    expect(await rowCount()).toBe(count)
    expect(repo.block(OWNER).peekProperty(textProp)).toBeUndefined()
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(0)
  })

  it('offers no editable ghosts in a read-only workspace', async () => {
    Object.defineProperty(repo, 'isReadOnly', {value: true})
    const count = await rowCount()
    mount('all')
    await waitForOutline()
    expect(screen.queryByRole('textbox', {name: `Value for ${textProp.name}`})).toBeNull()
    expect(await rowCount()).toBe(count)
  })
})

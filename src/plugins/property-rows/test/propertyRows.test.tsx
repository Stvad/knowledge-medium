// @vitest-environment happy-dom
/**
 * The outline's in-place property rows, driven through the real renderer
 * registry (default renderers + this plugin) on a child-backed workspace: what
 * each display mode shows, where, and that an edit through a row is the
 * panel's write of the panel's value.
 */
import { Suspense } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, seedProperty, type User } from '@/data/api'
import type { Block } from '@/data/block'
import { definitionSeedsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { propertyDisplayProp, type PropertyDisplaySetting } from '@/data/propertyDisplayMode'
import { resolveFacetRuntimeSync, type FacetRuntime } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { actionContextsFacet } from '@/extensions/core'
import { defaultRenderersExtension } from '@/extensions/defaultRenderers'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts'
import { BlockContextProvider, NestedBlockContextProvider } from '@/context/block'
import { PropertyDisplayScopeContext, PropertyRowListingContext } from '@/context/propertyDisplay'
import { RepoContext } from '@/context/repo'
import { BlockComponent } from '@/components/BlockComponent'
import { __resetLazyMountCachesForTesting } from '@/components/util/LazyViewportMount'
import { __resetLazyMountRegistryForTesting } from '@/components/util/lazyMountRegistry'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { propertyRowsPlugin } from '../index'
import { setBlockPropertyDisplay } from '../actions'

const USER: User = {id: 'user-1', name: 'Alice'}
vi.mock('@/components/Login.tsx', () => ({useUser: () => USER}))

const WS = 'ws-property-rows'
const PANEL = 'panel'
const OWNER = 'owner'
const NOTE = 'note'

const statusProp = seedProperty({
  seedKey: 'test/property/rows-status', revision: 1, name: 'rows:status',
  preset: 'string', defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const secretProp = seedProperty({
  seedKey: 'test/property/rows-secret', revision: 1, name: 'rows:secret',
  preset: 'string', defaultValue: '', changeScope: ChangeScope.BlockDefault, hidden: true,
})

let sharedDb: TestDb
let repo: Repo
let runtime: FacetRuntime
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  __resetLazyMountRegistryForTesting()
  __resetLazyMountCachesForTesting()
})

beforeEach(async () => {
  // No observer: every lazy row mounts at once, so the whole outline renders.
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
  }))
  await resetTestDb(sharedDb.db)
  await sharedDb.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
       encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'test ws', ?, 1, 1, 'none', NULL, 'children')`, [WS, USER.id])
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  runtime = resolveFacetRuntimeSync([
    kernelDataExtension,
    kernelPropertyUiExtension,
    kernelValuePresetsExtension,
    defaultRenderersExtension,
    propertyRowsPlugin,
    defaultActionContextConfigs.map(config => actionContextsFacet.of(config, {source: 'test'})),
    [statusProp, secretProp].map(prop => definitionSeedsFacet.of(prop, {source: 'test'})),
  ])
  repo.setFacetRuntime(runtime)
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: PANEL, workspaceId: WS, parentId: null, orderKey: 'a0', content: ''})
    await tx.create({id: OWNER, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'owner'})
    await tx.create({id: NOTE, workspaceId: WS, parentId: OWNER, orderKey: 'a0', content: 'a note'})
  }, {scope: ChangeScope.BlockDefault})
  await waitFor(() => expect(repo.propertySchemas.has(statusProp.name)).toBe(true))
  const owner = repo.block(OWNER)
  await owner.set(statusProp, 'draft')
  await owner.set(secretProp, 'shh')
})

type Scope = {childBacked?: boolean; workspace?: PropertyDisplaySetting}

const mount = (scope: Scope = {}) => render(outline(scope))

const outline = (scope: Scope) => (
    <RepoContext value={repo}>
      <AppRuntimeContextProvider value={runtime}>
        <ActiveContextsProvider>
          <Suspense fallback={null}>
            <BlockContextProvider initialValue={{panelId: PANEL}}>
              <PropertyDisplayScopeContext.Provider value={{
                childBacked: scope.childBacked ?? true,
                workspace: scope.workspace ?? 'inherit',
                panel: 'inherit',
              }}>
                <BlockComponent blockId={OWNER}/>
              </PropertyDisplayScopeContext.Provider>
            </BlockContextProvider>
          </Suspense>
        </ActiveContextsProvider>
      </AppRuntimeContextProvider>
    </RepoContext>
)

/** Names of the property rows on screen, in document order. */
const shownRows = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-property-field-row="true"]')]
    .map(row => row.querySelector('[data-property-definition-link="true"]')?.textContent ?? '?')

/** The owner's field rows, named, in `core.childIds`' structural order. */
const structuralFieldRowNames = async (): Promise<string[]> => {
  const ids = await repo.runQuery('core.childIds', {id: OWNER}) as string[]
  const names: string[] = []
  for (const id of ids) {
    const data = await repo.load(id)
    const fieldId = data?.isFieldForm ? data.referenceTargetId : null
    if (!fieldId) continue
    const resolution = repo.propertySchemaResolverFor(WS).resolveField(fieldId)
    if (resolution.status === 'resolved') names.push(resolution.schema.name)
  }
  return names
}

/** Waits until the owner's ordinary child is on screen, so an empty
 *  `shownRows()` means "rendered without rows", never "not rendered yet". */
const outlineSettled = () => screen.findByText('a note')

describe('the property display mode', () => {
  it('hides every property row by default, as the outline did before rows', async () => {
    mount()
    await outlineSettled()
    expect(shownRows()).toEqual([])
  })

  it('shows non-hidden rows at their true position, after the note they follow', async () => {
    mount({workspace: 'non-hidden'})
    await waitFor(() => expect(shownRows()).toEqual(['rows:status']))
    const note = await outlineSettled()
    const row = document.querySelector('[data-property-name="rows:status"]')!
    expect(note.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByDisplayValue('draft')).toBeTruthy()
  })

  it('shows hidden-tier rows too in show-all, in the structural order', async () => {
    mount({workspace: 'all'})
    const expected = await structuralFieldRowNames()
    expect([...expected].sort()).toEqual(['rows:secret', 'rows:status'])
    await waitFor(() => expect(shownRows()).toEqual(expected))
    expect(screen.getByDisplayValue('shh')).toBeTruthy()
  })

  it('lets the block level win over the workspace level', async () => {
    await setBlockPropertyDisplay([repo.block(OWNER)], 'all')
    mount({workspace: 'none'})
    // The switch is itself a (hidden) property of the block, so revealing
    // shows its own row as well.
    await waitFor(() => expect([...shownRows()].sort())
      .toEqual(['rows:secret', 'rows:status', 'system:propertyDisplay']))

    await act(async () => { await setBlockPropertyDisplay([repo.block(OWNER)], 'inherit') })
    await outlineSettled()
    await waitFor(() => expect(shownRows()).toEqual([]))
  })

  it('shows no rows on a cell-backed workspace, whatever the levels say', async () => {
    await setBlockPropertyDisplay([repo.block(OWNER)], 'all')
    mount({childBacked: false, workspace: 'all'})
    await outlineSettled()
    expect(shownRows()).toEqual([])
  })
})

describe('editing through a property row', () => {
  it('writes the owner\'s property, the value the panel reads', async () => {
    mount({workspace: 'non-hidden'})
    const input = await screen.findByDisplayValue('draft') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, {target: {value: 'final'}})
      fireEvent.blur(input)
    })
    const owner: Block = repo.block(OWNER)
    await waitFor(() => expect(owner.peekProperty(statusProp)).toBe('final'))
    await waitFor(() => expect(screen.getByDisplayValue('final')).toBeTruthy())
  })
})

describe('a scalar whose value children disagree', () => {
  // Concurrent offline edits can leave two value children under one scalar's
  // field row; the data layer keeps both. Written raw, so no processor folds
  // the second into the owner's cell before the render.
  it('shows the stray sibling as its own text, not as a second copy of the owner\'s value', async () => {
    const fieldRow = await sharedDb.db.getOptional<{id: string}>(
      `SELECT f.id FROM blocks f WHERE f.parent_id = ? AND f.is_field_form = 1 AND f.deleted = 0
         AND EXISTS (SELECT 1 FROM blocks v WHERE v.parent_id = f.id AND v.content = 'draft' AND v.deleted = 0)`,
      [OWNER])
    expect(fieldRow).not.toBeNull()
    await sharedDb.db.writeTransaction(async tx => {
      await tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json, deleted,
           created_at, updated_at, created_by, updated_by)
         VALUES ('stray', ?, ?, 'z9', 'final', '{}', 0, 1, 1, ?, ?)`,
        [WS, fieldRow!.id, USER.id, USER.id])
    })
    expect(repo.block(OWNER).peekProperty(statusProp)).toBe('draft')

    mount({workspace: 'non-hidden'})
    await screen.findByDisplayValue('draft')
    const stray = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-block-id="stray"] .block-content')
      expect(found?.textContent).toContain('final')
      return found!
    })
    expect(stray.querySelector('[data-property-value-row]')).toBeNull()
    expect(screen.queryByDisplayValue('final')).toBeNull()
  })
})

describe('resetting the block switch', () => {
  // The switch is itself a property, so in show-all its field row is visible
  // and a user can nest content under it. Clearing the switch must not take
  // that content with it: the scope is not undoable.
  it('keeps content a user nested under the switch\'s own row', async () => {
    await setBlockPropertyDisplay([repo.block(OWNER)], 'all')
    const switchRow = await waitFor(async () => {
      const found = await sharedDb.db.getOptional<{id: string}>(
        `SELECT f.id FROM blocks f WHERE f.parent_id = ? AND f.is_field_form = 1 AND f.deleted = 0
           AND EXISTS (SELECT 1 FROM blocks v WHERE v.parent_id = f.id AND v.content = 'all' AND v.deleted = 0)`,
        [OWNER])
      expect(found).not.toBeNull()
      return found!
    })
    await repo.tx(tx => tx.create({
      id: 'nested-note', workspaceId: WS, parentId: switchRow.id, orderKey: 'z0', content: 'mine',
    }), {scope: ChangeScope.BlockDefault})

    await setBlockPropertyDisplay([repo.block(OWNER)], 'inherit')

    expect((await repo.load('nested-note'))?.deleted).toBe(false)
    expect(repo.block(OWNER).peekProperty(propertyDisplayProp)).toBe('inherit')
  })
})

describe('switching views', () => {
  // Every panel renders hide-all first (the workspace's child-backed answer
  // lands a render later), so a switched user's outline changes view on every
  // mount; the children both views show must not be torn down in between.
  it('keeps the children both views show mounted while the new view loads', async () => {
    const view = mount({childBacked: false, workspace: 'all'})
    const note = await outlineSettled()
    view.rerender(outline({childBacked: true, workspace: 'all'}))
    await waitFor(() => expect(shownRows().length).toBeGreaterThan(0))
    expect(note.isConnected).toBe(true)
    expect(screen.getByText('a note')).toBe(note)
  })
})

describe('a field row whose definition registers after it renders', () => {
  it('becomes a property row once the definition arrives', async () => {
    const LATE_DEF = 'late-definition'
    await repo.tx(async tx => {
      await tx.create({id: 'late-field', workspaceId: WS, parentId: OWNER, orderKey: 'zz', content: `::((${LATE_DEF}))`})
    }, {scope: ChangeScope.BlockDefault})
    mount({workspace: 'all'})
    await waitFor(() => expect(document.querySelector('[data-block-id="late-field"]')).not.toBeNull())
    expect(document.querySelector('[data-block-id="late-field"][data-property-field-row="true"]')).toBeNull()

    await repo.tx(tx => tx.create({
      id: LATE_DEF, workspaceId: WS, parentId: null, orderKey: 'z0', content: '',
      properties: {types: ['property-schema'], 'property-schema:name': 'rows:late', 'property-schema:preset': 'string'},
    }), {scope: ChangeScope.BlockDefault})
    await waitFor(() => expect(
      document.querySelector('[data-block-id="late-field"][data-property-field-row="true"]'),
    ).not.toBeNull())
  })
})

describe('a field row shown by id, not as a listed child', () => {
  const fieldRowId = async (): Promise<string> => {
    const row = await sharedDb.db.getOptional<{id: string}>(
      `SELECT f.id FROM blocks f WHERE f.parent_id = ? AND f.is_field_form = 1 AND f.deleted = 0
         AND EXISTS (SELECT 1 FROM blocks v WHERE v.parent_id = f.id AND v.content = 'draft' AND v.deleted = 0)`,
      [OWNER])
    return row!.id
  }
  const renderAlone = (id: string, {listing, breadcrumb}: {listing: boolean; breadcrumb: boolean}) => render(
    <RepoContext value={repo}>
      <AppRuntimeContextProvider value={runtime}>
        <ActiveContextsProvider>
          <Suspense fallback={null}>
            <BlockContextProvider initialValue={{panelId: PANEL}}>
              <NestedBlockContextProvider overrides={breadcrumb ? {isNestedSurface: true, isBreadcrumb: true} : {}}>
                <PropertyRowListingContext value={listing}>
                  <BlockComponent blockId={id}/>
                </PropertyRowListingContext>
              </NestedBlockContextProvider>
            </BlockContextProvider>
          </Suspense>
        </ActiveContextsProvider>
      </AppRuntimeContextProvider>
    </RepoContext>,
  )

  // A backlink of the definition, or a block's breadcrumb trail, mounts the
  // row by id — for every user, on every workspace, whatever the mode.
  it.each([
    {where: 'outside any listing (a backlink entry)', listing: false, breadcrumb: false},
    {where: 'as a breadcrumb crumb', listing: true, breadcrumb: true},
  ])('is an ordinary block $where', async ({listing, breadcrumb}) => {
    const id = await fieldRowId()
    renderAlone(id, {listing, breadcrumb})
    await waitFor(() => expect(document.querySelector(`[data-block-id="${id}"]`)).not.toBeNull())
    expect(document.querySelector('[data-property-field-row="true"]')).toBeNull()
    expect(document.querySelector('[data-property-value-row="true"]')).toBeNull()
    expect(screen.queryByDisplayValue('draft')).toBeNull()
  })

  it('is a property row inside a listing that shows them (the positive control)', async () => {
    const id = await fieldRowId()
    renderAlone(id, {listing: true, breadcrumb: false})
    await waitFor(() => expect(document.querySelector('[data-property-field-row="true"]')).not.toBeNull())
    expect(await screen.findByDisplayValue('draft')).toBeTruthy()
  })
})

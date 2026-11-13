// @vitest-environment happy-dom
/**
 * The outline's in-place property rows, driven through the real renderer
 * registry (default renderers + this plugin) on a child-backed workspace: what
 * each display mode shows, where, and that an edit through a row is the
 * panel's write of the panel's value.
 */
import { Suspense, useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, seedProperty, type User } from '@/data/api'
import type { Block } from '@/data/block'
import { definitionSeedsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { propertyDisplayProp, resolvePropertyDisplayMode, type PropertyDisplayMode, type PropertyDisplaySetting } from '@/data/propertyDisplayMode'
import { useHandle } from '@/hooks/block'
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
import { plainOutlinerPlugin } from '@/plugins/plain-outliner'
import { EditorView } from '@codemirror/view'
import { flushEditorContent } from '@/editor/contentFlush'
import { focusBlock, showPropertiesProp, isCollapsedProp } from '@/data/properties'
import { nextVisibleBlock, previousVisibleBlock } from '@/utils/selection'
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

const tagsProp = seedProperty({
  seedKey: 'test/property/rows-tags', revision: 1, name: 'rows:tags',
  preset: 'string-list', defaultValue: [], changeScope: ChangeScope.BlockDefault,
})

const ratingProp = seedProperty({
  seedKey: 'test/property/rows-rating', revision: 1, name: 'rows:rating',
  preset: 'optional-number', defaultValue: undefined, changeScope: ChangeScope.BlockDefault,
})

const sourceProp = seedProperty({
  seedKey: 'test/property/rows-source', revision: 1, name: 'rows:source',
  preset: 'optional-ref', defaultValue: undefined, changeScope: ChangeScope.BlockDefault,
})

let sharedDb: TestDb
let repo: Repo
let runtime: FacetRuntime
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(async () => {
  cleanup()
  // Blur callbacks run on the next frame; fence their writes before the DB reset.
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  await repo.tx(async () => {}, {scope: ChangeScope.UiState})
  committedListings.clear()
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
    plainOutlinerPlugin,
    defaultActionContextConfigs.map(config => actionContextsFacet.of(config, {source: 'test'})),
    [statusProp, secretProp, tagsProp, ratingProp, sourceProp].map(prop => definitionSeedsFacet.of(prop, {source: 'test'})),
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

type Scope = {childBacked?: boolean; workspace?: PropertyDisplaySetting; renderScopeId?: string}

const mount = (scope: Scope = {}) => render(outline(scope))

/** Each parent's loaded mode listing as React last COMMITTED it, recorded by a
 *  probe rendered after the outline: once it lacks a row, the outline's own
 *  commit of that list has happened too. */
const committedListings = new Map<string, readonly string[]>()
const ListingProbe = ({parentId, mode}: {parentId: string; mode: PropertyDisplayMode}) => {
  const ids = useHandle(repo.query.childIds({id: parentId, hydrate: true, propertyChildren: mode}), {selector: list => list})
  useEffect(() => { if (ids) committedListings.set(parentId, ids) }, [parentId, ids])
  return null
}

const outline = (scope: Scope) => (
    <RepoContext value={repo}>
      <AppRuntimeContextProvider value={runtime}>
        <ActiveContextsProvider>
          <Suspense fallback={null}>
            <BlockContextProvider initialValue={{panelId: PANEL, renderScopeId: scope.renderScopeId}}>
              <PropertyDisplayScopeContext.Provider value={{
                childBacked: scope.childBacked ?? true,
                workspace: scope.workspace ?? 'inherit',
                panel: 'inherit',
              }}>
                <BlockComponent blockId={OWNER}/>
                {[OWNER, NOTE].map(parentId => (
                  <ListingProbe key={parentId} parentId={parentId} mode={resolvePropertyDisplayMode({
                    childBacked: scope.childBacked ?? true, workspace: scope.workspace ?? 'inherit', panel: 'inherit', block: 'inherit',
                  })}/>
                ))}
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
    const row = [...document.querySelectorAll('[data-property-definition-link="true"]')]
      .find(link => link.textContent === 'rows:status')!
    expect(note.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(await screen.findByDisplayValue('draft')).toBeTruthy()
  })

  it('shows hidden-tier rows too in show-all, in the structural order', async () => {
    mount({workspace: 'all'})
    const expected = await structuralFieldRowNames()
    expect([...expected].sort()).toEqual(['rows:secret', 'rows:status'])
    await waitFor(() => expect(shownRows()).toEqual(expected))
    expect(await screen.findByDisplayValue('shh')).toBeTruthy()
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
  it('keeps the children both views show mounted across show-non-hidden → show-all', async () => {
    const view = mount({workspace: 'non-hidden'})
    await waitFor(() => expect(shownRows()).toEqual(['rows:status']))
    const note = await outlineSettled()
    view.rerender(outline({workspace: 'all'}))
    await waitFor(() => expect(shownRows()).toHaveLength(2))
    expect(note.isConnected).toBe(true)
    expect(screen.getByText('a note')).toBe(note)
  })

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
  const renderAlone = (id: string, {listing, breadcrumb}: {listing: string | null; breadcrumb: boolean}) => render(
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
    {where: 'outside any listing', listing: null, breadcrumb: false},
    // A backlink entry root inside an outline listing that shows rows: the
    // listing is some other block's, so this is not one of its rows.
    {where: 'inside another block\'s listing (a backlink entry)', listing: 'some-other-block', breadcrumb: false},
    {where: 'as a breadcrumb crumb', listing: OWNER, breadcrumb: true},
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
    renderAlone(id, {listing: OWNER, breadcrumb: false})
    await waitFor(() => expect(document.querySelector('[data-property-field-row="true"]')).not.toBeNull())
    expect(await screen.findByDisplayValue('draft')).toBeTruthy()
  })
})

describe('a list property', () => {
  // One value child per MEMBER: no editor edits one member, and binding each
  // to the whole list's editor would show the list once per member.
  it('shows each member as its own block, with no value editor', async () => {
    await repo.block(OWNER).set(tagsProp, ['alpha', 'beta'])
    mount({workspace: 'non-hidden'})
    await waitFor(() => expect(shownRows()).toContain('rows:tags'))
    await screen.findByText('alpha')
    await screen.findByText('beta')
    expect(document.querySelector('[data-property-value-row="true"][data-property-name="rows:tags"]')).toBeNull()
    // The scalar beside it still gets its editor (the positive control).
    expect(await screen.findByDisplayValue('draft')).toBeTruthy()
  })
})

describe('a read-only workspace', () => {
  it('still shows a reference value as the referenced block, not its id', async () => {
    await repo.tx(tx => tx.create({id: 'cited', workspaceId: WS, parentId: null, orderKey: 'a5', content: 'the cited block'}),
      {scope: ChangeScope.BlockDefault})
    await repo.block(OWNER).set(sourceProp, 'cited')
    repo.setReadOnly(true)
    mount({workspace: 'non-hidden'})
    await waitFor(() => expect(shownRows()).toContain('rows:source'))
    const cell = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-property-value-row="true"][data-property-name="rows:source"]')
      expect(found?.textContent).toContain('the cited block')
      return found!
    })
    expect(cell.textContent).not.toContain('"cited"')
  })

  it('shows values without editors', async () => {
    repo.setReadOnly(true)
    mount({workspace: 'non-hidden'})
    await waitFor(() => expect(shownRows()).toEqual(['rows:status']))
    await screen.findByText('"draft"')
    expect(screen.queryByDisplayValue('draft')).toBeNull()
  })
})

describe('a field row\'s own properties', () => {
  // A field row is a block like any other: toggling its property panel shows it.
  it('shows the field row\'s property panel when it is toggled on', async () => {
    mount({workspace: 'non-hidden'})
    await waitFor(() => expect(shownRows()).toEqual(['rows:status']))
    const row = document.querySelector<HTMLElement>('[data-property-field-row="true"]')!
    expect(row.querySelector('.tm-property-fields')).toBeNull()
    await act(async () => { await repo.block(row.dataset.blockId!).set(showPropertiesProp, true) })
    await waitFor(() => expect(row.querySelector('.tm-property-fields')).not.toBeNull())
  })
})

describe('a scalar whose first value child its codec cannot read', () => {
  // The cell reads the first child that decodes, and a write lands on that same
  // child, so its editor sits there and an edit leaves the unreadable row alone.
  it('edits the value the cell reads, leaving the unreadable row\'s text alone', async () => {
    await repo.block(OWNER).set(ratingProp, 5)
    const fieldRow = await sharedDb.db.getOptional<{id: string}>(
      `SELECT f.id FROM blocks f WHERE f.parent_id = ? AND f.is_field_form = 1 AND f.deleted = 0
         AND EXISTS (SELECT 1 FROM blocks v WHERE v.parent_id = f.id AND v.content = '5' AND v.deleted = 0)`,
      [OWNER])
    await sharedDb.db.writeTransaction(async tx => {
      await tx.execute(
        `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json, deleted,
           created_at, updated_at, created_by, updated_by)
         VALUES ('unreadable', ?, ?, 'A0', 'call Bob about this', '{}', 0, 1, 1, ?, ?)`,
        [WS, fieldRow!.id, USER.id, USER.id])
    })
    expect(repo.block(OWNER).peekProperty(ratingProp)).toBe(5)

    mount({workspace: 'non-hidden'})
    await waitFor(() => expect(shownRows()).toContain('rows:rating'))
    await screen.findByText('call Bob about this')
    await waitFor(() => expect(document.querySelector('[data-block-id="unreadable"]')).not.toBeNull())
    const input = await screen.findByDisplayValue('5') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, {target: {value: '7'}})
      fireEvent.blur(input)
    })
    await waitFor(() => expect(repo.block(OWNER).peekProperty(ratingProp)).toBe(7))
    const unreadable = await sharedDb.db.get<{content: string}>("SELECT content FROM blocks WHERE id = 'unreadable'")
    expect(unreadable.content).toBe('call Bob about this')
  })
})

describe('a definition renamed while its row is shown', () => {
  it('relabels the row', async () => {
    const DEF = 'renamed-definition'
    const bag = (name: string) => ({types: ['property-schema'], 'property-schema:name': name, 'property-schema:preset': 'string'})
    await repo.tx(async tx => {
      await tx.create({id: DEF, workspaceId: WS, parentId: null, orderKey: 'z0', content: '', properties: bag('rows:before')})
      await tx.create({id: 'renamed-field', workspaceId: WS, parentId: OWNER, orderKey: 'zz', content: `::((${DEF}))`})
    }, {scope: ChangeScope.BlockDefault})
    mount({workspace: 'all'})
    await waitFor(() => expect(shownRows()).toContain('rows:before'))

    await repo.tx(tx => tx.update(DEF, {properties: bag('rows:after')}), {scope: ChangeScope.BlockDefault})
    await waitFor(() => expect(shownRows()).toContain('rows:after'))
    expect(shownRows()).not.toContain('rows:before')
  })
})

describe('a child the user turns into a field row', () => {
  // Typing `::((id))` into a child makes it a field row in the same write that
  // commits the text, and a mode that hides that row's tier would unmount it
  // under the user's caret.
  const TYPED = 'typed'
  const typedRow = () => document.querySelector<HTMLElement>(`[data-block-id="${TYPED}"]`)
  const typedEditor = () => typedRow()?.querySelector<HTMLElement>('.cm-editor') ?? null
  const listedUnder = () => typedRow()?.parentElement?.closest('[data-block-id]')?.getAttribute('data-block-id')
  const definition = (name: string, flags: Record<string, unknown> = {}) =>
    ({types: ['property-schema'], 'property-schema:name': name, 'property-schema:preset': 'string', ...flags})

  /** happy-dom fires selectionchange synchronously from the DOM selection
   *  CodeMirror writes mid-update, which re-enters that update. */
  const swallowSelectionChange = (event: Event) => event.stopImmediatePropagation()
  beforeEach(async () => {
    window.addEventListener('selectionchange', swallowSelectionChange, true)
    await repo.tx(async tx => {
      await tx.create({id: 'def-plain', workspaceId: WS, parentId: null, orderKey: 'z0', content: '',
        properties: definition('rows:plain')})
      await tx.create({id: 'def-hidden', workspaceId: WS, parentId: null, orderKey: 'z1', content: '',
        properties: definition('rows:hid', {'property-schema:hidden': true})})
      await tx.create({id: 'def-outline-skip', workspaceId: WS, parentId: null, orderKey: 'z2', content: '',
        properties: definition('rows:skip', {'property-schema:hide-in-outline': true})})
      // Between two siblings, so its position is neither "first" nor "appended".
      await tx.create({id: 'first', workspaceId: WS, parentId: OWNER, orderKey: 'A', content: 'first'})
      await tx.create({id: TYPED, workspaceId: WS, parentId: OWNER, orderKey: 'Z', content: ''})
    }, {scope: ChangeScope.BlockDefault})
  })
  afterEach(() => { window.removeEventListener('selectionchange', swallowSelectionChange, true) })

  /** Edit the child in place and commit `text`, as the editor does. */
  const typeIntoChild = (workspace: PropertyDisplaySetting, text: string) => typeIntoChildOf(OWNER, workspace, text)
  const typeIntoChildOf = async (parentId: string, workspace: PropertyDisplaySetting, text: string) => {
    await focusBlock(repo.block(PANEL), TYPED, {edit: true})
    mount({workspace})
    await waitFor(() => expect(typedEditor()).not.toBeNull())
    const view = EditorView.findFromDOM(typedEditor()!)!
    act(() => {
      view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: text}, selection: {anchor: text.length}})
      flushEditorContent(view)
    })
    await waitFor(async () => expect((await repo.load(TYPED))?.isFieldForm).toBe(true))
    // The mode's listing without the row is committed, so an unmount would
    // have happened by now.
    await waitFor(() => {
      expect(committedListings.get(parentId)).toBeDefined()
      expect(committedListings.get(parentId)).not.toContain(TYPED)
    })
    expect((await repo.load(TYPED))?.content).toBe(text)
  }

  const precedesTheNote = (row: HTMLElement) =>
    Boolean(row.compareDocumentPosition(screen.getByText('a note')) & Node.DOCUMENT_POSITION_FOLLOWING)
  const followsTheFirst = (row: HTMLElement) =>
    Boolean(screen.getByText('first').compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING)

  // The editor itself remounts as the row's renderer changes; the caret comes
  // back from the stored selection, which this harness does not write.
  it('keeps the row editable, with its text, while the user is on it, where the mode hides every property row', async () => {
    await typeIntoChild('none', '::((def-plain))')
    await outlineSettled()
    expect(typedRow()).not.toBeNull()
    expect(typedRow()!.querySelector('.cm-content')?.textContent).toBe('::((def-plain))')
    expect(followsTheFirst(typedRow()!)).toBe(true)
    expect(precedesTheNote(typedRow()!)).toBe(true)
  })

  it.each([
    {tier: 'hidden', id: 'def-hidden', name: 'rows:hid'},
    {tier: 'hidden in the outline', id: 'def-outline-skip', name: 'rows:skip'},
  ])('keeps the row while the user is on it, where the mode hides a $tier definition', async ({id, name}) => {
    await typeIntoChild('non-hidden', `::((${id}))`)
    await waitFor(() => expect(shownRows()).toEqual([name, 'rows:status']))
    expect(followsTheFirst(typedRow()!)).toBe(true)
    expect(precedesTheNote(typedRow()!)).toBe(true)
  })

  it('picking an existing collapsed field expands it and focuses its value editor', async () => {
    const ownerChildren = await repo.query.children({id: OWNER, propertyChildren: 'all'}).load()
    const field = ownerChildren.find(row => {
      if (!row.isFieldForm || !row.referenceTargetId) return false
      const resolution = repo.propertySchemaResolverFor(WS).resolveField(row.referenceTargetId)
      return resolution.status === 'resolved' && resolution.schema.name === statusProp.name
    })!
    expect(field).toBeDefined()
    const [value] = await repo.query.children({id: field.id, propertyChildren: 'all'}).load()
    await repo.block(field.id).set(isCollapsedProp, true)
    await focusBlock(repo.block(PANEL), TYPED, {edit: true})
    mount({workspace: 'non-hidden'})
    await waitFor(() => expect(typedEditor()).not.toBeNull())
    expect(document.querySelector(`[data-block-id="${value.id}"]`)).toBeNull()
    const view = EditorView.findFromDOM(typedEditor()!)!
    act(() => {
      view.dispatch({changes: {from: 0, insert: ':'}, selection: {anchor: 1}})
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {key: ':', bubbles: true, cancelable: true}))
    })
    const input = await screen.findByPlaceholderText('Property name')
    fireEvent.change(input, {target: {value: statusProp.name}})
    fireEvent.keyDown(input, {key: 'Enter'})
    await waitFor(() => expect(document.querySelector(`[data-block-id="${value.id}"] .cm-content`)).not.toBeNull())
    expect(repo.block(field.id).peekProperty(isCollapsedProp)).toBe(false)
    expect(repo.block(TYPED).peek()?.content).toBe('::')
  })

  it('keeps a hidden field row mounted while the caret edits its value child', async () => {
    await typeIntoChild('none', '::((def-plain))')
    await act(async () => {
      await repo.tx(tx => tx.create({id: 'typed-value', workspaceId: WS, parentId: TYPED,
        orderKey: 'a0', content: ''}), {scope: ChangeScope.BlockDefault})
    })
    await act(async () => { await focusBlock(repo.block(PANEL), 'typed-value', {edit: true}) })
    await waitFor(() => expect(document.querySelector('[data-block-id="typed-value"] .cm-editor')).not.toBeNull())
    expect(typedRow()).not.toBeNull()
    expect(typedRow()?.querySelector('[data-property-definition-link]')?.textContent).toBe('rows:plain')
    await act(async () => {
      await repo.tx(tx => tx.move(TYPED, {parentId: NOTE, orderKey: 'a1'}), {scope: ChangeScope.BlockDefault})
    })
    await waitFor(() => expect(listedUnder()).toBe(NOTE))
    expect(document.querySelector('[data-block-id="typed-value"] .cm-editor')).not.toBeNull()
    await act(async () => { await focusBlock(repo.block(PANEL), NOTE, {edit: true}) })
    await waitFor(() => expect(typedRow()).toBeNull())
  })

  it('lets the mode hide the row once the user moves on', async () => {
    await typeIntoChild('none', '::((def-plain))')
    await outlineSettled()
    expect(typedRow()).not.toBeNull()
    await act(async () => { await focusBlock(repo.block(PANEL), NOTE, {edit: true}) })
    await waitFor(() => expect(typedRow()).toBeNull())
    // A focused child the mode shows anyway is listed once, not twice.
    expect(document.querySelectorAll(`[data-block-id="${NOTE}"]`)).toHaveLength(1)
  })

  it('follows the row into the parent it is indented under', async () => {
    await typeIntoChild('none', '::((def-plain))')
    await outlineSettled()
    expect(listedUnder()).toBe(OWNER)
    // Indenting moves it with focus unchanged, and the owner's own view of its
    // children does not change.
    await act(async () => {
      await repo.tx(tx => tx.move(TYPED, {parentId: NOTE, orderKey: 'a0'}), {scope: ChangeScope.BlockDefault})
    })
    await waitFor(() => expect(listedUnder()).toBe(NOTE))
  })

  it('keeps the row only in the render scope the focus is in', async () => {
    await repo.tx(tx => tx.update(TYPED, {content: '::((def-plain))'}), {scope: ChangeScope.BlockDefault})
    await focusBlock(repo.block(PANEL), TYPED, {renderScopeId: 'outline:elsewhere'})
    mount({workspace: 'none', renderScopeId: 'outline:here'})
    await outlineSettled()
    expect(typedRow()).toBeNull()
    await act(async () => { await focusBlock(repo.block(PANEL), TYPED, {renderScopeId: 'outline:here'}) })
    await waitFor(() => expect(typedRow()).not.toBeNull())
  })

  it('follows the row into the parent it is outdented to', async () => {
    await repo.tx(tx => tx.move(TYPED, {parentId: NOTE, orderKey: 'a0'}), {scope: ChangeScope.BlockDefault})
    await typeIntoChildOf(NOTE, 'none', '::((def-plain))')
    expect(listedUnder()).toBe(NOTE)
    await act(async () => {
      await repo.tx(tx => tx.move(TYPED, {parentId: OWNER, orderKey: 'a1'}), {scope: ChangeScope.BlockDefault})
    })
    await waitFor(() => expect(listedUnder()).toBe(OWNER))
    expect(Boolean(screen.getByText('a note').compareDocumentPosition(typedRow()!) & Node.DOCUMENT_POSITION_FOLLOWING))
      .toBe(true)
  })

  it('follows the row to its new place among its siblings', async () => {
    await typeIntoChild('none', '::((def-plain))')
    await outlineSettled()
    expect(precedesTheNote(typedRow()!)).toBe(true)
    await act(async () => {
      await repo.tx(tx => tx.move(TYPED, {parentId: OWNER, orderKey: 'a1'}), {scope: ChangeScope.BlockDefault})
    })
    await waitFor(() => expect(precedesTheNote(typedRow()!)).toBe(false))
  })

  it('re-places the row when a sibling moves across it', async () => {
    await typeIntoChild('none', '::((def-plain))')
    await outlineSettled()
    expect(precedesTheNote(typedRow()!)).toBe(true)
    // The note moves from after the row to before it; the mode's own list
    // (first, note) keeps its order.
    await act(async () => {
      await repo.tx(tx => tx.move(NOTE, {parentId: OWNER, orderKey: 'B'}), {scope: ChangeScope.BlockDefault})
    })
    await waitFor(() => expect(precedesTheNote(typedRow()!)).toBe(false))
    expect(followsTheFirst(typedRow()!)).toBe(true)
  })
})

describe('moving the caret off a row the listing leaves out', () => {
  // The focused row a display mode hides is on screen between its siblings,
  // so the walkers the arrow keys and merges use must place it there too.
  beforeEach(async () => {
    await repo.tx(async tx => {
      await tx.create({id: 'def-nav', workspaceId: WS, parentId: null, orderKey: 'z0', content: '',
        properties: {types: ['property-schema'], 'property-schema:name': 'rows:nav', 'property-schema:preset': 'string'}})
      await tx.create({id: 'nav-row', workspaceId: WS, parentId: OWNER, orderKey: 'a0V', content: '::((def-nav))'})
      await tx.create({id: 'after', workspaceId: WS, parentId: OWNER, orderKey: 'a1', content: 'after'})
    }, {scope: ChangeScope.BlockDefault})
    await waitFor(async () => expect(await repo.block(OWNER).childIds.load()).toEqual([NOTE, 'after']))
  })

  it('steps back to the sibling before it', async () => {
    expect((await previousVisibleBlock(repo.block('nav-row'), OWNER))?.id).toBe(NOTE)
  })

  it('steps on to the sibling after it', async () => {
    expect((await nextVisibleBlock(repo.block('nav-row'), OWNER))?.id).toBe('after')
  })
})

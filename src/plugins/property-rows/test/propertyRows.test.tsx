// @vitest-environment jsdom
/**
 * The outline's in-place property rows, driven through the real renderer
 * registry (default renderers + this plugin) on a child-backed workspace: what
 * each display mode shows, where, and how edits project back to properties.
 */
import { Suspense, useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, codecs, definePresetCore, definePropertyEditorOverride, seedProperty, type PropertyEditorProps, type User } from '@/data/api'
import { Block } from '@/data/block'
import { materializePropertySeeds } from '@/data/definitionSeeds'
import { definitionSeedsFacet, propertyEditorOverridesFacet, valuePresetCoresFacet, valuePresetPresentationsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { valueChildContentToEncoded } from '@/data/propertyChildren'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo, childIdsOf } from '@/data/test/createTestRepo'
import { propertyDisplayProp, resolvePropertyDisplayMode, type PropertyDisplayMode, type PropertyDisplaySetting } from '@/data/propertyDisplayMode'
import { useHandle } from '@/hooks/block'
import { resolveFacetRuntimeSync, type AppExtension, type FacetRuntime } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { actionContextsFacet, blockRenderersFacet } from '@/extensions/core'
import { defaultRenderersExtension } from '@/extensions/defaultRenderers'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler'
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
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer'
import { referencesPlugin } from '@/plugins/references'
import { plainOutlinerPlugin } from '@/plugins/plain-outliner'
import { vimNormalModeInteractionExtension } from '@/plugins/vim-normal-mode'
import { vimNormalModeActionsExtension } from '@/plugins/vim-normal-mode/actions'
import { EditorView } from '@codemirror/view'
import { flushEditorContent } from '@/editor/contentFlush'
import { defaultEditorInteractionExtension } from '@/editor/defaultInteractions'
import {
  focusBlock,
  isCollapsedProp,
  isEditingProp,
  peekFocusedBlockLocation,
  showPropertiesProp,
} from '@/data/properties'
import { nextVisibleBlock, previousVisibleBlock } from '@/utils/selection'
import { outlineSurfaceOf } from '@/data/outlineSurface'
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

const readyProp = seedProperty({
  seedKey: 'test/property/rows-ready', revision: 1, name: 'rows:ready',
  preset: 'boolean', changeScope: ChangeScope.BlockDefault,
})

const rowSeeds = [statusProp, secretProp, tagsProp, ratingProp, sourceProp, readyProp]

let sharedDb: TestDb
let repo: Repo
let runtime: FacetRuntime
beforeAll(async () => {
  // CodeMirror measures its cursor during real click-to-edit and keyboard entry.
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {configurable: true, value: vi.fn()})
  Object.assign(Range.prototype, {
    getClientRects: () => [],
    getBoundingClientRect: () => new DOMRect(),
  })
  sharedDb = await createTestDb()
})
afterAll(async () => { await sharedDb.cleanup() })
afterEach(() => {
  cleanup()
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
  runtime = resolveFacetRuntimeSync(testExtensions())
  repo.setFacetRuntime(runtime)
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: PANEL, workspaceId: WS, parentId: null, orderKey: 'a0', content: ''})
    await tx.create({id: OWNER, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'owner'})
    await tx.create({id: NOTE, workspaceId: WS, parentId: OWNER, orderKey: 'a0', content: 'a note'})
  }, {scope: ChangeScope.BlockDefault})
  // The outline follows real reference targets, so give code-defined fields
  // their backing schema blocks before rendering them.
  await materializePropertySeeds(repo, WS, [...rowSeeds, propertyDisplayProp])
  await waitFor(() => expect(repo.propertySchemas.has(statusProp.name)).toBe(true))
  const owner = repo.block(OWNER)
  await owner.set(statusProp, 'draft')
  await owner.set(secretProp, 'shh')
})

const testExtensions = (): AppExtension[] => [
  kernelDataExtension,
  kernelPropertyUiExtension,
  kernelValuePresetsExtension,
  defaultRenderersExtension,
  defaultEditorInteractionExtension,
  propertyRowsPlugin,
  referencesPlugin,
  plainOutlinerPlugin,
  defaultActionContextConfigs.map(config => actionContextsFacet.of(config, {source: 'test'})),
  rowSeeds.map(prop => definitionSeedsFacet.of(prop, {source: 'test'})),
]

const addExtensions = (...extensions: AppExtension[]) => {
  runtime = resolveFacetRuntimeSync([...testExtensions(), ...extensions])
  repo.setFacetRuntime(runtime)
}

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
          <HotkeyReconciler/>
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

/** The block id of the one property row on screen. */
const shownRowId = (): string | undefined =>
  document.querySelector<HTMLElement>('[data-property-field-row="true"]')
    ?.closest<HTMLElement>('[data-block-id]')?.dataset.blockId

/** Waits until the owner's ordinary child is on screen, so an empty
 *  `shownRows()` means "rendered without rows", never "not rendered yet". */
const outlineSettled = () => screen.findByText('a note')

const blockRow = (element: HTMLElement): HTMLElement => element.closest('[data-block-shell]')!

const fieldRow = async (name: string) => {
  const rows = await repo.query.children({id: OWNER, propertyChildren: 'all'}).load()
  const match = rows.find(row => {
    if (!row.isFieldForm || !row.referenceTargetId) return false
    const resolution = repo.propertySchemaResolverFor(WS).resolveField(row.referenceTargetId)
    return resolution.status === 'resolved' && resolution.schema.name === name
  })
  expect(match).toBeDefined()
  return match!
}

const insertSyncedValue = async (id: string, fieldId: string, orderKey: string, content: string) =>
  sharedDb.db.writeTransaction(async tx => {
    await tx.execute(
      `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json, deleted,
         created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, '{}', 0, 1, 1, ?, ?)`,
      [id, WS, fieldId, orderKey, content, USER.id, USER.id])
  })

const editorFor = (id: string) => waitFor(() => {
  const dom = document.querySelector<HTMLElement>(`[data-block-shell][data-block-id="${id}"] .cm-editor`)
  expect(dom).not.toBeNull()
  return EditorView.findFromDOM(dom!)!
})

const writeInEditor = (view: EditorView, text: string) => {
  act(() => {
    view.dispatch({changes: {from: 0, to: view.state.doc.length, insert: text}, selection: {anchor: text.length}})
    flushEditorContent(view)
  })
}

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
    expect(await screen.findByText('draft')).toBeTruthy()
  })

  it('shows hidden-tier rows too in show-all, in the structural order', async () => {
    mount({workspace: 'all'})
    const expected = await structuralFieldRowNames()
    expect([...expected].sort()).toEqual(['rows:secret', 'rows:status'])
    await waitFor(() => expect(shownRows()).toEqual(expected))
    expect(await screen.findByText('shh')).toBeTruthy()
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

describe('ordinary property value content', () => {
  it('renders string Markdown without a panel input', async () => {
    await repo.block(OWNER).set(statusProp, '**draft**')
    mount({workspace: 'non-hidden'})
    const text = await screen.findByText('draft', {selector: 'strong'})
    expect(text.closest('.block-content')?.querySelector('input')).toBeNull()
    expect(screen.queryByDisplayValue('**draft**')).toBeNull()
  })

  it('retains custom type renderers in both columns of a property row', async () => {
    await repo.block(OWNER).set(readyProp, true)
    const field = await fieldRow(readyProp.name)
    const [value] = await repo.query.children({id: field.id, propertyChildren: 'all'}).load()
    await repo.tx(async tx => {
      await tx.update(field.id, {properties: {...field.properties, types: ['test:custom']}})
      await tx.update(value.id, {properties: {...value.properties, types: ['test:custom']}})
    }, {scope: ChangeScope.BlockDefault})
    const TypedContent = ({block}: {block: Block}) => (
      <span>{block.id === field.id ? 'custom field content' : 'custom value content'}</span>
    )
    const Renderer = Object.assign((props: {block: Block}) => <DefaultBlockRenderer {...props} ContentRenderer={TypedContent}/>, {
      canRender: ({block}: {block: Block}) => {
        const types = block.peek()?.properties.types
        return Array.isArray(types) && types.includes('test:custom')
      },
      priority: () => 10,
    })
    addExtensions(blockRenderersFacet.of({id: 'test:custom', renderer: Renderer}))
    mount({workspace: 'non-hidden'})
    const renderedField = await screen.findByText('custom field content')
    const renderedValue = await screen.findByText('custom value content')
    expect(renderedField.closest('[data-property-name-cell]')).not.toBeNull()
    expect(renderedValue.closest('[data-property-value-cell]')).not.toBeNull()
    expect(renderedValue.closest('[data-property-field-row]')).toBe(blockRow(renderedField))
    expect(within(blockRow(renderedValue)).queryByRole('checkbox')).toBeNull()
  })
})

describe('editing through a property row', () => {
  it.each(['click', 'keyboard'])('opens the same block editor by %s and projects its edit to the property', async entry => {
    if (entry === 'keyboard') {
      addExtensions(vimNormalModeInteractionExtension, vimNormalModeActionsExtension({repo}))
    }
    mount({workspace: 'non-hidden'})
    const text = await screen.findByText('draft')
    const row = blockRow(text)
    const valueId = row.dataset.blockId!
    const panel = repo.block(PANEL)

    if (entry === 'click') {
      fireEvent.click(text, {detail: 1})
    } else {
      await act(() => focusBlock(panel, valueId))
      fireEvent.keyDown(row, {key: 'i', code: 'KeyI'})
    }
    const editor = await editorFor(valueId)
    expect(peekFocusedBlockLocation(panel)?.blockId).toBe(valueId)
    expect(editor.state.doc.toString()).toBe('draft')

    writeInEditor(editor, '**final**')
    await waitFor(() => expect(repo.block(OWNER).peekProperty(statusProp)).toBe('**final**'))
    expect((await repo.load(valueId))?.content).toBe('**final**')
    await act(() => focusBlock(panel, NOTE))
    expect(blockRow(await screen.findByText('final', {selector: 'strong'}))).toBe(row)
  })

  it('offers a checkbox for a boolean while leaving its raw block editable', async () => {
    const owner = repo.block(OWNER)
    await owner.set(readyProp, true)
    mount({workspace: 'non-hidden'})
    const checkbox = await screen.findByRole('checkbox', {name: 'Toggle rows:ready'})
    expect(checkbox).toBeChecked()
    const id = blockRow(checkbox).dataset.blockId!

    fireEvent.click(checkbox)
    await waitFor(() => expect(owner.peekProperty(readyProp)).toBe(false))
    expect((await repo.load(id))?.content).toBe('false')

    await act(() => focusBlock(repo.block(PANEL), id, {edit: true}))
    const editor = await editorFor(id)
    expect(editor.state.doc.toString()).toBe('false')
    expect(screen.queryByRole('checkbox', {name: 'Toggle rows:ready'})).toBeNull()
  })

  it('uses a complex preset’s opt-in editor with the value block as its subject', async () => {
    const presetId = 'rows:dimensions'
    const core = definePresetCore<{width: number}>({
      id: presetId,
      build: () => ({...codecs.unsafeIdentity<{width: number}>(), type: presetId}),
      defaultValue: {width: 0},
    })
    const dimensions = seedProperty({
      seedKey: 'test/property/rows-dimensions', revision: 1, name: 'rows:dimensions',
      preset: core, changeScope: ChangeScope.BlockDefault,
    })
    const InlineEditor = ({block, value, onChange}: PropertyEditorProps<{width: number}>) => (
      <button type="button" data-editor-subject={block instanceof Block ? block.id : undefined}
        onClick={() => onChange({width: value.width + 1})}>
        Width {value.width}
      </button>
    )
    addExtensions(valuePresetCoresFacet.of(core), definitionSeedsFacet.of(dimensions), valuePresetPresentationsFacet.of({
      id: presetId, label: 'Dimensions', hideFromPicker: true, InlineEditor,
    }))
    await materializePropertySeeds(repo, WS, [dimensions])
    await waitFor(() => expect(repo.propertySchemas.has(dimensions.name)).toBe(true))
    const owner = repo.block(OWNER)
    await owner.set(dimensions, {width: 4})
    mount({workspace: 'non-hidden'})
    const button = await screen.findByRole('button', {name: 'Width 4'})
    const valueId = blockRow(button).dataset.blockId!
    expect(button).toHaveAttribute('data-editor-subject', valueId)
    fireEvent.click(button)
    expect(await screen.findByRole('button', {name: 'Width 5'})).toBe(button)
    expect((await repo.load(valueId))?.content).toBe('{"width":5}')
    expect(owner.peekProperty(dimensions)).toEqual({width: 5})
  })

  it('keeps an unresolved field-form child out of the scalar inline editor', async () => {
    const InlineEditor = ({value}: PropertyEditorProps<string>) => <button type="button">Edit {value}</button>
    addExtensions(propertyEditorOverridesFacet.of(definePropertyEditorOverride(statusProp, {InlineEditor})))
    const field = await fieldRow(statusProp.name)
    const id = 'unresolved-field'
    const content = '::((missing-schema))'
    await repo.tx(tx => tx.create({id, workspaceId: WS, parentId: field.id, orderKey: 'z9', content}),
      {scope: ChangeScope.BlockDefault})
    expect((await repo.load(id))?.isFieldForm).toBe(true)
    expect(statusProp.codec.decode(valueChildContentToEncoded(statusProp, content))).toBe(content)

    mount({workspace: 'non-hidden'})
    expect(await screen.findByRole('button', {name: 'Edit draft'})).toBeEnabled()
    expect(blockRow(await screen.findByText(content))).toHaveAttribute('data-block-id', id)
    expect(screen.queryByRole('button', {name: `Edit ${content}`})).toBeNull()
  })
})

describe('a scalar whose value children disagree', () => {
  // Concurrent offline edits can leave two value children under one scalar's
  // field row; the data layer keeps both. Written raw, so no processor folds
  // the second into the owner's cell before the render.
  it('shows each text sibling’s own content', async () => {
    const field = await fieldRow(statusProp.name)
    await insertSyncedValue('stray', field.id, 'z9', 'final')
    expect(repo.block(OWNER).peekProperty(statusProp)).toBe('draft')

    mount({workspace: 'non-hidden'})
    expect(blockRow(await screen.findByText('draft'))).not.toHaveAttribute('data-block-id', 'stray')
    expect(blockRow(await screen.findByText('final'))).toHaveAttribute('data-block-id', 'stray')
  })

  it('binds each boolean checkbox to its own value block', async () => {
    const owner = repo.block(OWNER)
    await owner.set(readyProp, true)
    const field = await fieldRow(readyProp.name)
    const [primaryId] = await repo.query.childIds({id: field.id, propertyChildren: 'all'}).load()
    const siblingId = 'synced-value'
    await insertSyncedValue(siblingId, field.id, 'z9', 'false')
    expect(owner.peekProperty(readyProp)).toBe(true)

    mount({workspace: 'non-hidden'})
    const primary = await screen.findByRole('checkbox', {name: 'Toggle rows:ready', checked: true})
    const sibling = await screen.findByRole('checkbox', {name: 'Toggle rows:ready', checked: false})
    expect(blockRow(primary)).toHaveAttribute('data-block-id', primaryId)
    expect(blockRow(sibling)).toHaveAttribute('data-block-id', siblingId)

    fireEvent.click(sibling)
    await waitFor(() => expect(sibling).toBeChecked())
    expect((await repo.load(siblingId))?.content).toBe('true')
    expect((await repo.load(primaryId))?.content).toBe('true')
    expect(owner.peekProperty(readyProp)).toBe(true)

    fireEvent.click(primary)
    await waitFor(() => expect(owner.peekProperty(readyProp)).toBe(false))
    expect((await repo.load(primaryId))?.content).toBe('false')
    expect((await repo.load(siblingId))?.content).toBe('true')
    expect(sibling).toBeChecked()
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
    const LATE_DEF = '22222222-2222-4222-8222-222222222222'
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
    expect(await screen.findByRole('link', {name: 'rows:late'})).toBeTruthy()
  })
})

describe('a field row shown by id, not as a listed child', () => {
  beforeEach(async () => { await repo.block(OWNER).set(readyProp, true) })

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
    const {id} = await fieldRow(readyProp.name)
    renderAlone(id, {listing, breadcrumb})
    await waitFor(() => expect(document.querySelector(`[data-block-id="${id}"]`)).not.toBeNull())
    expect(document.querySelector('[data-property-field-row="true"]')).toBeNull()
    expect(document.querySelector('[data-property-value-row="true"]')).toBeNull()
    expect(await screen.findByText('true')).toBeTruthy()
    expect(screen.queryByRole('checkbox', {name: 'Toggle rows:ready'})).toBeNull()
  })

  it('is a property row inside a listing that shows them (the positive control)', async () => {
    const {id} = await fieldRow(readyProp.name)
    renderAlone(id, {listing: OWNER, breadcrumb: false})
    await waitFor(() => expect(document.querySelector('[data-property-field-row="true"]')).not.toBeNull())
    expect(await screen.findByRole('checkbox', {name: 'Toggle rows:ready'})).toBeChecked()
  })
})

describe('a list property', () => {
  // One value child per MEMBER: no editor edits one member, and binding each
  // to the whole list's editor would show the list once per member.
  it('shows each member as its own block, with no value editor', async () => {
    await repo.block(OWNER).set(tagsProp, ['alpha', 'beta'])
    await repo.block(OWNER).set(readyProp, true)
    mount({workspace: 'non-hidden'})
    await waitFor(() => expect(shownRows()).toContain('rows:tags'))
    const alpha = blockRow(await screen.findByText('alpha'))
    const beta = blockRow(await screen.findByText('beta'))
    expect(alpha).not.toBe(beta)
    expect(alpha.querySelector('input, textarea')).toBeNull()
    expect(beta.querySelector('input, textarea')).toBeNull()
    // The scalar beside it still gets its editor (the positive control).
    expect(await screen.findByRole('checkbox', {name: 'Toggle rows:ready'})).toBeChecked()
  })

  it('keeps list members ordinary even when the list has an inline editor', async () => {
    const lists = seedProperty({
      seedKey: 'test/property/rows-nested-list', revision: 1, name: 'rows:nested-list',
      preset: 'list', changeScope: ChangeScope.BlockDefault,
    })
    const InlineEditor = () => <button type="button">Edit list</button>
    addExtensions(definitionSeedsFacet.of(lists),
      propertyEditorOverridesFacet.of(definePropertyEditorOverride(lists, {InlineEditor})))
    await materializePropertySeeds(repo, WS, [lists])
    await repo.block(OWNER).set(lists, [['alpha'], ['beta']])
    // Each member can also decode as a whole list, so decode cannot mask the guard.
    expect(lists.codec.decode(valueChildContentToEncoded(lists, '["alpha"]'))).toEqual(['alpha'])

    mount({workspace: 'non-hidden'})
    const alpha = blockRow(await screen.findByText('["alpha"]'))
    const beta = blockRow(await screen.findByText('["beta"]'))
    expect(alpha).not.toBe(beta)
    expect(screen.queryByRole('button', {name: 'Edit list'})).toBeNull()
  })
})

describe('a reference value', () => {
  it.each([false, true])('renders an ordinary reference link (read-only: %s)', async readOnly => {
    const cited = '22222222-2222-4222-8222-222222222222'
    await repo.tx(tx => tx.create({id: cited, workspaceId: WS, parentId: null, orderKey: 'a5', content: 'the cited block'}),
      {scope: ChangeScope.BlockDefault})
    await repo.block(OWNER).set(sourceProp, cited)
    repo.setReadOnly(readOnly)
    mount({workspace: 'non-hidden'})
    await waitFor(() => expect(shownRows()).toContain('rows:source'))
    const link = await screen.findByRole('link', {name: 'the cited block'})
    expect(link).toHaveClass('blockref')
    expect(link).toHaveAttribute('data-block-id', cited)
    const cell = link.closest<HTMLElement>('[data-property-value-cell]')!
    expect(cell.querySelector('.blockembed, input')).toBeNull()
    expect(within(cell).queryByRole('button', {name: 'Remove block reference'})).toBeNull()
  })
})

describe('a read-only workspace', () => {
  it('shows ordinary text and a disabled checkbox', async () => {
    await repo.block(OWNER).set(readyProp, true)
    repo.setReadOnly(true)
    mount({workspace: 'non-hidden'})
    const text = await screen.findByText('draft')
    expect(blockRow(text).querySelector('input, [contenteditable="true"]')).toBeNull()
    expect(await screen.findByRole('checkbox', {name: 'Toggle rows:ready'})).toBeDisabled()
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
  // child. Each editor still edits the block the user is on.
  it('edits the value the cell reads, leaving the unreadable row\'s text alone', async () => {
    await repo.block(OWNER).set(ratingProp, 5)
    const field = await fieldRow(ratingProp.name)
    await insertSyncedValue('unreadable', field.id, 'A0', 'call Bob about this')
    expect(repo.block(OWNER).peekProperty(ratingProp)).toBe(5)

    mount({workspace: 'non-hidden'})
    await waitFor(() => expect(shownRows()).toContain('rows:rating'))
    expect(blockRow(await screen.findByText('call Bob about this'))).toHaveAttribute('data-block-id', 'unreadable')
    const valueId = blockRow(await screen.findByText('5')).dataset.blockId!
    await act(() => focusBlock(repo.block(PANEL), valueId, {edit: true}))
    const editor = await editorFor(valueId)
    expect(editor.state.doc.toString()).toBe('5')
    writeInEditor(editor, '7')
    await waitFor(() => expect(repo.block(OWNER).peekProperty(ratingProp)).toBe(7))
    expect((await repo.load(valueId))?.content).toBe('7')
    const unreadable = await sharedDb.db.get<{content: string}>("SELECT content FROM blocks WHERE id = 'unreadable'")
    expect(unreadable.content).toBe('call Bob about this')
  })
})

describe('a definition renamed while its row is shown', () => {
  it('relabels the row', async () => {
    const DEF = '22222222-2222-4222-8222-222222222222'
    const bag = (name: string) => ({types: ['property-schema'], 'property-schema:name': name, 'property-schema:preset': 'string'})
    await repo.tx(async tx => {
      await tx.create({id: DEF, workspaceId: WS, parentId: null, orderKey: 'z0', content: '', properties: bag('rows:before')})
      await tx.create({id: 'renamed-field', workspaceId: WS, parentId: OWNER, orderKey: 'zz', content: `::((${DEF}))`})
    }, {scope: ChangeScope.BlockDefault})
    mount({workspace: 'all'})
    await waitFor(() => expect(shownRows()).toContain('rows:before'))
    const link = screen.getByRole('link', {name: 'rows:before'})

    await act(() => repo.tx(tx => tx.update(DEF, {properties: bag('rows:after')}), {scope: ChangeScope.BlockDefault}))
    expect(await screen.findByRole('link', {name: 'rows:after'})).toBe(link)
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

  beforeEach(async () => {
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

  /** Edit the child in place and commit `text`, as the editor does. */
  const typeIntoChild = (workspace: PropertyDisplaySetting, text: string) => typeIntoChildOf(OWNER, workspace, text)
  const typeIntoChildOf = async (parentId: string, workspace: PropertyDisplaySetting, text: string) => {
    await focusBlock(repo.block(PANEL), TYPED, {edit: true})
    mount({workspace})
    await waitFor(() => expect(typedEditor()).not.toBeNull())
    const view = EditorView.findFromDOM(typedEditor()!)!
    writeInEditor(view, text)
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
    {tier: 'hidden', id: 'def-hidden'},
    {tier: 'hidden in the outline', id: 'def-outline-skip'},
  ])('keeps the row while the user is on it, where the mode hides a $tier definition', async ({id}) => {
    const rawContent = `::((${id}))`
    await typeIntoChild('non-hidden', rawContent)
    await waitFor(() => expect(typedRow()).not.toBeNull())
    expect(typedEditor()?.querySelector('.cm-content')?.textContent).toBe(rawContent)
    expect(followsTheFirst(typedRow()!)).toBe(true)
    expect(precedesTheNote(typedRow()!)).toBe(true)
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
  const OWNER_SURFACE = outlineSurfaceOf({scopeRootId: OWNER})!
  // The focused row a display mode hides is on screen between its siblings,
  // so the walkers the arrow keys and merges use must place it there too.
  beforeEach(async () => {
    await repo.tx(async tx => {
      await tx.create({id: 'def-nav', workspaceId: WS, parentId: null, orderKey: 'z0', content: '',
        properties: {types: ['property-schema'], 'property-schema:name': 'rows:nav', 'property-schema:preset': 'string'}})
      await tx.create({id: 'nav-row', workspaceId: WS, parentId: OWNER, orderKey: 'a0V', content: '::((def-nav))'})
      await tx.create({id: 'after', workspaceId: WS, parentId: OWNER, orderKey: 'a1', content: 'after'})
    }, {scope: ChangeScope.BlockDefault})
    await waitFor(async () => expect(await childIdsOf(repo, OWNER)).toEqual([NOTE, 'after']))
  })

  it('steps back to the sibling before it', async () => {
    expect((await previousVisibleBlock(repo.block('nav-row'), OWNER_SURFACE))?.id).toBe(NOTE)
  })

  it('steps on to the sibling after it', async () => {
    expect((await nextVisibleBlock(repo.block('nav-row'), OWNER_SURFACE))?.id).toBe('after')
  })
})


describe('a name row asked to edit', () => {
  it('keeps its raw block content editable and preserves its value child', async () => {
    mount({workspace: 'non-hidden'})
    await waitFor(() => expect(shownRows()).toEqual(['rows:status']))
    const statusRow = shownRowId()!
    expect((await repo.load(statusRow))?.isFieldForm).toBe(true)
    const original = (await repo.load(statusRow))!.content
    const childrenBefore = await childIdsOf(repo, statusRow)
    expect(childrenBefore).toHaveLength(1)
    const panel = repo.block(PANEL)

    // The control: an ordinary block asked to edit stays editing.
    await act(async () => { await focusBlock(panel, NOTE, {edit: true}) })
    await waitFor(() => expect(panel.peekProperty(isEditingProp)).toBe(true))

    let editor: HTMLElement | null = null
    await act(async () => { await focusBlock(panel, statusRow, {edit: true}) })
    await waitFor(() => {
      expect(panel.peekProperty(isEditingProp)).toBe(true)
      editor = document.querySelector<HTMLElement>(`[data-block-id="${statusRow}"] .cm-editor`)
      expect(editor).not.toBeNull()
    })
    expect(peekFocusedBlockLocation(panel)?.blockId).toBe(statusRow)
    const view = EditorView.findFromDOM(editor!)!
    expect(view.state.doc.toString()).toBe(original)

    const edited = `${original}!`
    writeInEditor(view, edited)
    await waitFor(async () => expect((await repo.load(statusRow))?.content).toBe(edited))
    expect(await childIdsOf(repo, statusRow)).toEqual(childrenBefore)
  })
})

describe('field row expansion affordance', () => {
  it('only hides the wide-row control for one expanded leaf value', async () => {
    mount({workspace: 'non-hidden'})
    const text = await screen.findByText('draft')
    const row = text.closest('[data-property-field-row="true"]')!
    const fieldId = row.getAttribute('data-block-id')!
    const [valueId] = await repo.query.childIds({id: fieldId, propertyChildren: 'all'}).load()
    await waitFor(() => expect(row.getAttribute('data-expanded-single-leaf')).toBe('true'))
    await act(() => repo.block(fieldId).set(isCollapsedProp, true))
    await waitFor(() => expect(row.getAttribute('data-expanded-single-leaf')).toBe('false'))
    await act(() => repo.block(fieldId).set(isCollapsedProp, false))
    expect(await screen.findByText('draft')).toBeTruthy()
    await waitFor(() => expect(row.getAttribute('data-expanded-single-leaf')).toBe('true'))
    await act(() => repo.tx(tx => tx.create({id: 'nested-note', workspaceId: WS, parentId: valueId, orderKey: 'a0', content: 'nested detail'}), {scope: ChangeScope.BlockDefault}))
    await waitFor(() => expect(row.getAttribute('data-expanded-single-leaf')).toBe('false'))
    expect(await screen.findByText('nested detail')).toBeTruthy()
  })

  it('keeps the control for multiple values, then follows a change to one value', async () => {
    await repo.block(OWNER).set(tagsProp, ['alpha', 'beta'])
    mount({workspace: 'non-hidden'})
    const alpha = await screen.findByText('alpha')
    expect(await screen.findByText('beta')).toBeTruthy()
    const row = alpha.closest('[data-property-field-row="true"]')!
    await waitFor(() => expect(row.getAttribute('data-expanded-single-leaf')).toBe('false'))
    await act(() => repo.block(OWNER).set(tagsProp, ['alpha']))
    await waitFor(() => expect(row.getAttribute('data-expanded-single-leaf')).toBe('true'))
  })
})

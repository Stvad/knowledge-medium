// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { type FacetRuntime } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { RepoContext } from '@/context/repo'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { seedProperty } from '@/data/propertySeeds'
import {
  canonicalPropertySeedProperties,
  propertyDefinitionBlockId,
} from '@/data/definitionSeeds'
import { PropertySchemaContentRenderer } from './PropertySchemaBlockRenderer'

const WS = 'ws-1'

// A code-owned seed (Optional text) materialized into the workspace, and a
// user-created schema (Plain text) for contrast.
const seed = seedProperty({
  seedKey: 'system:test/property/read-only-demo',
  revision: 1,
  name: 'test:readOnlyDemo',
  preset: 'optional-string',
  changeScope: ChangeScope.BlockDefault,
})
const SEED_ID = propertyDefinitionBlockId(WS, seed.seedKey)

// A second seed, on a preset that CONTRIBUTES a ConfigEditor — the surface the
// name field and the type picker do not cover.
const refSeed = seedProperty({
  seedKey: 'system:test/property/ref-config-demo',
  revision: 1,
  name: 'test:refConfigDemo',
  preset: 'ref',
  changeScope: ChangeScope.BlockDefault,
})
const REF_SEED_ID = propertyDefinitionBlockId(WS, refSeed.seedKey)

describe('PropertySchemaContentRenderer read-only for code-owned seeds', () => {
  let sharedDb: TestDb
  let repo: Repo
  let runtime: FacetRuntime

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })

  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    repo = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      extensions: [kernelPropertyUiExtension, kernelValuePresetsExtension],
    }).repo
    runtime = repo.facetRuntime!
    repo.setActiveWorkspaceId(WS)

    await repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Root'})
      // Materialized seed row: id satisfies the deterministic equation, so it
      // parses as a valid seeded (code-owned) definition.
      await tx.create({
        id: SEED_ID,
        workspaceId: WS,
        parentId: 'root',
        orderKey: 'a1',
        content: seed.name,
        properties: canonicalPropertySeedProperties(seed),
      })
      await tx.create({
        id: REF_SEED_ID,
        workspaceId: WS,
        parentId: 'root',
        orderKey: 'a3',
        content: refSeed.name,
        properties: canonicalPropertySeedProperties(refSeed),
      })
      // A user-created schema on the SAME preset, so the config editor's
      // enabled behaviour can be compared against the seed's.
      await tx.create({
        id: 'user-ref-schema',
        workspaceId: WS,
        parentId: 'root',
        orderKey: 'a4',
        content: 'test:myRef',
        properties: {
          types: ['property-schema'],
          'property-schema:name': 'test:myRef',
          'property-schema:preset': 'ref',
          'property-schema:config': {},
        },
      })
      // User-created schema: no seed marker.
      await tx.create({
        id: 'user-schema',
        workspaceId: WS,
        parentId: 'root',
        orderKey: 'a2',
        content: 'test:myProp',
        properties: {
          types: ['property-schema'],
          'property-schema:name': 'test:myProp',
          'property-schema:preset': 'string',
          'property-schema:config': {},
        },
      })
      // Automation scope: the fixture authors a provenance-valid seed row,
      // which the tx-layer forge guard rejects under user scope (in
      // production only materialization — an Automation write — creates it).
    }, {scope: ChangeScope.Automation, description: 'schema renderer fixture'})
  })

  afterEach(() => { cleanup() })

  const renderSchema = (blockId: string) =>
    render(
      // `RepoContext` as well as the runtime: `RefTargetTypePicker` reads the
      // type registry through it, so the config-editor case does not render
      // without one.
      <RepoContext value={repo}>
        <AppRuntimeContextProvider value={runtime}>
          <PropertySchemaContentRenderer block={repo.block(blockId)} />
        </AppRuntimeContextProvider>
      </RepoContext>,
    )

  it('renders a materialized seed read-only: type locked, no delete, with a note', () => {
    renderSchema(SEED_ID)

    const typeSelect = screen.getByRole('combobox') as HTMLSelectElement
    expect(typeSelect.disabled).toBe(true)
    // The seed's actual type is preserved even though it's hidden from the picker.
    expect(typeSelect.value).toBe('optional-string')

    const nameInput = screen.getByPlaceholderText('property name') as HTMLInputElement
    expect(nameInput.disabled).toBe(true)

    expect(screen.queryByText(/Delete schema/)).toBeNull()
    expect(screen.getByText(/Built-in property defined in code/)).toBeTruthy()
  })

  it('keeps a user-created schema editable', () => {
    renderSchema('user-schema')

    const typeSelect = screen.getByRole('combobox') as HTMLSelectElement
    expect(typeSelect.disabled).toBe(false)

    const nameInput = screen.getByPlaceholderText('property name') as HTMLInputElement
    expect(nameInput.disabled).toBe(false)

    expect(screen.getByText(/Delete schema/)).toBeTruthy()
    expect(screen.queryByText(/Built-in property defined in code/)).toBeNull()
  })

  it('writes nothing when a SEED\'s config editor is driven from the keyboard', async () => {
    // `pointer-events-none` blocks the POINTER and nothing else. The config
    // editors are extension-contributed, take no readOnly prop, and render
    // ordinary inputs and buttons, so behind a pointer-only block a keyboard
    // user tabs into a code-owned seed's options and edits them — and nothing
    // downstream catches it, because `core.migratePropertyDefinition` skips
    // seeded rows rather than refusing them.
    //
    // FOCUS, never click: a click is a pointer action, which the old block
    // stopped on its own, so a test that clicks cannot tell the two apart.
    renderSchema(REF_SEED_ID)
    const user = userEvent.setup()
    const txSpy = vi.spyOn(repo, 'tx')

    const configInput = screen.getByPlaceholderText('Add a block type…')
    configInput.focus()
    await user.keyboard('page{Enter}')

    expect(txSpy).not.toHaveBeenCalled()
  })

  it('writes a config change for a user-created schema on the same preset', async () => {
    // The control: these keystrokes really do reach `writeConfig`, so the
    // assertion above is not green for want of a working path.
    renderSchema('user-ref-schema')
    const user = userEvent.setup()

    const configInput = screen.getByPlaceholderText('Add a block type…')
    configInput.focus()
    await user.keyboard('page{Enter}')

    await vi.waitFor(() => {
      expect(repo.block('user-ref-schema').peek()?.properties['property-schema:config'])
        .toEqual({targetTypes: ['page']})
    })
  })
})

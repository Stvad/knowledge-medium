// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChangeScope, codecs, type AnyValuePresetCore } from '@/data/api'
import { valuePresetCoresFacet } from '@/data/facets'
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

const UNLOADED_PRESET = 'test-unloaded-preset'

// Seeds whose materialized rows name a type that does not build here — a
// plugin-owned preset gone from this device, and one whose stored config its
// loaded preset cannot read. The preset is overridden in the row, since a
// declaration only takes kernel presets.
const missingPresetSeed = seedProperty({
  seedKey: 'system:test/property/missing-preset-seed',
  revision: 1,
  name: 'test:seedMissing',
  preset: 'string',
  changeScope: ChangeScope.BlockDefault,
})
const MISSING_PRESET_SEED_ID = propertyDefinitionBlockId(WS, missingPresetSeed.seedKey)
const badConfigSeed = seedProperty({
  seedKey: 'system:test/property/bad-config-seed',
  revision: 1,
  name: 'test:seedBadConfig',
  preset: 'ref',
  changeScope: ChangeScope.BlockDefault,
})
const BAD_CONFIG_SEED_ID = propertyDefinitionBlockId(WS, badConfigSeed.seedKey)

describe('PropertySchemaContentRenderer read-only for code-owned seeds', () => {
  let sharedDb: TestDb
  let repo: Repo

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })

  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    repo = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      extensions: [kernelPropertyUiExtension, kernelValuePresetsExtension],
    }).repo
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
      // A user schema on a preset no plugin on this device provides (#1077).
      await tx.create({
        id: 'missing-preset-schema',
        workspaceId: WS,
        parentId: 'root',
        orderKey: 'a5',
        content: 'test:broken',
        properties: {
          types: ['property-schema'],
          'property-schema:name': 'test:broken',
          'property-schema:preset': UNLOADED_PRESET,
          'property-schema:config': {},
        },
      })
      // A LOADED preset whose stored config it cannot decode — the other way a
      // definition's current type builds nothing.
      await tx.create({
        id: 'bad-config-schema',
        workspaceId: WS,
        parentId: 'root',
        orderKey: 'a6',
        content: 'test:badConfig',
        properties: {
          types: ['property-schema'],
          'property-schema:name': 'test:badConfig',
          'property-schema:preset': 'ref',
          'property-schema:config': {targetTypes: 'not-a-list'},
        },
      })
      await tx.create({
        id: MISSING_PRESET_SEED_ID,
        workspaceId: WS,
        parentId: 'root',
        orderKey: 'a7',
        content: missingPresetSeed.name,
        properties: {
          ...canonicalPropertySeedProperties(missingPresetSeed),
          'property-schema:preset': UNLOADED_PRESET,
        },
      })
      await tx.create({
        id: BAD_CONFIG_SEED_ID,
        workspaceId: WS,
        parentId: 'root',
        orderKey: 'a8',
        content: badConfigSeed.name,
        properties: {
          ...canonicalPropertySeedProperties(badConfigSeed),
          'property-schema:config': {targetTypes: 'not-a-list'},
        },
      })
      // A named schema whose row names no preset yet, as a hand-tagged block has.
      await tx.create({
        id: 'no-preset-schema',
        workspaceId: WS,
        parentId: 'root',
        orderKey: 'a9',
        content: 'test:untyped',
        properties: {
          types: ['property-schema'],
          'property-schema:name': 'test:untyped',
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

  const schemaTree = (blockId: string, on: Repo = repo, rt: FacetRuntime = on.facetRuntime!) => (
    // `RepoContext` as well as the runtime: `RefTargetTypePicker` reads the
    // type registry through it, so the config-editor case does not render
    // without one.
    <RepoContext value={on}>
      <AppRuntimeContextProvider value={rt}>
        <PropertySchemaContentRenderer block={on.block(blockId)} />
      </AppRuntimeContextProvider>
    </RepoContext>
  )

  const renderSchema = (blockId: string, on: Repo = repo) => render(schemaTree(blockId, on))

  /** A second client on the same database — with extra preset cores, or
   *  read-only — with `blockId` loaded so the editor renders it at once. */
  const otherRepo = async (
    blockId: string,
    {cores = [], isReadOnly = false}: {cores?: AnyValuePresetCore[]; isReadOnly?: boolean} = {},
  ): Promise<Repo> => {
    const other = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      isReadOnly,
      extensions: [
        kernelPropertyUiExtension,
        kernelValuePresetsExtension,
        ...cores.map(core => valuePresetCoresFacet.of(core, {source: 'test'})),
      ],
    }).repo
    other.setActiveWorkspaceId(WS)
    await other.load(blockId)
    return other
  }

  const throwingCore = {
    id: UNLOADED_PRESET,
    build: () => { throw new Error('[test] preset build failed') },
    defaultValue: '',
  } as unknown as AnyValuePresetCore
  const loadedCore = {
    id: UNLOADED_PRESET, build: () => codecs.string, defaultValue: '',
  } as unknown as AnyValuePresetCore

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

  it('snaps the type picker back when the kernel REFUSES the re-type', async () => {
    // The picker must not be left displaying a type the kernel refused. React's
    // controlled-state restore is what delivers this, not anything in the
    // renderer — pinned because the property is user-facing and an `onChange`
    // that ever writes local state before awaiting would silently lose it.
    await sharedDb.db.execute(
      `INSERT OR REPLACE INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode,
          wk_canary, properties_migration)
       VALUES (?, 'ws', 'user-1', 1, 1, 'none', NULL, 'children')`,
      [WS])
    const schema = await vi.waitFor(() => {
      const registered = repo.propertySchemas.get('test:myProp')
      if (!registered) throw new Error('[test] test:myProp not registered yet')
      return registered
    }, {timeout: 3000})
    // Prose under a string property: `number` cannot read it, so the re-type
    // below is refused rather than dropping it.
    await repo.tx(async tx => {
      await tx.create({
        id: 'host', workspaceId: WS, parentId: 'root', orderKey: 'a3', content: 'host',
      })
      await tx.setProperty('host', schema, 'not a number')
    }, {scope: ChangeScope.BlockDefault})

    renderSchema('user-schema')
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('string')

    fireEvent.change(screen.getByRole('combobox'), {target: {value: 'number'}})

    await waitFor(() => {
      expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('string')
    })
    expect(repo.block('user-schema')).toBeTruthy()
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
  describe('while the definition\'s current type does not load (#1077, #1090)', () => {
    it('offers no type picker or config editor, naming the preset and the ways out', () => {
      renderSchema('missing-preset-schema')

      // Positive first: the editor rendered this definition at all.
      const notice = screen.getByText(/that isn.t loaded on this device/)
      expect(notice.textContent).toContain(UNLOADED_PRESET)
      expect(notice.textContent)
        .toMatch(/Enable the plugin or update the app on this device, or delete the schema/)
      expect(screen.getByRole('button', {name: 'Manage extensions'})).toBeTruthy()
      expect(screen.getByText(/Delete schema/)).toBeTruthy()

      expect(screen.queryByRole('combobox')).toBeNull()
      // Renames stay the transaction's call: one that strands nothing lands.
      expect((screen.getByPlaceholderText('property name') as HTMLInputElement).disabled)
        .toBe(false)
    })

    it('locks a LOADED preset whose stored config does not decode, config editor included', () => {
      renderSchema('bad-config-schema')

      // Update first: under version skew the definition works on a newer
      // device, and deleting it here deletes it there.
      expect(screen.getByText(/The stored settings of .* can.t be read on this device/).textContent)
        .toMatch(/Update the plugin or the app on this device, or delete the schema/)
      expect(screen.queryByRole('combobox')).toBeNull()
      expect(screen.queryByPlaceholderText('Add a block type…')).toBeNull()
    })

    it('locks a LOADED preset whose build throws', async () => {
      renderSchema('missing-preset-schema', await otherRepo(
        'missing-preset-schema', {cores: [throwingCore]}))

      expect(screen.getByText(/which fails to build on this device/).textContent)
        .toMatch(/Update the plugin or the app on this device/)
      expect(screen.queryByRole('combobox')).toBeNull()
    })

    it('keeps the picker for a schema that names no type yet, which choosing one finishes', () => {
      renderSchema('no-preset-schema')

      expect(screen.getByPlaceholderText('property name')).toBeTruthy()
      expect(screen.getByRole('combobox')).toBeTruthy()
      expect(screen.queryByText(/on this device/)).toBeNull()
    })

    it('points a SEED whose plugin is not loaded at the plugin, not at deleting it', () => {
      // A seed is code-owned and renders read-only, with no delete button.
      renderSchema(MISSING_PRESET_SEED_ID)

      const notice = screen.getByText(/that isn.t loaded on this device/)
      expect(notice.textContent).toMatch(/Enable the plugin or update the app on this device\./)
      expect(notice.textContent).not.toMatch(/delete/)
      expect(screen.getByRole('button', {name: 'Manage extensions'})).toBeTruthy()
      expect(screen.queryByText(/Delete schema/)).toBeNull()
    })

    it('points a SEED whose stored config does not decode at its plugin', () => {
      renderSchema(BAD_CONFIG_SEED_ID)

      const notice = screen.getByText(/The stored settings of .* can.t be read on this device/)
      expect(notice.textContent).toMatch(/Update the plugin or the app on this device\./)
      expect(notice.textContent).not.toMatch(/delete/)
    })

    it('does not offer a VIEWER the delete it cannot make', async () => {
      renderSchema('bad-config-schema', await otherRepo('bad-config-schema', {isReadOnly: true}))

      expect(screen.getByText(/The stored settings of .* can.t be read on this device/).textContent)
        .toMatch(/ask someone who can edit this workspace to delete the schema/)
      expect(screen.queryByText(/Delete schema/)).toBeNull()
    })

    it('puts the stored name back when the transaction refuses a rename', async () => {
      // While blocks use it, a rename of such a definition is refused in the
      // transaction; the field must not go on showing a name that never landed.
      renderSchema('missing-preset-schema')
      vi.spyOn(repo, 'tx').mockRejectedValueOnce(new Error('[test] refused'))
      const nameInput = screen.getByPlaceholderText('property name') as HTMLInputElement

      fireEvent.change(nameInput, {target: {value: 'test:renamed'}})
      fireEvent.blur(nameInput)

      await waitFor(() => { expect(nameInput.value).toBe('test:broken') })
    })

    it('offers the picker again once the preset loads', async () => {
      renderSchema('missing-preset-schema', await otherRepo(
        'missing-preset-schema', {cores: [loadedCore]}))

      expect(screen.getByRole('combobox')).toBeTruthy()
      expect(screen.queryByText(/on this device/)).toBeNull()
    })

    it('lifts the lock when the preset loads while the editor is mounted', async () => {
      // The row does not change; only the runtime does, as when a plugin is
      // enabled. The lock must follow the runtime, not wait for a row write.
      const view = renderSchema('missing-preset-schema')
      expect(screen.queryByRole('combobox')).toBeNull()
      const withPreset = await otherRepo('missing-preset-schema', {cores: [loadedCore]})

      view.rerender(schemaTree('missing-preset-schema', repo, withPreset.facetRuntime!))

      expect(screen.getByRole('combobox')).toBeTruthy()
    })
  })
})

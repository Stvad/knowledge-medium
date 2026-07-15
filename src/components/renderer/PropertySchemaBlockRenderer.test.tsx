// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { type FacetRuntime } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
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
    }, {scope: ChangeScope.BlockDefault, description: 'schema renderer fixture'})
  })

  afterEach(() => { cleanup() })

  const renderSchema = (blockId: string) =>
    render(
      <AppRuntimeContextProvider value={runtime}>
        <PropertySchemaContentRenderer block={repo.block(blockId)} />
      </AppRuntimeContextProvider>,
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
})

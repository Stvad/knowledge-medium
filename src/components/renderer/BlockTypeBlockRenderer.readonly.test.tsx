// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/toast.js', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/toast.js')>(),
  showError: vi.fn(),
}))
vi.mock('@/components/propertyPanel/PropertyPicker.js', () => ({PropertyPicker: () => null}))
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { type FacetRuntime } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { seedType } from '@/data/typeSeeds'
import { canonicalTypeSeedProperties, typeDefinitionBlockId } from '@/data/definitionSeeds'
import { blockTypeLabelProp } from '@/data/properties'
import { RepoContext } from '@/context/repo'
import { showError } from '@/utils/toast.js'
import { BlockTypeContentRenderer } from './BlockTypeBlockRenderer'

const WS = 'ws-1'

// A code-owned type seed materialized into the workspace. (The non-seed
// "user-created type stays editable" case is covered at the model level in
// model.test.ts — the renderer's editable path renders PropertyPicker, which
// needs a RepoContext this harness doesn't inject.)
const typeSeed = seedType({
  seedKey: 'system:test/type/read-only-demo',
  revision: 1,
  id: 'test-read-only-demo',
  label: 'Widget',
})
const SEED_ID = typeDefinitionBlockId(WS, typeSeed.seedKey)

describe('BlockTypeContentRenderer read-only for code-owned type seeds', () => {
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

    // Materialized type-seed row: its id satisfies the deterministic equation,
    // so it parses as a valid seeded (code-owned) definition. Authored under
    // Automation scope — the tx-layer forge guard rejects a provenance-valid
    // seed bag under user scope (only materialization creates it in production),
    // and the typeify carve-out leaves a valid seed row bare (no page/alias).
    await repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Root'})
      await tx.create({
        id: SEED_ID,
        workspaceId: WS,
        parentId: 'root',
        orderKey: 'a1',
        content: typeSeed.label,
        properties: canonicalTypeSeedProperties(typeSeed, WS),
      })
    }, {scope: ChangeScope.Automation, description: 'type seed fixture'})
  })

  afterEach(() => { cleanup() })

  const renderType = (blockId: string) =>
    render(
      <RepoContext value={repo}>
        <AppRuntimeContextProvider value={runtime}>
          <BlockTypeContentRenderer block={repo.block(blockId)} />
        </AppRuntimeContextProvider>
      </RepoContext>,
    )

  it('renders a materialized type seed read-only: label locked, no "Add property"', () => {
    renderType(SEED_ID)

    const labelInput = screen.getByPlaceholderText('type label') as HTMLInputElement
    expect(labelInput.readOnly).toBe(true)
    expect(labelInput.value).toBe('Widget')
    // The add-property affordance is hidden on a code-owned type. (A user-created
    // type stays editable — the non-seed path is covered at the model level in
    // model.test.ts, where the panel row lock has no PropertyPicker/RepoContext
    // render dependency.)
    expect(screen.queryByPlaceholderText('Add property')).toBeNull()
  })

  it('shows why a grammar-shaped type label was refused', async () => {
    await repo.tx(async tx => {
      await tx.create({
        id: 'user-type', workspaceId: WS, parentId: 'root', orderKey: 'a2', content: 'Author',
      })
      await repo.addTypeInTx(tx, 'user-type', 'block-type', {})
      await tx.setProperty('user-type', blockTypeLabelProp, 'Author')
    }, {scope: ChangeScope.BlockDefault, description: 'create editable type'})

    renderType('user-type')
    const labelInput = screen.getByPlaceholderText('type label') as HTMLInputElement
    fireEvent.change(labelInput, {target: {value: '[[Author]]'}})
    fireEvent.blur(labelInput)

    await waitFor(() => expect(labelInput.value).toBe('Author'))
    expect(showError).toHaveBeenCalledWith(expect.stringMatching(/reads as a block reference/i))
  })
})

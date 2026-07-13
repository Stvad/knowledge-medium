// @vitest-environment node

import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  ChangeScope,
  PropertySchemaIdentityError,
  codecs,
  defineProperty,
} from '@/data/api'
import {
  definitionSeedsFacet,
  propertySchemasFacet,
  projectedPropertyDefinitionsFacet,
} from '@/data/facets'
import {seedProperty} from '@/data/propertySeeds'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {kernelDataExtension} from '@/data/kernelDataExtension'
import {resolveFacetRuntimeSync} from '@/facets/facet'

const WS = 'ws-property-boundary'

const shadowed = seedProperty({
  seedKey: 'system:test-plugin/property/status',
  revision: 1,
  name: 'status',
  preset: 'string',
  defaultValue: 'seed-default',
  changeScope: ChangeScope.BlockDefault,
})

const winner = defineProperty('status', {
  codec: codecs.number,
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})

const winnerMetadata = {
  fieldId: 'field-winning-status',
  workspaceId: WS,
  createdAt: 1,
  name: winner.name,
  changeScope: winner.changeScope,
  hidden: false,
  origin: 'user' as const,
}

let sharedDb: TestDb

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })

const setup = async () => {
  const {repo} = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    installKernelRuntime: false,
  })
  repo.setFacetRuntime(resolveFacetRuntimeSync([]))
  repo.setActiveWorkspaceId(WS)
  repo.setRuntimeContributions(definitionSeedsFacet, 'test-shadowed-seed', [shadowed])
  repo.setRuntimeContributions(
    projectedPropertyDefinitionsFacet,
    'test-winning-definition',
    [{
      metadata: winnerMetadata,
      schema: winner,
    }],
    {workspaceId: WS},
  )
  await repo.tx(
    tx => tx.create({
      id: 'target',
      workspaceId: WS,
      parentId: null,
      orderKey: 'a0',
      properties: {[winner.name]: winner.codec.encode(42)},
    }),
    {scope: ChangeScope.BlockDefault},
  )
  return repo
}

describe('typed property identity boundary', () => {
  it('keeps an unclaimed plain schema writable before a workspace is pinned', async () => {
    const plain = defineProperty('pre-pin-unclaimed', {
      codec: codecs.string,
      defaultValue: 'plain-default',
      changeScope: ChangeScope.BlockDefault,
    })
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      installKernelRuntime: false,
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension]))
    await repo.tx(
      tx => tx.create({
        id: 'pre-pin-unclaimed-target',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
      }),
      {scope: ChangeScope.BlockDefault},
    )

    await repo.tx(
      tx => tx.setProperty('pre-pin-unclaimed-target', plain, 'stored'),
      {scope: ChangeScope.BlockDefault},
    )

    expect(repo.block('pre-pin-unclaimed-target').get(plain)).toBe('stored')
  })

  it('rejects a pre-pin legacy lookalike when an unbound seed owns the name', async () => {
    const encode = vi.fn(codecs.string.encode)
    const legacyLookalike = defineProperty(shadowed.name, {
      codec: {...codecs.string, encode},
      defaultValue: 'legacy-default',
      changeScope: ChangeScope.BlockDefault,
    })
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      installKernelRuntime: false,
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension]))
    repo.setRuntimeContributions(propertySchemasFacet, 'test-pre-pin-legacy', [legacyLookalike])
    repo.setRuntimeContributions(definitionSeedsFacet, 'test-pre-pin-seed', [shadowed])
    await repo.tx(
      tx => tx.create({
        id: 'pre-pin-target',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        properties: {[shadowed.name]: 'foreign'},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    const updater = vi.fn(() => 'changed')

    expect(repo.block('pre-pin-target').get(legacyLookalike)).toBe('legacy-default')
    expect(repo.block('pre-pin-target').peekProperty(legacyLookalike)).toBeUndefined()
    await expect(repo.block('pre-pin-target').set(legacyLookalike, 'changed'))
      .rejects.toBeInstanceOf(PropertySchemaIdentityError)
    await expect(repo.tx(
      tx => tx.setProperty('pre-pin-target', legacyLookalike, 'changed'),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toBeInstanceOf(PropertySchemaIdentityError)
    await expect(repo.block('pre-pin-target').set(legacyLookalike, updater)).rejects.toMatchObject({
      name: 'PropertySchemaIdentityError',
      reason: 'shadowed',
    })
    expect(encode).not.toHaveBeenCalled()
    expect(updater).not.toHaveBeenCalled()
    expect(repo.block('pre-pin-target').peek()!.properties.status).toBe('foreign')
  })

  it('degrades shadowed Block reads without decoding the winner cell', async () => {
    const repo = await setup()
    const block = repo.block('target')

    expect(block.get(shadowed)).toBe('seed-default')
    expect(block.peekProperty(shadowed)).toBeUndefined()
  })

  it('rejects shadowed Block writes before invoking an updater', async () => {
    const repo = await setup()
    const updater = vi.fn(() => 'changed')

    await expect(repo.block('target').set(shadowed, updater)).rejects.toMatchObject({
      name: 'PropertySchemaIdentityError',
      schemaName: shadowed.name,
      reason: 'shadowed',
    })
    expect(updater).not.toHaveBeenCalled()
    expect(repo.block('target').peek()!.properties.status).toBe(42)
  })

  it('degrades shadowed Tx reads and rejects shadowed Tx writes', async () => {
    const repo = await setup()

    await expect(repo.tx(async tx => {
      expect(await tx.getProperty('target', shadowed)).toBe('seed-default')
      await tx.setProperty('target', shadowed, 'changed')
    }, {scope: ChangeScope.BlockDefault})).rejects.toBeInstanceOf(PropertySchemaIdentityError)

    expect(repo.block('target').peek()!.properties.status).toBe(42)
  })

  it('accepts the resolved winner and uses its canonical codec', async () => {
    const repo = await setup()
    const resolution = repo.propertySchemaResolverFor(WS).resolve(winner.name)
    if (resolution.status !== 'resolved') throw new Error('expected winner to resolve')

    expect(repo.block('target').get(resolution.schema)).toBe(42)
    await repo.tx(
      tx => tx.setProperty('target', resolution.schema, 7),
      {scope: ChangeScope.BlockDefault},
    )
    expect(repo.block('target').get(resolution.schema)).toBe(7)
  })

  it('keeps an unclaimed legacy schema usable during the B2-to-B4 transition', async () => {
    const repo = await setup()
    const legacy = defineProperty('legacy-only', {
      codec: codecs.string,
      defaultValue: 'legacy-default',
      changeScope: ChangeScope.BlockDefault,
    })
    repo.setRuntimeContributions(propertySchemasFacet, 'test-legacy-only', [legacy])
    const ambient = repo.propertySchemas.get(legacy.name)
    if (!ambient) throw new Error('expected transitional legacy schema')
    expect(ambient).toBe(legacy)

    await repo.tx(
      tx => tx.setProperty('target', legacy, 'legacy-value'),
      {scope: ChangeScope.BlockDefault},
    )
    expect(repo.block('target').get(legacy)).toBe('legacy-value')
  })

  it('allows an unregistered plain schema for an unclaimed active-workspace name', async () => {
    const repo = await setup()
    const unregistered = defineProperty('active-unregistered', {
      codec: codecs.string,
      defaultValue: 'unregistered-default',
      changeScope: ChangeScope.BlockDefault,
    })

    await repo.tx(
      tx => tx.setProperty('target', unregistered, 'unregistered-value'),
      {scope: ChangeScope.BlockDefault},
    )
    expect(repo.block('target').get(unregistered)).toBe('unregistered-value')
  })

  it('rejects an exact ambient PropertyHandle without a seed declaration', async () => {
    const handle = seedProperty({
      seedKey: 'system:test-plugin/property/ambient-handle-only',
      revision: 1,
      name: 'ambient-handle-only',
      preset: 'string',
      defaultValue: 'handle-default',
      changeScope: ChangeScope.BlockDefault,
    })
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      installKernelRuntime: false,
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([]))
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(propertySchemasFacet, 'test-ambient-handle-only', [handle])
    await repo.tx(
      tx => tx.create({
        id: 'ambient-handle-only-target',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        properties: {[handle.name]: 'unchanged'},
      }),
      {scope: ChangeScope.BlockDefault},
    )

    expect(repo.propertySchemas.get(handle.name)).toBe(handle)
    expect(repo.propertySchemaResolverFor(WS).resolveBoundary(handle)).toEqual({
      status: 'identity-unavailable',
      reason: 'definition-unavailable',
    })
    await expect(repo.tx(
      tx => tx.setProperty('ambient-handle-only-target', handle, 'changed'),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toMatchObject({
      name: 'PropertySchemaIdentityError',
      reason: 'definition-unavailable',
    })
    expect(repo.block('ambient-handle-only-target').peek()!.properties[handle.name])
      .toBe('unchanged')
  })

  it('pins a seed to its declared name and shadows a legacy schema there', async () => {
    const declared = seedProperty({
      seedKey: 'system:test-plugin/property/renamed-away',
      revision: 1,
      name: 'seed-name-before-rename',
      preset: 'string',
      defaultValue: 'seed-default',
      changeScope: ChangeScope.BlockDefault,
    })
    const legacy = defineProperty(declared.name, {
      codec: codecs.string,
      defaultValue: 'legacy-default',
      changeScope: ChangeScope.BlockDefault,
    })
    // A stored name divergence (older client / import / sync). Seeds are
    // non-renamable, so it must be ignored: the seed stays at its declared name.
    const storedDivergence = 'seed-name-after-rename'
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      installKernelRuntime: false,
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([]))
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(propertySchemasFacet, 'test-renamed-seed-legacy', [legacy])
    repo.setRuntimeContributions(definitionSeedsFacet, 'test-renamed-seed', [declared])
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      'test-renamed-seed-definition',
      [{
        metadata: {
          fieldId: propertyDefinitionBlockId(WS, declared.seedKey),
          workspaceId: WS,
          createdAt: 1,
          name: storedDivergence,
          changeScope: declared.changeScope,
          hidden: false,
          seedKey: declared.seedKey,
          origin: 'plugin:system:test-plugin',
        },
      }],
      {workspaceId: WS},
    )
    await repo.tx(
      tx => tx.create({
        id: 'renamed-seed-legacy-target',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        properties: {[legacy.name]: 'unchanged'},
      }),
      {scope: ChangeScope.BlockDefault},
    )

    expect(repo.propertySchemas.has(storedDivergence)).toBe(false)
    expect(repo.propertySchemas.get(declared.name)).toBe(declared)
    expect(repo.propertySchemaResolverFor(WS).resolveBoundary(legacy)).toEqual({
      status: 'identity-unavailable',
      reason: 'shadowed',
    })
    await expect(repo.tx(
      tx => tx.setProperty('renamed-seed-legacy-target', legacy, 'changed'),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toMatchObject({
      name: 'PropertySchemaIdentityError',
      reason: 'shadowed',
    })
    expect(repo.block('renamed-seed-legacy-target').peek()!.properties[legacy.name])
      .toBe('unchanged')
  })

  it('rejects a write whose resolved change-scope differs from the tx scope', async () => {
    // A stale-schema caller can open the tx under one scope while the resolved
    // definition carries another (its change-scope was edited after capture).
    // Admitting the write under the stale scope would bypass the read-only gate
    // and misroute undo, so the resolved-vs-admitted mismatch must be rejected.
    const seed = seedProperty({
      seedKey: 'system:test-plugin/property/scope-check',
      revision: 1,
      name: 'scope-check',
      preset: 'string',
      defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
    })
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      installKernelRuntime: false,
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([]))
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(definitionSeedsFacet, 'test-scope-check', [seed])
    await repo.tx(
      tx => tx.create({id: 'scope-target', workspaceId: WS, parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )

    await expect(repo.tx(
      tx => tx.setProperty('scope-target', seed, 'x'),
      {scope: ChangeScope.UiState},
    )).rejects.toMatchObject({
      name: 'PropertySchemaScopeMismatchError',
      txScope: ChangeScope.UiState,
      resolvedScope: ChangeScope.BlockDefault,
    })
    expect(repo.block('scope-target').peek()!.properties['scope-check']).toBeUndefined()

    // The matching-scope write is unaffected.
    await repo.tx(
      tx => tx.setProperty('scope-target', seed, 'ok'),
      {scope: ChangeScope.BlockDefault},
    )
    expect(repo.block('scope-target').get(seed)).toBe('ok')
  })

  it('accepts a resolved synthesized seed before its definition row exists', async () => {
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      installKernelRuntime: false,
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([]))
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(definitionSeedsFacet, 'test-synthesized-seed', [shadowed])
    await repo.tx(
      tx => tx.create({
        id: 'synthesized-target',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
      }),
      {scope: ChangeScope.BlockDefault},
    )
    const resolution = repo.propertySchemaResolverFor(WS).resolve(shadowed)
    if (resolution.status !== 'resolved') throw new Error('expected synthesized seed to resolve')

    expect(repo.block('synthesized-target').get(resolution.schema)).toBe('seed-default')
    await repo.tx(
      tx => tx.setProperty('synthesized-target', resolution.schema, 'stored'),
      {scope: ChangeScope.BlockDefault},
    )
    expect(repo.block('synthesized-target').get(resolution.schema)).toBe('stored')
  })

  it('uses canonical behavior after a resolved entry is replaced', async () => {
    const repo = await setup()
    const oldResolution = repo.propertySchemaResolverFor(WS).resolve(winner.name)
    if (oldResolution.status !== 'resolved') throw new Error('expected winner to resolve')
    const replacement = defineProperty(winner.name, {
      codec: codecs.number,
      defaultValue: 5,
      changeScope: ChangeScope.BlockDefault,
    })
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      'test-winning-definition',
      [{metadata: winnerMetadata, schema: replacement}],
      {workspaceId: WS},
    )
    await repo.tx(
      tx => tx.create({
        id: 'empty-target',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a1',
      }),
      {scope: ChangeScope.BlockDefault},
    )

    expect(repo.block('empty-target').get(oldResolution.schema)).toBe(5)
    await expect(repo.tx(
      tx => tx.getProperty('empty-target', oldResolution.schema),
      {scope: ChangeScope.BlockDefault},
    )).resolves.toBe(5)
  })

  it('revalidates a resolved entry by durable field id after a rename', async () => {
    const repo = await setup()
    const oldResolution = repo.propertySchemaResolverFor(WS).resolve(winner.name)
    if (oldResolution.status !== 'resolved') throw new Error('expected winner to resolve')
    const renamed = 'renamed-status'
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      'test-winning-definition',
      [{
        metadata: {...winnerMetadata, name: renamed},
        schema: winner,
      }],
      {workspaceId: WS},
    )
    await repo.tx(
      tx => tx.update('target', {properties: {status: 42, [renamed]: 9}}),
      {scope: ChangeScope.BlockDefault},
    )

    expect(repo.block('target').get(oldResolution.schema)).toBe(9)
    await repo.tx(
      tx => tx.setProperty('target', oldResolution.schema, 10),
      {scope: ChangeScope.BlockDefault},
    )
    expect(repo.block('target').peek()!.properties).toMatchObject({status: 42, [renamed]: 10})
  })

  it('pins a seed to its declared name, ignoring the row stored name', async () => {
    const repo = await setup()
    const fieldId = propertyDefinitionBlockId(WS, shadowed.seedKey)
    // A stored name divergence on the seed's own row. Non-renamable seeds keep
    // their declared name, so the divergent name is invisible and read/write
    // resolve under the declared name.
    const storedDivergence = 'renamed-seed-status'
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      'test-winning-definition',
      [{
        metadata: {
          ...winnerMetadata,
          fieldId,
          name: storedDivergence,
          seedKey: shadowed.seedKey,
          origin: 'plugin:system:test-plugin',
        },
      }],
      {workspaceId: WS},
    )
    expect(repo.propertySchemas.has(storedDivergence)).toBe(false)
    const ambient = repo.propertySchemas.get(shadowed.name)
    if (!ambient) throw new Error('expected seed pinned at its declared name')

    await repo.tx(
      tx => tx.setProperty('target', ambient, 'after'),
      {scope: ChangeScope.BlockDefault},
    )
    expect(repo.block('target').get(ambient)).toBe('after')
    expect(repo.block('target').peek()!.properties[shadowed.name]).toBe('after')
    expect(repo.block('target').peek()!.properties[storedDivergence]).toBeUndefined()
  })

  it('accepts the exact ambient fallback when a seed declaration is absent', async () => {
    const fallback = defineProperty('fallback-status', {
      codec: codecs.number,
      defaultValue: 3,
      changeScope: ChangeScope.BlockDefault,
    })
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      installKernelRuntime: false,
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([]))
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      'test-fallback-definition',
      [{
        metadata: {
          ...winnerMetadata,
          fieldId: 'field-fallback-status',
          name: fallback.name,
          seedKey: 'system:disabled-plugin/property/fallback-status',
          origin: 'plugin:system:disabled-plugin',
        },
        schema: fallback,
      }],
      {workspaceId: WS},
    )
    await repo.tx(
      tx => tx.create({
        id: 'fallback-target',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        properties: {[fallback.name]: 4},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    const ambient = repo.propertySchemas.get(fallback.name)
    if (!ambient) throw new Error('expected fallback winner')

    expect(repo.block('fallback-target').get(ambient)).toBe(4)
    await repo.tx(
      tx => tx.setProperty('fallback-target', ambient, 6),
      {scope: ChangeScope.BlockDefault},
    )
    expect(repo.block('fallback-target').peek()!.properties[fallback.name]).toBe(6)
  })

  it('resolves the immediately-previous workspace, then fails closed once it is foreign', async () => {
    const projected = defineProperty('retained-workspace-schema', {
      codec: codecs.number,
      defaultValue: 0,
      changeScope: ChangeScope.BlockDefault,
    })
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      installKernelRuntime: false,
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([]))
    repo.setActiveWorkspaceId(WS)
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      'test-retained-workspace-definition',
      [{
        metadata: {
          fieldId: 'field-retained-workspace-schema',
          workspaceId: WS,
          createdAt: 1,
          name: projected.name,
          changeScope: projected.changeScope,
          hidden: false,
          origin: 'user',
        },
        schema: projected,
      }],
      {workspaceId: WS},
    )
    await repo.tx(
      tx => tx.create({
        id: 'retained-workspace-target',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        properties: {[projected.name]: projected.codec.encode(42)},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    const retained = repo.propertySchemas.get(projected.name)
    if (!retained) throw new Error('expected projected schema in workspace A')

    repo.setActiveWorkspaceId('ws-property-boundary-b')
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      'test-retained-workspace-definition',
      [],
      {workspaceId: WS},
    )
    // WS is now the immediately-previous workspace. Its faithful registry is
    // retained across this one switch, so an in-flight read/tx that began for WS
    // still resolves against its real definitions rather than failing closed or
    // synthesising a partial snapshot. (`repo.propertySchemas` is the ACTIVE
    // workspace's ambient map, so it no longer carries WS's entry.)
    expect(repo.propertySchemas.get(projected.name)).toBeUndefined()
    expect(repo.propertySchemaResolverFor(WS).resolveBoundary(retained)).toEqual({
      status: 'available',
      schema: expect.objectContaining({
        name: projected.name,
        fieldId: 'field-retained-workspace-schema',
        workspaceId: WS,
      }),
    })

    // Switch once more: WS is now two workspaces back — genuinely foreign — so it
    // fails closed instead of resolving against a stale/partial snapshot.
    repo.setActiveWorkspaceId('ws-property-boundary-c')
    expect(repo.propertySchemaResolverFor(WS).resolveBoundary(retained)).toEqual({
      status: 'identity-unavailable',
      reason: 'registry-not-workspace-keyed',
    })
    await expect(repo.tx(
      tx => tx.setProperty('retained-workspace-target', retained, 7),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toMatchObject({
      name: 'PropertySchemaIdentityError',
      reason: 'registry-not-workspace-keyed',
    })
    expect(repo.block('retained-workspace-target').peek()!.properties[projected.name]).toBe(42)
  })

  it('rejects a retained plain schema for an inactive workspace without a runtime snapshot', async () => {
    const retained = defineProperty('retained-without-runtime', {
      codec: codecs.number,
      defaultValue: 0,
      changeScope: ChangeScope.BlockDefault,
    })
    const {repo} = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      installKernelRuntime: false,
    })
    repo.setActiveWorkspaceId(WS)
    await repo.tx(
      tx => tx.create({
        id: 'retained-without-runtime-target',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        properties: {[retained.name]: retained.codec.encode(42)},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    expect(repo.propertySchemaResolverFor(WS).resolveBoundary(retained)).toEqual({
      status: 'available',
      schema: retained,
    })

    repo.setActiveWorkspaceId('ws-property-boundary-b')

    expect(repo.propertySchemaResolverFor(WS).resolveBoundary(retained)).toEqual({
      status: 'identity-unavailable',
      reason: 'registry-not-workspace-keyed',
    })
    await expect(repo.tx(
      tx => tx.setProperty('retained-without-runtime-target', retained, 7),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toMatchObject({
      name: 'PropertySchemaIdentityError',
      reason: 'registry-not-workspace-keyed',
    })
    expect(repo.block('retained-without-runtime-target').peek()!.properties[retained.name])
      .toBe(42)
  })

  it('resolves a code-owned seed handle on a foreign workspace but fails plain schemas closed', async () => {
    const repo = await setup()
    const legacyLookalike = defineProperty(shadowed.name, {
      codec: codecs.string,
      defaultValue: 'legacy-default',
      changeScope: ChangeScope.BlockDefault,
    })
    const registeredLegacy = defineProperty('registered-legacy', {
      codec: codecs.string,
      defaultValue: 'registered-default',
      changeScope: ChangeScope.BlockDefault,
    })
    repo.setRuntimeContributions(
      propertySchemasFacet,
      'test-cross-workspace-registered-legacy',
      [registeredLegacy],
    )
    // A row in `ws-other`, a workspace that is neither active nor the retained
    // previous one — its projected definitions are not loaded. A code-owned seed
    // HANDLE is a workspace-independent identity, so it still resolves there (a
    // plugin seed via a decode fallback), which is what lets a plugin seed a note
    // or asset into a non-active target workspace. Plain name lookups, by
    // contrast, can't be trusted without the workspace's definitions.
    await repo.tx(
      tx => tx.create({
        id: 'other-workspace-target',
        workspaceId: 'ws-other',
        parentId: null,
        orderKey: 'a0',
        properties: {
          [shadowed.name]: shadowed.codec.encode('stored-seed'),
          [registeredLegacy.name]: 'before',
        },
      }),
      {scope: ChangeScope.BlockDefault},
    )

    // The seed handle resolves: the read decodes the stored value (not the
    // default), and a write lands under the seed's own codec.
    expect(repo.block('other-workspace-target').get(shadowed)).toBe('stored-seed')
    await repo.tx(
      tx => tx.setProperty('other-workspace-target', shadowed, 'changed'),
      {scope: ChangeScope.BlockDefault},
    )
    expect(repo.block('other-workspace-target').get(shadowed)).toBe('changed')

    // A plain lookalike collides with the seed name (shadowed) and a registered
    // plain schema has no faithful winner here — both fail closed. Reads return
    // the schema default, never the foreign workspace's stored value.
    expect(repo.block('other-workspace-target').get(legacyLookalike)).toBe('legacy-default')
    expect(repo.block('other-workspace-target').get(registeredLegacy)).toBe('registered-default')
    for (const schema of [legacyLookalike, registeredLegacy]) {
      await expect(repo.tx(
        tx => tx.setProperty('other-workspace-target', schema, 'changed'),
        {scope: ChangeScope.BlockDefault},
      )).rejects.toMatchObject({
        name: 'PropertySchemaIdentityError',
      })
    }
    // The registered-legacy raw value is untouched.
    expect(repo.block('other-workspace-target').peek()!.properties[registeredLegacy.name]).toBe('before')
  })
})

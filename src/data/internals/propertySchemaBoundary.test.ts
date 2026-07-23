// @vitest-environment node

import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  ChangeScope,
  PropertySchemaIdentityError,
  codecs,
  defineProperty,
  seedType,
} from '@/data/api'
import {
  definitionSeedsFacet,
  typeSeedsFacet,
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
    repo.setRuntimeContributions(typeSeedsFacet, 'test-pre-pin-legacy', [
      seedType({seedKey: 'test/type/pre-pin-legacy', revision: 1, id: 'test:pre-pin-legacy', label: 'Pre pin legacy', properties: [legacyLookalike]}),
    ])
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

  it('surfaces a codec error reading a seed cell that holds an incompatible leftover value', async () => {
    const repo = await setup()
    const block = repo.block('target')

    // The seed (string) now wins `status`, but `target` holds a number left by
    // an earlier same-name definition. v1 is loud: decoding it under the seed's
    // codec throws rather than silently degrading to the default.
    expect(() => block.get(shadowed)).toThrow(/expected string/)
  })

  it('rejects an updater write over an incompatible leftover before invoking the updater', async () => {
    const repo = await setup()
    const updater = vi.fn(() => 'changed')

    // The updater form decodes the current (incompatible) value first, so the
    // write throws and the updater never runs; the stored value is preserved.
    await expect(repo.block('target').set(shadowed, updater)).rejects.toThrow(/expected string/)
    expect(updater).not.toHaveBeenCalled()
    expect(repo.block('target').peek()!.properties.status).toBe(42)
  })

  it('surfaces a codec error on a tx read of an incompatible leftover value', async () => {
    const repo = await setup()

    await expect(repo.tx(async tx => {
      await tx.getProperty('target', shadowed)
    }, {scope: ChangeScope.BlockDefault})).rejects.toThrow(/expected string/)

    expect(repo.block('target').peek()!.properties.status).toBe(42)
  })

  it('resolves the seed for its name and round-trips a compatible value (no shadowing)', async () => {
    const repo = await setup()
    const resolution = repo.propertySchemaResolverFor(WS).resolve(shadowed.name)
    if (resolution.status !== 'resolved') throw new Error('expected the seed to resolve')
    // It's the seed's own deterministic identity, not the excluded user def.
    expect(resolution.schema.fieldId).toBe(propertyDefinitionBlockId(WS, shadowed.seedKey))

    await repo.tx(
      tx => tx.create({id: 'compat-target', workspaceId: WS, parentId: null, orderKey: 'a1'}),
      {scope: ChangeScope.BlockDefault},
    )
    await repo.tx(
      tx => tx.setProperty('compat-target', resolution.schema, 'ok'),
      {scope: ChangeScope.BlockDefault},
    )
    expect(repo.block('compat-target').get(resolution.schema)).toBe('ok')
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

  it('rejects a PropertyHandle embedded in a type but never declared as a seed', async () => {
    // The handle is embedded in a type's `properties` but its seedKey is owned by
    // `system:test-plugin` while the TYPE's seedKey is owned by `test` — cross-owner,
    // so nested-property harvest deliberately does NOT contribute it, and (with the
    // type-lift gone) it never enters the property registry. Its seedKey is therefore
    // absent from the workspace snapshot, so the identity boundary rejects writes
    // as `definition-unavailable` rather than interpreting a cell it can't identify.
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
    repo.setRuntimeContributions(typeSeedsFacet, 'test-ambient-handle-only', [
      seedType({seedKey: 'test/type/ambient-handle-only', revision: 1, id: 'test:ambient-handle-only', label: 'Ambient handle only', properties: [handle]}),
    ])
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

    // The undeclared handle never enters the ambient schema map (no lift, no harvest).
    expect(repo.propertySchemas.has(handle.name)).toBe(false)
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
    repo.setRuntimeContributions(typeSeedsFacet, 'test-renamed-seed-legacy', [
      seedType({seedKey: 'test/type/renamed-seed-legacy', revision: 1, id: 'test:renamed-seed-legacy', label: 'Renamed seed legacy', properties: [legacy]}),
    ])
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

  it('unsetProperty rejects a resolved-vs-admitted scope mismatch too (shared guard)', async () => {
    // unsetProperty shares assertPropertyWriteScope with setProperty, so the
    // same stale-scope bypass must be refused on the delete path (this is the
    // coverage the property panel used to hold inline before deleteProperty
    // delegated to unsetProperty).
    const seed = seedProperty({
      seedKey: 'system:test-plugin/property/unset-scope-check',
      revision: 1,
      name: 'unset-scope-check',
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
    repo.setRuntimeContributions(definitionSeedsFacet, 'test-unset-scope-check', [seed])
    await repo.tx(
      tx => tx.create({id: 'unset-scope-target', workspaceId: WS, parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await repo.tx(
      tx => tx.setProperty('unset-scope-target', seed, 'present'),
      {scope: ChangeScope.BlockDefault},
    )

    await expect(repo.tx(
      tx => tx.unsetProperty('unset-scope-target', seed),
      {scope: ChangeScope.UiState},
    )).rejects.toMatchObject({name: 'PropertySchemaScopeMismatchError'})
    // The value survived the rejected delete.
    expect(repo.block('unset-scope-target').get(seed)).toBe('present')

    // A matching-scope unset clears it.
    await repo.tx(
      tx => tx.unsetProperty('unset-scope-target', seed),
      {scope: ChangeScope.BlockDefault},
    )
    expect(repo.block('unset-scope-target').peek()!.properties['unset-scope-check']).toBeUndefined()
  })

  it('accepts a write whose resolved scope differs from the tx scope but shares its policy', async () => {
    // The guard compares by POLICY (read-only behavior + undoability), NOT scope
    // identity. BlockDefault and References share a policy, so a References tx
    // writing a BlockDefault-scoped property is intentional and must succeed —
    // this is what lets the references processor write a BlockDefault property
    // under its own bucket. A regression to identity comparison would reject it,
    // which the reject-case test above (differing scopes AND policies) can't catch.
    const seed = seedProperty({
      seedKey: 'system:test-plugin/property/policy-share',
      revision: 1,
      name: 'policy-share',
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
    repo.setRuntimeContributions(definitionSeedsFacet, 'test-policy-share', [seed])
    await repo.tx(
      tx => tx.create({id: 'policy-share-target', workspaceId: WS, parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )

    await repo.tx(
      tx => tx.setProperty('policy-share-target', seed, 'via-references'),
      {scope: ChangeScope.References},
    )
    expect(repo.block('policy-share-target').get(seed)).toBe('via-references')
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

  it('keeps the seed canonical even when an excluded same-name user schema changes', async () => {
    const repo = await setup()
    const resolution = repo.propertySchemaResolverFor(WS).resolve(shadowed.name)
    if (resolution.status !== 'resolved') throw new Error('expected the seed to resolve')
    // Replacing the excluded same-name user definition's schema must not affect
    // the seed, which owns the name.
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

    // An empty block reads the SEED default (string), not the user schema's 5.
    expect(repo.block('empty-target').get(resolution.schema)).toBe('seed-default')
  })

  it('revalidates a resolved entry by durable field id after a rename', async () => {
    const repo = await setup()
    // A user definition whose name does NOT collide with a seed, so it's a real
    // winner (not excluded by the no-shadowing rule). Resolve it, then rename it:
    // the captured resolution follows its durable field id to the new name.
    const userSchema = defineProperty('user-status', {
      codec: codecs.number,
      defaultValue: 0,
      changeScope: ChangeScope.BlockDefault,
    })
    const userMetadata = {
      fieldId: 'user-status-field',
      workspaceId: WS,
      createdAt: 1,
      name: 'user-status',
      changeScope: ChangeScope.BlockDefault,
      hidden: false,
      origin: 'user' as const,
    }
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      'test-user-status',
      [{metadata: userMetadata, schema: userSchema}],
      {workspaceId: WS},
    )
    const oldResolution = repo.propertySchemaResolverFor(WS).resolve('user-status')
    if (oldResolution.status !== 'resolved') throw new Error('expected the user def to resolve')

    const renamed = 'renamed-user-status'
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      'test-user-status',
      [{metadata: {...userMetadata, name: renamed}, schema: userSchema}],
      {workspaceId: WS},
    )
    await repo.tx(
      tx => tx.update('target', {properties: {[renamed]: 9}}),
      {scope: ChangeScope.BlockDefault},
    )

    expect(repo.block('target').get(oldResolution.schema)).toBe(9)
    await repo.tx(
      tx => tx.setProperty('target', oldResolution.schema, 10),
      {scope: ChangeScope.BlockDefault},
    )
    expect(repo.block('target').peek()!.properties[renamed]).toBe(10)
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
      typeSeedsFacet,
      'test-cross-workspace-registered-legacy',
      [seedType({seedKey: 'test/type/cross-workspace-registered-legacy', revision: 1, id: 'test:cross-workspace-registered-legacy', label: 'Cross workspace registered legacy', properties: [registeredLegacy]})],
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
    // The two failures have DISTINCT reasons, and the test pins each: the
    // lookalike squats on a seed name (shadowed); the registered plain name has
    // no faithful winner in an unloaded foreign workspace (registry-not-keyed).
    // Asserting only the error name would let a resolver that conflates the two
    // branches pass silently.
    await expect(repo.tx(
      tx => tx.setProperty('other-workspace-target', legacyLookalike, 'changed'),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toMatchObject({
      name: 'PropertySchemaIdentityError',
      reason: 'shadowed',
    })
    await expect(repo.tx(
      tx => tx.setProperty('other-workspace-target', registeredLegacy, 'changed'),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toMatchObject({
      name: 'PropertySchemaIdentityError',
      reason: 'registry-not-workspace-keyed',
    })
    // The registered-legacy raw value is untouched.
    expect(repo.block('other-workspace-target').peek()!.properties[registeredLegacy.name]).toBe('before')
  })

  it('decodes strictly on an updater-form write, preserving a codec-incompatible foreign value', async () => {
    const repo = await setup()
    // A row in `ws-other` (foreign — neither active nor retained) whose stored
    // `status` value is INCOMPATIBLE with the seed's string codec: the shape a
    // pre-existing/synced user definition on that workspace could have left. The
    // seed handle resolves there via a decode FALLBACK so a synchronous render
    // can't throw — but a write must not silently degrade-then-overwrite it.
    await repo.tx(
      tx => tx.create({
        id: 'foreign-incompatible-target',
        workspaceId: 'ws-other',
        parentId: null,
        orderKey: 'a0',
        properties: {[shadowed.name]: 42},
      }),
      {scope: ChangeScope.BlockDefault},
    )

    // Read degrades to the seed default (render-safe).
    expect(repo.block('foreign-incompatible-target').get(shadowed)).toBe('seed-default')

    // An updater-form write decodes the CURRENT value strictly: it throws rather
    // than feeding the updater the default and clobbering the stored value.
    await expect(repo.tx(
      tx => tx.setProperty('foreign-incompatible-target', shadowed, current => `${current ?? ''}!`),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow()

    // The incompatible stored value is preserved, not overwritten with a
    // default-derived value.
    expect(repo.block('foreign-incompatible-target').peek()!.properties[shadowed.name]).toBe(42)
  })
})

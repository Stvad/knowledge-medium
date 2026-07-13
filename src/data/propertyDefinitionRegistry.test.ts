import {describe, expect, it} from 'vitest'
import {ChangeScope, codecs, defineProperty} from '@/data/api'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'
import type {PropertyDefinitionMetadata} from '@/data/propertyDefinitionMetadata'
import {
  buildPropertyDefinitionRegistry,
} from '@/data/propertyDefinitionRegistry'
import {createPropertySchemaResolver} from '@/data/internals/propertySchemaResolution'
import {seedProperty} from '@/data/propertySeeds'

const WS = 'ws-property-registry'

const titleSeed = seedProperty({
  seedKey: 'system:kernel-data/property/title',
  revision: 1,
  name: 'title',
  preset: 'string',
  defaultValue: 'code-default',
  changeScope: ChangeScope.UserPrefs,
  hidden: false,
})

const competingTitleSeed = seedProperty({
  seedKey: 'system:other-plugin/property/title',
  revision: 1,
  name: titleSeed.name,
  preset: 'number',
  defaultValue: 5,
  changeScope: ChangeScope.BlockDefault,
})

const metadata = (
  fieldId: string,
  name: string,
  createdAt: number,
  overrides: Partial<PropertyDefinitionMetadata> = {},
): PropertyDefinitionMetadata => ({
  fieldId,
  workspaceId: WS,
  createdAt,
  name,
  changeScope: ChangeScope.BlockDefault,
  hidden: false,
  origin: 'user',
  ...overrides,
})

const build = (overrides: Partial<Parameters<typeof buildPropertyDefinitionRegistry>[0]> = {}) =>
  buildPropertyDefinitionRegistry({
    workspaceId: WS,
    legacySchemas: new Map(),
    projectedDefinitions: new Map(),
    seeds: [titleSeed],
    ...overrides,
  })

describe('property definition registry snapshot', () => {
  it('synthesizes declared behavior and resolves its identity per workspace with zero rows', () => {
    const snapshot = build()
    const result = createPropertySchemaResolver(snapshot).resolve(titleSeed)

    expect(snapshot.schemas.get('title')).toBe(titleSeed)
    expect(result).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({
        name: 'title',
        fieldId: propertyDefinitionBlockId(WS, titleSeed.seedKey),
        workspaceId: WS,
        defaultValue: 'code-default',
        changeScope: ChangeScope.UserPrefs,
        hidden: false,
        origin: 'kernel',
      }),
    })
  })

  it('uses block metadata but keeps locally declared behavior', () => {
    const fieldId = propertyDefinitionBlockId(WS, titleSeed.seedKey)
    const definition = metadata(fieldId, 'renamed title', 10, {
      seedKey: titleSeed.seedKey,
      hidden: true,
      origin: 'kernel',
      changeScope: ChangeScope.Automation,
    })
    const snapshot = build({
      legacySchemas: new Map([[titleSeed.name, titleSeed]]),
      projectedDefinitions: new Map([[fieldId, {metadata: definition}]]),
    })
    const result = createPropertySchemaResolver(snapshot).resolve(titleSeed)

    expect(snapshot.schemas.has('title')).toBe(false)
    expect(snapshot.schemas.get('renamed title')).toMatchObject({
      name: 'renamed title',
      defaultValue: 'code-default',
      changeScope: ChangeScope.UserPrefs,
    })
    expect(createPropertySchemaResolver(snapshot).resolve(titleSeed.name)).toEqual({
      status: 'identity-unavailable',
      reason: 'definition-unavailable',
    })
    expect(createPropertySchemaResolver(snapshot).resolve(definition.name)).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({fieldId, name: definition.name}),
    })
    expect(result).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({
        name: 'renamed title',
        fieldId,
        hidden: true,
        defaultValue: 'code-default',
        // Behavior remains code-owned in v1 even when the mirror differs.
        changeScope: ChangeScope.UserPrefs,
      }),
    })
  })

  it('resolves a name through the earliest synced definition and its field-id behavior', () => {
    const earlierSchema = defineProperty('status', {
      codec: codecs.string,
      defaultValue: 'winner-default',
      changeScope: ChangeScope.BlockDefault,
    })
    const laterSchema = defineProperty('status', {
      codec: codecs.number,
      defaultValue: 42,
      changeScope: ChangeScope.BlockDefault,
    })
    const later = metadata('user-b', 'status', 20)
    const earlier = metadata('user-a', 'status', 10)
    const snapshot = build({
      seeds: [],
      // Winner first, loser last: an ungated publication loop lets the loser
      // overwrite the already-selected definition in the name-keyed map.
      projectedDefinitions: new Map([
        ['user-a', {metadata: earlier, schema: earlierSchema}],
        ['user-b', {metadata: later, schema: laterSchema}],
      ]),
    })

    expect(snapshot.schemasByFieldId.get(earlier.fieldId)).toBe(earlierSchema)
    expect(snapshot.schemasByFieldId.get(later.fieldId)).toBe(laterSchema)
    expect(snapshot.schemas.get('status')).toBe(earlierSchema)
    const result = createPropertySchemaResolver(snapshot).resolve('status')
    expect(result).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({
        fieldId: 'user-a',
        name: 'status',
        origin: 'user',
        codec: earlierSchema.codec,
        defaultValue: earlierSchema.defaultValue,
      }),
    })
  })

  it('does not publish a later schema when the same-name winner is metadata-only', () => {
    const winner = metadata('user-a', 'status', 10)
    const loser = metadata('user-b', 'status', 20)
    const loserSchema = defineProperty('status', {
      codec: codecs.number,
      defaultValue: 42,
      changeScope: ChangeScope.BlockDefault,
    })
    const snapshot = build({
      seeds: [],
      legacySchemas: new Map([['status', defineProperty('status', {
        codec: codecs.string,
        defaultValue: 'legacy-default',
        changeScope: ChangeScope.BlockDefault,
      })]]),
      projectedDefinitions: new Map([
        [winner.fieldId, {metadata: winner}],
        [loser.fieldId, {metadata: loser, schema: loserSchema}],
      ]),
    })

    expect(snapshot.schemas.has('status')).toBe(false)
    expect(createPropertySchemaResolver(snapshot).resolve('status')).toEqual({
      status: 'identity-unavailable',
      reason: 'definition-unavailable',
    })
  })

  it('keeps declaration-only metadata identity-visible but behavior-unresolvable', () => {
    const definition = metadata('plugin-field', 'plugin:config', 10, {
      seedKey: 'system:missing-plugin/property/config',
      origin: 'plugin:system:missing-plugin',
    })
    const snapshot = build({
      seeds: [],
      projectedDefinitions: new Map([[
        definition.fieldId,
        {metadata: definition},
      ]]),
    })

    expect(snapshot.definitionsByFieldId.get('plugin-field')).toBe(definition)
    expect(createPropertySchemaResolver(snapshot).resolve('plugin:config')).toEqual({
      status: 'identity-unavailable',
      reason: 'definition-unavailable',
    })
  })

  it('does not admit another workspace metadata into the bound snapshot', () => {
    const foreign = metadata('foreign', 'foreign', 1, {workspaceId: 'ws-other'})
    const snapshot = build({
      projectedDefinitions: new Map([['foreign', {metadata: foreign}]]),
    })
    expect(snapshot.definitionsByFieldId).not.toHaveProperty('foreign')
    expect(snapshot.definitionsByFieldId.has('foreign')).toBe(false)
    expect(snapshot.schemasByFieldId.has('foreign')).toBe(false)
    expect(snapshot.schemas.has('foreign')).toBe(false)
  })

  it('rejects a structural handle that borrows another declaration seed key', () => {
    const forged = {...titleSeed, codec: codecs.number, defaultValue: 0}
    expect(createPropertySchemaResolver(build()).resolve(forged)).toEqual({
      status: 'identity-unavailable',
      reason: 'definition-unavailable',
    })
  })

  it('keeps ambient and resolved behavior on a behavior-backed user winner over a seed', () => {
    const seedFieldId = propertyDefinitionBlockId(WS, titleSeed.seedKey)
    const earlierUser = metadata('user-title', titleSeed.name, 1)
    const userSchema = defineProperty(titleSeed.name, {
      codec: codecs.number,
      defaultValue: 7,
      changeScope: ChangeScope.BlockDefault,
    })
    const laterSeed = metadata(seedFieldId, titleSeed.name, 2, {
      seedKey: titleSeed.seedKey,
      origin: 'kernel',
    })
    const snapshot = build({
      projectedDefinitions: new Map([
        ['user-title', {metadata: earlierUser, schema: userSchema}],
        [seedFieldId, {metadata: laterSeed}],
      ]),
    })

    expect(snapshot.schemasByFieldId.get(earlierUser.fieldId)).toBe(userSchema)
    expect(snapshot.schemas.get(titleSeed.name)).toBe(userSchema)
    expect(createPropertySchemaResolver(snapshot).resolve(titleSeed.name)).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({
        fieldId: earlierUser.fieldId,
        codec: userSchema.codec,
        defaultValue: userSchema.defaultValue,
      }),
    })
    expect(createPropertySchemaResolver(snapshot).resolve(titleSeed)).toEqual({
      status: 'identity-unavailable',
      reason: 'shadowed',
    })
  })

  it('does not fall through to seed behavior when its same-name winner is metadata-only', () => {
    const seedFieldId = propertyDefinitionBlockId(WS, titleSeed.seedKey)
    const earlierUser = metadata('user-title', titleSeed.name, 1)
    const laterSeed = metadata(seedFieldId, titleSeed.name, 2, {
      seedKey: titleSeed.seedKey,
      origin: 'kernel',
    })
    const snapshot = build({
      projectedDefinitions: new Map([
        ['user-title', {metadata: earlierUser}],
        [seedFieldId, {metadata: laterSeed}],
      ]),
    })

    expect(snapshot.schemas.has(titleSeed.name)).toBe(false)
    expect(createPropertySchemaResolver(snapshot).resolve(titleSeed.name)).toEqual({
      status: 'identity-unavailable',
      reason: 'definition-unavailable',
    })
    expect(createPropertySchemaResolver(snapshot).resolve(titleSeed)).toEqual({
      status: 'identity-unavailable',
      reason: 'shadowed',
    })
  })

  it('rejects duplicate seed identities instead of choosing by contribution order', () => {
    expect(() => build({seeds: [titleSeed, titleSeed]})).toThrow('duplicate seed key')
  })

  it('keeps same-name synthesis handles ambiguous until synced state selects a winner', () => {
    const snapshot = build({
      seeds: [titleSeed, competingTitleSeed],
      legacySchemas: new Map([[titleSeed.name, titleSeed]]),
    })
    const resolver = createPropertySchemaResolver(snapshot)

    expect(snapshot.schemas.has(titleSeed.name)).toBe(false)
    expect(resolver.resolve(titleSeed)).toEqual({
      status: 'identity-unavailable',
      reason: 'ambiguous',
    })
    expect(resolver.resolve(competingTitleSeed)).toEqual({
      status: 'identity-unavailable',
      reason: 'ambiguous',
    })
    expect(resolver.resolve(titleSeed.name)).toEqual({
      status: 'identity-unavailable',
      reason: 'ambiguous',
    })
  })

  it('publishes the synced winner among same-name seed declarations', () => {
    const fieldId = propertyDefinitionBlockId(WS, titleSeed.seedKey)
    const winner = metadata(fieldId, titleSeed.name, 10, {
      seedKey: titleSeed.seedKey,
      origin: 'kernel',
    })
    const snapshot = build({
      seeds: [titleSeed, competingTitleSeed],
      projectedDefinitions: new Map([[fieldId, {metadata: winner}]]),
    })
    const resolver = createPropertySchemaResolver(snapshot)

    expect(snapshot.schemas.get(titleSeed.name)).toBe(titleSeed)
    expect(resolver.resolve(titleSeed.name)).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({fieldId, codec: titleSeed.codec}),
    })
    expect(resolver.resolve(titleSeed)).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({fieldId}),
    })
    expect(resolver.resolve(competingTitleSeed)).toEqual({
      status: 'identity-unavailable',
      reason: 'shadowed',
    })
  })

  it('breaks an equal-createdAt tie between synced seeds by field id', () => {
    const candidates = [titleSeed, competingTitleSeed].map(seed => {
      const fieldId = propertyDefinitionBlockId(WS, seed.seedKey)
      return {
        seed,
        fieldId,
        definition: metadata(fieldId, seed.name, 10, {
          seedKey: seed.seedKey,
          origin: seed === titleSeed ? 'kernel' : 'plugin:system:other-plugin',
        }),
      }
    })
    const [winner, loser] = [...candidates].sort((a, b) =>
      a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId ? 1 : 0,
    )
    const snapshot = build({
      seeds: [titleSeed, competingTitleSeed],
      projectedDefinitions: new Map(
        [...candidates].reverse().map(candidate => [
          candidate.fieldId,
          {metadata: candidate.definition},
        ]),
      ),
    })
    const resolver = createPropertySchemaResolver(snapshot)
    const winnerResolution = winner!.seed === titleSeed
      ? resolver.resolve(titleSeed)
      : resolver.resolve(competingTitleSeed)
    const loserResolution = loser!.seed === titleSeed
      ? resolver.resolve(titleSeed)
      : resolver.resolve(competingTitleSeed)

    expect(snapshot.definitionsByName.get(titleSeed.name)?.[0]?.fieldId).toBe(winner!.fieldId)
    expect(snapshot.schemas.get(titleSeed.name)).toBe(winner!.seed)
    expect(resolver.resolve(titleSeed.name)).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({fieldId: winner!.fieldId, codec: winner!.seed.codec}),
    })
    expect(winnerResolution).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({fieldId: winner!.fieldId}),
    })
    expect(loserResolution).toEqual({
      status: 'identity-unavailable',
      reason: 'shadowed',
    })
  })

  it('keeps code behavior authoritative over a synced seed projector fallback', () => {
    const fieldId = propertyDefinitionBlockId(WS, titleSeed.seedKey)
    const definition = metadata(fieldId, titleSeed.name, 10, {
      seedKey: titleSeed.seedKey,
      origin: 'kernel',
    })
    const fallback = defineProperty(titleSeed.name, {
      codec: codecs.number,
      defaultValue: 99,
      changeScope: ChangeScope.BlockDefault,
    })
    const snapshot = build({
      projectedDefinitions: new Map([[fieldId, {metadata: definition, schema: fallback}]]),
    })

    expect(snapshot.schemasByFieldId.get(fieldId)).toBe(fallback)
    expect(snapshot.schemas.get(titleSeed.name)).toBe(titleSeed)
    expect(createPropertySchemaResolver(snapshot).resolve(titleSeed.name)).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({
        fieldId,
        codec: titleSeed.codec,
        defaultValue: titleSeed.defaultValue,
      }),
    })
  })

  it('treats a wrong-provenance deterministic-id occupant as an ordinary winner', () => {
    const fieldId = propertyDefinitionBlockId(WS, titleSeed.seedKey)
    const ordinary = metadata(fieldId, titleSeed.name, 10)
    const ordinarySchema = defineProperty(titleSeed.name, {
      codec: codecs.number,
      defaultValue: 7,
      changeScope: ChangeScope.BlockDefault,
    })
    const snapshot = build({
      projectedDefinitions: new Map([[
        fieldId,
        {metadata: ordinary, schema: ordinarySchema},
      ]]),
    })
    const resolver = createPropertySchemaResolver(snapshot)

    expect(snapshot.schemas.get(titleSeed.name)).toBe(ordinarySchema)
    expect(resolver.resolve(titleSeed.name)).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({fieldId, codec: ordinarySchema.codec, origin: 'user'}),
    })
    expect(resolver.resolve(titleSeed)).toEqual({
      status: 'identity-unavailable',
      reason: 'definition-unavailable',
    })
  })
})

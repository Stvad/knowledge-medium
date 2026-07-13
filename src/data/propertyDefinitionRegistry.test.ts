import {describe, expect, it} from 'vitest'
import {ChangeScope, codecs, defineProperty} from '@/data/api'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'
import type {PropertyDefinitionMetadata} from '@/data/propertyDefinitionMetadata'
import {
  buildPropertyDefinitionRegistry,
  type ProjectedPropertyDefinition,
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
      projectedDefinitions: new Map([[fieldId, {metadata: definition}]]),
    })
    const result = createPropertySchemaResolver(snapshot).resolve(titleSeed)

    expect(snapshot.schemas.has('title')).toBe(false)
    expect(snapshot.schemas.get('renamed title')).toMatchObject({
      name: 'renamed title',
      defaultValue: 'code-default',
      changeScope: ChangeScope.UserPrefs,
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
    const userSchema = defineProperty('status', {
      codec: codecs.string,
      defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
    })
    const later = metadata('user-b', 'status', 20)
    const earlier = metadata('user-a', 'status', 10)
    const projected: ProjectedPropertyDefinition = {
      metadata: earlier,
      schema: userSchema,
    }
    const snapshot = build({
      seeds: [],
      // The later definition has no locally-buildable behavior.
      projectedDefinitions: new Map([
        ['user-a', projected],
        ['user-b', {metadata: later}],
      ]),
    })

    const result = createPropertySchemaResolver(snapshot).resolve('status')
    expect(result).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({fieldId: 'user-a', name: 'status', origin: 'user'}),
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

  it('rejects a seeded handle shadowed by an earlier synced definition', () => {
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

    expect(createPropertySchemaResolver(snapshot).resolve(titleSeed)).toEqual({
      status: 'identity-unavailable',
      reason: 'shadowed',
    })
  })

  it('rejects duplicate seed identities instead of choosing by contribution order', () => {
    expect(() => build({seeds: [titleSeed, titleSeed]})).toThrow('duplicate seed key')
  })

  it('keeps same-name synthesis handles ambiguous until synced state selects a winner', () => {
    const competing = seedProperty({
      seedKey: 'system:other-plugin/property/title',
      revision: 1,
      name: titleSeed.name,
      preset: 'string',
      changeScope: ChangeScope.BlockDefault,
    })
    const resolver = createPropertySchemaResolver(build({seeds: [titleSeed, competing]}))

    expect(resolver.resolve(titleSeed)).toEqual({
      status: 'identity-unavailable',
      reason: 'ambiguous',
    })
    expect(resolver.resolve(competing)).toEqual({
      status: 'identity-unavailable',
      reason: 'ambiguous',
    })
    expect(resolver.resolve(titleSeed.name)).toEqual({
      status: 'identity-unavailable',
      reason: 'ambiguous',
    })
  })
})

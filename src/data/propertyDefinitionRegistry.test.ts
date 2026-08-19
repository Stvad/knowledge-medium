import {describe, expect, it, vi} from 'vitest'
import {ChangeScope, codecs, defineProperty, type AnyPropertyEditorOverride} from '@/data/api'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'
import type {PropertyDefinitionMetadata} from '@/data/propertyDefinitionMetadata'
import {
  buildPropertyDefinitionRegistry,
  resolveEditorOverride,
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

  it('pins a seed to its declared name, ignoring a stored name divergence', () => {
    // Seeds are non-renamable (user renames deferred to #288): a stored
    // property-schema:name that diverges from the declaration — from an older
    // client, an import, or a sync from such a device — must not move the
    // seed's effective name, or the structural type/alias membership index and
    // static-type panel sections desync from it.
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

    expect(snapshot.schemas.has('renamed title')).toBe(false)
    expect(snapshot.schemas.get('title')).toBe(titleSeed)
    expect(createPropertySchemaResolver(snapshot).resolve('renamed title')).toEqual({
      status: 'identity-unavailable',
      reason: 'definition-unavailable',
    })
    expect(createPropertySchemaResolver(snapshot).resolve(titleSeed.name)).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({fieldId, name: 'title'}),
    })
    expect(createPropertySchemaResolver(snapshot).resolve(titleSeed)).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({
        name: 'title',
        fieldId,
        // Only the name is pinned to the code seed; hidden still mirrors the row.
        hidden: true,
        defaultValue: 'code-default',
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

  it('keeps the seed authoritative over an earlier same-name user definition (no shadowing)', () => {
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

    // v1: a code-owned seed is unshadowable. The earlier same-name user block
    // still exists by field id, but it never competes for the name, so the
    // ambient map and both resolve paths select the seed's declared behavior.
    expect(snapshot.schemasByFieldId.get(earlierUser.fieldId)).toBe(userSchema)
    expect(snapshot.schemas.get(titleSeed.name)).toBe(titleSeed)
    expect(createPropertySchemaResolver(snapshot).resolve(titleSeed.name)).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({
        fieldId: seedFieldId,
        codec: titleSeed.codec,
        defaultValue: titleSeed.defaultValue,
      }),
    })
    expect(createPropertySchemaResolver(snapshot).resolve(titleSeed)).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({fieldId: seedFieldId}),
    })
  })

  it('resolves to the seed when an earlier same-name user winner is metadata-only (no shadowing)', () => {
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

    // A metadata-only same-name user winner no longer blocks the seed — it's
    // excluded from name selection, so the seed's declared behavior is published.
    expect(snapshot.schemas.get(titleSeed.name)).toBe(titleSeed)
    expect(createPropertySchemaResolver(snapshot).resolve(titleSeed.name)).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({fieldId: seedFieldId, codec: titleSeed.codec}),
    })
    expect(createPropertySchemaResolver(snapshot).resolve(titleSeed)).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({fieldId: seedFieldId}),
    })
  })

  it('rejects duplicate seed identities instead of choosing by contribution order', () => {
    expect(() => build({seeds: [titleSeed, titleSeed]})).toThrow('duplicate seed key')
  })

  it('drops the second of two same-name seeds and keeps building (no crash)', () => {
    // v1: property names must be unique across seeds. The first keeps the name;
    // the collider is dropped LOUDLY (not resolvable) — but the registry still
    // builds, so a duplicate dynamic-extension install can't brick the workspace.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const snapshot = build({seeds: [titleSeed, competingTitleSeed]})
      const resolver = createPropertySchemaResolver(snapshot)
      expect(resolver.resolve(titleSeed).status).toBe('resolved')
      expect(resolver.resolve(competingTitleSeed)).toEqual({
        status: 'identity-unavailable',
        reason: 'definition-unavailable',
      })
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('must be unique'))
    } finally {
      errors.mockRestore()
    }
  })

  it('keeps a dropped duplicate seed\'s earlier-materialized row from winning the name', () => {
    // The realistic collider: one extension materialized its seed's row BEFORE a
    // second same-name extension was enabled. `indexSeeds` drops the second seed,
    // but its persisted row (earlier createdAt) is still projected. It must NOT
    // out-sort the kept seed by createdAt and publish its own behavior — else the
    // "drop the collider" contract is a lie for any workspace that already stored
    // the loser's row.
    const droppedFieldId = propertyDefinitionBlockId(WS, competingTitleSeed.seedKey)
    const droppedRow = metadata(droppedFieldId, competingTitleSeed.name, 1, {
      seedKey: competingTitleSeed.seedKey,
    })
    const droppedSchema = defineProperty(competingTitleSeed.name, {
      codec: codecs.number,
      defaultValue: 7,
      changeScope: ChangeScope.BlockDefault,
    })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const snapshot = build({
        seeds: [titleSeed, competingTitleSeed],
        projectedDefinitions: new Map([[droppedFieldId, {metadata: droppedRow, schema: droppedSchema}]]),
      })

      // The kept (first) seed owns the name with its own string behavior — the
      // dropped row's number schema never surfaces.
      expect(snapshot.schemas.get(titleSeed.name)).toBe(titleSeed)
      expect(snapshot.definitionsByName.get(titleSeed.name)).toBeUndefined()
      expect(createPropertySchemaResolver(snapshot).resolve(titleSeed.name)).toEqual({
        status: 'resolved',
        schema: expect.objectContaining({
          fieldId: propertyDefinitionBlockId(WS, titleSeed.seedKey),
          codec: titleSeed.codec,
        }),
      })
      // The loser's row is still resolvable BY FIELD ID (shadowed, not erased).
      expect(snapshot.definitionsByFieldId.has(droppedFieldId)).toBe(true)
    } finally {
      errors.mockRestore()
    }
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

  it('excludes a wrong-provenance occupant of a seed id from the seed name (no shadowing)', () => {
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

    // A non-seed block squatting a seed's deterministic id can neither shadow
    // the seed's name (it's excluded from name selection) nor let the seed
    // materialize there (the id carries the wrong provenance), so the name is
    // simply unresolvable until the collision is cleared.
    expect(snapshot.schemas.has(titleSeed.name)).toBe(false)
    expect(resolver.resolve(titleSeed.name)).toEqual({
      status: 'identity-unavailable',
      reason: 'definition-unavailable',
    })
    expect(resolver.resolve(titleSeed)).toEqual({
      status: 'identity-unavailable',
      reason: 'definition-unavailable',
    })
  })
})

describe('resolveEditorOverride (seed-identity join, B′ §8)', () => {
  const overrideFor = (seedKey: string): AnyPropertyEditorOverride => ({seedKey, label: 'X'})

  it('joins a name to its winning definition’s seedKey', () => {
    const fieldId = propertyDefinitionBlockId(WS, titleSeed.seedKey)
    const snapshot = build({
      projectedDefinitions: new Map([[
        fieldId,
        {metadata: metadata(fieldId, titleSeed.name, 1, {seedKey: titleSeed.seedKey})},
      ]]),
    })
    const ui = overrideFor(titleSeed.seedKey)
    const overrides = new Map([[titleSeed.seedKey, ui]])
    expect(resolveEditorOverride(
      titleSeed.name, snapshot, overrides, snapshot.schemas.get(titleSeed.name),
    )).toBe(ui)
  })

  it('uses a lone unmaterialized seed declaration when no row is projected yet', () => {
    const snapshot = build()
    expect(snapshot.definitionsByName.has(titleSeed.name)).toBe(false)
    const ui = overrideFor(titleSeed.seedKey)
    const overrides = new Map([[titleSeed.seedKey, ui]])
    expect(resolveEditorOverride(
      titleSeed.name, snapshot, overrides, snapshot.schemas.get(titleSeed.name),
    )).toBe(ui)
  })

  it('returns undefined for a user row — its winner carries no seedKey', () => {
    const userSchema = defineProperty('notes', {
      codec: codecs.string, defaultValue: '', changeScope: ChangeScope.BlockDefault,
    })
    const snapshot = build({
      seeds: [],
      projectedDefinitions: new Map([[
        'field-user-notes',
        {metadata: metadata('field-user-notes', 'notes', 1), schema: userSchema},
      ]]),
    })
    const overrides = new Map([['some/property/x', overrideFor('some/property/x')]])
    expect(resolveEditorOverride('notes', snapshot, overrides, userSchema)).toBeUndefined()
  })

  it('falls back to the ambient seed declaration before a workspace is pinned', () => {
    const ui = overrideFor(titleSeed.seedKey)
    const overrides = new Map([[titleSeed.seedKey, ui]])
    // definitions=null (stage 0); the ambient schema entry is the seed itself.
    expect(resolveEditorOverride(titleSeed.name, null, overrides, titleSeed)).toBe(ui)
  })

  it('returns undefined when the name has no seed identity', () => {
    const plain = defineProperty('plain', {
      codec: codecs.string, defaultValue: '', changeScope: ChangeScope.BlockDefault,
    })
    const overrides = new Map([[titleSeed.seedKey, overrideFor(titleSeed.seedKey)]])
    expect(resolveEditorOverride('plain', null, overrides, plain)).toBeUndefined()
  })

  it('returns undefined when the seedKey resolves but no override is registered', () => {
    expect(resolveEditorOverride(titleSeed.name, null, new Map(), titleSeed)).toBeUndefined()
  })
})

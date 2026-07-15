// @vitest-environment node

import {describe, expect, it, vi} from 'vitest'
import {
  ChangeScope,
  codecs,
  defineProperty,
  PropertySchemaScopeMismatchError,
  type AnyPropertySchema,
} from '@/data/api'
import type {Block} from '@/data/block'
import {seedKeyProp, seedRevisionProp} from '@/data/properties'
import type {PropertyDefinitionMetadata} from '@/data/propertyDefinitionMetadata'
import {buildPropertyDefinitionRegistry} from '@/data/propertyDefinitionRegistry'
import {
  addProperty,
  deleteProperty,
  renameProperty,
  writeProperty,
} from './actions'

describe('property panel action visibility guards', () => {
  it('refuses every mutation path for intrinsic seed provenance fields', async () => {
    const set = vi.fn()
    const tx = vi.fn()
    const block = {
      id: 'block-1',
      set,
      repo: {
        propertyDefinitions: null,
        propertySchemas: new Map<string, AnyPropertySchema>([
          [seedKeyProp.name, seedKeyProp],
          [seedRevisionProp.name, seedRevisionProp],
        ]),
        tx,
      },
    } as unknown as Block
    const properties = {
      [seedKeyProp.name]: 'srs-rescheduling/property/config',
      [seedRevisionProp.name]: 3,
    }

    await writeProperty(block, seedKeyProp, 'tampered/property/key')
    await renameProperty({
      block,
      properties,
      schemas: block.repo.propertySchemas,
      uis: new Map(),
      oldName: seedKeyProp.name,
      newName: 'renamed-seed-key',
    })
    await deleteProperty({
      block,
      properties,
      schemas: block.repo.propertySchemas,
      uis: new Map(),
      name: seedRevisionProp.name,
    })

    expect(set).not.toHaveBeenCalled()
    expect(tx).not.toHaveBeenCalled()
  })

  it('refuses add and delete when only projected metadata marks an ordinary schema hidden', async () => {
    const schema = defineProperty<string>('secret', {
      codec: codecs.string,
      defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
    })
    const hidden: PropertyDefinitionMetadata = {
      fieldId: 'field-secret',
      workspaceId: 'ws',
      createdAt: 1,
      name: schema.name,
      changeScope: ChangeScope.BlockDefault,
      hidden: true,
      origin: 'user',
    }
    const propertyDefinitions = buildPropertyDefinitionRegistry({
      workspaceId: 'ws',
      legacySchemas: new Map([[schema.name, schema]]),
      projectedDefinitions: new Map([[hidden.fieldId, {metadata: hidden}]]),
      seeds: [],
    })
    const tx = vi.fn()
    const addSchema = vi.fn()
    const block = {
      repo: {propertyDefinitions, tx, userSchemas: {addSchema}},
    } as unknown as Block
    const schemas = propertyDefinitions.schemas
    const uis = new Map()
    const properties = {[schema.name]: 'private'}

    await expect(addProperty(block, schemas, uis, {
      name: schema.name,
      presetId: schema.codec.type,
    })).resolves.toBeUndefined()
    await deleteProperty({block, properties, schemas, uis, name: schema.name})

    expect(addSchema).not.toHaveBeenCalled()
    expect(tx).not.toHaveBeenCalled()
  })

  it('refuses renames from or to a hidden declaration-only definition', async () => {
    const hidden: PropertyDefinitionMetadata = {
      fieldId: 'field-secret',
      workspaceId: 'ws',
      createdAt: 1,
      name: 'secret',
      changeScope: ChangeScope.BlockDefault,
      hidden: true,
      origin: 'user',
    }
    const propertyDefinitions = buildPropertyDefinitionRegistry({
      workspaceId: 'ws',
      legacySchemas: new Map(),
      projectedDefinitions: new Map([[hidden.fieldId, {metadata: hidden}]]),
      seeds: [],
    })
    const tx = vi.fn()
    const block = {
      repo: {propertyDefinitions, tx},
    } as unknown as Block
    const properties = {secret: 'private', visible: 'public'}

    await renameProperty({
      block,
      properties,
      schemas: propertyDefinitions.schemas,
      uis: new Map(),
      oldName: 'secret',
      newName: 'renamed',
    })
    await renameProperty({
      block,
      properties,
      schemas: propertyDefinitions.schemas,
      uis: new Map(),
      oldName: 'visible',
      newName: 'secret',
    })

    expect(tx).not.toHaveBeenCalled()
  })

  it('refuses rename and delete for a visible declaration-only definition', async () => {
    const metadataOnly: PropertyDefinitionMetadata = {
      fieldId: 'field-srs-config',
      workspaceId: 'ws',
      createdAt: 1,
      name: 'srs:config',
      changeScope: ChangeScope.BlockDefault,
      hidden: false,
      origin: 'plugin:srs-rescheduling',
      seedKey: 'srs-rescheduling/property/config',
    }
    const propertyDefinitions = buildPropertyDefinitionRegistry({
      workspaceId: 'ws',
      legacySchemas: new Map(),
      projectedDefinitions: new Map([[
        metadataOnly.fieldId,
        {metadata: metadataOnly},
      ]]),
      seeds: [],
    })
    const tx = vi.fn()
    const addSchema = vi.fn()
    const block = {
      id: 'block-1',
      repo: {propertyDefinitions, tx, userSchemas: {addSchema}},
    } as unknown as Block
    const properties = {[metadataOnly.name]: {queue: ['block-2']}}
    // Simulate a stale render/action closure retained from before the atomic
    // registry snapshot became metadata-only.
    const staleSchema = defineProperty(metadataOnly.name, {
      codec: codecs.unsafeIdentity('object'),
      defaultValue: {},
      changeScope: ChangeScope.BlockDefault,
    })
    const staleSchemas = new Map([[staleSchema.name, staleSchema]])

    await expect(addProperty(block, staleSchemas, new Map(), {
      adopted: staleSchema,
      name: staleSchema.name,
      presetId: staleSchema.codec.type,
    })).resolves.toBeUndefined()

    await renameProperty({
      block,
      properties,
      schemas: staleSchemas,
      uis: new Map(),
      oldName: metadataOnly.name,
      newName: 'renamed-config',
    })
    await deleteProperty({
      block,
      properties,
      schemas: staleSchemas,
      uis: new Map(),
      name: metadataOnly.name,
    })

    expect(tx).not.toHaveBeenCalled()
    expect(addSchema).not.toHaveBeenCalled()
  })

  // A UserPrefs (allow, non-hidden) captured scope is the reachable case: a
  // UiState capture would be filtered as hidden before reaching the tx.
  const scopeDriftBlock = (resolvedScope: ChangeScope) => {
    const captured = defineProperty<string>('pref:foo', {
      codec: codecs.string,
      defaultValue: '',
      changeScope: ChangeScope.UserPrefs,
    })
    const update = vi.fn()
    const resolvePropertySchema = vi.fn(async () => ({...captured, changeScope: resolvedScope}))
    const tx = vi.fn(async (cb: (t: unknown) => Promise<void>) => {
      await cb({resolvePropertySchema, update})
    })
    const block = {
      id: 'block-1',
      repo: {propertyDefinitions: null, propertySchemas: new Map(), tx},
    } as unknown as Block
    return {captured, update, block}
  }

  it('rejects a delete whose captured scope policy differs from the live resolved scope', async () => {
    // Captured UserPrefs (allow) but the definition now resolves BlockDefault
    // (reject): raw tx.update would bypass the read-only gate without this check.
    const {captured, update, block} = scopeDriftBlock(ChangeScope.BlockDefault)
    await expect(deleteProperty({
      block,
      properties: {[captured.name]: 'v'},
      schemas: new Map([[captured.name, captured]]),
      uis: new Map(),
      name: captured.name,
    })).rejects.toThrow(PropertySchemaScopeMismatchError)
    expect(update).not.toHaveBeenCalled()
  })

  it('deletes when the captured and resolved scope policies match', async () => {
    const {captured, update, block} = scopeDriftBlock(ChangeScope.UserPrefs)
    await deleteProperty({
      block,
      properties: {[captured.name]: 'v'},
      schemas: new Map([[captured.name, captured]]),
      uis: new Map(),
      name: captured.name,
    })
    expect(update).toHaveBeenCalledWith('block-1', {properties: {}})
  })
})

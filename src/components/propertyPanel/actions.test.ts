// @vitest-environment node

import {describe, expect, it, vi} from 'vitest'
import {ChangeScope, codecs, defineProperty} from '@/data/api'
import type {Block} from '@/data/block'
import type {PropertyDefinitionMetadata} from '@/data/propertyDefinitionMetadata'
import {buildPropertyDefinitionRegistry} from '@/data/propertyDefinitionRegistry'
import {
  addProperty,
  deleteProperty,
  renameProperty,
} from './actions'

describe('property panel action visibility guards', () => {
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
})

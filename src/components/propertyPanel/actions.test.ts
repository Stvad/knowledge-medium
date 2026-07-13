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
})

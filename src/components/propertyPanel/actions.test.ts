// @vitest-environment node

import {describe, expect, it, vi} from 'vitest'
import {
  ChangeScope,
  codecs,
  defineProperty,
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

  // deleteProperty now routes a SCHEMA'd key through tx.unsetProperty, which
  // owns the scope-consistency guard (resolved scope vs the tx's admitted
  // scope) — the drift protection that used to be inlined here lives in the
  // engine now (see the unsetProperty scope-mismatch test). A SCHEMA-LESS key
  // has no resolvable definition, so it stays a raw tx.update.
  // `get` returns the CURRENT (in-tx) bag — distinct from the snapshot the
  // caller passes as `args.properties`, so a test can prove the write is built
  // from the fresh read, not the stale snapshot.
  const deleteBlock = (properties: Record<string, unknown> = {}) => {
    const update = vi.fn()
    const unsetProperty = vi.fn()
    const get = vi.fn(async () => ({id: 'block-1', properties}))
    const tx = vi.fn(async (cb: (t: unknown) => Promise<void>) => {
      await cb({update, unsetProperty, get})
    })
    const block = {
      id: 'block-1',
      repo: {propertyDefinitions: null, propertySchemas: new Map(), tx},
    } as unknown as Block
    return {update, unsetProperty, get, block}
  }

  it('routes a schema-backed delete through the scope-checked unsetProperty, not a raw tx.update', async () => {
    const schema = defineProperty<string>('pref:foo', {
      codec: codecs.string,
      defaultValue: '',
      changeScope: ChangeScope.UserPrefs,
    })
    const {update, unsetProperty, block} = deleteBlock()
    await deleteProperty({
      block,
      properties: {[schema.name]: 'v'},
      schemas: new Map([[schema.name, schema]]),
      uis: new Map(),
      name: schema.name,
    })
    expect(unsetProperty).toHaveBeenCalledWith('block-1', schema)
    expect(update).not.toHaveBeenCalled()
  })

  it('removes a schema-less key with a raw tx.update (no resolvable definition to unset through)', async () => {
    const {update, unsetProperty, block} = deleteBlock({'unregistered:key': 'v', keep: 'me'})
    await deleteProperty({
      block,
      properties: {'unregistered:key': 'v', keep: 'me'},
      schemas: new Map(), // no schema for the deleted name
      uis: new Map(),
      name: 'unregistered:key',
    })
    expect(update).toHaveBeenCalledWith('block-1', {properties: {keep: 'me'}})
    expect(unsetProperty).not.toHaveBeenCalled()
  })

  // The raw whole-bag write must be built from the CURRENT bag read inside the
  // tx, not the panel's captured `args.properties` — otherwise a property some
  // other write changed between the panel opening and this commit is clobbered
  // back to its snapshot value.
  it('renameProperty writes the FRESH in-tx bag, not the stale panel snapshot', async () => {
    const {update, block} = deleteBlock({a: 1, b: 99}) // `b` concurrently changed
    await renameProperty({
      block,
      properties: {a: 1, b: 2}, // stale snapshot
      schemas: new Map(),
      uis: new Map(),
      oldName: 'a',
      newName: 'c',
    })
    expect(update).toHaveBeenCalledWith('block-1', {properties: {b: 99, c: 1}})
  })

  it('deleteProperty (schema-less) writes the FRESH in-tx bag, not the stale snapshot', async () => {
    const {update, block} = deleteBlock({a: 1, b: 99}) // `b` concurrently changed
    await deleteProperty({
      block,
      properties: {a: 1, b: 2}, // stale snapshot
      schemas: new Map(),
      uis: new Map(),
      name: 'a',
    })
    expect(update).toHaveBeenCalledWith('block-1', {properties: {b: 99}})
  })
})

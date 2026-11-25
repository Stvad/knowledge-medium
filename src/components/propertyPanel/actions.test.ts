// @vitest-environment node

import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  ChangeScope,
  codecs,
  defineProperty,
  type AnyPropertySchema,
} from '@/data/api'
import type {Block} from '@/data/block'
import {presetIdProp, propertyChangeScopeProp, seedKeyProp, seedRevisionProp} from '@/data/properties'
import type {PropertyDefinitionMetadata} from '@/data/propertyDefinitionMetadata'
import {buildPropertyDefinitionRegistry} from '@/data/propertyDefinitionRegistry'
import {getOrCreatePropertiesPage} from '@/data/propertiesPage'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {
  addProperty,
  deleteProperty,
  resolveAndWriteProperty,
  writeProperty,
} from './actions'

describe('property panel writes through a retained editor', () => {
  let database: TestDb
  let block: Block
  let schema: Awaited<ReturnType<Block['repo']['userSchemas']['addSchema']>>

  beforeAll(async () => { database = await createTestDb() })
  afterAll(async () => { await database.cleanup() })
  beforeEach(async () => {
    await resetTestDb(database.db)
    await database.db.execute(
      "INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration) VALUES ('ws', 'Test', 'user', 1, 1, 'none', 'children')",
    )
    const {repo} = createTestRepo({db: database.db, extensions: [], newId: () => crypto.randomUUID()})
    repo.setActiveWorkspaceId('ws')
    await getOrCreatePropertiesPage(repo, 'ws')
    schema = await repo.userSchemas.addSchema({name: 'test:value', presetId: 'string'})
    await repo.tx(tx => tx.create({
      id: 'owner', workspaceId: 'ws', parentId: null, orderKey: 'a0', content: 'Owner',
    }), {scope: ChangeScope.BlockDefault})
    block = repo.block('owner')
    await block.set(schema, 'original')
  })

  it.each(['owner deleted', 'same definition retyped', 'scope drift', 'read-only repo'])(
    'refuses plain and resolving writes after %s', async stale => {
      const {repo} = block
      const definition = repo.block(schema.fieldId)
      switch (stale) {
        case 'owner deleted':
          await repo.tx(tx => tx.delete(block.id), {scope: ChangeScope.BlockDefault})
          expect(await database.db.get('SELECT deleted FROM blocks WHERE id = ?', [block.id]))
            .toEqual({deleted: 1})
          break
        case 'same definition retyped':
          await definition.set(presetIdProp, 'optional-string')
          await vi.waitFor(() => expect(repo.propertySchemas.get(schema.name)?.codec).toBe(codecs.optionalString))
          break
        case 'scope drift':
          await definition.set(propertyChangeScopeProp, ChangeScope.UserPrefs)
          await vi.waitFor(() => expect(repo.propertySchemas.get(schema.name)?.changeScope).toBe(ChangeScope.UserPrefs))
          break
        case 'read-only repo':
          repo.setReadOnly(true)
          break
      }

      const before = await database.db.getAll('SELECT * FROM blocks ORDER BY id')
      const resolve = vi.fn(async () => 'replacement')
      await expect(writeProperty(block, schema, 'replacement')).resolves.toBe(false)
      expect(await database.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
      await expect(resolveAndWriteProperty(block, schema, resolve)).resolves.toBe(false)
      expect(resolve).not.toHaveBeenCalled()
      expect(await database.db.getAll('SELECT * FROM blocks ORDER BY id')).toEqual(before)
    },
  )

  it('checks read-only policy again in the transaction before resolving a value', async () => {
    const {repo} = block
    const transact = repo.tx.bind(repo)
    const transaction = vi.spyOn(repo, 'tx').mockImplementationOnce((write, options) =>
      transact(async tx => {
        repo.setReadOnly(true)
        return write(tx)
      }, options))
    const resolve = vi.fn(async () => 'replacement')
    try {
      await expect(resolveAndWriteProperty(block, schema, resolve)).resolves.toBe(false)
      expect(transaction).toHaveBeenCalledOnce()
      expect(resolve).not.toHaveBeenCalled()
    } finally {
      transaction.mockRestore()
    }
    expect(await block.get(schema)).toBe('original')
  })
})

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
    const resolve = vi.fn(async () => 'tampered/property/key')
    await expect(resolveAndWriteProperty(block, seedKeyProp, resolve)).resolves.toBe(false)
    await deleteProperty({
      block,
      properties,
      schemas: block.repo.propertySchemas,
      uis: new Map(),
      name: seedRevisionProp.name,
    })

    expect(set).not.toHaveBeenCalled()
    expect(tx).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
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

  it('refuses add and delete for a visible declaration-only definition', async () => {
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

    const resolve = vi.fn(async () => ({}))
    await expect(resolveAndWriteProperty(block, staleSchema, resolve)).resolves.toBe(false)

    await deleteProperty({
      block,
      properties,
      schemas: staleSchemas,
      uis: new Map(),
      name: metadataOnly.name,
    })

    expect(tx).not.toHaveBeenCalled()
    expect(addSchema).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
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

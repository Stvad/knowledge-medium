// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@/test/waitFor'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import {
  ChangeScope,
  codecs,
  seedProperty,
  seedType,
  type BlockReference,
} from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams } from '@/data/blockSchema'
import { typesProp } from '@/data/properties'
import {
  TYPED_BLOCKS_LIVE_CHANNEL,
  TYPED_BLOCKS_STRUCTURE_CHANNEL,
  TYPED_BLOCKS_PROPERTY_CHANNEL,
  typedBlocksLiveKey,
  typedBlocksStructureKey,
  typedBlocksPropertyKey,
} from '@/data/invalidation'
import { definitionSeedsFacet, KERNEL_QUERYABLE_FIELDS, queryableFieldsFacet, typeSeedsFacet, type QueryableField } from '../facets'
import { kernelDataExtension } from '../kernelDataExtension'
import { Repo } from '../repo'
import { compileTypedBlockQuery } from './typedBlockQuery'
import type { AnyPropertySchema, ResolvedTypedBlockQuery } from '@/data/api'
import { trackTestRepo } from '@/data/test/testRepoScope'
import { USER_SCHEMAS_PROJECTOR_ID } from '@/data/userSchemasService'
import { propertyDefinitionBlockId } from '@/data/definitionSeeds'
import { LoaderHandle } from './handleStore'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'

// Test property fixtures — code-owned seeds so they resolve by name in the
// property registry (the type-lift that used to surface a type's embedded
// schemas is gone; a property must be a seed to be queryable/resolvable).
const statusProp = seedProperty({
  seedKey: 'test/property/status', revision: 1, name: 'status',
  preset: 'string', defaultValue: 'open', changeScope: ChangeScope.BlockDefault,
})

const doneProp = seedProperty({
  seedKey: 'test/property/done', revision: 1, name: 'done',
  preset: 'boolean', defaultValue: false, changeScope: ChangeScope.BlockDefault,
})

const priorityProp = seedProperty({
  seedKey: 'test/property/priority', revision: 1, name: 'priority',
  preset: 'number', defaultValue: 0, changeScope: ChangeScope.BlockDefault,
})

const dueProp = seedProperty({
  seedKey: 'test/property/due', revision: 1, name: 'due',
  preset: 'date', defaultValue: undefined, changeScope: ChangeScope.BlockDefault,
})

const weirdNameProp = seedProperty({
  seedKey: 'test/property/weird-name', revision: 1, name: 'weird:name.with-dot-hyphen',
  preset: 'string', defaultValue: '', changeScope: ChangeScope.BlockDefault,
})

const labelsProp = seedProperty({
  seedKey: 'test/property/labels', revision: 1, name: 'labels',
  preset: 'string-list', defaultValue: [], changeScope: ChangeScope.BlockDefault,
})

const reviewerProp = seedProperty({
  seedKey: 'test/property/reviewer', revision: 1, name: 'reviewer',
  preset: 'ref', defaultValue: '', changeScope: ChangeScope.BlockDefault,
})

const reviewersProp = seedProperty({
  seedKey: 'test/property/reviewers', revision: 1, name: 'reviewers',
  preset: 'refList', defaultValue: [], changeScope: ChangeScope.BlockDefault,
})

const queryProps = [statusProp, doneProp, priorityProp, dueProp, weirdNameProp, labelsProp, reviewerProp, reviewersProp]

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  // Shared DB opened once per file, reset between tests; fresh Repo per test.
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = trackTestRepo(new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
    // Mnemonic ids — see the MNEMONIC IDS note in createTestRepo.ts.
    blockIdPolicy: 'any',
  }))
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    ...queryProps.map(prop => definitionSeedsFacet.of(prop, {source: 'test'})),
    typeSeedsFacet.of(seedType({
      seedKey: 'test/type/typed-block-query-props',
      revision: 1,
      id: 'test:typed-block-query-props',
      label: 'Typed block query props',
      properties: queryProps,
    }), {source: 'test'}),
  ]))
  repo.setActiveWorkspaceId(WS)
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })
// Dispose the per-test Repo's sync observer (some tests start it explicitly)
// so its db.onChange subscription doesn't leak onto the shared DB.
afterEach(() => { env.repo.stopSyncObserver() })

const create = async (args: {
  id: string
  workspaceId?: string
  parentId?: string | null
  orderKey?: string
  types?: readonly string[]
  properties?: Record<string, unknown>
  references?: BlockReference[]
}) => {
  const properties = {...(args.properties ?? {})}
  if (args.types !== undefined) {
    properties[typesProp.name] = typesProp.codec.encode(args.types)
  }
  await env.repo.tx(tx => tx.create({
    id: args.id,
    workspaceId: args.workspaceId ?? WS,
    parentId: args.parentId ?? null,
    orderKey: args.orderKey ?? `k-${args.id}`,
    properties,
    references: args.references ?? [],
  }), {
    scope: ChangeScope.BlockDefault,
    ...(args.workspaceId !== undefined && args.workspaceId !== WS ? {allowUnloadedWorkspace: true} : {}),
  })
}

const ids = (rows: readonly {id: string}[]) => rows.map(row => row.id)

describe('hydrated typedBlocks limit', () => {
  it('limits both single-type and multi-type results after ordering', async () => {
    await create({id: 'first', types: ['todo']})
    await create({id: 'second', types: ['todo', 'task']})
    await create({id: 'third', types: ['task']})
    expect(ids(await env.repo.query.typedBlocks({workspaceId: WS, types: ['todo'], limit: 1}).load())).toEqual(['first'])
    expect(ids(await env.repo.query.typedBlocks({workspaceId: WS, types: ['todo', 'task'], limit: 2}).load())).toEqual(['first', 'second'])
    expect(ids(await env.repo.query.typedBlocks({workspaceId: WS, types: ['todo'], limit: 0}).load())).toEqual([])
  })
})

describe('typed queries for table rows', () => {
  it.each([undefined, 'created-asc', 'created-desc'] as const)('reorders limited ids after a synced creation-time correction (%s)', async order => {
    env.repo.startSyncObserver({throttleMs: 0})
    const put = async (id: string, createdAt: number, updatedAt: number) => {
      await env.h.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams({
        id, workspaceId: WS, parentId: 'parent', orderKey: id, content: '',
        properties: {}, references: [], createdAt, updatedAt, userUpdatedAt: 1,
        createdBy: 'remote', updatedBy: 'remote', deleted: false,
      }))
      await env.repo.flushSyncObserver()
    }
    await put('first', 10, 10)
    await put('second', 20, 20)
    const query = {workspaceId: WS, parentId: 'parent', order}
    const handle = env.repo.query.typedBlockIds({...query, limit: 1})
    expect(await handle.load()).toEqual([order === 'created-desc' ? 'second' : 'first'])
    const unsubscribe = handle.subscribe(() => {})
    try {
      await put('second', 5, 30)
      await waitFor(() => expect(handle.peek()).toEqual([order === 'created-desc' ? 'first' : 'second']))
    } finally {
      unsubscribe()
    }
  })

  it('treats an unconstrained OR alternative as true and preserves the outer query', async () => {
    await create({id: 'first', types: ['entry'], properties: {status: 'open'}})
    await create({id: 'second', types: ['entry']})
    await create({id: 'outside'})
    for (const anyOf of [[{}], [{where: {status: 'open'}}, {scope: 'ancestor', where: {}}]] as const) {
      const query = {workspaceId: WS, types: ['entry'], anyOf}
      expect(await env.repo.query.typedBlockIds(query).load()).toEqual(['first', 'second'])
      expect(await env.repo.query.typedBlockCount(query).load()).toBe(2)
    }
  })

  it.each(['created', 'updated'])('refuses a date-only timestamp operand for %s', async name => {
    for (const value of ['2026-01-01', {lte: '2026-01-01'}, {between: [0, '2026-01-01']}]) {
      const query = {workspaceId: WS, where: {[name]: value}}
      await expect(env.repo.query.typedBlockIds(query).load()).rejects.toThrow(/date-only.*instant/i)
    }
  })

  it('validates field expression params and placeholders before executing SQL', () => {
    const name = 'test:expression'
    const compile = (sql: string, params: unknown) => {
      const field: QueryableField = {
        name, value: () => ({sql, params: params as readonly unknown[]}), encode: Number,
        dependencies: [workspaceId => ({kind: 'workspace', workspaceId})],
      }
      return compileTypedBlockQuery({workspaceId: WS, where: {[name]: 5}},
        {properties: new Map(), fields: new Map([[name, field]])})
    }
    expect(() => compile('?', 'x')).toThrow(/params.*array/)
    expect(() => compile('? + ?', [1])).toThrow(/placeholder/)
    expect(() => compile('?', [1, 2])).toThrow(/placeholder/)
    expect(() => compile('?2', [1])).toThrow(/anonymous/)
    expect(() => compile(':val', [])).toThrow(/anonymous/)
    expect(compile("(SELECT a$b FROM (SELECT ? AS a$b)) + length('it''s ?') /* ? */", [1]).params).toEqual([WS, 1, 5])
  })

  it('limits direct children after outline ordering while counting all live matches', async () => {
    await create({id: 'parent'})
    await create({id: 'other-parent'})
    await create({id: 'a', parentId: 'parent', orderKey: 'b', types: ['entry']})
    await create({id: 'c', parentId: 'parent', orderKey: 'a', types: ['entry']})
    await create({id: 'b', parentId: 'parent', orderKey: 'a', types: ['entry']})
    await create({id: 'deleted', parentId: 'parent', orderKey: 'A', types: ['entry']})
    await create({id: 'nested', parentId: 'b', orderKey: 'A', types: ['entry']})
    await create({id: 'outside', parentId: 'other-parent', orderKey: 'A', types: ['entry']})
    await create({id: 'untyped', parentId: 'parent', orderKey: 'A'})
    await env.repo.tx(tx => tx.delete('deleted'), {scope: ChangeScope.BlockDefault})

    const query = {workspaceId: WS, parentId: 'parent', order: 'outline', types: ['entry']} as const
    expect(await env.repo.query.typedBlockIds(query).load()).toEqual(['b', 'c', 'a'])
    expect(await env.repo.query.typedBlockIds({...query, limit: 2}).load()).toEqual(['b', 'c'])
    expect(ids(await env.repo.query.typedBlocks({...query, limit: 2}).load())).toEqual(['b', 'c'])
    expect(await env.repo.query.typedBlockIds({...query, limit: 0}).load()).toEqual([])
    expect(await env.repo.query.typedBlockCount(query).load()).toBe(3)
    void (() => {
      // @ts-expect-error Count always covers the complete match set.
      env.repo.query.typedBlockCount({...query, limit: 2})
    })
  })

  it('uses a direct parent to bound the ancestor walk before limiting', async () => {
    await create({id: 'parent', properties: {[statusProp.name]: 'open'}})
    await create({id: 'first', parentId: 'parent', orderKey: 'a'})
    await create({id: 'second', parentId: 'parent', orderKey: 'b'})
    await create({id: 'descendant', parentId: 'first', orderKey: 'A'})
    const query = {
      workspaceId: WS,
      parentId: 'parent',
      order: 'outline',
      match: [{scope: 'ancestor', where: {[statusProp.name]: 'open'}}],
    } as const
    expect(await env.repo.query.typedBlockIds({...query, limit: 1}).load()).toEqual(['first'])
    expect(ids(await env.repo.query.typedBlocks(query).load())).toEqual(['first', 'second'])
    expect(await env.repo.query.typedBlockCount(query).load()).toBe(2)
  })

  it('sorts ASCII text without case and keeps accented letters after z', async () => {
    await create({id: 'parent'})
    for (const word of ['Banana', 'apple', 'zebra', 'Éclair']) {
      await create({id: word, parentId: 'parent', properties: {[statusProp.name]: word}})
    }
    for (const direction of ['asc', 'desc'] as const) {
      const ordered = ['apple', 'Banana', 'zebra', 'Éclair']
      expect(await env.repo.query.typedBlockIds({
        workspaceId: WS, parentId: 'parent', order: {property: statusProp.name, direction},
      }).load()).toEqual(direction === 'asc' ? ordered : ordered.reverse())
    }
  })

  it('sorts numeric cells in SQL with deterministic ties and treats malformed values as missing', async () => {
    await create({id: 'parent'})
    await create({id: 'a-ten', parentId: 'parent', properties: {[priorityProp.name]: 10}})
    await create({id: 'c-two', parentId: 'parent', properties: {[priorityProp.name]: 2}})
    await create({id: 'b-two', parentId: 'parent', properties: {[priorityProp.name]: 2}})
    await create({id: 'empty', parentId: 'parent'})
    await create({id: 'malformed', parentId: 'parent'})
    // The stored projection can outlive a schema change and carry an old shape.
    await env.h.db.writeTransaction(tx => tx.execute(
      'UPDATE blocks SET properties_json = ? WHERE id = ?',
      [JSON.stringify({[priorityProp.name]: '1'}), 'malformed'],
    ))

    const query = {workspaceId: WS, parentId: 'parent'}
    const asc = {...query, order: {property: priorityProp.name, direction: 'asc'}} as const
    const desc = {...query, order: {property: priorityProp.name, direction: 'desc'}} as const
    const ascending = ['b-two', 'c-two', 'a-ten', 'empty', 'malformed']
    const descending = ['a-ten', 'b-two', 'c-two', 'empty', 'malformed']
    expect(await env.repo.query.typedBlockIds(asc).load()).toEqual(ascending)
    expect(ids(await env.repo.query.typedBlocks(asc).load())).toEqual(ascending)
    expect(await env.repo.query.typedBlockIds(desc).load()).toEqual(descending)
    expect(ids(await env.repo.query.typedBlocks(desc).load())).toEqual(descending)
    expect(await env.repo.query.typedBlockIds({...asc, limit: 3}).load()).toEqual(ascending.slice(0, 3))
    expect(await env.repo.query.typedBlockIds({...desc, limit: 3}).load()).toEqual(descending.slice(0, 3))
    expect(await env.repo.query.typedBlockCount(desc).load()).toBe(ascending.length)
  })

  it('keeps outline ids quiet for irrelevant edits and follows reorders and moves', async () => {
    await create({id: 'parent'})
    await create({id: 'other-parent'})
    await create({id: 'a', parentId: 'parent', orderKey: 'a'})
    await create({id: 'b', parentId: 'parent', orderKey: 'b'})
    const handle = env.repo.query.typedBlockIds({
      workspaceId: WS, parentId: 'parent', order: 'outline', propertyChildren: 'none',
    })
    expect(await handle.load()).toEqual(['a', 'b'])
    const unsubscribe = handle.subscribe(() => {})
    try {
      const before = env.repo.handleStore.metrics.loaderInvalidations
      await env.repo.tx(tx => tx.update('a', {content: 'edited'}), {scope: ChangeScope.BlockDefault})
      await create({id: 'elsewhere', parentId: 'other-parent'})
      await env.repo.tx(
        tx => tx.move('elsewhere', {parentId: null, orderKey: 'a'}), {scope: ChangeScope.BlockDefault},
      )
      expect(env.repo.handleStore.metrics.loaderInvalidations).toBe(before)

      await env.repo.tx(
        tx => tx.move('b', {parentId: 'parent', orderKey: 'A'}), {scope: ChangeScope.BlockDefault},
      )
      await waitFor(() => expect(handle.peek()).toEqual(['b', 'a']))
      await env.repo.tx(
        tx => tx.move('b', {parentId: 'other-parent', orderKey: 'x'}), {scope: ChangeScope.BlockDefault},
      )
      await waitFor(() => expect(handle.peek()).toEqual(['a']))
      await env.repo.tx(
        tx => tx.move('elsewhere', {parentId: 'parent', orderKey: 'A'}), {scope: ChangeScope.BlockDefault},
      )
      await waitFor(() => expect(handle.peek()).toEqual(['elsewhere', 'a']))
    } finally {
      unsubscribe()
    }
  })

  it('invalidates limited property-sort ids for a sort-key edit beyond the limit', async () => {
    await create({id: 'first', types: ['entry'], properties: {[priorityProp.name]: 1}})
    await create({id: 'second', types: ['entry'], properties: {[priorityProp.name]: 2}})
    const query = {
      workspaceId: WS, types: ['entry'], order: {property: priorityProp.name, direction: 'asc'},
    } as const
    const handle = env.repo.query.typedBlockIds({...query, limit: 1})
    const count = env.repo.query.typedBlockCount(query)
    expect(await handle.load()).toEqual(['first'])
    expect(await count.load()).toBe(2)
    const unsubscribers = [handle.subscribe(() => {}), count.subscribe(() => {})]
    try {
      const before = env.repo.handleStore.metrics.loaderInvalidations
      await env.repo.tx(tx => tx.update('first', {properties: {
        [typesProp.name]: ['entry'], [priorityProp.name]: 1, [statusProp.name]: 'edited',
      }}), {scope: ChangeScope.BlockDefault})
      expect(env.repo.handleStore.metrics.loaderInvalidations).toBe(before)
      await env.repo.tx(tx => tx.setProperty('second', priorityProp, 0), {scope: ChangeScope.BlockDefault})
      expect(env.repo.handleStore.metrics.loaderInvalidations).toBe(before + 1)
      await waitFor(() => expect(handle.peek()).toEqual(['second']))
    } finally {
      unsubscribers.forEach(unsubscribe => unsubscribe())
    }
  })

  it('reorders mounted limited ids when a synced definition changes the sort codec', async () => {
    const property = 'custom-sort'
    await env.repo.whenPropertyDefinitionsReady(WS)
    env.repo.startSyncObserver({throttleMs: 0})
    const syncDefinition = async (preset: string, updatedAt: number) => {
      await env.h.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams({
        id: 'sort-definition', workspaceId: WS, parentId: null, orderKey: 'a0', content: '',
        properties: {types: ['property-schema'], 'property-schema:name': property, 'property-schema:preset': preset},
        references: [], createdAt: 1, updatedAt, userUpdatedAt: updatedAt,
        createdBy: 'remote', updatedBy: 'remote', deleted: false,
      }))
      await env.repo.flushSyncObserver()
      await waitFor(() => expect(env.repo.propertySchemas.get(property)?.codec.type).toBe(preset))
    }
    await syncDefinition('string', 1)
    await create({id: 'text-value', types: ['entry']})
    await create({id: 'numeric-value', types: ['entry']})
    await env.h.db.writeTransaction(tx => tx.execute(
      `UPDATE blocks SET properties_json = json_set(properties_json, '$."custom-sort"',
         CASE id WHEN 'numeric-value' THEN 2 ELSE '2' END)
       WHERE id IN ('numeric-value', 'text-value')`,
    ))

    const handle = env.repo.query.typedBlockIds({
      workspaceId: WS, types: ['entry'], order: {property, direction: 'asc'}, limit: 1,
    })
    expect(await handle.load()).toEqual(['text-value'])
    const unsubscribe = handle.subscribe(() => {})
    try {
      await syncDefinition('number', 2)
      expect(await env.h.db.getAll(
        'SELECT id, json_extract(properties_json, ?) AS value FROM blocks WHERE id IN (?, ?) ORDER BY id',
        ['$."custom-sort"', 'numeric-value', 'text-value'],
      )).toEqual([{id: 'numeric-value', value: 2}, {id: 'text-value', value: '2'}])
      await waitFor(() => expect(handle.peek()).toEqual(['numeric-value']))
    } finally {
      unsubscribe()
    }
  })

  it('uses the workspace sort codec and field recognition after switching workspaces', async () => {
    const property = 'custom-sort'
    const definition = {types: ['property-schema'], 'property-schema:name': property}
    await env.repo.whenPropertyDefinitionsReady(WS)
    await create({id: 'definition-a', properties: {...definition, 'property-schema:preset': 'string'}})
    await create({id: 'malformed-a', properties: {...definition, 'property-schema:name': ''}})
    await create({id: 'parent-a'})
    await create({id: 'text-a', parentId: 'parent-a', properties: {[property]: '2'}})
    await create({id: 'number-a', parentId: 'parent-a'})
    await create({id: 'field-a', parentId: 'parent-a'})
    await create({id: 'plain-a', parentId: 'parent-a'})
    await env.repo.tx(async tx => {
      await tx.stampReferenceTarget('field-a', 'definition-a', true)
      await tx.stampReferenceTarget('plain-a', 'malformed-a', true)
    }, {scope: ChangeScope.BlockDefault})
    await waitFor(() => {
      expect(env.repo.propertySchemas.get(property)?.codec.type).toBe('string')
      expect(env.repo.propertyDefinitions?.unparseableDefinitionIds.has('malformed-a')).toBe(true)
    })
    const order = {property, direction: 'asc'} as const
    const queryA = {workspaceId: WS, parentId: 'parent-a', propertyChildren: 'none', order} as const
    expect(await env.repo.query.typedBlockIds({...queryA, limit: 1}).load()).toEqual(['text-a'])

    env.repo.setActiveWorkspaceId(OTHER_WS)
    await env.repo.whenPropertyDefinitionsReady(OTHER_WS)
    await create({id: 'definition-b', workspaceId: OTHER_WS, properties: {...definition, 'property-schema:preset': 'number'}})
    await create({id: 'parent-b', workspaceId: OTHER_WS})
    await create({id: 'a-text-b', workspaceId: OTHER_WS, parentId: 'parent-b'})
    await create({id: 'z-number-b', workspaceId: OTHER_WS, parentId: 'parent-b'})
    await env.h.db.writeTransaction(async tx => {
      for (const [id, value] of [['number-a', 2], ['z-number-b', 2], ['a-text-b', '2']]) {
        await tx.execute('UPDATE blocks SET properties_json = ? WHERE id = ?', [JSON.stringify({[property]: value}), id])
      }
    })
    await waitFor(() => expect(env.repo.propertySchemas.get(property)?.codec.type).toBe('number'))

    expect(await env.repo.query.typedBlockIds({workspaceId: OTHER_WS, parentId: 'parent-b', order}).load())
      .toEqual(['z-number-b', 'a-text-b'])
    expect(await env.repo.query.typedBlockIds(queryA).load()).toEqual(['text-a', 'number-a', 'plain-a'])
  })

  it('refuses registry-dependent queries for an unloaded workspace', async () => {
    await env.repo.whenPropertyDefinitionsReady(WS)
    const workspaceId = OTHER_WS
    await create({id: 'foreign', workspaceId, properties: {[priorityProp.name]: 1}})
    const unloaded = 'property registry unavailable for the requested workspace'
    await expect(Promise.resolve().then(() => env.repo.query.typedBlockIds({
      workspaceId, order: {property: priorityProp.name, direction: 'asc'},
    }).load())).rejects.toThrow(unloaded)
    await expect(Promise.resolve().then(() => env.repo.query.typedBlockIds({
      workspaceId, propertyChildren: 'none',
    }).load())).rejects.toThrow(unloaded)
  })

  it('excludes recognized fields and their direct values while retaining blocks below a value', async () => {
    await env.repo.projectors.handle(USER_SCHEMAS_PROJECTOR_ID)!.whenPrimed(WS)
    const fieldId = propertyDefinitionBlockId(WS, statusProp.seedKey)
    expect(await env.repo.db.getOptional('SELECT id FROM blocks WHERE id = ?', [fieldId])).toBeNull()
    await create({id: 'owner'})
    await create({id: 'field', parentId: 'owner', types: ['entry']})
    await create({id: 'value', parentId: 'field', types: ['entry']})
    await create({id: 'nested', parentId: 'value', types: ['entry']})
    const query = {workspaceId: WS, types: ['entry'], propertyChildren: 'none'} as const
    const handle = env.repo.query.typedBlockIds(query)
    const count = env.repo.query.typedBlockCount(query)
    const hydrated = env.repo.query.typedBlocks(query)
    expect(await handle.load()).toEqual(['field', 'value', 'nested'])
    expect(await count.load()).toBe(3)
    const before = env.repo.handleStore.metrics.loaderInvalidations
    await env.repo.tx(tx => tx.update('nested', {content: 'edited'}), {scope: ChangeScope.BlockDefault})
    expect(env.repo.handleStore.metrics.loaderInvalidations).toBe(before)
    expect(ids(await hydrated.load())).toEqual(['field', 'value', 'nested'])
    const unsubscribers = [handle.subscribe(() => {}), count.subscribe(() => {}), hydrated.subscribe(() => {})]
    try {
      await env.repo.tx(tx => tx.stampReferenceTarget('field', fieldId, true), {scope: ChangeScope.BlockDefault})
      expect(await env.h.db.get('SELECT is_field_form, reference_target_id FROM blocks WHERE id = ?', ['field']))
        .toEqual({is_field_form: 1, reference_target_id: fieldId})
      await waitFor(() => {
        expect(handle.peek()).toEqual(['nested'])
        expect(count.peek()).toBe(1)
        expect(ids(hydrated.peek() ?? [])).toEqual(['nested'])
      })
      await env.repo.tx(tx => tx.move('value', {parentId: 'owner', orderKey: 'z'}), {scope: ChangeScope.BlockDefault})
      await waitFor(() => expect(handle.peek()).toEqual(['value', 'nested']))
      await env.repo.tx(tx => tx.move('value', {parentId: 'field', orderKey: 'z'}), {scope: ChangeScope.BlockDefault})
      await waitFor(() => expect(handle.peek()).toEqual(['nested']))
      await env.repo.tx(tx => tx.stampReferenceTarget('field', 'unknown', true), {scope: ChangeScope.BlockDefault})
      await waitFor(() => expect(handle.peek()).toEqual(['field', 'value', 'nested']))
      await env.repo.tx(tx => tx.stampReferenceTarget('field', fieldId, true), {scope: ChangeScope.BlockDefault})
      await waitFor(() => expect(handle.peek()).toEqual(['nested']))
      await env.repo.tx(tx => tx.stampReferenceTarget('field', fieldId, false), {scope: ChangeScope.BlockDefault})
      await waitFor(() => expect(handle.peek()).toEqual(['field', 'value', 'nested']))
    } finally {
      unsubscribers.forEach(unsubscribe => unsubscribe())
    }
  })

  it('re-resolves mounted child ids when a tagged definition starts and stops parsing', async () => {
    await env.repo.projectors.handle(USER_SCHEMAS_PROJECTOR_ID)!.whenPrimed(WS)
    const definition = {types: ['property-schema'], 'property-schema:preset': 'string'}
    const broken = {...definition, 'property-schema:name': ''}
    await create({id: 'definition', properties: broken})
    await create({id: 'owner'})
    await create({id: 'field', parentId: 'owner'})
    await env.repo.tx(
      tx => tx.stampReferenceTarget('field', 'definition', true), {scope: ChangeScope.BlockDefault},
    )
    await waitFor(() => expect(env.repo.propertyDefinitions?.unparseableDefinitionIds.has('definition')).toBe(true))

    const handle = env.repo.query.typedBlockIds({workspaceId: WS, parentId: 'owner', propertyChildren: 'none'})
    expect(await handle.load()).toEqual(['field'])
    const unsubscribe = handle.subscribe(() => {})
    try {
      await env.repo.tx(tx => tx.update('definition', {properties: {
        ...definition, 'property-schema:name': 'custom-property',
      }}), {scope: ChangeScope.BlockDefault})
      await waitFor(() => expect(handle.peek()).toEqual([]))
      await env.repo.tx(tx => tx.update('definition', {properties: broken}), {scope: ChangeScope.BlockDefault})
      await waitFor(() => expect(handle.peek()).toEqual(['field']))
    } finally {
      unsubscribe()
    }
  })

  it.each([reviewerProp.name, reviewersProp.name, labelsProp.name])('refuses sorting by %s', async property => {
    await expect(Promise.resolve().then(() => env.repo.query.typedBlockIds({
      workspaceId: WS, order: {property, direction: 'asc'},
    }).load())).rejects.toThrow(new RegExp(property))
  })

  it('refuses outline order without a direct parent', async () => {
    await expect(Promise.resolve().then(() => env.repo.query.typedBlockIds({
      workspaceId: WS, order: 'outline',
    }).load())).rejects.toThrow(/parentId/)
  })
})

describe('repo.queryBlocks', () => {
  it('rejects calls that omit workspaceId at the type level', () => {
    // TypedBlockQuery.workspaceId is required so
    // background flows / import runs can't silently fall back to
    // activeWorkspaceId. The `@ts-expect-error` lines below FAIL the
    // build if the field becomes optional again.
    //
    // We don't actually invoke the call (no `await`) — the type check
    // alone is the assertion. The `void` cast prevents the unused-
    // expression lint rule from firing.
    void (() => {
      // @ts-expect-error workspaceId is required on TypedBlockQuery
      env.repo.queryBlocks({types: ['todo']})
      // @ts-expect-error workspaceId is required on TypedBlockQuery
      env.repo.subscribeBlocks({types: ['todo']}, () => {})
      // queryActiveWorkspace / subscribeActiveWorkspace accept the
      // workspaceId-free shape — these must compile.
      env.repo.queryActiveWorkspace({types: ['todo']})
      env.repo.subscribeActiveWorkspace({types: ['todo']}, () => {})
    })
  })

  it('filters by any matching type and scalar where values without duplicate rows', async () => {
    await create({id: 'todo-open', types: ['todo'], properties: {status: 'open'}})
    await create({id: 'todo-done', types: ['todo'], properties: {status: 'done'}})
    await create({id: 'task-open', types: ['task', 'todo'], properties: {status: 'open'}})
    await create({id: 'other-open', types: ['project'], properties: {status: 'open'}})

    const out = await env.repo.queryBlocks({workspaceId: WS, 
      types: ['todo', 'task'],
      where: {status: 'open'},
    })

    expect(ids(out)).toEqual(['todo-open', 'task-open'])
  })

  it('quotes property names in JSON paths', async () => {
    await create({
      id: 'hit',
      types: ['todo'],
      properties: {[weirdNameProp.name]: 'yes'},
    })
    await create({
      id: 'miss',
      types: ['todo'],
      properties: {[weirdNameProp.name]: 'no'},
    })

    await expect(env.repo.queryBlocks({workspaceId: WS, 
      where: {[weirdNameProp.name]: 'yes'},
    })).resolves.toMatchObject([{id: 'hit'}])
  })

  it('matches null filters against missing and explicit-null properties', async () => {
    await create({id: 'missing', types: ['todo']})
    await create({id: 'nullish', types: ['todo'], properties: {status: null}})
    await create({id: 'set', types: ['todo'], properties: {status: 'open'}})

    const out = await env.repo.queryBlocks({workspaceId: WS, where: {status: null}})

    expect(ids(out)).toEqual(['missing', 'nullish'])
  })

  describe('where operators', () => {
    /** `dueProp.codec.date` encodes Date instances to ISO strings.
     *  Lexicographic comparison on ISO 8601 matches chronological order,
     *  so SQL `<` / `BETWEEN` work directly on the encoded form. */
    const encodeDate = (iso: string): unknown =>
      dueProp.codec.encode(new Date(`${iso}T00:00:00.000Z`))

    it('comparator operators on a numeric property', async () => {
      await create({id: 'p1', properties: {[priorityProp.name]: priorityProp.codec.encode(1)}})
      await create({id: 'p2', properties: {[priorityProp.name]: priorityProp.codec.encode(2)}})
      await create({id: 'p3', properties: {[priorityProp.name]: priorityProp.codec.encode(3)}})

      const lt = await env.repo.queryBlocks({workspaceId: WS, where: {priority: {lt: 3}}})
      expect(ids(lt).sort()).toEqual(['p1', 'p2'])

      const lte = await env.repo.queryBlocks({workspaceId: WS, where: {priority: {lte: 2}}})
      expect(ids(lte).sort()).toEqual(['p1', 'p2'])

      const gt = await env.repo.queryBlocks({workspaceId: WS, where: {priority: {gt: 1}}})
      expect(ids(gt).sort()).toEqual(['p2', 'p3'])

      const gte = await env.repo.queryBlocks({workspaceId: WS, where: {priority: {gte: 2}}})
      expect(ids(gte).sort()).toEqual(['p2', 'p3'])

      const eq = await env.repo.queryBlocks({workspaceId: WS, where: {priority: {eq: 2}}})
      expect(ids(eq)).toEqual(['p2'])
    })

    it('comparator operators on a date property', async () => {
      await create({id: 'past', properties: {[dueProp.name]: encodeDate('2026-01-01')}})
      await create({id: 'today', properties: {[dueProp.name]: encodeDate('2026-05-18')}})
      await create({id: 'future', properties: {[dueProp.name]: encodeDate('2026-12-31')}})

      const before = await env.repo.queryBlocks({workspaceId: WS, 
        where: {due: {lt: new Date('2026-05-18T00:00:00.000Z')}},
      })
      expect(ids(before)).toEqual(['past'])

      const onOrAfter = await env.repo.queryBlocks({workspaceId: WS, 
        where: {due: {gte: new Date('2026-05-18T00:00:00.000Z')}},
      })
      expect(ids(onOrAfter).sort()).toEqual(['future', 'today'])
    })

    it('accepts JSON-revived date operands (Date → ISO string after persist)', async () => {
      // Persisted predicates (e.g. backlinks:predicates) round-trip
      // through JSON, which turns Date instances into ISO strings.
      // The compiler re-runs where.encode on the rehydrated value;
      // it must accept the string form so saved date-range filters
      // still work after reload.
      await create({id: 'past', properties: {[dueProp.name]: encodeDate('2026-01-01')}})
      await create({id: 'future', properties: {[dueProp.name]: encodeDate('2026-12-31')}})

      const original = {due: {lt: new Date('2026-05-18T00:00:00.000Z')}}
      const persisted = JSON.parse(JSON.stringify(original)) as Record<string, unknown>
      const out = await env.repo.queryBlocks({workspaceId: WS, where: persisted})
      expect(ids(out)).toEqual(['past'])
    })

    it('between is inclusive on both ends', async () => {
      await create({id: 'p1', properties: {[priorityProp.name]: priorityProp.codec.encode(1)}})
      await create({id: 'p2', properties: {[priorityProp.name]: priorityProp.codec.encode(2)}})
      await create({id: 'p3', properties: {[priorityProp.name]: priorityProp.codec.encode(3)}})
      await create({id: 'p5', properties: {[priorityProp.name]: priorityProp.codec.encode(5)}})

      const out = await env.repo.queryBlocks({workspaceId: WS, where: {priority: {between: [2, 3]}}})
      expect(ids(out).sort()).toEqual(['p2', 'p3'])
    })

    it('exists: true matches set, exists: false matches unset', async () => {
      await create({id: 'set', properties: {status: 'open'}})
      await create({id: 'missing', properties: {}})
      await create({id: 'nullish', properties: {status: null}})

      const set = await env.repo.queryBlocks({workspaceId: WS, where: {status: {exists: true}}})
      expect(ids(set)).toEqual(['set'])

      const unset = await env.repo.queryBlocks({workspaceId: WS, where: {status: {exists: false}}})
      expect(ids(unset).sort()).toEqual(['missing', 'nullish'])
    })

    it('rejects malformed operator objects with a clear message', async () => {
      await expect(env.repo.queryBlocks({workspaceId: WS, where: {priority: {lt: 1, gt: 0}}}))
        .rejects.toThrow('operator object must have exactly one key')
      await expect(env.repo.queryBlocks({workspaceId: WS, where: {priority: {bogus: 1}}}))
        .rejects.toThrow('unknown operator')
      await expect(env.repo.queryBlocks({workspaceId: WS, where: {priority: {between: [1]}}}))
        .rejects.toThrow('between must be a [lo, hi] tuple')
      await expect(env.repo.queryBlocks({workspaceId: WS, where: {status: {exists: 'yes'}}}))
        .rejects.toThrow('exists must be a boolean')
    })

    it('rejects comparator operators on non-where-queryable codecs', async () => {
      await expect(env.repo.queryBlocks({workspaceId: WS, where: {reviewer: {eq: 'target'}}}))
        .rejects.toThrow('is not where-queryable')
    })

    // Each foreign cell is one the comparison alone admits: SQLite orders
    // values across storage classes, so a re-type's leftover compared anyway.
    it.each([
      {
        storage: 'text', name: 'status', canonical: 'alpha', foreign: [5, false, ['a']],
        values: [{lt: 'm'}, {between: ['', 'm']}],
      },
      {
        storage: 'number', name: 'priority', canonical: 5, foreign: ['abc', true, [5]],
        values: [{gte: 1}, {between: [1, 10]}],
      },
      {
        storage: 'boolean', name: 'done', canonical: true, foreign: [1],
        values: [true, {between: [false, true]}],
      },
      {
        storage: 'iso-date',
        name: 'due',
        values: [
          {lt: new Date('2026-05-01T00:00:00.000Z')},
          {between: [new Date('0000-01-01T00:00:00.000Z'), new Date('2026-05-01T00:00:00.000Z')]},
        ],
        canonical: '2026-01-01T00:00:00.000Z',
        // Date-only and second-precision spellings parse, but are not what
        // the codec writes; a signed six-digit year sorts before every
        // four-digit one; GLOB reads only up to an embedded NUL.
        foreign: [
          '', '2026-01-01', '2026-01-01T00:00:00Z', '+010000-01-01T00:00:00.000Z', 20260101,
          '2026-01-01T00:00:00.000Z\u0000junk',
        ],
      },
    ])('a $storage comparator admits only a cell of its storage shape', async ({name, values, canonical, foreign}) => {
      await create({id: 'canonical', properties: {[name]: canonical}})
      const foreignIds = foreign.map((_, i) => `foreign-${i}`)
      for (const [i, cell] of foreign.entries()) {
        await create({id: foreignIds[i]!, properties: {[name]: cell}})
      }
      // Precondition: the cells are stored as written, not normalized.
      const stored = await env.h.db.getAll<{id: string; properties_json: string}>(
        `SELECT id, properties_json FROM blocks WHERE id LIKE 'foreign-%' ORDER BY id`)
      expect(stored.map(row => JSON.parse(row.properties_json)[name])).toEqual(foreign)

      for (const value of values) {
        expect(ids(await env.repo.queryBlocks({workspaceId: WS, where: {[name]: value}})))
          .toEqual(['canonical'])
        expect(ids(await env.repo.queryBlocks({workspaceId: WS, exclude: [{where: {[name]: value}}]})).sort())
          .toEqual(foreignIds.sort())
      }
    })

    it('refuses a date operand outside years 0000-9999 instead of comparing it as text', async () => {
      await create({id: 'dated', properties: {[dueProp.name]: '2026-01-01T00:00:00.000Z'}})

      for (const operand of [new Date('+010000-01-01T00:00:00.000Z'), '-000001-12-31T23:59:59.999Z']) {
        await expect(env.repo.queryBlocks({workspaceId: WS, where: {due: {gt: operand}}}))
          .rejects.toThrow('date in years 0000-9999')
      }
      expect(ids(await env.repo.queryBlocks({workspaceId: WS,
        where: {due: {between: [new Date('0000-01-01T00:00:00.000Z'), new Date('9999-12-31T23:59:59.999Z')]}},
      }))).toEqual(['dated'])
    })

    it('rejects a where capability with no storage shape the compiler knows', () => {
      // A DB-stored extension codec is never type-checked against `WhereStorage`.
      const legacy = {
        ...priorityProp,
        codec: {...priorityProp.codec, where: {encode: (v: number) => v}},
      } as unknown as AnyPropertySchema
      expect(() => compileTypedBlockQuery(
        {workspaceId: WS, where: {priority: {gt: 1}}},
        {properties: new Map([['priority', legacy]])},
      )).toThrow('declares where.storage undefined')
    })

    it('traverses ref-typed properties via the target operator', async () => {
      // Realistic shape: a ref-typed property points at a "target"
      // block that carries its own queryable properties (the daily-
      // notes plugin's date property is the motivating case, but the
      // compiler is plugin-agnostic — anything with a where-queryable
      // codec on the target works).
      await create({
        id: 'past-target',
        properties: {[dueProp.name]: encodeDate('2026-01-01')},
      })
      await create({
        id: 'future-target',
        properties: {[dueProp.name]: encodeDate('2026-12-31')},
      })
      await create({id: 'unrelated-target'})
      await create({
        id: 'source-past',
        properties: {[reviewerProp.name]: reviewerProp.codec.encode('past-target')},
        references: [{id: 'past-target', alias: 'past-target', sourceField: 'reviewer'}],
      })
      await create({
        id: 'source-future',
        properties: {[reviewerProp.name]: reviewerProp.codec.encode('future-target')},
        references: [{id: 'future-target', alias: 'future-target', sourceField: 'reviewer'}],
      })
      await create({
        id: 'source-unrelated',
        properties: {[reviewerProp.name]: reviewerProp.codec.encode('unrelated-target')},
        references: [{id: 'unrelated-target', alias: 'unrelated-target', sourceField: 'reviewer'}],
      })

      const past = await env.repo.queryBlocks({workspaceId: WS, 
        where: {
          [reviewerProp.name]: {
            target: {[dueProp.name]: {lt: new Date('2026-06-01T00:00:00.000Z')}},
          },
        },
      })
      expect(ids(past)).toEqual(['source-past'])

      // Empty target predicate = "ref points at a live block".
      // Excludes the dangling case (no row at the ref id) and the
      // soft-deleted case via the JOIN's `d.deleted = 0` clause.
      const anyTarget = await env.repo.queryBlocks({workspaceId: WS, 
        where: {[reviewerProp.name]: {target: {}}},
      })
      expect(ids(anyTarget).sort()).toEqual(['source-future', 'source-past', 'source-unrelated'])
    })

    it('ancestor-scoped empty target predicate names the target ids, not workspace liveness', async () => {
      // Mirrors what the backlinks filter UI actually builds: the "exists"
      // operator on a ref property emits {scope:'ancestor', target:{}}
      // (propertyFilter.ts). `live-target` resolves; `missing-target` has no
      // row at all, which is the case a fresh create would admit.
      await create({id: 'live-target'})
      await create({
        id: 'parent-live',
        properties: {[reviewerProp.name]: reviewerProp.codec.encode('live-target')},
        references: [{id: 'live-target', alias: 'live-target', sourceField: reviewerProp.name}],
      })
      await create({id: 'entry-live', parentId: 'parent-live', types: ['entry']})
      await create({
        id: 'parent-dangling',
        properties: {[reviewerProp.name]: reviewerProp.codec.encode('missing-target')},
        references: [{id: 'missing-target', alias: 'missing-target', sourceField: reviewerProp.name}],
      })
      await create({id: 'entry-dangling', parentId: 'parent-dangling', types: ['entry']})

      // A candidate gate is required for any ancestor-scoped predicate; the
      // real filter gets one from `referencedBy` (the backlinked page).
      const handle = env.repo.query.typedBlocks({
        workspaceId: WS,
        types: ['entry'],
        match: [{scope: 'ancestor', where: {[reviewerProp.name]: {target: {}}}}],
      })
      await handle.load()
      const deps = handle.__depsForTest()

      // The coarse channel fires on every create/delete in the workspace,
      // including edits that cannot change this result.
      expect(deps).not.toContainEqual({
        kind: 'plugin',
        channel: TYPED_BLOCKS_LIVE_CHANNEL,
        key: typedBlocksLiveKey(WS),
      })
      // Deleting/restoring a resolving target flips membership.
      expect(deps).toContainEqual({
        kind: 'plugin',
        channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
        key: typedBlocksStructureKey(WS, 'live-target'),
      })
      // And a target with no row yet still gets named: the id lives in the
      // encoded ref PROPERTY, which is what the deps are read from, so it is
      // available with or without a projected edge. Creating that block is
      // precisely the event to wake on.
      expect(deps).toContainEqual({
        kind: 'plugin',
        channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
        key: typedBlocksStructureKey(WS, 'missing-target'),
      })
    })

    it('the count path declares the same target deps as the rows path', async () => {
      // Regression guard: `collectTypedBlockAxisDeps` suppresses the coarse
      // live channel for every resolver, but only the ancestor walk declares
      // the precise ids that replace it. A resolver that walks ancestors
      // without picking them up would UNDER-fire — the direction that leaves
      // a permanently stale view. `resolveTypedBlockCount` (the inline badge)
      // and `resolveTypedBlockIds` both take that path.
      await create({id: 'live-target'})
      await create({
        id: 'parent-live',
        properties: {[reviewerProp.name]: reviewerProp.codec.encode('live-target')},
        references: [{id: 'live-target', alias: 'live-target', sourceField: reviewerProp.name}],
      })
      await create({id: 'entry-live', parentId: 'parent-live', types: ['entry']})

      const handle = env.repo.query.typedBlockCount({
        workspaceId: WS,
        types: ['entry'],
        match: [{scope: 'ancestor', where: {[reviewerProp.name]: {target: {}}}}],
      })
      await handle.load()
      const deps = handle.__depsForTest()

      expect(deps).not.toContainEqual({
        kind: 'plugin',
        channel: TYPED_BLOCKS_LIVE_CHANNEL,
        key: typedBlocksLiveKey(WS),
      })
      expect(deps).toContainEqual({
        kind: 'plugin',
        channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
        key: typedBlocksStructureKey(WS, 'live-target'),
      })
    })

    it('reads target ids from the property value, not the not-yet-projected edge', async () => {
      // `block_references` is trigger-maintained from `references_json`, which
      // the references processor writes POST-COMMIT. A ref-typed property
      // write therefore commits — and invalidates on the property channel —
      // before its edge row exists. Deriving deps from the edge index would
      // see nothing in that window and register nothing; on the
      // `kind: 'structure'` paths nothing later fires to correct it, so the
      // handle would stay stale forever. This block has the property set and
      // NO references, which is exactly that window.
      await create({id: 'live-target'})
      await create({
        id: 'parent-unprojected',
        properties: {[reviewerProp.name]: reviewerProp.codec.encode('live-target')},
      })
      await create({id: 'entry-unprojected', parentId: 'parent-unprojected', types: ['entry']})

      const edges = await env.repo.db.getAll(
        'SELECT * FROM block_references WHERE source_id = ?', ['parent-unprojected'],
      )
      expect(edges).toEqual([])

      const handle = env.repo.query.typedBlocks({
        workspaceId: WS,
        types: ['entry'],
        match: [{scope: 'ancestor', where: {[reviewerProp.name]: {target: {}}}}],
      })
      await handle.load()

      expect(handle.__depsForTest()).toContainEqual({
        kind: 'plugin',
        channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
        key: typedBlocksStructureKey(WS, 'live-target'),
      })
    })

    it('target does not resolve to a live block in another workspace', async () => {
      // Reference resolution and the target deps that wake a handle are both
      // workspace-scoped, so a ref naming another workspace's block is
      // dangling here — on the ref and the refList branch alike.
      await create({id: 'foreign-target', workspaceId: OTHER_WS, properties: {status: 'done'}})
      await create({id: 'local-target', properties: {status: 'done'}})
      await create({
        id: 'via-ref',
        properties: {[reviewerProp.name]: reviewerProp.codec.encode('foreign-target')},
      })
      await create({
        id: 'via-ref-list',
        properties: {[reviewersProp.name]: reviewersProp.codec.encode(['foreign-target'])},
      })
      await create({
        id: 'via-ref-list-mixed',
        properties: {[reviewersProp.name]: reviewersProp.codec.encode(['foreign-target', 'local-target'])},
      })

      for (const inner of [{}, {status: 'done'}]) {
        expect(ids(await env.repo.queryBlocks({workspaceId: WS,
          where: {[reviewerProp.name]: {target: inner}},
        }))).toEqual([])
        expect(ids(await env.repo.queryBlocks({workspaceId: WS,
          where: {[reviewersProp.name]: {target: inner}},
        }))).toEqual(['via-ref-list-mixed'])
      }
    })

    it('a refList cell that is not an array names no targets instead of failing the query', async () => {
      // A ref → refList re-type leaves the old plain-string cells behind (an
      // accepted residual of the definition-change processor). A bare
      // `json_each` over one throws `malformed JSON`, failing every target
      // query on the property — both the predicate and the ancestor-dep walk.
      await create({id: 'live-target'})
      await create({id: 'stale', properties: {[reviewersProp.name]: 'live-target'}})
      await create({id: 'object-cell', properties: {[reviewersProp.name]: {a: 'live-target'}}})
      await create({
        id: 'current',
        properties: {[reviewersProp.name]: reviewersProp.codec.encode(['live-target'])},
      })
      await create({id: 'entry-stale', parentId: 'stale', types: ['entry']})
      await create({id: 'entry-current', parentId: 'current', types: ['entry']})

      expect(ids(await env.repo.queryBlocks({workspaceId: WS,
        where: {[reviewersProp.name]: {target: {}}},
      }))).toEqual(['current'])
      expect(ids(await env.repo.queryBlocks({workspaceId: WS,
        types: ['entry'],
        match: [{scope: 'ancestor', where: {[reviewersProp.name]: {target: {}}}}],
      }))).toEqual(['entry-current'])
    })

    it('rejects the target operator on non-ref properties', async () => {
      await expect(env.repo.queryBlocks({workspaceId: WS, 
        where: {status: {target: {priority: {gt: 0}}}},
      })).rejects.toThrow('only valid on ref / refList properties')
    })

    it('rejects malformed target operand', async () => {
      await expect(env.repo.queryBlocks({workspaceId: WS, 
        where: {[reviewerProp.name]: {target: 'not-an-object'}},
      })).rejects.toThrow('target must be a where-map object')
    })
  })

  it('filters by references with optional sourceField', async () => {
    await create({id: 'target'})
    await create({
      id: 'content-source',
      references: [{id: 'target', alias: 'Target'}],
    })
    await create({
      id: 'field-source',
      references: [{id: 'target', alias: 'target', sourceField: 'reviewer'}],
    })

    expect(ids(await env.repo.queryBlocks({workspaceId: WS, referencedBy: {id: 'target'}})))
      .toEqual(['content-source', 'field-source'])
    expect(ids(await env.repo.queryBlocks({workspaceId: WS, referencedBy: {id: 'target', sourceField: 'reviewer'}})))
      .toEqual(['field-source'])
    expect(ids(await env.repo.queryBlocks({workspaceId: WS, referencedBy: {id: 'target', sourceField: ''}})))
      .toEqual(['content-source'])
  })

  it('scopes to the explicit workspace and ignores other workspaces', async () => {
    await create({id: 'local', types: ['todo']})
    await create({id: 'remote', workspaceId: OTHER_WS, types: ['todo']})

    expect(ids(await env.repo.queryBlocks({workspaceId: WS, types: ['todo']}))).toEqual(['local'])
    expect(ids(await env.repo.queryBlocks({workspaceId: OTHER_WS, types: ['todo']}))).toEqual(['remote'])
  })

  it('queryActiveWorkspace resolves to the active workspace at call time', async () => {
    await create({id: 'local', types: ['todo']})
    await create({id: 'remote', workspaceId: OTHER_WS, types: ['todo']})

    // setActiveWorkspaceId(WS) ran in setup
    expect(ids(await env.repo.queryActiveWorkspace({types: ['todo']}))).toEqual(['local'])

    env.repo.setActiveWorkspaceId(OTHER_WS)
    expect(ids(await env.repo.queryActiveWorkspace({types: ['todo']}))).toEqual(['remote'])

    env.repo.setActiveWorkspaceId(null)
    expect(await env.repo.queryActiveWorkspace({types: ['todo']})).toEqual([])
  })

  it('rejects unsupported where filters clearly', async () => {
    await expect(env.repo.queryBlocks({workspaceId: WS, where: {missing: 'x'}}))
      .rejects.toThrow('has no registered PropertySchema')
    await expect(env.repo.queryBlocks({workspaceId: WS, where: {labels: ['x']}}))
      .rejects.toThrow('is not where-queryable')
    await expect(env.repo.queryBlocks({workspaceId: WS, where: {reviewer: 'target'}}))
      .rejects.toThrow('is not where-queryable')
    await expect(env.repo.queryBlocks({workspaceId: WS, where: {status: undefined}}))
      .rejects.toThrow('is undefined')
  })

  it('does not alias invalid undefined where filters to a cached empty where handle', async () => {
    await create({id: 'todo-open', types: ['todo'], properties: {status: 'open'}})

    await expect(env.repo.queryBlocks({workspaceId: WS, where: {}}))
      .resolves.toMatchObject([{id: 'todo-open'}])
    await expect(env.repo.queryBlocks({workspaceId: WS, where: {status: undefined}}))
      .rejects.toThrow('is undefined')
  })

  it('rejects ancestor-scope predicates without a candidate-narrowing filter', async () => {
    // No referencedBy, no types, no top-level where, no narrowing
    // self-scope match → would chain-walk every block in the ws.
    await expect(env.repo.queryBlocks({workspaceId: WS, 
      match: [{scope: 'ancestor', where: {status: 'done'}}],
    })).rejects.toThrow('require at least one candidate filter')
  })

  it('null-only where does not pass the ancestor gate', async () => {
    // Top-level where: {status: null} matches every row that doesn't
    // have status set — does not narrow the candidate set in any
    // meaningful way for the recursive walk.
    await expect(env.repo.queryBlocks({workspaceId: WS, 
      where: {status: null},
      match: [{scope: 'ancestor', where: {status: 'done'}}],
    })).rejects.toThrow('require at least one candidate filter')
  })

  it('exists:false-only where does not pass the ancestor gate either', async () => {
    // `{exists: false}` is semantically identical to `null` (both
    // compile to IS NULL). The selectivity gate must treat them the
    // same, otherwise callers using one shorthand silently bypass
    // the guard the other shorthand triggers.
    await expect(env.repo.queryBlocks({workspaceId: WS, 
      where: {status: {exists: false}},
      match: [{scope: 'ancestor', where: {status: 'done'}}],
    })).rejects.toThrow('require at least one candidate filter')
  })

  it('self-scope match predicate counts as a candidate filter for the gate', async () => {
    // create() hardcodes parentId: null, so use tx.create directly to
    // build a parent-child chain.
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'parent', workspaceId: WS, parentId: null, orderKey: 'a',
        properties: {[typesProp.name]: typesProp.codec.encode(['todo']), status: 'open'},
      })
      await tx.create({
        id: 'child', workspaceId: WS, parentId: 'parent', orderKey: 'b',
        properties: {[typesProp.name]: typesProp.codec.encode(['todo']), status: 'open'},
      })
    }, {scope: ChangeScope.BlockDefault})
    await create({id: 'unrelated', properties: {status: 'open'}})

    // Self-scope `status=open` predicate folds into candidates →
    // the recursive walk only seeds from rows that match it.
    const out = await env.repo.queryBlocks({workspaceId: WS, 
      match: [
        {scope: 'self', where: {status: 'open'}},
        {scope: 'ancestor', id: 'parent'},
      ],
    })
    expect(ids(out).sort()).toEqual(['child', 'parent'])
  })

  it('top-level where folds into candidates and applies before ancestor walk', async () => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'parent', workspaceId: WS, parentId: null, orderKey: 'a',
        properties: {[typesProp.name]: typesProp.codec.encode(['todo'])},
      })
      await tx.create({
        id: 'open-child', workspaceId: WS, parentId: 'parent', orderKey: 'b',
        properties: {[typesProp.name]: typesProp.codec.encode(['todo']), status: 'open'},
      })
      await tx.create({
        id: 'done-child', workspaceId: WS, parentId: 'parent', orderKey: 'c',
        properties: {[typesProp.name]: typesProp.codec.encode(['todo']), status: 'done'},
      })
    }, {scope: ChangeScope.BlockDefault})

    const out = await env.repo.queryBlocks({workspaceId: WS,
      where: {status: 'open'},
      match: [{scope: 'ancestor', id: 'parent'}],
    })
    expect(ids(out)).toEqual(['open-child'])
  })

  it('exclude keeps rows whose filtered property is unset (NULL is not a match)', async () => {
    // Regression: a scalar `exclude` where compiles to
    // `json_extract(...) = ?`, which is NULL when the property is
    // missing. A bare `NOT (NULL)` is NULL — not TRUE — so it used to
    // drop every row that never set the property, the opposite of the
    // documented NOR contract ("exclude iff a predicate matches"; an
    // unknown does not match). This is exactly how SRS due-cards lost
    // every card that had never been archived.
    await create({id: 'unset', types: ['todo']})
    await create({id: 'explicit-false', types: ['todo'], properties: {[doneProp.name]: doneProp.codec.encode(false)}})
    await create({id: 'explicit-true', types: ['todo'], properties: {[doneProp.name]: doneProp.codec.encode(true)}})

    const out = await env.repo.queryBlocks({
      workspaceId: WS,
      types: ['todo'],
      exclude: [{scope: 'self', where: {[doneProp.name]: true}}],
    })
    expect(ids(out).sort()).toEqual(['explicit-false', 'unset'])
  })
})

describe('repo.subscribeBlocks', () => {
  it('asks only a projector-mode subscription\'s handle to rerun on a stale mark', () => {
    const asked = vi.spyOn(LoaderHandle.prototype, 'rerunOnStaleMark')

    env.repo.subscribeBlocks({workspaceId: WS, types: ['todo']}, () => {})()
    expect(asked).not.toHaveBeenCalled()

    env.repo.subscribeBlocks({workspaceId: WS, types: ['todo']}, () => {}, {freshInitial: true})()
    expect(asked).toHaveBeenCalledTimes(1)
    asked.mockRestore()
  })

  it('updates when local writes change type membership', async () => {
    const fired: string[][] = []
    const off = env.repo.subscribeBlocks({workspaceId: WS, types: ['todo']}, rows => {
      fired.push(ids(rows))
    })

    await waitFor(() => expect(fired).toEqual([[]]))
    await create({id: 'todo', types: ['todo']})

    await waitFor(() => expect(fired).toEqual([[], ['todo']]))
    off()
  })

  it('updates when a target row appears with the inner-null property unset', async () => {
    // `target: { status: null }` matches rows whose status is unset.
    // A freshly-inserted target row with no `status` property doesn't
    // fire the status property channel — same shape as the top-level
    // "where with only null predicates" case. Without a live-channel
    // sub on this branch the subscriber would stay stale.
    await env.repo.tx(tx => tx.create({
      id: 'source', workspaceId: WS, parentId: null, orderKey: 'a',
      properties: {[reviewerProp.name]: reviewerProp.codec.encode('target')},
      references: [{id: 'target', alias: 'target', sourceField: 'reviewer'}],
    }), {scope: ChangeScope.BlockDefault})

    const fired: string[][] = []
    const off = env.repo.subscribeBlocks(
      {workspaceId: WS, where: {[reviewerProp.name]: {target: {status: null}}}},
      rows => fired.push(ids(rows)),
    )
    await waitFor(() => expect(fired).toEqual([[]]))

    await env.repo.tx(tx => tx.create({
      id: 'target', workspaceId: WS, parentId: null, orderKey: 'b',
    }), {scope: ChangeScope.BlockDefault})
    await waitFor(() => expect(fired).toEqual([[], ['source']]))
    off()
  })

  it('updates when a target operator inner property changes on the referenced row', async () => {
    // Regression: the `target` traversal makes membership depend on
    // the REFERENCED row's properties. Without dep wiring on the
    // inner property channel, a target-side update wouldn't wake
    // the subscriber.
    await env.repo.tx(tx => tx.create({
      id: 'target', workspaceId: WS, parentId: null, orderKey: 'a',
    }), {scope: ChangeScope.BlockDefault})
    await env.repo.tx(tx => tx.create({
      id: 'source', workspaceId: WS, parentId: null, orderKey: 'b',
      properties: {[reviewerProp.name]: reviewerProp.codec.encode('target')},
      references: [{id: 'target', alias: 'target', sourceField: 'reviewer'}],
    }), {scope: ChangeScope.BlockDefault})

    const fired: string[][] = []
    const off = env.repo.subscribeBlocks(
      {workspaceId: WS, where: {[reviewerProp.name]: {target: {status: 'done'}}}},
      rows => fired.push(ids(rows)),
    )
    await waitFor(() => expect(fired).toEqual([[]]))

    // Update the *target* row's status. The subscription's filter
    // doesn't reference the target id directly — only an inner
    // property predicate — so this hits the dep wiring that
    // `collectWhereDeps` adds for traversals.
    await env.repo.tx(tx => tx.setProperty('target', statusProp, 'done'),
      {scope: ChangeScope.BlockDefault})
    await waitFor(() => expect(fired).toEqual([[], ['source']]))
    off()
  })

  it('updates when sync-applied rows change type membership', async () => {
    const fired: string[][] = []
    const off = env.repo.subscribeBlocks({workspaceId: WS, types: ['todo']}, rows => {
      fired.push(ids(rows))
    })
    await waitFor(() => expect(fired).toEqual([[]]))

    env.repo.startSyncObserver({throttleMs: 0})
    // A brand-new typed block arrives via the sync path: staged into
    // blocks_synced, materialized by the observer. New id ⇒ no prior local
    // row, so no pending-upload gate to clear.
    await env.h.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams({
      id: 'remote-todo', workspaceId: WS, parentId: null, orderKey: 'a0',
      content: '', properties: {[typesProp.name]: ['todo']}, references: [],
      createdAt: 0, updatedAt: 0, userUpdatedAt: 0, createdBy: 'remote', updatedBy: 'remote', deleted: false,
    }))

    await env.repo.flushSyncObserver()
    await waitFor(() => expect(fired).toEqual([[], ['remote-todo']]))
    off()
  })
})

describe('repo.countBlocksUsingProperty', () => {
  it('counts only non-deleted blocks where the property is set', async () => {
    await create({id: 'a', properties: {status: 'open'}})
    await create({id: 'b', properties: {status: 'done'}})
    await create({id: 'c', properties: {}})
    await create({id: 'd', properties: {status: 'open'}})
    await env.repo.tx(tx => tx.delete('d'), {scope: ChangeScope.BlockDefault})

    expect(await env.repo.countBlocksUsingProperty('status')).toBe(2)
    expect(await env.repo.countBlocksUsingProperty('done')).toBe(0)
  })

  it('scopes to the active workspace by default and accepts an explicit one', async () => {
    await create({id: 'local', properties: {status: 'open'}})
    await create({id: 'remote', workspaceId: OTHER_WS, properties: {status: 'open'}})

    expect(await env.repo.countBlocksUsingProperty('status')).toBe(1)
    expect(await env.repo.countBlocksUsingProperty('status', OTHER_WS)).toBe(1)
  })

  it('escapes property names containing quotes and special characters', async () => {
    await create({id: 'hit', properties: {[weirdNameProp.name]: 'yes'}})
    await create({id: 'miss', properties: {status: 'open'}})

    expect(await env.repo.countBlocksUsingProperty(weirdNameProp.name)).toBe(1)
  })
})

// Why the type filter is a JOIN and not a correlated EXISTS, including the
// crossover where it is SLOWER: see the block comment on `typeJoin` in
// typedBlockQuery.ts. These tests pin the emitted shape and the param order.
describe('compileTypedBlockQuery — type filter join order', () => {
  const compileTypes = (types: string[], extra: Partial<ResolvedTypedBlockQuery> = {}) =>
    compileTypedBlockQuery(
      {workspaceId: WS, types, match: [], exclude: [], ...extra},
      {properties: new Map()},
      {projection: 'ids'},
    )

  it('joins block_types instead of probing it per candidate row', () => {
    const {sql} = compileTypes(['property-schema'])
    expect(sql).toContain('JOIN block_types bt')
    expect(sql).not.toMatch(/EXISTS\s*\(\s*SELECT 1\s*FROM block_types/)
  })

  it('binds the type params in FROM-clause position, ahead of the WHERE params', () => {
    // The join's `?` now precedes `b.workspace_id = ?` in the statement text,
    // so a params array still ordered WHERE-first would silently filter by the
    // wrong values rather than throw.
    const {sql, params} = compileTypes(['property-schema', 'block-type'])
    // Types arrive sorted — normalizeTypedBlockQuery canonicalises them so the
    // compiled SQL is a stable cache key.
    expect(params).toEqual(['block-type', 'property-schema', WS])
    expect(sql.indexOf('bt.type IN')).toBeLessThan(sql.indexOf('b.workspace_id = ?'))
  })

  it('keeps referencedBy params in statement order when both are present', () => {
    const {sql, params} = compileTypes(['todo'], {referencedBy: {id: 'target-1'}})
    expect(params).toEqual(['todo', WS, 'target-1'])
    expect(sql.indexOf('bt.type IN')).toBeLessThan(sql.indexOf('br.workspace_id = ?'))
  })
})

// Seeding the large fixture and refreshing statistics takes about 2 seconds.
it('bounds limited table queries by workspace, type, or siblings with and without statistics', async () => {
  const {db} = env.h
  await db.writeTransaction(async tx => {
    await tx.execute(`
      WITH RECURSIVE parents(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM parents WHERE n < 399)
      INSERT INTO blocks (id, workspace_id, order_key, created_at, updated_at, created_by, updated_by)
      SELECT 'parent-' || n, CASE WHEN n < 360 THEN ? ELSE ? END, printf('%03d', n), n, n, 'user', 'user'
      FROM parents
    `, [WS, OTHER_WS])
    await tx.execute(`
      WITH RECURSIVE children(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM children WHERE n < 41999)
      INSERT INTO blocks (id, workspace_id, parent_id, order_key, properties_json,
                          created_at, updated_at, created_by, updated_by)
      SELECT 'child-' || n, CASE WHEN n % 400 < 360 THEN ? ELSE ? END, 'parent-' || (n % 400),
             printf('%05d', n), CASE
               WHEN n % 137 = 1 THEN json_object('priority', n % 37, 'types', json_array('entry'))
               WHEN n % 2 = 0 THEN json_object('types', json_array('todo'))
               ELSE '{}'
             END, n, n, 'user', 'user'
      FROM children
    `, [WS, OTHER_WS])
    const base = {workspaceId: WS, propertyChildren: 'none'} as const
    const order = {property: priorityProp.name, direction: 'asc'} as const
    const fields = new Map(KERNEL_QUERYABLE_FIELDS.map(field => [field.name, field]))
    const readPlan = async (query: ResolvedTypedBlockQuery) => {
      const compiled = compileTypedBlockQuery(query, {properties: env.repo.propertySchemas, fields}, {projection: 'ids', limit: 20})
      const plan = await tx.getAll<{parent: number; detail: string}>(
        `EXPLAIN QUERY PLAN ${compiled.sql}`, [...compiled.params],
      )
      return plan.filter(row => row.parent === 0).map(row => row.detail)
    }
    const assertPlans = async () => {
      const tempSort = 'USE TEMP B-TREE FOR ORDER BY'
      const workspacePlan = await readPlan({...base, order})
      expect(workspacePlan[0]).toBe('SEARCH b USING INDEX idx_blocks_workspace_active (workspace_id=?)')
      expect(workspacePlan).toContain(tempSort)

      const typePlan = await readPlan({...base, types: ['entry'], order})
      expect(typePlan[0]).toBe('SEARCH bt USING INDEX idx_block_types_type_workspace (type=? AND workspace_id=?)')
      expect(typePlan[1]).toBe('SEARCH b USING INDEX sqlite_autoindex_blocks_1 (id=?)')

      const siblingSearch = 'SEARCH b USING INDEX idx_blocks_parent_order (parent_id=?)'
      for (const types of [undefined, ['entry']]) {
        const siblings = {...base, parentId: 'parent-1', types}
        const outlinePlan = await readPlan({...siblings, order: 'outline'})
        expect(outlinePlan[0]).toBe(siblingSearch)
        expect(outlinePlan).not.toContain(tempSort)
        const propertyPlan = await readPlan({...siblings, order})
        expect(propertyPlan[0]).toBe(siblingSearch)
        expect(propertyPlan).toContain(tempSort)
        expect((await readPlan({...siblings, order: 'outline', where: {
          created: {gt: 0}, updated: {gte: 0}, labels: {contains: 'urgent'},
        }}))[0]).toBe(siblingSearch)
      }
    }

    await assertPlans()
    await tx.execute('ANALYZE main.blocks')
    await tx.execute('ANALYZE main.block_types')
    await assertPlans()
  })
}, 20_000)

describe('typed query disjunctions and extended where operators', () => {
  // Bulk seeding and analyzing the two-workspace graph takes about one second.
  it('finds reference alternatives from both target indexes before and after ANALYZE', async () => {
    await env.h.db.writeTransaction(async tx => {
      // The shared DB can retain planner stats from an earlier fixture after its rows are reset.
      await tx.execute('ANALYZE main.blocks')
      await tx.execute('ANALYZE main.block_references')
      await tx.execute(`
        WITH RECURSIVE nums(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM nums WHERE n < 19999)
        INSERT INTO blocks (id, workspace_id, order_key, references_json, created_at, updated_at, created_by, updated_by)
        SELECT 'source-' || n, CASE WHEN n % 5 = 0 THEN ? ELSE ? END, 'a',
               json_array(json_object('id', 'target-' || (n % 257), 'alias', 'link',
                 'sourceField', CASE WHEN n % 4 = 3 THEN 'reviewer' ELSE '' END)),
               n, n, 'user', 'user'
        FROM nums
      `, [OTHER_WS, WS])
      const query = {workspaceId: WS, anyOf: [
        {referencedBy: {id: 'target-3'}}, {referencedBy: {id: 'target-7', sourceField: 'reviewer'}},
      ]}
      const compiled = compileTypedBlockQuery(query, {properties: env.repo.propertySchemas}, {projection: 'ids', limit: 5})
      const check = async () => {
        const plan = (await tx.getAll<{detail: string}>(`EXPLAIN QUERY PLAN ${compiled.sql}`, [...compiled.params]))
          .map(row => row.detail)
        expect(plan, plan.join('\n')).toContain('MULTI-INDEX OR')
        expect(plan.filter(step => step.includes('idx_block_references_target (target_id=? AND workspace_id=?)'))).toHaveLength(2)
        expect(plan.filter(step => step.includes('sqlite_autoindex_blocks_1 (id=?)'))).toHaveLength(2)
        expect(ids(await tx.getAll<{id: string}>(compiled.sql, [...compiled.params])))
          .toEqual(['source-3', 'source-7', 'source-517', 'source-774', 'source-1031'])
      }
      await check()
      await tx.execute('ANALYZE main.blocks')
      await tx.execute('ANALYZE main.block_references')
      await check()
    })
  }, 20_000)

  it('ORs self-scoped and ancestor-scoped predicates inside an independently bounded query', async () => {
    await create({id: 'ancestor', properties: {status: 'ancestor-hit'}})
    await create({id: 'ancestor-match', parentId: 'ancestor', properties: {done: false}})
    await create({id: 'outside-bound', parentId: 'ancestor', properties: {done: true}})
    await create({id: 'self-match', properties: {done: false, status: 'self-hit'}})
    await create({id: 'not-a-match', parentId: 'self-match', properties: {done: false}})

    const anyOf = [
      {where: {status: 'self-hit'}},
      {scope: 'ancestor', where: {status: 'ancestor-hit'}},
    ] as const
    const query = {workspaceId: WS, where: {done: false}, anyOf}
    expect(await env.repo.query.typedBlockIds(query).load()).toEqual(['ancestor-match', 'self-match'])
    expect(ids(await env.repo.queryBlocks(query))).toEqual(['ancestor-match', 'self-match'])
    expect(await env.repo.query.typedBlockCount(query).load()).toBe(2)
    await expect(env.repo.queryBlocks({workspaceId: WS, anyOf}))
      .rejects.toThrow('require at least one candidate filter')
    expect(await env.repo.query.typedBlockIds({...query, anyOf: []}).load()).toEqual([])
  })

  it('returns no matches for empty alternatives even alongside an unbounded ancestor predicate', async () => {
    await create({id: 'parent'})
    await create({id: 'child', parentId: 'parent'})
    const query = {workspaceId: WS, anyOf: [], match: [{scope: 'ancestor', id: 'parent'}]} as const
    expect(await env.repo.query.typedBlockIds(query).load()).toEqual([])
    expect(await env.repo.query.typedBlockCount(query).load()).toBe(0)
  })

  it.each([
    {label: 'where', predicates: {where: {created: {gt: 0}}}},
    {label: 'self alternative', predicates: {anyOf: [{where: {created: {gt: 0}}}]}},
    {label: 'ancestor alternative', predicates: {anyOf: [{scope: 'ancestor', where: {created: {gt: 0}}}]}},
  ] as const)('refuses timestamp filters in an unloaded workspace ($label)', async ({predicates}) => {
    await env.repo.whenPropertyDefinitionsReady(WS)
    await create({id: 'foreign', workspaceId: OTHER_WS, types: ['entry']})
    const query = {workspaceId: OTHER_WS, types: ['entry'], ...predicates}
    await expect(env.repo.query.typedBlockIds(query).load()).rejects.toThrow('property registry unavailable')
  })

  it('stops an ancestor alternative at the workspace boundary', async () => {
    await create({id: 'local', types: ['entry']})
    await create({id: 'foreign-parent', workspaceId: OTHER_WS, properties: {status: 'open'}})
    await env.h.db.writeTransaction(tx => tx.execute(
      'UPDATE blocks SET parent_id = ? WHERE id = ?', ['foreign-parent', 'local'],
    ))
    const query = {workspaceId: WS, types: ['entry'], anyOf: [{scope: 'ancestor', where: {status: 'open'}}]} as const
    expect(await env.repo.query.typedBlockIds(query).load()).toEqual([])
  })

  it('admits a newly created id alternative whose matching property lives on an ancestor', async () => {
    await create({id: 'parent', properties: {status: 'open'}})
    const handle = env.repo.query.typedBlockIds({
      workspaceId: WS, anyOf: [{id: 'later'}, {id: 'another'}],
      match: [{scope: 'ancestor', where: {status: 'open'}}],
    })
    expect(await handle.load()).toEqual([])
    const off = handle.subscribe(() => {})
    try {
      await create({id: 'later', parentId: 'parent'})
      await waitFor(() => expect(handle.peek()).toEqual(['later']))
    } finally {
      off()
    }
  })

  it('admits a candidate when its previously missing ancestor arrives', async () => {
    await create({id: 'child', types: ['entry']})
    await env.h.db.writeTransaction(tx => tx.execute(
      'UPDATE blocks SET parent_id = ? WHERE id = ?', ['late-parent', 'child'],
    ))
    const handle = env.repo.query.typedBlockIds({
      workspaceId: WS, types: ['entry'], anyOf: [{scope: 'ancestor', id: 'late-parent'}],
    })
    expect(await handle.load()).toEqual([])
    const off = handle.subscribe(() => {})
    try {
      await create({id: 'late-parent'})
      await waitFor(() => expect(handle.peek()).toEqual(['child']))
    } finally {
      off()
    }
  })

  it('keeps all-self alternatives quiet for an unrelated block create', async () => {
    await create({id: 'target'})
    await create({id: 'property-match', properties: {status: 'open'}})
    const handle = env.repo.query.typedBlockIds({
      workspaceId: WS, anyOf: [{where: {status: 'open'}}, {referencedBy: {id: 'target'}}],
    })
    expect(await handle.load()).toEqual(['property-match'])
    const off = handle.subscribe(() => {})
    try {
      const before = env.repo.handleStore.metrics.loaderInvalidations
      await create({id: 'unrelated'})
      expect(env.repo.handleStore.metrics.loaderInvalidations).toBe(before)
      await create({id: 'reference-match', references: [{id: 'target', alias: 'target'}]})
      await waitFor(() => expect(handle.peek()).toEqual(['property-match', 'reference-match']))
    } finally {
      off()
    }
  })

  it('binds operands through custom queryable fields and invalidates ids on a declared dependency', async () => {
    const field = 'test:content'
    env.repo.setRuntimeContributions(queryableFieldsFacet, 'test', [{
      name: field,
      value: alias => ({sql: `${alias}.content`, params: []}),
      encode: operand => codecs.string.decode(operand),
      dependencies: [workspaceId => ({kind: 'workspace', workspaceId})],
    }])
    const literal = "it's ?"
    await create({id: 'row'})
    const query = {workspaceId: WS, where: {[field]: {eq: literal}}}
    const handle = env.repo.query.typedBlockIds(query)
    expect(await handle.load()).toEqual([])
    const unsubscribe = handle.subscribe(() => {})
    try {
      const before = env.repo.handleStore.metrics.loaderInvalidations
      await env.repo.tx(tx => tx.update('row', {content: literal}), {scope: ChangeScope.BlockDefault})
      expect(env.repo.handleStore.metrics.loaderInvalidations).toBe(before + 1)
      await waitFor(() => expect(handle.peek()).toEqual(['row']))
    } finally {
      unsubscribe()
    }
  })

  it('filters and orders on one bound virtual value and keeps missing values last', async () => {
    const field = 'test:score'
    env.repo.setRuntimeContributions(queryableFieldsFacet, 'scores', [{
      name: field,
      value: alias => ({sql: `json_extract(${alias}.properties_json, ?)`, params: ['$.priority']}),
      encode: operand => codecs.number.decode(operand),
      dependencies: [workspaceId => ({
        kind: 'plugin', channel: TYPED_BLOCKS_PROPERTY_CHANNEL, key: typedBlocksPropertyKey(workspaceId, priorityProp.name),
      })],
    }])
    await create({id: 'a-missing', types: ['entry']})
    await create({id: 'higher', types: ['entry'], properties: {priority: 7}})
    await create({id: 'lower', types: ['entry'], properties: {priority: 3}})
    const base = {workspaceId: WS, types: ['entry']}
    const ordered = (direction: 'asc' | 'desc') => ({...base, order: {property: field, direction}})
    const ascending = env.repo.query.typedBlockIds(ordered('asc'))
    expect(await ascending.load()).toEqual(['lower', 'higher', 'a-missing'])
    expect(await env.repo.query.typedBlockIds(ordered('desc')).load()).toEqual(['higher', 'lower', 'a-missing'])
    expect(await env.repo.query.typedBlockIds({
      ...ordered('desc'), where: {[field]: {between: [3, 7]}}, limit: 1,
    }).load()).toEqual(['higher'])
    expect(await env.repo.query.typedBlockIds({...base, where: {[field]: {exists: true}}}).load()).toEqual(['higher', 'lower'])
    expect(await env.repo.query.typedBlockIds({...base, where: {[field]: null}}).load()).toEqual(['a-missing'])
    const off = ascending.subscribe(() => {})
    try {
      await env.repo.tx(tx => tx.setProperty('higher', priorityProp, 1), {scope: ChangeScope.BlockDefault})
      await waitFor(() => expect(ascending.peek()).toEqual(['higher', 'lower', 'a-missing']))
    } finally {
      off()
    }
  })

  it('refreshes a cached query when its runtime field is replaced or removed', async () => {
    const field = 'test:chosen-row'
    const source = 'test'
    const chooseRow = (id: string): QueryableField => ({
      name: field,
      value: alias => ({sql: `${alias}.id = ?`, params: [id]}),
      encode: Number,
      dependencies: [workspaceId => ({kind: 'workspace', workspaceId})],
    })
    await create({id: 'first'})
    await create({id: 'second'})
    env.repo.setRuntimeContributions(queryableFieldsFacet, source, [chooseRow('first')])

    const handle = env.repo.query.typedBlockIds({workspaceId: WS, where: {[field]: true}})
    expect(await handle.load()).toEqual(['first'])
    env.repo.setRuntimeContributions(queryableFieldsFacet, source, [chooseRow('second')])
    expect(await handle.load()).toEqual(['second'])
    env.repo.setRuntimeContributions(queryableFieldsFacet, source, [])
    await expect(handle.load()).rejects.toThrow(field)
  })

  it('recovers a subscribed query when its initially missing runtime field is installed', async () => {
    await create({id: 'row'})
    const field = 'test:late-field'
    const handle = env.repo.query.typedBlockIds({workspaceId: WS, where: {[field]: true}})
    const off = handle.subscribe(() => {})
    try {
      await waitFor(() => expect(handle.status()).toBe('error'))
      expect(() => handle.read()).toThrow(field)
      env.repo.setRuntimeContributions(queryableFieldsFacet, 'test', [{
        name: field,
        value: () => ({sql: '1', params: []}),
        encode: Number,
        dependencies: [workspaceId => ({kind: 'workspace', workspaceId})],
      }])
      await waitFor(() => expect(handle.peek()).toEqual(['row']))
    } finally {
      off()
    }
  })

  it('uses the requested workspace for scoped queryable fields', async () => {
    const field: QueryableField = {
      name: 'test:workspace-field',
      value: () => ({sql: '1', params: []}),
      encode: Number,
      dependencies: [workspaceId => ({kind: 'workspace', workspaceId})],
    }
    env.repo.setRuntimeContributions(queryableFieldsFacet, 'test', [field])
    await create({id: 'in-a'})
    await create({id: 'in-b', workspaceId: OTHER_WS})
    await env.repo.whenPropertyDefinitionsReady(WS)
    const where = {[field.name]: true}
    expect(await env.repo.query.typedBlockIds({workspaceId: WS, where}).load()).toEqual(['in-a'])

    env.repo.setActiveWorkspaceId(OTHER_WS)
    await env.repo.whenPropertyDefinitionsReady(OTHER_WS)
    env.repo.setRuntimeContributions(queryableFieldsFacet, 'test', [
      {...field, value: () => ({sql: '0', params: []})},
    ], {workspaceId: OTHER_WS})
    expect(await env.repo.query.typedBlockIds({workspaceId: OTHER_WS, where}).load()).toEqual([])
    expect(await env.repo.query.typedBlockIds({workspaceId: WS, where, limit: 1}).load()).toEqual(['in-a'])
  })

  it('accepts an ancestor walk bounded by an explicitly selective virtual field', async () => {
    env.repo.setRuntimeContributions(queryableFieldsFacet, 'test', [{
      name: 'test:row', bounding: true,
      value: alias => ({sql: `${alias}.id`, params: []}),
      encode: operand => codecs.string.decode(operand),
      dependencies: [workspaceId => ({kind: 'workspace', workspaceId})],
    }])
    await create({id: 'parent'})
    await create({id: 'child', parentId: 'parent'})
    await create({id: 'sibling', parentId: 'parent'})
    expect(await env.repo.query.typedBlockIds({
      workspaceId: WS, where: {'test:row': 'child'}, match: [{scope: 'ancestor', id: 'parent'}],
    }).load()).toEqual(['child'])
  })

  it.each(['created', 'updated'])('refuses ambiguous timestamp names in filters and sorts (%s)', async name => {
    await env.repo.whenPropertyDefinitionsReady(WS)
    await create({id: 'definition', properties: {types: ['property-schema'], 'property-schema:name': name, 'property-schema:preset': 'string'}})
    await waitFor(() => expect(env.repo.propertySchemas.has(name)).toBe(true))
    for (const term of [{where: {[name]: 'yesterday'}}, {order: {property: name, direction: 'desc' as const}}]) {
      await expect(env.repo.query.typedBlockIds({workspaceId: WS, ...term}).load())
        .rejects.toThrow(new RegExp(`ambiguous.*${name}`))
    }
  })

  it('keeps virtual fields outside the ancestor bound by default', async () => {
    env.repo.setRuntimeContributions(queryableFieldsFacet, 'test', [{
      name: 'test:always', value: () => ({sql: '1', params: []}), encode: Number,
      dependencies: [workspaceId => ({kind: 'workspace', workspaceId})],
    }])
    await expect(env.repo.query.typedBlockIds({
      workspaceId: WS, where: {'test:always': true}, match: [{scope: 'ancestor', id: 'first'}],
    }).load()).rejects.toThrow('require at least one candidate filter')
    await expect(env.repo.query.typedBlockIds({workspaceId: WS, where: {'test:always': {toString: 1}}}).load())
      .rejects.toThrow('unknown operator')
  })

  it('filters created and user-facing updated timestamps as milliseconds, including the legacy fallback', async () => {
    const origin = Date.UTC(2024, 0, 1)
    const lastEdit = Date.UTC(2024, 0, 2)
    await env.repo.tx(tx => tx.create({
      id: 'imported', workspaceId: WS, parentId: null, orderKey: 'a',
    }, {sourceTimestamps: {createdAt: origin, userUpdatedAt: lastEdit}}), {scope: ChangeScope.BlockDefault})
    await create({id: 'legacy'})
    await env.h.db.writeTransaction(tx => tx.execute(
      'UPDATE blocks SET updated_at = ?, user_updated_at = NULL WHERE id = ?',
      [lastEdit, 'legacy'],
    ))

    const base = {workspaceId: WS}
    expect(await env.repo.query.typedBlockIds({...base, where: {created: {eq: origin}}}).load())
      .toEqual(['imported'])
    expect(await env.repo.query.typedBlockIds({...base, where: {updated: {lte: lastEdit}}}).load())
      .toEqual(['legacy', 'imported'])
    expect(await env.repo.query.typedBlockIds({...base, where: {updated: {lt: lastEdit}}}).load())
      .toEqual([])
  })

  it('invalidates the updated filter without invalidating the created filter on a content edit', async () => {
    const createdAt = Date.UTC(2023, 0, 1)
    const userUpdatedAt = Date.UTC(2023, 0, 2)
    await env.repo.tx(tx => tx.create({
      id: 'row', workspaceId: WS, parentId: null, orderKey: 'a',
    }, {sourceTimestamps: {createdAt, userUpdatedAt}}), {scope: ChangeScope.BlockDefault})
    const created = env.repo.query.typedBlockIds({workspaceId: WS, where: {created: {eq: createdAt}}})
    const updated = env.repo.query.typedBlockIds({workspaceId: WS, where: {updated: {gt: userUpdatedAt}}})
    expect(await created.load()).toEqual(['row'])
    expect(await updated.load()).toEqual([])
    const offCreated = created.subscribe(() => {})
    const offUpdated = updated.subscribe(() => {})
    try {
      const before = env.repo.handleStore.metrics.loaderInvalidations
      await env.repo.tx(tx => tx.update('row', {content: 'edited'}), {scope: ChangeScope.BlockDefault})
      expect(env.repo.handleStore.metrics.loaderInvalidations).toBe(before + 1)
      await waitFor(() => expect(updated.peek()).toEqual(['row']))
      expect(created.peek()).toEqual(['row'])
    } finally {
      offCreated()
      offUpdated()
    }
  })

  it('requires a codec to opt into contains independently of its member encoding', () => {
    const {encode, decode} = codecs.list(codecs.string)
    const property = {
      ...labelsProp,
      codec: {type: 'test:member-list', member: codecs.string, encode, decode},
    }
    expect(() => compileTypedBlockQuery(
      {workspaceId: WS, where: {[property.name]: {contains: 'label'}}},
      {properties: new Map([[property.name, property]])},
    )).toThrow('contains requires a codec with a contains capability')
  })

  it('checks ISO date member shape even if a contributed encoder binds noncanonical text', async () => {
    const canonical = '2026-01-01T00:00:00.000Z'
    const malformed = canonical + '\u0000junk'
    const name = 'dates'
    const property = {
      ...labelsProp, name,
      codec: {...labelsProp.codec, contains: {storage: 'iso-date' as const, encode: String}},
    }
    await create({id: 'valid', properties: {[name]: [canonical]}})
    await create({id: 'malformed', properties: {[name]: [malformed]}})
    const memberIds = async (contains: string) => {
      const {sql, params} = compileTypedBlockQuery(
        {workspaceId: WS, where: {[name]: {contains}}}, {properties: new Map([[name, property]])}, {projection: 'ids'},
      )
      return env.h.db.getAll<{id: string}>(sql, [...params])
    }
    expect(await memberIds(canonical)).toEqual([{id: 'valid'}])
    expect(await memberIds(malformed)).toEqual([])
  })

  it('matches scalar list members while ignoring malformed stored list shapes', async () => {
    const {name} = labelsProp
    await create({id: 'match', properties: {[name]: ['7', 'extra']}})
    await create({id: 'scalar'})
    await create({id: 'object'})
    await create({id: 'wrong-member'})
    await env.h.db.writeTransaction(async tx => {
      for (const [id, value] of [['scalar', '7'], ['object', {label: '7'}], ['wrong-member', [7]]]) {
        await tx.execute('UPDATE blocks SET properties_json = ? WHERE id = ?', [JSON.stringify({[name]: value}), id])
      }
    })

    const where = {[name]: {contains: '7'}}
    expect(await env.repo.query.typedBlockIds({workspaceId: WS, where}).load()).toEqual(['match'])
    await expect(env.repo.queryBlocks({workspaceId: WS, where: {[name]: {contains: 7}}})).rejects.toThrow()
  })
})

describe('predicate types term', () => {
  const VIEW = 'test:view'
  const COLUMN = 'test:column'
  const setTypes = (id: string, types: readonly string[]) =>
    env.repo.tx(tx => tx.setProperty(id, typesProp, [...types]), {scope: ChangeScope.BlockDefault})

  const seedTable = async () => {
    await create({id: 'row-a', types: ['row']})
    await create({id: 'row-view', types: ['row', VIEW]})
    await create({id: 'row-b', types: ['row', 'other']})
    await create({id: 'row-column', types: ['row', COLUMN]})
    await create({id: 'plain'})
    await create({id: 'view', types: [VIEW]})
  }

  it('excludes exactly the blocks carrying any of the named types', async () => {
    await seedTable()
    const exclude = [{types: [VIEW, COLUMN]}]
    expect(await env.repo.query.typedBlockIds({workspaceId: WS, types: ['row'], exclude}).load())
      .toEqual(['row-a', 'row-b'])
    // An untyped block has no membership row, so it is not excluded.
    expect(await env.repo.query.typedBlockIds({workspaceId: WS, exclude}).load())
      .toEqual(['row-a', 'row-b', 'plain'])
    expect(await env.repo.query.typedBlockIds({workspaceId: WS, types: ['row'], exclude, limit: 1}).load())
      .toEqual(['row-a'])
    expect(await env.repo.query.typedBlockCount({workspaceId: WS, types: ['row'], exclude}).load()).toBe(2)
    expect(ids(await env.repo.query.typedBlocks({workspaceId: WS, types: ['row'], exclude}).load()))
      .toEqual(['row-a', 'row-b'])
    // Ids are trimmed like the top-level filter's.
    expect(await env.repo.query.typedBlockIds({workspaceId: WS, types: ['row'], exclude: [{types: [` ${VIEW} `, COLUMN]}]}).load())
      .toEqual(['row-a', 'row-b'])
  })

  it('matches any of the named types and ANDs with the predicate’s other terms', async () => {
    await seedTable()
    await create({id: 'open-view', types: [VIEW], properties: {status: 'open'}})
    expect(await env.repo.query.typedBlockIds({workspaceId: WS, match: [{types: [VIEW, COLUMN]}]}).load())
      .toEqual(['row-view', 'row-column', 'view', 'open-view'])
    expect(await env.repo.query.typedBlockIds({
      workspaceId: WS, match: [{types: [VIEW], where: {status: 'open'}}],
    }).load()).toEqual(['open-view'])
  })

  it('accepts a type as an anyOf alternative', async () => {
    await seedTable()
    await create({id: 'open', properties: {status: 'open'}})
    expect(await env.repo.query.typedBlockIds({
      workspaceId: WS, anyOf: [{types: [COLUMN]}, {where: {status: 'open'}}],
    }).load()).toEqual(['row-column', 'open'])
    expect(await env.repo.query.typedBlockIds({
      workspaceId: WS, types: ['row'], anyOf: [{types: [VIEW]}, {types: [` ${COLUMN}`]}],
    }).load()).toEqual(['row-view', 'row-column'])
  })

  it('treats an empty or blank types list as no type term', async () => {
    await seedTable()
    const all = ['row-a', 'row-view', 'row-b', 'row-column', 'plain', 'view']
    for (const types of [[], ['  ']]) {
      expect(await env.repo.query.typedBlockIds({workspaceId: WS, exclude: [{types}]}).load()).toEqual(all)
      expect(await env.repo.query.typedBlockIds({workspaceId: WS, match: [{types}]}).load()).toEqual(all)
      // An unconstrained alternative matches every candidate.
      expect(await env.repo.query.typedBlockIds({workspaceId: WS, anyOf: [{types}, {types: [VIEW]}]}).load())
        .toEqual(all)
    }
  })

  it('keeps foreign-workspace blocks out of every predicate position', async () => {
    await seedTable()
    await create({id: 'foreign-view', workspaceId: OTHER_WS, types: ['row', VIEW]})
    await create({id: 'foreign-row', workspaceId: OTHER_WS, types: ['row']})
    expect(await env.repo.query.typedBlockIds({workspaceId: WS, match: [{types: [VIEW]}]}).load())
      .toEqual(['row-view', 'view'])
    expect(await env.repo.query.typedBlockIds({workspaceId: WS, anyOf: [{types: [VIEW]}]}).load())
      .toEqual(['row-view', 'view'])
    expect(await env.repo.query.typedBlockIds({workspaceId: WS, types: ['row'], exclude: [{types: [VIEW]}]}).load())
      .toEqual(['row-a', 'row-b', 'row-column'])
  })

  it('matches a type on the block or any ancestor in ancestor scope', async () => {
    await create({id: 'table', types: [VIEW]})
    await create({id: 'inside', parentId: 'table', types: ['row']})
    await create({id: 'deeper', parentId: 'inside', types: ['row']})
    await create({id: 'outside', types: ['row']})
    const ancestor = {scope: 'ancestor', types: [VIEW]} as const
    expect(await env.repo.query.typedBlockIds({workspaceId: WS, types: ['row'], match: [ancestor]}).load())
      .toEqual(['inside', 'deeper'])
    expect(await env.repo.query.typedBlockIds({workspaceId: WS, types: ['row'], exclude: [ancestor]}).load())
      .toEqual(['outside'])
    // A self-scope type term bounds the ancestor walk on its own.
    expect(await env.repo.query.typedBlockIds({
      workspaceId: WS, match: [{types: ['row']}, ancestor],
    }).load()).toEqual(['inside', 'deeper'])
    await expect(env.repo.query.typedBlockIds({workspaceId: WS, match: [ancestor]}).load())
      .rejects.toThrow(/bound the recursive walk/)
  })

  it('wakes a mounted ids handle when a block gains or loses an excluded type, and stays quiet otherwise', async () => {
    await seedTable()
    const handle = env.repo.query.typedBlockIds({workspaceId: WS, types: ['row'], exclude: [{types: [VIEW, COLUMN]}]})
    expect(await handle.load()).toEqual(['row-a', 'row-b'])
    const off = handle.subscribe(() => {})
    try {
      const before = env.repo.handleStore.metrics.loaderInvalidations
      await env.repo.tx(tx => tx.update('row-a', {content: 'edited'}), {scope: ChangeScope.BlockDefault})
      await create({id: 'unrelated', types: ['other']})
      await setTypes('plain', ['other'])
      expect(env.repo.handleStore.metrics.loaderInvalidations).toBe(before)

      await setTypes('row-a', ['row', COLUMN])
      expect(env.repo.handleStore.metrics.loaderInvalidations).toBe(before + 1)
      await waitFor(() => expect(handle.peek()).toEqual(['row-b']))
      await setTypes('row-view', ['row'])
      await waitFor(() => expect(handle.peek()).toEqual(['row-view', 'row-b']))
    } finally {
      off()
    }
  })

  it('wakes a type alternative for a new matching block but not for an unrelated create', async () => {
    await create({id: 'open', properties: {status: 'open'}})
    const handle = env.repo.query.typedBlockIds({workspaceId: WS, anyOf: [{types: [VIEW]}, {where: {status: 'open'}}]})
    expect(await handle.load()).toEqual(['open'])
    const off = handle.subscribe(() => {})
    try {
      const before = env.repo.handleStore.metrics.loaderInvalidations
      await create({id: 'unrelated', types: ['other']})
      expect(env.repo.handleStore.metrics.loaderInvalidations).toBe(before)
      await create({id: 'view', types: [VIEW]})
      await waitFor(() => expect(handle.peek()).toEqual(['open', 'view']))
    } finally {
      off()
    }
  })

  // Seeding and analyzing the fixture takes well under a second.
  it('drives a limited, type-bounded exclusion from the type index before and after ANALYZE', async () => {
    await env.h.db.writeTransaction(async tx => {
      // Drop statistics an earlier fixture left behind; `ANALYZE sqlite_schema` reloads the emptied table.
      // Analyzing the empty tables first creates `sqlite_stat1` when the file runs alone.
      await tx.execute('ANALYZE main.blocks')
      await tx.execute(`DELETE FROM sqlite_stat1 WHERE tbl IN ('blocks', 'block_types')`)
      await tx.execute('ANALYZE sqlite_schema')
      await tx.execute(`
        WITH RECURSIVE nums(n) AS (VALUES(0) UNION ALL SELECT n + 1 FROM nums WHERE n < 9999)
        INSERT INTO blocks (id, workspace_id, order_key, properties_json, created_at, updated_at, created_by, updated_by)
        SELECT 'b-' || n, CASE WHEN n % 10 = 0 THEN ? ELSE ? END, 'a', CASE
                 WHEN n % 50 = 1 THEN json_object('types', json_array('row', ?))
                 WHEN n % 7 = 0 THEN json_object('types', json_array('row'))
                 WHEN n % 3 = 0 THEN json_object('types', json_array(?))
                 ELSE '{}'
               END, n, n, 'user', 'user'
        FROM nums
      `, [OTHER_WS, WS, VIEW, COLUMN])
      const query = {workspaceId: WS, types: ['row'], exclude: [{types: [VIEW, COLUMN]}]}
      const compiled = compileTypedBlockQuery(query, {properties: new Map()}, {projection: 'ids', limit: 20})
      const readPlan = async (sql: string, params: readonly unknown[]) => (await tx.getAll<{detail: string}>(
        `EXPLAIN QUERY PLAN ${sql}`, [...params],
      )).map(row => row.detail)
      const alternatives = compileTypedBlockQuery(
        {workspaceId: WS, anyOf: [{types: [VIEW]}, {types: [COLUMN]}]}, {properties: new Map()}, {projection: 'ids', limit: 20},
      )
      const assertPlan = async () => {
        const plan = await readPlan(compiled.sql, compiled.params)
        expect(plan[0]).toBe('SEARCH bt USING INDEX idx_block_types_type_workspace (type=? AND workspace_id=?)')
        expect(plan[1]).toBe('SEARCH b USING INDEX sqlite_autoindex_blocks_1 (id=?)')
        const alternativesPlan = await readPlan(alternatives.sql, alternatives.params)
        expect(alternativesPlan[0]).toBe('MULTI-INDEX OR')
        for (const detail of [...plan, ...alternativesPlan]) expect(detail).not.toMatch(/^SCAN|idx_blocks_workspace/)
      }
      await assertPlan()
      await tx.execute('ANALYZE main.blocks')
      await tx.execute('ANALYZE main.block_types')
      await assertPlan()
      const rows = await tx.getAll<{id: string}>(compiled.sql, [...compiled.params])
      expect(rows).toHaveLength(20)
    })
  }, 20_000)
})

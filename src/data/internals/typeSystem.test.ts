// @vitest-environment node

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync, type AppExtension } from '@/facets/facet'
import {
  BlockNotFoundForTypeError,
  ChangeScope,
  PropertySchemaIdentityError,
  codecs,
  defineBlockType,
  defineProperty,
  defineSameTxProcessor,
  seedProperty,
} from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import {
  definitionSeedsFacet,
  projectedPropertyDefinitionsFacet,
  sameTxProcessorsFacet,
  typesFacet,
} from '@/data/facets'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'
import { addedTypes, getBlockTypes, typesProp } from '@/data/properties'
import { Repo } from '@/data/repo'

let sharedDb: TestDb
let h: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

const createBlock = async (id: string, properties: Record<string, unknown> = {}) => {
  await repo.tx(async tx => {
    await tx.create({
      id,
      workspaceId: 'ws-1',
      parentId: null,
      orderKey: id,
      properties,
    })
  }, {scope: ChangeScope.BlockDefault, description: `create ${id}`})
}

const resolveTypeRuntime = (
  contributions: readonly AppExtension[],
) => resolveFacetRuntimeSync([
  definitionSeedsFacet.of(typesProp, {source: 'test-kernel'}),
  ...contributions,
])

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  h = sharedDb
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  repo = new Repo({
    db: h.db,
    cache: new BlockCache(),
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
    // Start empty so setFacetRuntime is the only registration path.
    installKernelRuntime: false,
  })
})

afterEach(() => { repo.stopSyncObserver() })

describe('Repo type membership orchestration', () => {
  it('adds a type, encodes initial values, and runs a type-add same-tx processor only on the first transition', async () => {
    const dueProp = defineProperty<Date | undefined>('due', {
      codec: codecs.date,
      defaultValue: new Date(0),
      changeScope: ChangeScope.BlockDefault,
    })
    const setupCountProp = defineProperty<number>('setupCount', {
      codec: codecs.number,
      defaultValue: 0,
      changeScope: ChangeScope.BlockDefault,
    })
    let setupCalls = 0
    const taskType = defineBlockType({
      id: 'task',
      properties: [dueProp, setupCountProp],
    })
    const taskAddProcessor = defineSameTxProcessor({
      name: 'test.taskAdd',
      watches: {kind: 'field', table: 'blocks', fields: ['properties']},
      apply: async (event, ctx) => {
        for (const row of event.changedRows) {
          if (!addedTypes(row).includes('task')) continue
          setupCalls++
          const block = await ctx.tx.get(row.id)
          if (!block) continue
          await ctx.tx.update(row.id, {
            properties: {
              ...block.properties,
              [setupCountProp.name]: setupCountProp.codec.encode(setupCalls),
            },
          })
        }
      },
    })
    repo.setFacetRuntime(resolveTypeRuntime([
      typesFacet.of(taskType, {source: 'test'}),
      sameTxProcessorsFacet.of(taskAddProcessor, {source: 'test'}),
    ]))
    await createBlock('b1')

    await repo.addType('b1', 'task')
    let block = repo.block('b1')
    expect(block.types).toEqual(['task'])
    expect(block.get(setupCountProp)).toBe(1)
    expect(setupCalls).toBe(1)

    const due = new Date('2026-05-01T00:00:00.000Z')
    await repo.addType('b1', 'task', {due})
    block = repo.block('b1')
    expect(block.types).toEqual(['task'])
    expect(block.get(dueProp)?.toISOString()).toBe(due.toISOString())
    expect(block.get(setupCountProp)).toBe(1)
    expect(setupCalls).toBe(1)
  })

  it('fires the type-add same-tx processor for raw tx.update(typesProp) writes (no addType orchestration)', async () => {
    const seenAdds: string[] = []
    const recorder = defineSameTxProcessor({
      name: 'test.recordTypeAdds',
      watches: {kind: 'field', table: 'blocks', fields: ['properties']},
      apply: async (event) => {
        for (const row of event.changedRows) {
          for (const t of addedTypes(row)) seenAdds.push(`${row.id}:${t}`)
        }
      },
    })
    repo.setFacetRuntime(resolveTypeRuntime([
      typesFacet.of(defineBlockType({id: 'task'}), {source: 'test'}),
      sameTxProcessorsFacet.of(recorder, {source: 'test'}),
    ]))
    await createBlock('b1')

    // Raw write — no repo.addType orchestration. The processor still fires
    // because every property write produces a row event the watcher consumes.
    await repo.tx(async tx => {
      const block = await tx.get('b1')
      if (!block) return
      await tx.update('b1', {
        properties: {
          ...block.properties,
          [typesProp.name]: typesProp.codec.encode(['task']),
        },
      })
    }, {scope: ChangeScope.BlockDefault, description: 'raw type write'})

    expect(seenAdds).toEqual(['b1:task'])
    expect(getBlockTypes(repo.block('b1').data)).toEqual(['task'])
  })

  it('does not overwrite existing properties while materialising initial values', async () => {
    const statusProp = defineProperty<string>('status', {
      codec: codecs.string,
      defaultValue: 'open',
      changeScope: ChangeScope.BlockDefault,
    })
    repo.setFacetRuntime(resolveTypeRuntime([
      typesFacet.of(defineBlockType({id: 'todo', properties: [statusProp]}), {source: 'test'}),
    ]))
    await createBlock('b1')

    await repo.addType('b1', 'todo', {status: 'open'})
    await repo.addType('b1', 'todo', {status: 'done'})

    expect(repo.block('b1').get(statusProp)).toBe('open')
  })

  it('rejects a shadowed type-declared schema before adding membership or initial values', async () => {
    const shadowed = seedProperty({
      seedKey: 'system:test/property/status',
      revision: 1,
      name: 'status',
      preset: 'string',
      defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
    })
    const winner = defineProperty('status', {
      codec: codecs.number,
      defaultValue: 0,
      changeScope: ChangeScope.BlockDefault,
    })
    repo.setFacetRuntime(resolveTypeRuntime([
      typesFacet.of(defineBlockType({id: 'todo', properties: [shadowed]}), {source: 'test'}),
    ]))
    repo.setActiveWorkspaceId('ws-1')
    repo.setRuntimeContributions(definitionSeedsFacet, 'test-seed', [shadowed])
    repo.setRuntimeContributions(projectedPropertyDefinitionsFacet, 'test-winner', [{
      metadata: {
        fieldId: 'field-user-status',
        workspaceId: 'ws-1',
        createdAt: 1,
        name: 'status',
        changeScope: ChangeScope.BlockDefault,
        hidden: false,
        origin: 'user',
      },
      schema: winner,
    }], {workspaceId: 'ws-1'})
    await createBlock('b1')
    await createBlock('caught')

    await expect(repo.addType('b1', 'todo', {status: 7}))
      .rejects.toBeInstanceOf(PropertySchemaIdentityError)
    expect(getBlockTypes(repo.block('b1').data)).toEqual([])
    expect(repo.block('b1').peek()!.properties.status).toBeUndefined()

    await repo.tx(async tx => {
      try {
        await repo.addTypeInTx(
          tx,
          'caught',
          'todo',
          {status: 7},
          repo.snapshotTypeRegistries(),
        )
      } catch (error) {
        expect(error).toBeInstanceOf(PropertySchemaIdentityError)
      }
    }, {scope: ChangeScope.BlockDefault})
    expect(getBlockTypes(repo.block('caught').data)).toEqual([])
    expect(repo.block('caught').peek()!.properties.status).toBeUndefined()
  })

  it('gates add, remove, toggle, and set writes to the types membership cell', async () => {
    const winner = defineProperty('types', {
      codec: codecs.string,
      defaultValue: 'winner-default',
      changeScope: ChangeScope.BlockDefault,
    })
    repo.setFacetRuntime(resolveTypeRuntime([
      typesFacet.of(defineBlockType({id: 'todo'}), {source: 'test'}),
    ]))
    repo.setActiveWorkspaceId('ws-1')
    repo.setRuntimeContributions(projectedPropertyDefinitionsFacet, 'test-types-winner', [{
      metadata: {
        fieldId: 'field-user-types',
        workspaceId: 'ws-1',
        createdAt: 1,
        name: 'types',
        changeScope: ChangeScope.BlockDefault,
        hidden: false,
        origin: 'user',
      },
      schema: winner,
    }], {workspaceId: 'ws-1'})
    await createBlock('add', {types: 'winner-add'})
    await createBlock('remove', {types: 'winner-remove'})
    await createBlock('toggle', {types: 'winner-toggle'})
    await createBlock('set', {types: 'winner-set'})

    await expect(repo.addType('add', 'todo')).rejects.toBeInstanceOf(PropertySchemaIdentityError)
    await expect(repo.removeType('remove', 'todo')).rejects.toBeInstanceOf(PropertySchemaIdentityError)
    await expect(repo.toggleType('toggle', 'todo')).rejects.toBeInstanceOf(PropertySchemaIdentityError)
    await expect(repo.setBlockTypes('set', [])).rejects.toBeInstanceOf(PropertySchemaIdentityError)

    expect(repo.block('add').peek()!.properties.types).toBe('winner-add')
    expect(repo.block('remove').peek()!.properties.types).toBe('winner-remove')
    expect(repo.block('toggle').peek()!.properties.types).toBe('winner-toggle')
    expect(repo.block('set').peek()!.properties.types).toBe('winner-set')
  })

  it('pins a divergent-named type-property seed to its declared name and preserves an existing value', async () => {
    const declared = seedProperty({
      seedKey: 'system:test/property/status',
      revision: 1,
      name: 'status',
      preset: 'optional-string',
      defaultValue: undefined,
      changeScope: ChangeScope.BlockDefault,
    })
    const fieldId = propertyDefinitionBlockId('ws-1', declared.seedKey)
    repo.setFacetRuntime(resolveTypeRuntime([
      typesFacet.of(defineBlockType({id: 'todo', properties: [declared]}), {source: 'test'}),
    ]))
    repo.setActiveWorkspaceId('ws-1')
    repo.setRuntimeContributions(definitionSeedsFacet, 'test-seed', [declared])
    // The projected row carries a divergent stored name; seeds are non-renamable
    // (rename deferred to #288), so it is ignored and the property stays at its
    // declared name — the type section and writes resolve under 'status'.
    repo.setRuntimeContributions(projectedPropertyDefinitionsFacet, 'test-renamed', [{
      metadata: {
        fieldId,
        workspaceId: 'ws-1',
        createdAt: 1,
        name: 'renamed-status',
        changeScope: ChangeScope.BlockDefault,
        hidden: false,
        seedKey: declared.seedKey,
        origin: 'plugin:system:test',
      },
    }], {workspaceId: 'ws-1'})
    await createBlock('empty')
    await createBlock('existing', {status: null})

    await repo.addType('empty', 'todo', {status: 'initial'})
    await repo.addType('existing', 'todo', {status: 'replacement'})

    expect(repo.block('empty').peek()!.properties).toMatchObject({
      types: ['todo'],
      status: 'initial',
    })
    expect(repo.block('empty').peek()!.properties['renamed-status']).toBeUndefined()
    expect(repo.block('existing').peek()!.properties.status).toBeNull()
  })

  it('throws for unknown type ids and unknown initial value schemas', async () => {
    repo.setFacetRuntime(resolveTypeRuntime([
      typesFacet.of(defineBlockType({id: 'todo'}), {source: 'test'}),
    ]))
    await createBlock('b1')

    await expect(repo.addType('b1', 'missing')).rejects.toThrow('[addType] type id "missing" is not registered')
    await expect(repo.addType('b1', 'todo', {status: 'open'}))
      .rejects.toThrow('initialValues["status"] has no registered PropertySchema')
    expect(getBlockTypes(repo.block('b1').data)).toEqual([])
  })

  it('removes, toggles, and sets type membership in one tx per operation', async () => {
    repo.setFacetRuntime(resolveTypeRuntime([
      typesFacet.of(defineBlockType({id: 'a'}), {source: 'test'}),
      typesFacet.of(defineBlockType({id: 'b'}), {source: 'test'}),
    ]))
    await createBlock('b1')

    const block = repo.block('b1')
    await block.addType('a')
    expect(block.hasType('a')).toBe(true)

    await block.toggleType('a')
    expect(block.types).toEqual([])

    await block.toggleType('a')
    expect(block.types).toEqual(['a'])

    await repo.setBlockTypes('b1', ['b', 'a', 'b'])
    expect(block.types).toEqual(['b', 'a'])

    await block.removeType('b')
    expect(block.types).toEqual(['a'])
  })

  it('addType throws BlockNotFoundForTypeError when the target block is missing', async () => {
    repo.setFacetRuntime(resolveTypeRuntime([
      typesFacet.of(defineBlockType({id: 'todo'}), {source: 'test'}),
    ]))

    await expect(repo.addType('does-not-exist', 'todo')).rejects.toBeInstanceOf(BlockNotFoundForTypeError)
    try {
      await repo.addType('does-not-exist', 'todo')
    } catch (err) {
      const e = err as BlockNotFoundForTypeError
      expect(e.blockId).toBe('does-not-exist')
      expect(e.typeId).toBe('todo')
      expect(e.reason).toBe('missing')
    }
  })

  it('addTypeInTx (strict default) throws BlockNotFoundForTypeError on a missing block', async () => {
    repo.setFacetRuntime(resolveTypeRuntime([
      typesFacet.of(defineBlockType({id: 'todo'}), {source: 'test'}),
    ]))
    const snapshot = repo.snapshotTypeRegistries()

    let caught: unknown = null
    await repo.tx(async tx => {
      try {
        await repo.addTypeInTx(tx, 'ghost', 'todo', {}, snapshot)
      } catch (err) {
        caught = err
        throw err
      }
    }, {scope: ChangeScope.BlockDefault, description: 'strict missing'}).catch(() => {})

    expect(caught).toBeInstanceOf(BlockNotFoundForTypeError)
    const e = caught as BlockNotFoundForTypeError
    expect(e.blockId).toBe('ghost')
    expect(e.typeId).toBe('todo')
    expect(e.reason).toBe('missing')
  })

  it('addTypeInTx (strict default) throws BlockNotFoundForTypeError on a tombstoned block', async () => {
    repo.setFacetRuntime(resolveTypeRuntime([
      typesFacet.of(defineBlockType({id: 'todo'}), {source: 'test'}),
    ]))
    await createBlock('b1')
    // Soft-delete the row so tx.get returns it with deleted=true.
    await repo.tx(async tx => {
      await tx.delete('b1')
    }, {scope: ChangeScope.BlockDefault, description: 'tombstone'})

    const snapshot = repo.snapshotTypeRegistries()
    let caught: unknown = null
    await repo.tx(async tx => {
      try {
        await repo.addTypeInTx(tx, 'b1', 'todo', {}, snapshot)
      } catch (err) {
        caught = err
        throw err
      }
    }, {scope: ChangeScope.BlockDefault, description: 'strict tombstone'}).catch(() => {})

    expect(caught).toBeInstanceOf(BlockNotFoundForTypeError)
    const e = caught as BlockNotFoundForTypeError
    expect(e.blockId).toBe('b1')
    expect(e.typeId).toBe('todo')
    expect(e.reason).toBe('tombstoned')
  })

  it('addTypeInTxLenient silently no-ops on a missing block (preserves legacy semantics)', async () => {
    repo.setFacetRuntime(resolveTypeRuntime([
      typesFacet.of(defineBlockType({id: 'todo'}), {source: 'test'}),
    ]))
    const snapshot = repo.snapshotTypeRegistries()

    // Should not throw; should not write anything.
    await repo.tx(async tx => {
      await repo.addTypeInTxLenient(tx, 'ghost', 'todo', {}, snapshot)
    }, {scope: ChangeScope.BlockDefault, description: 'lenient missing'})
  })

  it('addTypeInTxLenient silently no-ops on a tombstoned block', async () => {
    repo.setFacetRuntime(resolveTypeRuntime([
      typesFacet.of(defineBlockType({id: 'todo'}), {source: 'test'}),
    ]))
    await createBlock('b1')
    await repo.tx(async tx => {
      await tx.delete('b1')
    }, {scope: ChangeScope.BlockDefault, description: 'tombstone'})

    const snapshot = repo.snapshotTypeRegistries()
    await repo.tx(async tx => {
      await repo.addTypeInTxLenient(tx, 'b1', 'todo', {}, snapshot)
    }, {scope: ChangeScope.BlockDefault, description: 'lenient tombstone'})
  })

  it('addTypeInTx (strict default) tags a valid block normally', async () => {
    repo.setFacetRuntime(resolveTypeRuntime([
      typesFacet.of(defineBlockType({id: 'todo'}), {source: 'test'}),
    ]))
    await createBlock('b1')
    const snapshot = repo.snapshotTypeRegistries()

    await repo.tx(async tx => {
      await repo.addTypeInTx(tx, 'b1', 'todo', {}, snapshot)
    }, {scope: ChangeScope.BlockDefault, description: 'strict happy'})

    expect(repo.block('b1').types).toEqual(['todo'])
  })

  it('addTypeInTx uses a caller-supplied registry snapshot', async () => {
    const statusProp = defineProperty<string>('status', {
      codec: codecs.string,
      defaultValue: 'open',
      changeScope: ChangeScope.BlockDefault,
    })
    repo.setFacetRuntime(resolveTypeRuntime([
      typesFacet.of(defineBlockType({id: 'todo', properties: [statusProp]}), {source: 'test'}),
    ]))
    const snapshot = repo.snapshotTypeRegistries()

    await repo.tx(async tx => {
      await tx.create({
        id: 'b1',
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'a0',
      })
      await repo.addTypeInTx(tx, 'b1', 'todo', {status: 'open'}, snapshot)
    }, {scope: ChangeScope.BlockDefault, description: 'create todo'})

    const block = repo.block('b1')
    expect(block.types).toEqual(['todo'])
    expect(block.get(statusProp)).toBe('open')
    expect(block.data.properties[typesProp.name]).toEqual(['todo'])
  })
})

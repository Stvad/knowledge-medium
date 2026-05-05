// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import {
  ChangeScope,
  codecs,
  defineBlockType,
  defineProperty,
} from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { typesFacet } from '@/data/facets'
import { getBlockTypes, typesProp } from '@/data/properties'
import { Repo } from '@/data/repo'

let h: TestDb
let repo: Repo

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

beforeEach(async () => {
  h = await createTestDb()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  repo = new Repo({
    db: h.db,
    cache: new BlockCache(),
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
    registerKernelMutators: false,
    registerKernelProcessors: false,
    registerKernelQueries: false,
  })
})

afterEach(async () => {
  await h.cleanup()
})

describe('Repo type membership orchestration', () => {
  it('adds a type, encodes initial values, and runs setup only on the first transition', async () => {
    const dueProp = defineProperty<Date>('due', {
      codec: codecs.date,
      defaultValue: new Date(0),
      changeScope: ChangeScope.BlockDefault,
      kind: 'date',
    })
    const setupCountProp = defineProperty<number>('setupCount', {
      codec: codecs.number,
      defaultValue: 0,
      changeScope: ChangeScope.BlockDefault,
      kind: 'number',
    })
    let setupCalls = 0
    const taskType = defineBlockType({
      id: 'task',
      properties: [dueProp, setupCountProp],
      setup: async ({tx, id}) => {
        setupCalls++
        const block = await tx.get(id)
        if (!block) return
        await tx.update(id, {
          properties: {
            ...block.properties,
            [setupCountProp.name]: setupCountProp.codec.encode(setupCalls),
          },
        })
      },
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([
      typesFacet.of(taskType, {source: 'test'}),
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
    expect(block.get(dueProp).toISOString()).toBe(due.toISOString())
    expect(block.get(setupCountProp)).toBe(1)
    expect(setupCalls).toBe(1)
  })

  it('does not overwrite existing properties while materialising initial values', async () => {
    const statusProp = defineProperty<string>('status', {
      codec: codecs.string,
      defaultValue: 'open',
      changeScope: ChangeScope.BlockDefault,
      kind: 'string',
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([
      typesFacet.of(defineBlockType({id: 'todo', properties: [statusProp]}), {source: 'test'}),
    ]))
    await createBlock('b1')

    await repo.addType('b1', 'todo', {status: 'open'})
    await repo.addType('b1', 'todo', {status: 'done'})

    expect(repo.block('b1').get(statusProp)).toBe('open')
  })

  it('throws for unknown type ids and unknown initial value schemas', async () => {
    repo.setFacetRuntime(resolveFacetRuntimeSync([
      typesFacet.of(defineBlockType({id: 'todo'}), {source: 'test'}),
    ]))
    await createBlock('b1')

    await expect(repo.addType('b1', 'missing')).rejects.toThrow('[addType] type id "missing" is not registered')
    await expect(repo.addType('b1', 'todo', {status: 'open'}))
      .rejects.toThrow('initialValues["status"] has no registered PropertySchema')
    expect(getBlockTypes(repo.block('b1').data)).toEqual([])
  })

  it('removes, toggles, and sets type membership in one tx per operation', async () => {
    repo.setFacetRuntime(resolveFacetRuntimeSync([
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

  it('addTypeInTx uses a caller-supplied registry snapshot', async () => {
    const statusProp = defineProperty<string>('status', {
      codec: codecs.string,
      defaultValue: 'open',
      changeScope: ChangeScope.BlockDefault,
      kind: 'string',
    })
    repo.setFacetRuntime(resolveFacetRuntimeSync([
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

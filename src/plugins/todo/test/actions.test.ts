// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { typesProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { cycleTodoState } from '../actions'
import { todoDataExtension } from '../dataExtension'
import { statusProp, TODO_TYPE } from '../schema'

let h: TestDb
let repo: Repo

beforeEach(async () => {
  h = await createTestDb()
  let now = 1700_000_000_000
  let id = 0
  repo = new Repo({
    db: h.db,
    cache: new BlockCache(),
    user: {id: 'user-1'},
    now: () => ++now,
    newId: () => `generated-${++id}`,
    registerKernelProcessors: false,
  })
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    todoDataExtension,
  ]))
  expect(repo.propertySchemas.get(statusProp.name)).toBe(statusProp)
  await repo.tx(tx => tx.create({
    id: 'block-1',
    workspaceId: 'ws-1',
    parentId: null,
    orderKey: 'a0',
  }), {scope: ChangeScope.BlockDefault, description: 'create block'})
})

afterEach(async () => {
  await h.cleanup()
})

describe('cycleTodoState', () => {
  it('rotates not todo -> open -> done -> not todo', async () => {
    const block = repo.block('block-1')

    await cycleTodoState(block)
    expect(block.types).toContain(TODO_TYPE)
    expect(block.get(statusProp)).toBe('open')

    await cycleTodoState(block)
    expect(block.types).toContain(TODO_TYPE)
    expect(block.get(statusProp)).toBe('done')

    await cycleTodoState(block)
    expect(block.types).not.toContain(TODO_TYPE)
    expect(block.peekProperty(statusProp)).toBeUndefined()
  })

  it('reopens as open even when a stale status property exists without todo type', async () => {
    await repo.tx(async tx => {
      await tx.update('block-1', {
        properties: {
          [statusProp.name]: statusProp.codec.encode('done'),
          [typesProp.name]: typesProp.codec.encode([]),
        },
      })
    }, {scope: ChangeScope.BlockDefault, description: 'seed stale status'})

    const block = repo.block('block-1')
    await cycleTodoState(block)

    expect(block.types).toContain(TODO_TYPE)
    expect(block.get(statusProp)).toBe('open')
  })
})

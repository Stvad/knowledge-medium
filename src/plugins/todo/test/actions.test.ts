// @vitest-environment node

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { typesProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { SWIPE_RIGHT_BLOCK_ACTION_ID } from '@/plugins/swipe-quick-actions'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types'
import { cycleTodoState, todoActions } from '../actions'
import { todoDataExtension } from '../dataExtension'
import { statusProp, TODO_TYPE } from '../schema'

let sharedDb: TestDb
let h: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  h = sharedDb
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

afterEach(() => { repo.stopSyncObserver() })

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

  it('uses todo cycling as the baseline swipe-right block action', async () => {
    const action = todoActions.find(it => it.id === SWIPE_RIGHT_BLOCK_ACTION_ID) as
      ActionConfig<typeof ActionContextTypes.NORMAL_MODE> | undefined
    expect(action?.context).toBe(ActionContextTypes.NORMAL_MODE)

    const block = repo.block('block-1')
    await action?.handler({block, uiStateBlock: block}, {} as CustomEvent)

    expect(block.types).toContain(TODO_TYPE)
    expect(block.get(statusProp)).toBe('open')
  })
})

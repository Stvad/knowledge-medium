// @vitest-environment happy-dom

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb.js'
import { createTestRepo } from '@/data/test/createTestRepo'
import { focusBlock, isEditingProp, selectionStateProp } from '@/data/properties.js'
import type { ActionTrigger, BlockPointerDependencies } from '@/shortcuts/types.js'
import { selectHeldBlockAction, toggleTappedBlockAction } from '../actions.ts'

const WS = 'ws-1'
const USER: User = {id: 'user-1'}

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'panel', workspaceId: WS, parentId: null, orderKey: 'a0'})
    await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'root'})
    for (const [id, orderKey] of [['r1', 'a0'], ['r2', 'b0'], ['r3', 'c0']]) {
      await tx.create({id, workspaceId: WS, parentId: 'root', orderKey, content: id})
    }
  }, {scope: ChangeScope.UiState})
})

const depsFor = (blockId: string): BlockPointerDependencies => ({
  block: repo.block(blockId),
  uiStateBlock: repo.block('panel'),
  scopeRootId: 'root',
  targetElement: document.body,
})

const trigger = {} as ActionTrigger
const selection = () => repo.block('panel').peekProperty(selectionStateProp)

describe('selectHeldBlockAction', () => {
  it('starts a selection at the held block', async () => {
    await selectHeldBlockAction.handler(depsFor('r2'), trigger)
    expect(selection()).toEqual({selectedBlockIds: ['r2'], anchorBlockId: 'r2'})
  })

  it('adds the held block to a selection already under way', async () => {
    await repo.block('panel').set(selectionStateProp, {selectedBlockIds: ['r1'], anchorBlockId: 'r1'})
    await selectHeldBlockAction.handler(depsFor('r3'), trigger)
    expect(selection()).toEqual({selectedBlockIds: ['r1', 'r3'], anchorBlockId: 'r1'})
  })

  it('keeps a held block that is already selected, and still handles the hold', async () => {
    await repo.block('panel').set(selectionStateProp, {selectedBlockIds: ['r1', 'r2'], anchorBlockId: 'r1'})
    const result = await selectHeldBlockAction.handler(depsFor('r2'), trigger)
    expect(result).not.toBe(false)
    expect(selection()).toEqual({selectedBlockIds: ['r1', 'r2'], anchorBlockId: 'r1'})
  })

  it('takes edit mode off the block that was being edited', async () => {
    const panel = repo.block('panel')
    await focusBlock(panel, 'r1', {edit: true})
    expect(panel.peekProperty(isEditingProp)).toBe(true)

    await selectHeldBlockAction.handler(depsFor('r2'), trigger)

    expect(panel.peekProperty(isEditingProp)).toBe(false)
  })
})

describe('toggleTappedBlockAction', () => {
  it('only takes a tap while blocks are selected; otherwise the tap edits as usual', async () => {
    expect(toggleTappedBlockAction.canDispatch?.(depsFor('r1'))).toBe(false)
    await repo.block('panel').set(selectionStateProp, {selectedBlockIds: ['r1'], anchorBlockId: 'r1'})
    expect(toggleTappedBlockAction.canDispatch?.(depsFor('r1'))).toBe(true)
  })

  it('adds a tapped block, removes a tapped selected one, and ends the selection with the last', async () => {
    await repo.block('panel').set(selectionStateProp, {selectedBlockIds: ['r1'], anchorBlockId: 'r1'})

    await toggleTappedBlockAction.handler(depsFor('r2'), trigger)
    expect(selection()).toEqual({selectedBlockIds: ['r1', 'r2'], anchorBlockId: 'r1'})

    await toggleTappedBlockAction.handler(depsFor('r1'), trigger)
    await toggleTappedBlockAction.handler(depsFor('r2'), trigger)
    expect(selection()).toEqual({selectedBlockIds: [], anchorBlockId: null})
  })
})

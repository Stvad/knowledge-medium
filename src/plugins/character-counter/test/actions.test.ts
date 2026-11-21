// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import type { MultiSelectModeDependencies } from '@/shortcuts/types'
import { addWordCounterAction } from '../actions'
import { WORD_COUNTER_TYPE } from '../blockType'
import { characterCounterDataExtension } from '../dataExtension'
import { charProfileProp, charScopeProp } from '../properties'

const WS = 'ws-counter-actions'
const A = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
const B = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({
    db: sharedDb.db, user: {id: 'user-1'}, extensions: [characterCounterDataExtension],
  }).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: A, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'one'})
    await tx.create({id: B, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'two'})
  }, {scope: ChangeScope.BlockDefault})
})

const selection = (...ids: string[]) =>
  ({selectedBlocks: ids.map(id => repo.block(id))}) as unknown as MultiSelectModeDependencies

describe('add counter commands', () => {
  it('tag every selected block, each starting on its type\'s values', async () => {
    await addWordCounterAction.blocks.handler(selection(A, B), new CustomEvent('test'))
    for (const id of [A, B]) {
      const block = repo.block(id)
      expect(block.hasType(WORD_COUNTER_TYPE)).toBe(true)
      expect(block.get(charScopeProp)).toBe('subtree')
      expect(block.get(charProfileProp)).toBe('words')
    }
  })

  it('still tag the rest of a selection when one block was deleted', async () => {
    await repo.block(B).delete()
    await addWordCounterAction.blocks.handler(selection(A, B), new CustomEvent('test'))
    expect(repo.block(A).hasType(WORD_COUNTER_TYPE)).toBe(true)
  })

  it('treat a block with a malformed types cell as lacking the type instead of throwing', async () => {
    await repo.tx(async tx => { await tx.update(A, {properties: {types: 'not-a-list'}}) }, {scope: ChangeScope.BlockDefault})
    expect(repo.block(A).peek()!.properties.types).toBe('not-a-list')
    expect(addWordCounterAction.blocks.isVisible!(selection(A))).toBe(true)
  })

  it('are offered while some selected block lacks the type, and hidden once all have it', async () => {
    await repo.addType(A, WORD_COUNTER_TYPE)
    const isVisible = addWordCounterAction.blocks.isVisible!
    expect(isVisible(selection(A, B))).toBe(true)
    expect(isVisible(selection(A))).toBe(false)
  })
})

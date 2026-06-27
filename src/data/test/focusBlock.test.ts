// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { focusBlock, focusedBlockLocationProp, isEditingProp, topLevelBlockIdProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'

const WS = 'ws-1'
const USER = {id: 'user-1'}
const NOTE_SCOPE = 'outline:root'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: USER,
    newId: () => crypto.randomUUID(),
  })
  repo.setActiveWorkspaceId(WS)

  await repo.tx(async tx => {
    await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Root'})
    await tx.create({id: 'note-1', workspaceId: WS, parentId: 'root', orderKey: 'a0', content: 'Note'})
    await tx.create({id: 'note-2', workspaceId: WS, parentId: 'root', orderKey: 'a1', content: 'Other'})
    await tx.create({
      id: 'ui',
      workspaceId: WS,
      parentId: null,
      orderKey: 'z0',
      content: 'UI',
    })
  }, {scope: ChangeScope.BlockDefault, description: 'seed focusBlock fixture'})
  await repo.block('ui').set(topLevelBlockIdProp, 'root')

  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  env = await setup()
})

describe('focusBlock', () => {
  it('preserves edit mode when a same-location normal focus write lands after edit mode', async () => {
    const uiStateBlock = env.repo.block('ui')

    await focusBlock(uiStateBlock, 'note-1', {edit: true, renderScopeId: NOTE_SCOPE})
    await focusBlock(uiStateBlock, 'note-1', {renderScopeId: NOTE_SCOPE})

    expect(uiStateBlock.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'note-1',
      renderScopeId: NOTE_SCOPE,
    })
    expect(uiStateBlock.peekProperty(isEditingProp)).toBe(true)
  })

  it('still exits edit mode when normal focus moves to another block', async () => {
    const uiStateBlock = env.repo.block('ui')

    await focusBlock(uiStateBlock, 'note-1', {edit: true, renderScopeId: NOTE_SCOPE})
    await focusBlock(uiStateBlock, 'note-2', {renderScopeId: NOTE_SCOPE})

    expect(uiStateBlock.peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: 'note-2',
      renderScopeId: NOTE_SCOPE,
    })
    expect(uiStateBlock.peekProperty(isEditingProp)).toBe(false)
  })
})

// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockCache } from '@/data/blockCache.js'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb.js'
import { selectionStateProp } from '@/data/properties.js'
import type { ActionTrigger, BlockPointerDependencies } from '@/shortcuts/types.js'
import { toggleBlockSelectionAction } from '@/extensions/blockSelectionAction.js'

const WS = 'ws-1'
const USER: User = {id: 'user-1'}

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = new Repo({db: sharedDb.db, cache: new BlockCache(), user: USER, registerKernelProcessors: false})
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'panel', workspaceId: WS, parentId: null, orderKey: 'a0'})
    await tx.create({id: 'A', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'A'})
    await tx.create({id: 'B', workspaceId: WS, parentId: null, orderKey: 'c0', content: 'B'})
  }, {scope: ChangeScope.UiState})
})

afterEach(() => { repo.stopSyncObserver() })

describe('toggleBlockSelectionAction', () => {
  const toggle = (blockId: string) =>
    toggleBlockSelectionAction.handler({
      block: repo.block(blockId),
      uiStateBlock: repo.block('panel'),
    } as BlockPointerDependencies, {} as ActionTrigger)

  it('adds and removes the clicked block from the selection, tracking the anchor', async () => {
    const panel = repo.block('panel')
    // The handler fire-and-forgets the selection-state set, and each toggle
    // reads the prior committed state — so wait for each commit before the next.
    const expectSelection = (state: {selectedBlockIds: string[]; anchorBlockId: string | null}) =>
      vi.waitFor(() => expect(panel.peekProperty(selectionStateProp)).toEqual(state))

    await toggle('A')
    await expectSelection({selectedBlockIds: ['A'], anchorBlockId: 'A'})

    await toggle('B')
    await expectSelection({selectedBlockIds: ['A', 'B'], anchorBlockId: 'A'})

    // Toggling A back out keeps B and the original anchor.
    await toggle('A')
    await expectSelection({selectedBlockIds: ['B'], anchorBlockId: 'A'})

    // Removing the last block clears the anchor.
    await toggle('B')
    await expectSelection({selectedBlockIds: [], anchorBlockId: null})
  })
})

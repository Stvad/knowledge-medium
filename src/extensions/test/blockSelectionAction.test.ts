// @vitest-environment happy-dom

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb.js'
import { createTestRepo } from '@/data/test/createTestRepo'
import { focusBlock, selectionStateProp } from '@/data/properties.js'
import type { ActionTrigger, BlockPointerDependencies } from '@/shortcuts/types.js'
import {
  extendBlockSelectionAction,
  toggleBlockSelectionAction,
} from '@/extensions/blockSelectionAction.js'

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
    await tx.create({id: 'A', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'A'})
    await tx.create({id: 'B', workspaceId: WS, parentId: null, orderKey: 'c0', content: 'B'})
    await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'd0', content: 'root'})
    for (const [id, orderKey] of [['r1', 'a0'], ['r2', 'b0'], ['r3', 'c0']]) {
      await tx.create({id, workspaceId: WS, parentId: 'root', orderKey, content: id})
    }
  }, {scope: ChangeScope.UiState})
})

describe('extendBlockSelectionAction', () => {
  const SCOPE = 'panel:root'

  it('extends from the range origin the gesture carries rather than the focused row', async () => {
    const panel = repo.block('panel')
    await focusBlock(panel, 'r2', {renderScopeId: SCOPE})

    await extendBlockSelectionAction.handler({
      block: repo.block('r3'),
      uiStateBlock: panel,
      scopeRootId: 'root',
      targetElement: document.body,
      rangeOrigin: {blockId: 'r1', renderScopeId: SCOPE},
    }, {} as ActionTrigger)

    expect(panel.peekProperty(selectionStateProp)).toEqual({
      selectedBlockIds: ['r1', 'r2', 'r3'],
      anchorBlockId: 'r1',
    })
  })

  it('lets an active selection anchor win over the range origin', async () => {
    const panel = repo.block('panel')
    await focusBlock(panel, 'r3', {renderScopeId: SCOPE})
    await panel.set(selectionStateProp, {selectedBlockIds: ['r2'], anchorBlockId: 'r2'})

    await extendBlockSelectionAction.handler({
      block: repo.block('r3'),
      uiStateBlock: panel,
      scopeRootId: 'root',
      targetElement: document.body,
      rangeOrigin: {blockId: 'r1', renderScopeId: SCOPE},
    }, {} as ActionTrigger)

    expect(panel.peekProperty(selectionStateProp)).toEqual({
      selectedBlockIds: ['r2', 'r3'],
      anchorBlockId: 'r2',
    })
  })
})

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

  // Multi-select actions fan out over the selection in its stored order
  // (indent, move up/down), so a block toggled in out of order must still
  // land in document order: indenting [r3, r2] in that order nests r3 under r2.
  it('keeps the selection in document order whatever order blocks are toggled in', async () => {
    const panel = repo.block('panel')
    await toggle('r3')
    await toggle('r1')
    await toggle('r2')
    expect(panel.peekProperty(selectionStateProp)?.selectedBlockIds).toEqual(['r1', 'r2', 'r3'])
  })

  it('orders a block among selected blocks at other depths by where it renders', async () => {
    await repo.tx(async tx => {
      await tx.create({id: 'r1a', workspaceId: WS, parentId: 'r1', orderKey: 'a0', content: 'r1a'})
    }, {scope: ChangeScope.UiState})
    const panel = repo.block('panel')
    await toggle('r2')
    await toggle('r1a')
    expect(panel.peekProperty(selectionStateProp)?.selectedBlockIds).toEqual(['r1a', 'r2'])

    // Selecting the parent replaces its selected child, in the child's place.
    await toggle('r1')
    expect(panel.peekProperty(selectionStateProp)?.selectedBlockIds).toEqual(['r1', 'r2'])
  })
})

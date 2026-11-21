// @vitest-environment node
/**
 * `move_down` / `move_up` resolve their target with an awaited model walk —
 * on an uncached `childIds` that's a DB round-trip. A click or a second
 * keystroke can land inside that window, and the resumed invocation would
 * then write focus from a row that no longer holds it: overwriting the newer
 * intent, or making two fast presses land on the same row.
 *
 * This path carries most of the traffic since spatial navigation started
 * declining to it at the lazily-mounted boundary, so it's pinned here rather
 * than left to the caller.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  focusBlock,
  focusedBlockLocationProp,
  peekFocusedBlockLocation,
  selectionStateProp,
} from '@/data/properties'
import { getVimNormalModeActions } from '../actions.ts'
import type { ActionTrigger, BlockShortcutDependencies } from '@/shortcuts/types'

const WS = 'ws-1'
const USER: User = {id: 'user-1'}
const PANEL_UI = 'panel-ui'
const ROOT = 'root'

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: ROOT, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Root'})
    await tx.create({id: 'a', workspaceId: WS, parentId: ROOT, orderKey: 'a0', content: 'a'})
    await tx.create({id: 'b', workspaceId: WS, parentId: ROOT, orderKey: 'a1', content: 'b'})
    await tx.create({id: 'elsewhere', workspaceId: WS, parentId: ROOT, orderKey: 'a2', content: 'elsewhere'})
    await tx.create({id: PANEL_UI, workspaceId: WS, parentId: null, orderKey: 'z0', content: 'Panel UI'})
  }, {scope: ChangeScope.BlockDefault, description: 'seed stale-focus fixture'})
  await repo.load(PANEL_UI)
})

const trigger = {preventDefault: vi.fn()} as unknown as ActionTrigger

const actionById = (id: string) => {
  const action = getVimNormalModeActions({repo}).find(a => a.id === id)
  if (!action) throw new Error(`missing ${id}`)
  return action
}

/** Focus writes are fire-and-forget, so a bare assertion would run before a
 *  stale one could land. Transactions commit in order — once an awaited write
 *  is through, anything queued ahead of it has landed too. */
const fenceWrites = async () => {
  await repo.block(PANEL_UI).set(selectionStateProp, {selectedBlockIds: [], anchorBlockId: null})
}

describe('move_down / move_up with focus moved during the walk', () => {
  const stale = (blockId: string): BlockShortcutDependencies => ({
    uiStateBlock: repo.block(PANEL_UI),
    scopeRootId: ROOT,
    block: repo.block(blockId),
    // The row this keystroke started on...
    renderScopeId: `panel:${blockId}`,
  } as BlockShortcutDependencies)

  it('move_down does not write when focus has left the starting row', async () => {
    // ...while focus has already moved on, as a click would have moved it.
    await focusBlock(repo.block(PANEL_UI), 'elsewhere', {renderScopeId: 'panel:elsewhere'})

    await actionById('move_down').handler(stale('a'), trigger)
    await fenceWrites()

    // Not 'b' — that would be the superseded keystroke overwriting the click.
    expect(peekFocusedBlockLocation(repo.block(PANEL_UI))).toEqual({
      blockId: 'elsewhere',
      renderScopeId: 'panel:elsewhere',
    })
  })

  it('move_up does not write when focus has left the starting row', async () => {
    await focusBlock(repo.block(PANEL_UI), 'elsewhere', {renderScopeId: 'panel:elsewhere'})

    await actionById('move_up').handler(stale('b'), trigger)
    await fenceWrites()

    expect(peekFocusedBlockLocation(repo.block(PANEL_UI))).toEqual({
      blockId: 'elsewhere',
      renderScopeId: 'panel:elsewhere',
    })
  })

  it('still moves when focus is where the keystroke started', async () => {
    await repo.block(PANEL_UI).set(focusedBlockLocationProp, {blockId: 'a', renderScopeId: 'panel:a'})

    await actionById('move_down').handler(stale('a'), trigger)

    await vi.waitFor(() => {
      expect(peekFocusedBlockLocation(repo.block(PANEL_UI))?.blockId).toBe('b')
    })
  })
})

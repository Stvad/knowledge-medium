// @vitest-environment node
/**
 * The move flow's selection hygiene.
 *
 * Multi-select mode is activated by `PanelMultiSelectActionContext`
 * from a non-empty `selectedBlockIds` ALONE — it never checks that those
 * blocks are still inside the panel. So a move that relocates the
 * selection somewhere off-surface and leaves the ids in ui-state gives
 * the user a pane with nothing highlighted while `Delete` and the other
 * multi-select shortcuts still act on the blocks at their new home.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { keyBetween } from '@/data/orderKey'
import { selectionStateProp } from '@/data/properties.js'
import { getSelectionStateSnapshot } from '@/data/stateBlocks.js'

const WS = 'ws-1'

// The picker is a dialog; stub it so the flow runs headlessly. Defaults
// to `dest`; `pickDestination` re-points it per test.
const destinationId = vi.hoisted(() => ({current: 'dest'}))
const pickDestination = (id: string): void => { destinationId.current = id }
vi.mock('@/utils/dialogs.js', () => ({
  openDialog: vi.fn(async () => ({destinationId: destinationId.current})),
}))
vi.mock('@/utils/toast.js', () => ({
  showError: vi.fn(),
  showSuccess: vi.fn(),
}))

const { runMoveFlow } = await import('./moveAction.ts')

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

const lastKeyByParent = new Map<string, string | null>()

beforeEach(async () => {
  lastKeyByParent.clear()
  destinationId.current = 'dest'
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({ db: sharedDb.db, user: { id: 'user-1' } }).repo
  repo.setActiveWorkspaceId(WS)
})

const seed = async (id: string, parentId: string | null): Promise<void> => {
  const bucket = parentId ?? '\u0000root'
  const orderKey = keyBetween(lastKeyByParent.get(bucket) ?? null, null)
  lastKeyByParent.set(bucket, orderKey)
  await repo.tx(async tx => {
    await tx.create({ id, workspaceId: WS, parentId, orderKey, content: id })
  }, { scope: ChangeScope.BlockDefault, description: `seed ${id}` })
}

const parentOf = async (id: string): Promise<string | null> => {
  const row = await repo.db.getOptional<{ parent_id: string | null }>(
    'SELECT parent_id FROM blocks WHERE id = ?', [id],
  )
  return row?.parent_id ?? null
}

describe('runMoveFlow selection handling', () => {
  beforeEach(async () => {
    await seed('dest', null)
    await seed('a', null)
    await seed('b', null)
    await seed('ui', null)
  })

  it('clears the ui-state selection after a multi-select move', async () => {
    const uiStateBlock = repo.block('ui')
    await uiStateBlock.set(selectionStateProp, {
      selectedBlockIds: ['a', 'b'],
      anchorBlockId: 'a',
    })
    // Prove the precondition rather than assuming it — an "it's empty
    // afterwards" assertion passes trivially if it was never set.
    expect(getSelectionStateSnapshot(uiStateBlock).selectedBlockIds).toEqual(['a', 'b'])

    await runMoveFlow([repo.block('a'), repo.block('b')], {uiStateBlock})

    const after = getSelectionStateSnapshot(uiStateBlock)
    expect(after.selectedBlockIds).toEqual([])
    expect(after.anchorBlockId).toBeNull()
  })

  it('drops the relocated prefix from the selection when the batch fails part-way', async () => {
    // 'x' lands in 'd'; 'p' then can't (d is inside p), so the flow
    // throws PartialMoveError. The prefix still moved, so it must leave
    // the selection — otherwise Delete reaches it at its new home.
    await seed('p', null)
    await seed('d', 'p')
    const uiStateBlock = repo.block('ui')
    await uiStateBlock.set(selectionStateProp, {
      selectedBlockIds: ['a', 'p'],
      anchorBlockId: 'a',
    })

    // Destination is 'd' for this one, so re-point the stubbed picker.
    pickDestination('d')
    await runMoveFlow([repo.block('a'), repo.block('p')], {uiStateBlock})

    // 'a' moved into 'd' and is gone from the selection; 'p' never moved
    // and stays selected.
    expect(await parentOf('a')).toBe('d')
    expect(getSelectionStateSnapshot(uiStateBlock).selectedBlockIds).toEqual(['p'])
  })

  it('also unselects a selected descendant that rode along inside a moved subtree', async () => {
    // `moveBlocksTo` prunes descendants, so only the ancestor is reported
    // as moved — but the descendant relocated too. Subtracting the
    // reported ids alone would leave it selected at its new home.
    await seed('kid', 'a')
    const uiStateBlock = repo.block('ui')
    await uiStateBlock.set(selectionStateProp, {
      selectedBlockIds: ['a', 'kid'],
      anchorBlockId: 'a',
    })

    await runMoveFlow([repo.block('a'), repo.block('kid')], {uiStateBlock})

    expect(await parentOf('a')).toBe('dest')
    expect(await parentOf('kid')).toBe('a') // rode along, still under 'a'
    expect(getSelectionStateSnapshot(uiStateBlock).selectedBlockIds).toEqual([])
  })

  it('leaves an unrelated selection alone on a single-block move', async () => {
    // Focus can sit on an unselected block (and a right-click can land
    // on one) while a selection is live elsewhere. Nothing in that
    // selection moved, so it must survive untouched — the user never
    // asked to act on it.
    const uiStateBlock = repo.block('ui')
    await uiStateBlock.set(selectionStateProp, {
      selectedBlockIds: ['b'],
      anchorBlockId: 'b',
    })

    await runMoveFlow([repo.block('a')], {uiStateBlock})

    expect(getSelectionStateSnapshot(uiStateBlock).selectedBlockIds).toEqual(['b'])
  })

  it('removes just the moved block when a context-menu move targets one of several selected blocks', async () => {
    // The bullet menu acts on the right-clicked block alone, so a
    // selection of [a, b] must come back as [b] — not cleared (b never
    // moved) and not left holding `a` (which is now off-surface, where
    // Delete would still reach it).
    const uiStateBlock = repo.block('ui')
    await uiStateBlock.set(selectionStateProp, {
      selectedBlockIds: ['a', 'b'],
      anchorBlockId: 'a',
    })

    await runMoveFlow([repo.block('a')], {uiStateBlock})

    const after = getSelectionStateSnapshot(uiStateBlock)
    expect(after.selectedBlockIds).toEqual(['b'])
    // The anchor moved with `a`, so it has to be re-pointed at a block
    // that's still selected or range-extension anchors off-surface.
    expect(after.anchorBlockId).toBe('b')
  })
})

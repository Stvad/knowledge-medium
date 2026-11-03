import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type BlockData } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import {
  editorSelection,
  focusedBlockLocationFromProperties,
  focusedBlockLocationProp,
  isEditingProp,
  setIsEditing,
} from '@/data/properties'
import { outlineRenderScopeId } from '@/utils/renderScope'
import { enterEditModeForBlock } from '@/extensions/blockInteraction'
import { enterEditMode } from '@/shortcuts/blockActions'

const WS = 'ws-1'
const UI_STATE = 'ui-state'

/** BlockEditor places the cursor in the task of the commit that mounts it, so
 *  an edit-mode entry has to store the selection before it turns editing on. */
describe('edit-mode entry stores the selection first', () => {
  let sharedDb: TestDb
  let repo: Repo

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })

  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
    repo.setActiveWorkspaceId(WS)
    await repo.tx(async tx => {
      await tx.create({
        id: UI_STATE,
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        content: '',
        properties: {
          [focusedBlockLocationProp.name]: focusedBlockLocationProp.codec.encode({
            blockId: 'block-a',
            renderScopeId: outlineRenderScopeId('block-a'),
          }),
          [isEditingProp.name]: isEditingProp.codec.encode(true),
          [editorSelection.name]: editorSelection.codec.encode({blockId: 'block-a', start: 0}),
        },
      })
      await tx.create({id: 'block-a', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'first'})
      await tx.create({id: 'block-b', workspaceId: WS, parentId: null, orderKey: 'b1', content: 'second'})
    }, {scope: ChangeScope.BlockDefault, description: 'edit entry fixture'})
  })

  /** The stored editor selection at the first ui-state snapshot where
   *  `blockId` owns edit mode. */
  const recordSelectionWhenEditing = async (blockId: string) => {
    const uiStateBlock = repo.block(UI_STATE)
    await uiStateBlock.load()
    const seen: unknown[] = []
    const unsubscribe = uiStateBlock.subscribe((data: BlockData | null) => {
      const location = focusedBlockLocationFromProperties(data?.properties)
      const editing = data?.properties[isEditingProp.name]
      if (location?.blockId !== blockId || !editing || seen.length) return
      const stored = data?.properties[editorSelection.name]
      seen.push(stored === undefined ? undefined : editorSelection.codec.decode(stored))
    })
    return {uiStateBlock, seen, unsubscribe}
  }

  it('stores the click position before edit mode moves to the clicked block', async () => {
    const {uiStateBlock, seen, unsubscribe} = await recordSelectionWhenEditing('block-b')

    await enterEditModeForBlock(repo.block('block-b'), uiStateBlock, outlineRenderScopeId('block-b'), {start: 3})
    unsubscribe()

    expect(seen).toEqual([{blockId: 'block-b', start: 3}])
  })

  it('stores the selection before enterEditMode turns edit mode on', async () => {
    const {uiStateBlock, seen, unsubscribe} = await recordSelectionWhenEditing('block-a')
    setIsEditing(uiStateBlock, false)
    await vi.waitFor(() => expect(uiStateBlock.peekProperty(isEditingProp)).toBe(false))

    enterEditMode(uiStateBlock, {blockId: 'block-a', start: 4})
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    unsubscribe()

    expect(seen).toEqual([{blockId: 'block-a', start: 4}])
  })
})

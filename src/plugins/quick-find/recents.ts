import type { Block } from '@/data/block'
import { ChangeScope, codecs, defineBlockType, defineProperty } from '@/data/api'

export const RECENT_BLOCKS_LIMIT = 10

/** Recently-opened block-id MRU list. Per-device state — what *this*
 *  device's user has just been looking at. Lives on the plugin's
 *  ui-state sub-block (see `quickFindUIStateType`), scoped to UiState
 *  so it stays in its own undo bucket. The sub-block has a deterministic
 *  id derived from (workspace, user), so if it does sync the per-device
 *  semantic still holds — each device's quick-find subtree is keyed
 *  to that device's user identity. */
export const recentBlockIdsProp = defineProperty<string[]>('recentBlockIds', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.UiState,
})

export const quickFindUIStateType = defineBlockType({
  id: 'quick-find-ui-state',
  label: 'Quick find',
  properties: [recentBlockIdsProp],
})

export const pushRecentBlockId = (uiStateBlock: Block, blockId: string): void => {
  const current = uiStateBlock.peekProperty(recentBlockIdsProp) ?? []
  const next = [blockId, ...current.filter(id => id !== blockId)].slice(0, RECENT_BLOCKS_LIMIT)
  void uiStateBlock.set(recentBlockIdsProp, next)
}

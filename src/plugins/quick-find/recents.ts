import type { Block } from '@/data/block'
import { ChangeScope, codecs, defineProperty } from '@/data/api'

export const RECENT_BLOCKS_LIMIT = 10

export const recentBlockIdsProp = defineProperty<string[]>('recentBlockIds', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.UiState,
  kind: 'list',
})

export const pushRecentBlockId = (uiStateBlock: Block, blockId: string): void => {
  const current = uiStateBlock.peekProperty(recentBlockIdsProp) ?? []
  const next = [blockId, ...current.filter(id => id !== blockId)].slice(0, RECENT_BLOCKS_LIMIT)
  void uiStateBlock.set(recentBlockIdsProp, next)
}

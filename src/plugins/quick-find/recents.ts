import type { Block } from '@/data/block'
import { ChangeScope, codecs, defineProperty } from '@/data/api'

export const RECENT_BLOCKS_LIMIT = 10

export const recentBlockIdsProp = defineProperty<string[]>('recentBlockIds', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.UserPrefs,
  kind: 'list',
})

export const pushRecentBlockId = (prefsBlock: Block, blockId: string): void => {
  const current = prefsBlock.peekProperty(recentBlockIdsProp) ?? []
  const next = [blockId, ...current.filter(id => id !== blockId)].slice(0, RECENT_BLOCKS_LIMIT)
  void prefsBlock.set(recentBlockIdsProp, next)
}

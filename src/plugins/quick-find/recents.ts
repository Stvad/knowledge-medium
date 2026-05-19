import type { Block } from '@/data/block'
import { ChangeScope, codecs, defineBlockType, defineProperty } from '@/data/api'

export const RECENT_BLOCKS_LIMIT = 10

export const recentBlockIdsProp = defineProperty<string[]>('recentBlockIds', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.UserPrefs,
})

/** Per-plugin prefs sub-block for quick-find — holds the recently-opened
 *  block-id MRU list. */
export const quickFindPrefsType = defineBlockType({
  id: 'quick-find-prefs',
  label: 'Quick find',
  properties: [recentBlockIdsProp],
})

export const pushRecentBlockId = (prefsBlock: Block, blockId: string): void => {
  const current = prefsBlock.peekProperty(recentBlockIdsProp) ?? []
  const next = [blockId, ...current.filter(id => id !== blockId)].slice(0, RECENT_BLOCKS_LIMIT)
  void prefsBlock.set(recentBlockIdsProp, next)
}

import type { Block } from '@/data/block'
import { getBlockTypes } from '@/data/properties.ts'
import { SWIPE_RIGHT_BLOCK_ACTION_ID } from '@/plugins/swipe-quick-actions/actions.ts'
import type {
  ActionConfig,
  ActionDecorator,
  BlockShortcutDependencies,
} from '@/shortcuts/types.ts'
import { SRS_SM25_TYPE, srsArchivedProp } from './schema.ts'

export const archiveSrsBlock = async (block: Block): Promise<boolean> => {
  const data = block.peek() ?? await block.load()
  if (!data || !getBlockTypes(data).includes(SRS_SM25_TYPE)) return false

  if (!block.repo.isReadOnly) {
    await block.set(srsArchivedProp, true)
  }
  return true
}

export const srsSwipeRightDecorator: ActionDecorator = {
  actionId: SWIPE_RIGHT_BLOCK_ACTION_ID,
  decorate: (action: ActionConfig): ActionConfig => ({
    ...action,
    handler: async (deps, trigger) => {
      const block = (deps as BlockShortcutDependencies).block
      if (block && (await archiveSrsBlock(block))) return
      await action.handler(deps as never, trigger)
    },
  }),
}

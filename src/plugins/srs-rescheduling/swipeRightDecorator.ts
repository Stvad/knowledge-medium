import type { Block } from '@/data/block'
import { getBlockTypes } from '@/data/properties.js'
import { safeDecodeRowProperty } from '@/data/rowProperty.js'
import { SWIPE_RIGHT_BLOCK_ACTION_ID } from '@/plugins/swipe-quick-actions/actions.js'
import {
  EDIT_MODE_TODO_CYCLE_ACTION_ID,
  TODO_CYCLE_ACTION_ID,
} from '@/plugins/todo/actions.js'
import type {
  ActionContextType,
  BlockShortcutDependencies,
} from '@/shortcuts/types.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import type { ActionDispatchDecorator } from '@/shortcuts/actionDispatch.js'
import { SRS_SM25_TYPE, srsArchivedProp } from './schema.ts'

/** Archiving is a one-way LATCH, not a sink: once archived this declines the
 *  press so it falls through to whatever else wants it (the readwise review
 *  mark sits above us; the todo cycle below). Before, an SRS block consumed the
 *  key forever — every press after the first re-wrote `archived: true` and
 *  nothing downstream ever ran.
 *
 *  Un-archiving is deliberately not on this key (that would make it a cycle);
 *  it's the `archived` checkbox in the block's properties. */
export const archiveSrsBlock = async (block: Block): Promise<boolean> => {
  const data = block.peek() ?? await block.load()
  if (!data || !getBlockTypes(data).includes(SRS_SM25_TYPE)) return false
  if (safeDecodeRowProperty(data, srsArchivedProp)) return false

  if (!block.repo.isReadOnly) {
    await block.set(srsArchivedProp, true)
  }
  return true
}

const decorateActionToArchiveSrsBlock = (
  actionId: string,
  context?: ActionContextType,
): ActionDispatchDecorator => ({
  actionId,
  ...(context ? {context} : {}),
  // Behaviour wrap at DISPATCH time (was an `actionTransformsFacet` handler
  // rewrite): on an SRS block, archive it and handle the gesture; otherwise
  // delegate to the action's own handler. `await next` (not `return next`)
  // mirrors the old `await action.handler(...)` — an async wrap can't propagate
  // the inner sync `false` sentinel (`ActionHandlerResult` forbids
  // `Promise<false>`), so it resolves to `Promise<void>` (handled).
  wrap: async (deps, trigger, next, dispatch) => {
    const block = (deps as BlockShortcutDependencies).block
    if (block && (await archiveSrsBlock(block))) return
    await next(deps, trigger, dispatch)
  },
})

export const srsSwipeRightDecorator: ActionDispatchDecorator =
  decorateActionToArchiveSrsBlock(SWIPE_RIGHT_BLOCK_ACTION_ID)

export const srsTodoCycleDecorators: readonly ActionDispatchDecorator[] = [
  decorateActionToArchiveSrsBlock(
    TODO_CYCLE_ACTION_ID,
    ActionContextTypes.NORMAL_MODE,
  ),
  decorateActionToArchiveSrsBlock(
    EDIT_MODE_TODO_CYCLE_ACTION_ID,
    ActionContextTypes.EDIT_MODE_CM,
  ),
]

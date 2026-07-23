import { actionsFacet } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import type { Block } from '@/data/block'
import { ChangeScope } from '@/data/api'
import { getBlockTypes } from '@/data/properties.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type BlockShortcutDependencies,
} from '@/shortcuts/types.js'
import { SWIPE_RIGHT_BLOCK_ACTION_ID } from '@/plugins/swipe-quick-actions/actions.js'
import { statusProp, TODO_TYPE } from './schema.ts'

type TodoActionContext =
  | typeof ActionContextTypes.NORMAL_MODE
  | typeof ActionContextTypes.EDIT_MODE_CM

export const TODO_CYCLE_ACTION_ID = 'todo.cycle'
export const EDIT_MODE_TODO_CYCLE_ACTION_ID = 'edit.cm.todo.cycle'
const TODO_TOGGLE_KEYS = ['$mod+Enter']

const readStatus = (properties: Record<string, unknown>) => {
  const stored = properties[statusProp.name]
  if (stored === undefined) return statusProp.defaultValue
  return statusProp.codec.decode(stored)
}

const clearStatusInTx = async (block: Block): Promise<void> => {
  await block.repo.tx(async tx => {
    const row = await tx.get(block.id)
    if (!row) return
    await block.repo.removeTypeInTx(tx, block.id, TODO_TYPE)
    await tx.unsetProperty(block.id, statusProp)
  }, {scope: ChangeScope.BlockDefault, description: 'cycle todo state'})
}

export const cycleTodoState = async (block: Block): Promise<void> => {
  if (block.repo.isReadOnly) return

  const row = block.peek() ?? await block.load()
  if (!row) return

  const types = getBlockTypes(row)
  if (!types.includes(TODO_TYPE)) {
    await block.repo.tx(async tx => {
      await block.repo.addTypeInTx(tx, block.id, TODO_TYPE, {[statusProp.name]: 'open'})
      await tx.setProperty(block.id, statusProp, 'open')
    }, {scope: ChangeScope.BlockDefault, description: 'cycle todo state'})
    return
  }

  if (readStatus(row.properties) !== 'done') {
    await block.set(statusProp, 'done')
    return
  }

  await clearStatusInTx(block)
}

const createTodoCycleAction = <T extends TodoActionContext>(
  context: T,
  id: string,
  description: string,
): ActionConfig<T> => ({
  id,
  description,
  context,
  handler: (async ({block}: BlockShortcutDependencies) => {
    await cycleTodoState(block)
  }) as ActionConfig<T>['handler'],
  defaultBinding: {
    keys: TODO_TOGGLE_KEYS,
    eventOptions: {
      preventDefault: true,
    },
  },
})

export const todoActions: readonly ActionConfig[] = [
  createTodoCycleAction(
    ActionContextTypes.NORMAL_MODE,
    TODO_CYCLE_ACTION_ID,
    'Cycle todo state',
  ),
  createTodoCycleAction(
    ActionContextTypes.EDIT_MODE_CM,
    EDIT_MODE_TODO_CYCLE_ACTION_ID,
    'Cycle todo state (Edit Mode)',
  ),
  {
    id: SWIPE_RIGHT_BLOCK_ACTION_ID,
    description: 'Swipe right: cycle todo state',
    context: ActionContextTypes.NORMAL_MODE,
    // Bound to the swipe recognizer's `swipe-right` commit: the recognizer names
    // the gesture, this action names the gesture (symmetric with pointerBinding).
    // The swipe plugin no longer dispatches this action by id.
    gestureBinding: {gesture: 'swipe-right'},
    handler: async ({block}: BlockShortcutDependencies) => {
      await cycleTodoState(block)
    },
  },
]

export const todoActionsExtension: AppExtension =
  todoActions.map(action => actionsFacet.of(action, {source: 'todo'}))

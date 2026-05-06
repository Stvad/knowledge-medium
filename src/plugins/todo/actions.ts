import { actionsFacet } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import type { Block } from '@/data/block'
import { ChangeScope } from '@/data/api'
import { getBlockTypes } from '@/data/properties.ts'
import {
  ActionContextTypes,
  type ActionConfig,
  type BlockShortcutDependencies,
} from '@/shortcuts/types.ts'
import { statusProp, TODO_TYPE } from './schema.ts'

type TodoActionContext =
  | typeof ActionContextTypes.NORMAL_MODE
  | typeof ActionContextTypes.EDIT_MODE_CM

const TODO_TOGGLE_KEYS = ['cmd+enter', 'ctrl+enter']

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
    const updated = await tx.get(block.id)
    if (!updated) return
    const next = {...updated.properties}
    delete next[statusProp.name]
    await tx.update(block.id, {properties: next})
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
    'todo.cycle',
    'Cycle todo state',
  ),
  createTodoCycleAction(
    ActionContextTypes.EDIT_MODE_CM,
    'edit.cm.todo.cycle',
    'Cycle todo state (Edit Mode)',
  ),
]

export const todoActionsExtension: AppExtension =
  todoActions.map(action => actionsFacet.of(action, {source: 'todo'}))

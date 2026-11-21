import { hasBlockType } from '@/data/properties'
import { bindBlockActionContext, type BlockAction } from '@/shortcuts/blockActions'
import { ActionContextTypes, type ActionConfig, type BlockShortcutDependencies } from '@/shortcuts/types'
import { showTableAsOutline, turnIntoTable } from './convert'
import { TABLE_TYPE } from './schema'

const isTable = ({block}: BlockShortcutDependencies) => {
  const data = block?.peek()
  return data !== undefined && data !== null && hasBlockType(data, TABLE_TYPE)
}

const turnIntoTableAction: BlockAction = {
  id: 'tables.turn-into-table',
  description: 'Turn into table',
  handler: async ({block}) => {
    if (!block.repo.isReadOnly) await turnIntoTable(block.repo, block.id)
  },
}

const showAsOutlineAction: BlockAction = {
  id: 'tables.show-as-outline',
  description: 'Show table as outline',
  handler: async ({block}) => {
    if (!block.repo.isReadOnly) await showTableAsOutline(block.repo, block.id)
  },
}

const bindBoth = (action: BlockAction, isVisible: (deps: BlockShortcutDependencies) => boolean): ActionConfig[] => [
  {...bindBlockActionContext(ActionContextTypes.NORMAL_MODE, action), isVisible},
  {...bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, action, {idPrefix: 'edit.cm'}), isVisible},
]

/** Both contexts: normal mode exists only with vim mode on, which is opt-in. */
export const tableConversionActions: ActionConfig[] = [
  ...bindBoth(turnIntoTableAction, deps => !isTable(deps)),
  ...bindBoth(showAsOutlineAction, deps => isTable(deps)),
]

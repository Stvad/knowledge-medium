import {
  nextVisibleBlock,
  previousVisibleBlock,
  Block,
} from '@/data/internals/block'
import { Repo } from '@/data/internals/repo'
import { resetBlockSelection } from '@/data/globalState.ts'
import {
  editorSelection,
  focusedBlockIdProp,
  isCollapsedProp,
  isEditingProp,
  requestEditorFocus,
  setFocusedBlockId,
  setIsEditing,
  showPropertiesProp,
  topLevelBlockIdProp,
} from '@/data/properties.ts'
import {
  ActionConfig,
  ActionContextType,
  ActionTrigger,
  BlockShortcutDependencies,
  ShortcutBinding,
} from '@/shortcuts/types.ts'
import { EditorSelectionState } from '@/types.ts'
import { extendSelection } from '@/utils/selection'

export interface BlockAction {
  id: string
  description: string
  handler: (dependencies: BlockShortcutDependencies, trigger: ActionTrigger) => void | Promise<void>
  defaultBinding?: Omit<ShortcutBinding, 'action'>
  hideFromCommandPallet?: boolean
}

export interface SharedBlockActions {
  indentBlock: BlockAction
  outdentBlock: BlockAction
  moveBlockUp: BlockAction
  moveBlockDown: BlockAction
  deleteBlock: BlockAction
  togglePropertiesDisplay: BlockAction
  toggleBlockCollapse: BlockAction
  extendSelectionUp: BlockAction
  extendSelectionDown: BlockAction
}

export const bindBlockActionContext = <T extends ActionContextType>(
  context: T,
  action: BlockAction,
  {idPrefix}: { idPrefix?: string } = {},
): ActionConfig<T> => ({
  ...action,
  id: idPrefix ? `${idPrefix}.${action.id}` : action.id,
  context,
  handler: action.handler as ActionConfig<T>['handler'],
})

export const requestEditorFocusIfEditing = (uiStateBlock: Block) => {
  if (uiStateBlock.dataSync()?.properties[isEditingProp.name]?.value) {
    requestEditorFocus(uiStateBlock)
  }
}

export const enterEditMode = (uiStateBlock: Block, selection?: EditorSelectionState) => {
  // No-op in read-only workspaces — see setIsEditing for the source-level
  // gate. Bailing here also avoids the side-effects (selection reset, focus
  // request) that would otherwise fire for nothing.
  if (uiStateBlock.repo.isReadOnly) return

  resetBlockSelection(uiStateBlock)

  setIsEditing(uiStateBlock, true)

  if (selection) uiStateBlock.setProperty({...editorSelection, value: selection})
  requestEditorFocus(uiStateBlock)
}

export const extendSelectionDown = async (uiStateBlock: Block, repo: Repo) => {
  const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
  if (!topLevelBlockId) return

  const focusedBlockId = (await uiStateBlock.getProperty(focusedBlockIdProp))?.value
  if (!focusedBlockId) return

  const nextBlock = await nextVisibleBlock(repo.find(focusedBlockId), topLevelBlockId)
  if (!nextBlock) return

  await extendSelection(nextBlock.id, uiStateBlock, repo)
}

export const extendSelectionUp = async (uiStateBlock: Block, repo: Repo) => {
  const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
  if (!topLevelBlockId) return

  const focusedBlockId = (await uiStateBlock.getProperty(focusedBlockIdProp))?.value
  if (!focusedBlockId) return

  const prevBlock = await previousVisibleBlock(repo.find(focusedBlockId), topLevelBlockId)
  if (!prevBlock) return

  await extendSelection(prevBlock.id, uiStateBlock, repo)
}

export const createSharedBlockActions = ({repo}: { repo: Repo }): SharedBlockActions => {
  const indentBlock: BlockAction = {
    id: 'indent_block',
    description: 'Indent block',
    handler: async (deps: BlockShortcutDependencies) => {
      await deps.block.indent()
      requestEditorFocusIfEditing(deps.uiStateBlock)
    },
    defaultBinding: {
      keys: 'tab',
      eventOptions: {
        preventDefault: true,
      },
    },
  }

  const outdentBlock: BlockAction = {
    id: 'outdent_block',
    description: 'Outdent block',
    handler: async ({block, uiStateBlock}: BlockShortcutDependencies) => {
      const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
      if (!topLevelBlockId) return

      await block.outdent(topLevelBlockId)
      requestEditorFocusIfEditing(uiStateBlock)
    },
    defaultBinding: {
      keys: 'shift+tab',
      eventOptions: {
        preventDefault: true,
      },
    },
  }

  const moveBlockUp: BlockAction = {
    id: 'move_block_up',
    description: 'Move block up',
    handler: async (deps: BlockShortcutDependencies) => {
      const {block, uiStateBlock} = deps
      if (!block) return
      await block.changeOrder(-1)
      requestEditorFocusIfEditing(uiStateBlock)
    },
    defaultBinding: {
      keys: 'cmd+shift+up',
      eventOptions: {
        preventDefault: true,
      },
    },
  }

  const moveBlockDown: BlockAction = {
    id: 'move_block_down',
    description: 'Move block down',
    handler: async (deps: BlockShortcutDependencies) => {
      const {block, uiStateBlock} = deps
      if (!block) return
      await block.changeOrder(1)
      requestEditorFocusIfEditing(uiStateBlock)
    },
    defaultBinding: {
      keys: 'cmd+shift+down',
    },
  }

  const deleteBlock: BlockAction = {
    id: 'delete_block',
    description: 'Delete block',
    handler: async (deps: BlockShortcutDependencies) => {
      const {block, uiStateBlock} = deps
      if (!block || !uiStateBlock) return

      const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
      if (!topLevelBlockId) return

      const prevVisible = await previousVisibleBlock(block, topLevelBlockId)
      void block.delete()
      if (prevVisible) setFocusedBlockId(uiStateBlock, prevVisible.id)
    },
    defaultBinding: {
      keys: 'delete',
    },
  }

  const togglePropertiesDisplay: BlockAction = {
    id: 'toggle_properties',
    description: 'Toggle block properties',
    handler: async (deps: BlockShortcutDependencies) => {
      const {block} = deps
      if (!block) return

      const showProperties = (await block.getProperty(showPropertiesProp))?.value
      block.setProperty({...showPropertiesProp, value: !showProperties})
    },
    defaultBinding: {
      keys: 't',
    },
  }

  const toggleBlockCollapse: BlockAction = {
    id: 'toggle_collapse',
    description: 'Toggle block collapse',
    handler: async (deps: BlockShortcutDependencies) => {
      const {block} = deps
      if (!block) return

      const isCollapsed = (await block.getProperty(isCollapsedProp))?.value
      block.setProperty({...isCollapsedProp, value: !isCollapsed})
    },
    defaultBinding: {
      keys: 'z',
    },
  }

  const extendSelectionUpAction: BlockAction = {
    id: 'extend_selection_up',
    description: 'Extend selection up',
    handler: async (deps: BlockShortcutDependencies) =>
      await extendSelectionUp(deps.uiStateBlock, repo),
    defaultBinding: {
      keys: 'shift+up',
    },
  }

  const extendSelectionDownAction: BlockAction = {
    id: 'extend_selection_down',
    description: 'Extend selection down',
    handler: async (deps: BlockShortcutDependencies) =>
      await extendSelectionDown(deps.uiStateBlock, repo),
    defaultBinding: {
      keys: 'shift+down',
    },
  }

  return {
    indentBlock,
    outdentBlock,
    moveBlockUp,
    moveBlockDown,
    deleteBlock,
    togglePropertiesDisplay,
    toggleBlockCollapse,
    extendSelectionUp: extendSelectionUpAction,
    extendSelectionDown: extendSelectionDownAction,
  }
}

import {
  nextVisibleBlock,
  previousVisibleBlock,
  Block,
} from '@/data/block.ts'
import { Repo } from '@/data/repo.ts'
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
import { ActionConfig, ActionContextTypes, BlockShortcutDependencies } from '@/shortcuts/types.ts'
import { EditorSelectionState } from '@/types.ts'
import { extendSelection } from '@/utils/selection'

export type NormalModeAction = ActionConfig<typeof ActionContextTypes.NORMAL_MODE>

export interface SharedBlockActions {
  indentBlock: NormalModeAction
  outdentBlock: NormalModeAction
  moveBlockUp: NormalModeAction
  moveBlockDown: NormalModeAction
  deleteBlock: NormalModeAction
  togglePropertiesDisplay: NormalModeAction
  toggleBlockCollapse: NormalModeAction
  extendSelectionUpNormal: NormalModeAction
  extendSelectionDownNormal: NormalModeAction
}

export const requestEditorFocusIfEditing = (uiStateBlock: Block) => {
  if (uiStateBlock.dataSync()?.properties[isEditingProp.name]?.value) {
    requestEditorFocus(uiStateBlock)
  }
}

export const enterEditMode = (uiStateBlock: Block, selection?: EditorSelectionState) => {
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
  const indentBlock: NormalModeAction = {
    id: 'indent_block',
    description: 'Indent block',
    context: ActionContextTypes.NORMAL_MODE,
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

  const outdentBlock: NormalModeAction = {
    id: 'outdent_block',
    description: 'Outdent block',
    context: ActionContextTypes.NORMAL_MODE,
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

  const moveBlockUp: NormalModeAction = {
    id: 'move_block_up',
    description: 'Move block up',
    context: ActionContextTypes.NORMAL_MODE,
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

  const moveBlockDown: NormalModeAction = {
    id: 'move_block_down',
    description: 'Move block down',
    context: ActionContextTypes.NORMAL_MODE,
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

  const deleteBlock: NormalModeAction = {
    id: 'delete_block',
    description: 'Delete block',
    context: ActionContextTypes.NORMAL_MODE,
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

  const togglePropertiesDisplay: NormalModeAction = {
    id: 'toggle_properties',
    description: 'Toggle block properties',
    context: ActionContextTypes.NORMAL_MODE,
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

  const toggleBlockCollapse: NormalModeAction = {
    id: 'toggle_collapse',
    description: 'Toggle block collapse',
    context: ActionContextTypes.NORMAL_MODE,
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

  const extendSelectionUpNormal: NormalModeAction = {
    id: 'extend_selection_up',
    description: 'Extend selection up',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) =>
      await extendSelectionUp(deps.uiStateBlock, repo),
    defaultBinding: {
      keys: 'shift+up',
    },
  }

  const extendSelectionDownNormal: NormalModeAction = {
    id: 'extend_selection_down',
    description: 'Extend selection down',
    context: ActionContextTypes.NORMAL_MODE,
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
    extendSelectionUpNormal,
    extendSelectionDownNormal,
  }
}

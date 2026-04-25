import {
  Block,
  getLastVisibleDescendant,
  nextVisibleBlock,
  previousVisibleBlock,
} from '@/data/block.ts'
import { Repo } from '@/data/repo.ts'
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
import { selectionStateProp } from '@/data/properties'
import { resetBlockSelection } from '@/data/globalState.ts'
import { actionsFacet } from '@/extensions/core.ts'
import { AppExtension } from '@/extensions/facet.ts'
import { copyBlockToClipboard } from '@/utils/copy.ts'
import { extendSelection } from '@/utils/selection'
import { EditorSelectionState } from '@/types.ts'
import { makeNormalMode } from '@/shortcuts/utils'
import {
  ActionConfig,
  ActionContextTypes,
  BlockShortcutDependencies,
} from '@/shortcuts/types.ts'

type VimNormalModeAction = ActionConfig<typeof ActionContextTypes.NORMAL_MODE>

const requestEditorFocusIfEditing = (uiStateBlock: Block) => {
  if (uiStateBlock.dataSync()?.properties[isEditingProp.name]?.value) {
    requestEditorFocus(uiStateBlock)
  }
}

const enterEditMode = (uiStateBlock: Block, selection?: EditorSelectionState) => {
  resetBlockSelection(uiStateBlock)

  setIsEditing(uiStateBlock, true)

  if (selection) uiStateBlock.setProperty({...editorSelection, value: selection})
  requestEditorFocus(uiStateBlock)
}

const extendSelectionDown = async (uiStateBlock: Block, repo: Repo) => {
  const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
  if (!topLevelBlockId) return

  const focusedBlockId = (await uiStateBlock.getProperty(focusedBlockIdProp))?.value
  if (!focusedBlockId) return

  const nextBlock = await nextVisibleBlock(repo.find(focusedBlockId), topLevelBlockId)
  if (!nextBlock) return

  await extendSelection(nextBlock.id, uiStateBlock, repo)
}

const extendSelectionUp = async (uiStateBlock: Block, repo: Repo) => {
  const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
  if (!topLevelBlockId) return

  const focusedBlockId = (await uiStateBlock.getProperty(focusedBlockIdProp))?.value
  if (!focusedBlockId) return

  const prevBlock = await previousVisibleBlock(repo.find(focusedBlockId), topLevelBlockId)
  if (!prevBlock) return

  await extendSelection(prevBlock.id, uiStateBlock, repo)
}

export function getVimNormalModeActions({repo}: { repo: Repo }): VimNormalModeAction[] {
  const indentBlock: VimNormalModeAction = {
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

  const outdentBlock: VimNormalModeAction = {
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

  const moveBlockUp: VimNormalModeAction = {
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

  const moveBlockDown: VimNormalModeAction = {
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

  const deleteBlock: VimNormalModeAction = {
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

  const togglePropertiesDisplay: VimNormalModeAction = {
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

  const toggleBlockCollapse: VimNormalModeAction = {
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

  const extendSelectionUpNormal: VimNormalModeAction = {
    id: 'extend_selection_up',
    description: 'Extend selection up',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) =>
      await extendSelectionUp(deps.uiStateBlock, repo),
    defaultBinding: {
      keys: 'shift+up',
    },
  }

  const extendSelectionDownNormal: VimNormalModeAction = {
    id: 'extend_selection_down',
    description: 'Extend selection down',
    context: ActionContextTypes.NORMAL_MODE,
    handler: async (deps: BlockShortcutDependencies) =>
      await extendSelectionDown(deps.uiStateBlock, repo),
    defaultBinding: {
      keys: 'shift+down',
    },
  }

  return [
    indentBlock,
    outdentBlock,
    {
      id: 'move_down',
      description: 'Move to next block',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock} = deps
        if (!block || !uiStateBlock) return

        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return

        const nextVisible = await nextVisibleBlock(block, topLevelBlockId)
        if (nextVisible) setFocusedBlockId(uiStateBlock, nextVisible.id)
      },
      defaultBinding: {
        keys: ['down', 'k'],
      },
    },
    {
      id: 'move_up',
      description: 'Move to previous block',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock} = deps
        if (!block || !uiStateBlock) return

        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return

        const prevVisible = await previousVisibleBlock(block, topLevelBlockId)
        if (prevVisible) setFocusedBlockId(uiStateBlock, prevVisible.id)
      },
      defaultBinding: {
        keys: ['up', 'h'],
      },
    },
    {
      id: 'enter_edit_mode',
      description: 'Enter edit mode',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async (deps: BlockShortcutDependencies) => enterEditMode(deps.uiStateBlock),
      defaultBinding: {
        keys: 'i',
      },
    },
    {
      id: 'enter_edit_mode_at_end',
      description: 'Enter edit mode at end',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async ({block, uiStateBlock}: BlockShortcutDependencies) => {
        enterEditMode(uiStateBlock, {blockId: block.id, start: block.dataSync()?.content.length})
      },
      defaultBinding: {
        keys: 'a',
      },
    },
    toggleBlockCollapse,
    togglePropertiesDisplay,
    deleteBlock,
    {
      id: 'create_block_below_and_edit',
      description: 'Create block below (or as child) and enter edit mode',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock} = deps
        if (!block || !uiStateBlock) return

        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return
        const isCollapsed = (await block.getProperty(isCollapsedProp))?.value
        const hasChildren = await block.hasChildren()
        const isTopLevel = block.id === topLevelBlockId

        const hasUncollapsedChildren = hasChildren && !isCollapsed
        const result = hasUncollapsedChildren || isTopLevel ? await block.createChild({position: 'first'}) : await block.createSiblingBelow()
        if (result) {
          setFocusedBlockId(uiStateBlock, result.id)
          setIsEditing(uiStateBlock, true)
        }
      },
      defaultBinding: {
        keys: 'o',
      },
    },
    {
      id: 'select_focused_block_and_start_selection',
      description: 'Select focused block and start selection',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock} = deps
        if (!block || !uiStateBlock) return

        uiStateBlock.setProperty({
          ...selectionStateProp,
          value: {
            selectedBlockIds: [block.id],
            anchorBlockId: block.id,
          },
        })
      },
      defaultBinding: {
        keys: ['space', 'v'],
      },
    },
    extendSelectionUpNormal,
    extendSelectionDownNormal,
    makeNormalMode(moveBlockUp),
    makeNormalMode(moveBlockDown),
    {
      id: 'jump_to_first_visible_block',
      description: 'Jump to first visible block',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async ({uiStateBlock}: BlockShortcutDependencies) => {
        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return

        setFocusedBlockId(uiStateBlock, topLevelBlockId)
      },
      defaultBinding: {
        keys: 'g g',
      },
    },
    {
      id: 'jump_to_last_visible_block',
      description: 'Jump to last visible block',
      context: ActionContextTypes.NORMAL_MODE,
      handler: async ({uiStateBlock}: BlockShortcutDependencies) => {
        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return

        const lastBlock = await getLastVisibleDescendant(repo.find(topLevelBlockId), true)
        if (!lastBlock) return

        setFocusedBlockId(uiStateBlock, lastBlock.id)
      },
      defaultBinding: {
        keys: 'shift+g',
      },
    },
    {
      id: 'copy_block',
      description: 'Copy block to clipboard',
      context: ActionContextTypes.NORMAL_MODE,
      handler: ({block}) => copyBlockToClipboard(block),
      defaultBinding: {
        keys: ['cmd+c', 'ctrl+c'],
        eventOptions: {
          preventDefault: true,
        },
      },
    },
  ]
}

export const vimNormalModeActionsExtension = ({repo}: { repo: Repo }): AppExtension =>
  getVimNormalModeActions({repo}).map(action =>
    actionsFacet.of(action as ActionConfig, {source: 'vim-normal-mode'}),
  )

import {
  getLastVisibleDescendant,
  nextVisibleBlock,
  previousVisibleBlock,
} from '@/data/block.ts'
import { Repo } from '@/data/repo.ts'
import {
  isCollapsedProp,
  setFocusedBlockId,
  setIsEditing,
  topLevelBlockIdProp,
} from '@/data/properties.ts'
import { selectionStateProp } from '@/data/properties'
import { actionsFacet } from '@/extensions/core.ts'
import { AppExtension } from '@/extensions/facet.ts'
import { copyBlockToClipboard } from '@/utils/copy.ts'
import { makeNormalMode } from '@/shortcuts/utils'
import {
  createSharedBlockActions,
  enterEditMode,
  NormalModeAction,
} from '@/shortcuts/blockActions.ts'
import {
  ActionConfig,
  ActionContextTypes,
  BlockShortcutDependencies,
} from '@/shortcuts/types.ts'

export function getVimNormalModeActions({repo}: { repo: Repo }): NormalModeAction[] {
  const {
    indentBlock,
    outdentBlock,
    moveBlockUp,
    moveBlockDown,
    deleteBlock,
    togglePropertiesDisplay,
    toggleBlockCollapse,
    extendSelectionUpNormal,
    extendSelectionDownNormal,
  } = createSharedBlockActions({repo})

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

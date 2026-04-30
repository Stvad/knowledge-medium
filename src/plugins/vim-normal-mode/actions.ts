import {
  defaultChangeScope,
  getLastVisibleDescendant,
  nextVisibleBlock,
  previousVisibleBlock,
} from '@/data/internals/block'
import { Repo } from '@/data/internals/repo'
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
import { pasteFromClipboard } from '@/utils/paste.ts'
import {
  bindBlockActionContext,
  createSharedBlockActions,
  enterEditMode,
} from '@/shortcuts/blockActions.ts'
import type { BlockAction } from '@/shortcuts/blockActions.ts'
import {
  ActionConfig,
  ActionContextTypes,
  BlockShortcutDependencies,
} from '@/shortcuts/types.ts'

const JUMP_BLOCK_COUNT = 8

const jumpVisibleBlocks = async (
  startBlock: BlockShortcutDependencies['block'],
  topLevelBlockId: string,
  count: number,
  direction: 'up' | 'down',
) => {
  const step = direction === 'up' ? previousVisibleBlock : nextVisibleBlock
  let current = startBlock
  let last = startBlock
  for (let i = 0; i < count; i++) {
    const next = await step(current, topLevelBlockId)
    if (!next) break
    current = next
    last = next
  }
  return last === startBlock ? null : last
}

export function getVimNormalModeActions({repo}: { repo: Repo }): ActionConfig<typeof ActionContextTypes.NORMAL_MODE>[] {
  const {
    indentBlock,
    outdentBlock,
    moveBlockUp,
    moveBlockDown,
    deleteBlock,
    togglePropertiesDisplay,
    toggleBlockCollapse,
    extendSelectionUp,
    extendSelectionDown,
  } = createSharedBlockActions({repo})

  const indentBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, indentBlock)
  const outdentBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, outdentBlock)
  const deleteBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, deleteBlock)
  const togglePropertiesDisplayAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, togglePropertiesDisplay)
  const toggleBlockCollapseAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, toggleBlockCollapse)
  const extendSelectionUpAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, extendSelectionUp)
  const extendSelectionDownAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, extendSelectionDown)
  const bindNormal = (action: BlockAction) => bindBlockActionContext(ActionContextTypes.NORMAL_MODE, action)

  return [
    indentBlockAction,
    outdentBlockAction,
    bindNormal({
      id: 'move_down',
      description: 'Move to next block',
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
    }),
    bindNormal({
      id: 'move_up',
      description: 'Move to previous block',
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
    }),
    bindNormal({
      id: 'enter_edit_mode',
      description: 'Enter edit mode',
      handler: async (deps: BlockShortcutDependencies) => enterEditMode(deps.uiStateBlock),
      defaultBinding: {
        keys: 'i',
      },
    }),
    bindNormal({
      id: 'enter_edit_mode_at_end',
      description: 'Enter edit mode at end',
      handler: async ({block, uiStateBlock}: BlockShortcutDependencies) => {
        enterEditMode(uiStateBlock, {blockId: block.id, start: block.dataSync()?.content.length})
      },
      defaultBinding: {
        keys: 'a',
      },
    }),
    toggleBlockCollapseAction,
    togglePropertiesDisplayAction,
    deleteBlockAction,
    bindNormal({
      id: 'create_block_below_and_edit',
      description: 'Create block below (or as child) and enter edit mode',
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
    }),
    bindNormal({
      id: 'select_focused_block_and_start_selection',
      description: 'Select focused block and start selection',
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
    }),
    extendSelectionUpAction,
    extendSelectionDownAction,
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, moveBlockUp, {idPrefix: 'normal'}),
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, moveBlockDown, {idPrefix: 'normal'}),
    bindNormal({
      id: 'jump_to_first_visible_block',
      description: 'Jump to first visible block',
      handler: async ({uiStateBlock}: BlockShortcutDependencies) => {
        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return

        setFocusedBlockId(uiStateBlock, topLevelBlockId)
      },
      defaultBinding: {
        keys: 'g g',
      },
    }),
    bindNormal({
      id: 'jump_to_last_visible_block',
      description: 'Jump to last visible block',
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
    }),
    bindNormal({
      id: 'copy_block',
      description: 'Copy block to clipboard',
      handler: ({block}) => copyBlockToClipboard(block),
      defaultBinding: {
        keys: ['cmd+c', 'ctrl+c'],
        eventOptions: {
          preventDefault: true,
        },
      },
    }),
    bindNormal({
      id: 'jump_many_down',
      description: 'Jump down several blocks',
      handler: async ({block, uiStateBlock}: BlockShortcutDependencies) => {
        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return

        const target = await jumpVisibleBlocks(block, topLevelBlockId, JUMP_BLOCK_COUNT, 'down')
        if (target) setFocusedBlockId(uiStateBlock, target.id)
      },
      defaultBinding: {
        keys: 'ctrl+d',
      },
    }),
    bindNormal({
      id: 'jump_many_up',
      description: 'Jump up several blocks',
      handler: async ({block, uiStateBlock}: BlockShortcutDependencies) => {
        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId) return

        const target = await jumpVisibleBlocks(block, topLevelBlockId, JUMP_BLOCK_COUNT, 'up')
        if (target) setFocusedBlockId(uiStateBlock, target.id)
      },
      defaultBinding: {
        keys: 'ctrl+u',
      },
    }),
    bindNormal({
      id: 'create_block_above_and_edit',
      description: 'Create block above and enter edit mode',
      handler: async ({block, uiStateBlock}: BlockShortcutDependencies) => {
        const created = await block.createSiblingAbove()
        if (!created) return
        setFocusedBlockId(uiStateBlock, created.id)
        setIsEditing(uiStateBlock, true)
      },
      defaultBinding: {
        keys: 'shift+o',
      },
    }),
    bindNormal({
      id: 'paste_after',
      description: 'Paste from clipboard after current block',
      handler: async ({block, uiStateBlock}: BlockShortcutDependencies) => {
        const pasted = await pasteFromClipboard(block, repo, {position: 'after'})
        if (pasted[0]) setFocusedBlockId(uiStateBlock, pasted[0].id)
      },
      defaultBinding: {
        keys: 'p',
      },
    }),
    bindNormal({
      id: 'paste_before',
      description: 'Paste from clipboard before current block',
      handler: async ({block, uiStateBlock}: BlockShortcutDependencies) => {
        const pasted = await pasteFromClipboard(block, repo, {position: 'before'})
        if (pasted[0]) setFocusedBlockId(uiStateBlock, pasted[0].id)
      },
      defaultBinding: {
        keys: 'shift+p',
      },
    }),
    bindNormal({
      id: 'normal_undo',
      description: 'Undo last action',
      handler: () => {
        repo.undoRedoManager.undo(defaultChangeScope)
      },
      defaultBinding: {
        keys: 'u',
      },
    }),
    bindNormal({
      id: 'normal_redo',
      description: 'Redo last action',
      handler: () => {
        repo.undoRedoManager.redo(defaultChangeScope)
      },
      defaultBinding: {
        keys: 'ctrl+r',
      },
    }),
    bindNormal({
      id: 'collapse_into_parent',
      description: 'Collapse current block into its parent and focus parent',
      handler: async ({block, uiStateBlock}: BlockShortcutDependencies) => {
        const topLevelBlockId = (await uiStateBlock.getProperty(topLevelBlockIdProp))?.value
        if (!topLevelBlockId || block.id === topLevelBlockId) return

        const parent = await block.parent()
        if (!parent || parent.id === topLevelBlockId) return

        parent.setProperty({...isCollapsedProp, value: true})
        setFocusedBlockId(uiStateBlock, parent.id)
      },
      defaultBinding: {
        keys: 'shift+z',
      },
    }),
  ]
}

export const vimNormalModeActionsExtension = ({repo}: { repo: Repo }): AppExtension =>
  getVimNormalModeActions({repo}).map(action =>
    actionsFacet.of(action as ActionConfig, {source: 'vim-normal-mode'}),
  )

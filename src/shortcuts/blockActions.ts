import { ChevronsDownUp, ClipboardCopy, Copy, Link2, SlidersHorizontal, Trash2 } from 'lucide-react'
import { Block } from '../data/block'
import { Repo } from '../data/repo'
import { resetBlockSelection } from '@/data/globalState.ts'
import { copyBlockToClipboard } from '@/utils/copy.ts'
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
  type EditorSelectionState,
} from '@/data/properties.ts'
import {
  ActionConfig,
  ActionContextType,
  ActionIcon,
  ActionTrigger,
  BlockShortcutDependencies,
  ShortcutBinding,
} from '@/shortcuts/types.ts'
import { extendSelection, nextVisibleBlock, previousVisibleBlock } from '@/utils/selection'

export interface BlockAction {
  id: string
  description: string
  handler: (dependencies: BlockShortcutDependencies, trigger: ActionTrigger) => void | Promise<void>
  defaultBinding?: Omit<ShortcutBinding, 'action'>
  /** Optional glyph for visual surfaces (swipe menus, mobile toolbars,
   *  future command-palette icons). Carried verbatim through
   *  `bindBlockActionContext` onto the resulting `ActionConfig`. */
  icon?: ActionIcon
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
  copyBlock: BlockAction
  copyBlockRef: BlockAction
  copyBlockEmbed: BlockAction
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

/** Write to the system clipboard if the platform exposes the async API.
 *  Used by the block-level "copy *" actions; safe to call in non-browser
 *  contexts (jsdom, Node) — the no-clipboard branch silently no-ops so
 *  unit tests can invoke handlers without setting up a clipboard mock. */
const writeToClipboard = (text: string): void => {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return
  void navigator.clipboard.writeText(text)
}

/** Move `block` up (-1) or down (+1) among its siblings. Computes a
 *  new orderKey that lands between the appropriate neighbor pair so
 *  the block's position changes deterministically. No-op if the
 *  block is already at the relevant edge or if it has no parent. */
const reorderBlock = async (repo: Repo, block: Block, direction: -1 | 1): Promise<void> => {
  const data = block.peek() ?? await block.load()
  if (!data || data.parentId === null) return

  const siblingIds = await repo.query.childIds({id: data.parentId}).load()
  const idx = siblingIds.indexOf(block.id)
  if (idx === -1) return

  const target = idx + direction
  if (target < 0 || target >= siblingIds.length) return

  // Target sibling we want to land before/after. For direction=-1
  // (move up), we want to land BEFORE siblingIds[target]. For
  // direction=+1, we want to land AFTER siblingIds[target].
  const targetSiblingId = siblingIds[target]
  await repo.mutate.move({
    id: block.id,
    parentId: data.parentId,
    position: direction === -1
      ? {kind: 'before', siblingId: targetSiblingId}
      : {kind: 'after', siblingId: targetSiblingId},
  })
}

export const requestEditorFocusIfEditing = (uiStateBlock: Block) => {
  if (uiStateBlock.peekProperty(isEditingProp)) {
    requestEditorFocus(uiStateBlock)
  }
}

export const enterEditMode = (uiStateBlock: Block, selection?: EditorSelectionState) => {
  // No-op in read-only workspaces — see setIsEditing for the source-level
  // gate. Bailing here also avoids the side-effects (selection reset, focus
  // request) that would otherwise fire for nothing.
  if (uiStateBlock.repo.isReadOnly) return

  void resetBlockSelection(uiStateBlock)
  setIsEditing(uiStateBlock, true)

  if (selection) void uiStateBlock.set(editorSelection, selection)
  requestEditorFocus(uiStateBlock)
}

export const extendSelectionDown = async (uiStateBlock: Block, repo: Repo) => {
  const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
  if (!topLevelBlockId) return

  const focusedBlockId = uiStateBlock.peekProperty(focusedBlockIdProp)
  if (!focusedBlockId) return

  const nextBlock = await nextVisibleBlock(repo.block(focusedBlockId), topLevelBlockId)
  if (!nextBlock) return

  await extendSelection(nextBlock.id, uiStateBlock, repo)
}

export const extendSelectionUp = async (uiStateBlock: Block, repo: Repo) => {
  const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
  if (!topLevelBlockId) return

  const focusedBlockId = uiStateBlock.peekProperty(focusedBlockIdProp)
  if (!focusedBlockId) return

  const prevBlock = await previousVisibleBlock(repo.block(focusedBlockId), topLevelBlockId)
  if (!prevBlock) return

  await extendSelection(prevBlock.id, uiStateBlock, repo)
}

export const createSharedBlockActions = ({repo}: { repo: Repo }): SharedBlockActions => {
  const indentBlock: BlockAction = {
    id: 'indent_block',
    description: 'Indent block',
    handler: async (deps: BlockShortcutDependencies) => {
      await repo.mutate.indent({id: deps.block.id})
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
      const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
      if (!topLevelBlockId) return

      await repo.mutate.outdent({id: block.id, topLevelBlockId})
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
      await reorderBlock(repo, block, -1)
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
      await reorderBlock(repo, block, 1)
      requestEditorFocusIfEditing(uiStateBlock)
    },
    defaultBinding: {
      keys: 'cmd+shift+down',
    },
  }

  const deleteBlock: BlockAction = {
    id: 'delete_block',
    description: 'Delete block',
    icon: Trash2,
    handler: async (deps: BlockShortcutDependencies) => {
      const {block, uiStateBlock} = deps
      if (!block || !uiStateBlock) return

      const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
      if (!topLevelBlockId) return

      const prevVisible = await previousVisibleBlock(block, topLevelBlockId)
      await block.delete()
      if (prevVisible) setFocusedBlockId(uiStateBlock, prevVisible.id)
    },
    defaultBinding: {
      keys: 'delete',
    },
  }

  const togglePropertiesDisplay: BlockAction = {
    id: 'toggle_properties',
    description: 'Toggle block properties',
    icon: SlidersHorizontal,
    handler: async (deps: BlockShortcutDependencies) => {
      const {block} = deps
      if (!block) return

      const showProperties = block.peekProperty(showPropertiesProp) ?? false
      await block.set(showPropertiesProp, !showProperties)
    },
    defaultBinding: {
      keys: 't',
    },
  }

  const toggleBlockCollapse: BlockAction = {
    id: 'toggle_collapse',
    description: 'Toggle block collapse',
    icon: ChevronsDownUp,
    handler: async (deps: BlockShortcutDependencies) => {
      const {block} = deps
      if (!block) return

      const isCollapsed = block.peekProperty(isCollapsedProp) ?? false
      await block.set(isCollapsedProp, !isCollapsed)
    },
    defaultBinding: {
      keys: 'z',
    },
  }

  /** Serializes the block + its subtree as indented markdown via the
   *  shared `copyBlockToClipboard` helper. The vim-normal-mode plugin
   *  used to define this with the cmd/ctrl+c binding; promoted here so
   *  it's available to any surface (swipe menu, command palette) and
   *  not coupled to the vim plugin. The binding still only fires in
   *  NORMAL_MODE, which only activates when vim is loaded — so removing
   *  vim disables the keybinding without disabling the action. */
  const copyBlock: BlockAction = {
    id: 'copy_block',
    description: 'Copy block to clipboard',
    icon: Copy,
    handler: ({block}: BlockShortcutDependencies) => copyBlockToClipboard(block),
    defaultBinding: {
      keys: ['cmd+c', 'ctrl+c'],
      eventOptions: {preventDefault: true},
    },
  }

  const copyBlockRef: BlockAction = {
    id: 'copy_block_ref',
    description: 'Copy block reference',
    icon: Link2,
    handler: ({block}: BlockShortcutDependencies) => {
      writeToClipboard(`((${block.id}))`)
    },
  }

  const copyBlockEmbed: BlockAction = {
    id: 'copy_block_embed',
    description: 'Copy block embed',
    icon: ClipboardCopy,
    handler: ({block}: BlockShortcutDependencies) => {
      writeToClipboard(`!((${block.id}))`)
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
    copyBlock,
    copyBlockRef,
    copyBlockEmbed,
  }
}

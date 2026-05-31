import { Repo } from '../../data/repo'
import {
  focusBlock,
  isCollapsedProp,
  selectionStateProp,
} from '@/data/properties.js'
import {
  getLastVisibleDescendant,
  nextVisibleBlock,
  previousVisibleBlock,
} from '@/utils/selection.js'
import { structuralEditPolicyForBlock } from '@/data/structuralEditPolicy.js'
import { actionsFacet } from '@/extensions/core.js'
import { AppExtension } from '@/extensions/facet.js'
import { pasteFromClipboard } from '@/utils/paste.js'
import {
  bindBlockActionContext,
  createSharedBlockActions,
  enterEditMode,
} from '@/shortcuts/blockActions.js'
import type { BlockAction } from '@/shortcuts/blockActions.js'
import {
  ActionConfig,
  ActionContextTypes,
  BlockShortcutDependencies,
} from '@/shortcuts/types.js'
import { outlineRenderScopeId } from '@/utils/renderScope.js'

const JUMP_BLOCK_COUNT = 8

const jumpVisibleBlocks = async (
  startBlock: BlockShortcutDependencies['block'],
  scopeRootId: string,
  count: number,
  direction: 'up' | 'down',
) => {
  const step = direction === 'up' ? previousVisibleBlock : nextVisibleBlock
  let current = startBlock
  let last = startBlock
  for (let i = 0; i < count; i++) {
    const next = await step(current, scopeRootId)
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
  const deleteBlockAction = {
    ...bindBlockActionContext(ActionContextTypes.NORMAL_MODE, deleteBlock),
    defaultBinding: {
      keys: ['Delete', 'Backspace', 'd d'],
    },
  }
  const togglePropertiesDisplayAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, togglePropertiesDisplay)
  const toggleBlockCollapseAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, toggleBlockCollapse)
  const extendSelectionUpAction = {
    ...bindBlockActionContext(ActionContextTypes.NORMAL_MODE, extendSelectionUp),
    defaultBinding: {
      ...extendSelectionUp.defaultBinding,
      keys: ['Shift+ArrowUp', 'Shift+k'],
    },
  }
  const extendSelectionDownAction = {
    ...bindBlockActionContext(ActionContextTypes.NORMAL_MODE, extendSelectionDown),
    defaultBinding: {
      ...extendSelectionDown.defaultBinding,
      keys: ['Shift+ArrowDown', 'Shift+j'],
    },
  }
  const bindNormal = (action: BlockAction) => bindBlockActionContext(ActionContextTypes.NORMAL_MODE, action)

  return [
    indentBlockAction,
    outdentBlockAction,
    bindNormal({
      id: 'move_down',
      description: 'Move to next block',
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock, scopeRootId} = deps
        if (!block || !uiStateBlock || !scopeRootId) return

        const next = await nextVisibleBlock(block, scopeRootId)
        if (next) void focusBlock(uiStateBlock, next.id, {renderScopeId: deps.renderScopeId})
      },
      defaultBinding: {
        keys: ['ArrowDown', 'j'],
      },
    }),
    bindNormal({
      id: 'move_up',
      description: 'Move to previous block',
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock, scopeRootId} = deps
        if (!block || !uiStateBlock || !scopeRootId) return

        const prev = await previousVisibleBlock(block, scopeRootId)
        if (prev) void focusBlock(uiStateBlock, prev.id, {renderScopeId: deps.renderScopeId})
      },
      defaultBinding: {
        keys: ['ArrowUp', 'k'],
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
        await block.load()
        enterEditMode(uiStateBlock, {blockId: block.id, start: block.peek()?.content.length})
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
        const {block, uiStateBlock, scopeRootId} = deps
        if (!block || !uiStateBlock || !scopeRootId) return

        // child-first when the block shows children OR is the scope root
        // (where a sibling would be created outside the visible surface —
        // the "invisible block" bug). Otherwise a sibling below.
        const {createBelowPlacement} = await structuralEditPolicyForBlock(block, scopeRootId)
        const newId = createBelowPlacement === 'child-first'
          ? await repo.mutate.createChild({parentId: block.id, position: {kind: 'first'}})
          : await repo.mutate.createSiblingBelow({siblingId: block.id})
        if (newId) await focusBlock(uiStateBlock, newId, {edit: true, renderScopeId: deps.renderScopeId})
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

        await uiStateBlock.set(selectionStateProp, {
          selectedBlockIds: [block.id],
          anchorBlockId: block.id,
        })
      },
      defaultBinding: {
        keys: ['Space', 'v'],
      },
    }),
    extendSelectionUpAction,
    extendSelectionDownAction,
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, moveBlockUp, {idPrefix: 'normal'}),
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, moveBlockDown, {idPrefix: 'normal'}),
    bindNormal({
      id: 'jump_to_first_visible_block',
      description: 'Jump to first visible block',
      handler: async ({uiStateBlock, scopeRootId, renderScopeId}: BlockShortcutDependencies) => {
        if (!scopeRootId) return

        void focusBlock(uiStateBlock, scopeRootId, {
          renderScopeId: renderScopeId ?? outlineRenderScopeId(scopeRootId),
        })
      },
      defaultBinding: {
        // Two-press sequence — tinykeys dispatches on the second `g`
        // after the first within ~1s. Under hotkeys-js this string
        // was treated as a single chord with a literal space and
        // never matched, which is why the binding was dead.
        keys: 'g g',
      },
    }),
    bindNormal({
      id: 'jump_to_last_visible_block',
      description: 'Jump to last visible block',
      handler: async ({uiStateBlock, scopeRootId, renderScopeId}: BlockShortcutDependencies) => {
        if (!scopeRootId) return

        const lastBlock = await getLastVisibleDescendant(repo.block(scopeRootId), scopeRootId)
        if (!lastBlock) return

        void focusBlock(uiStateBlock, lastBlock.id, {
          renderScopeId: renderScopeId ?? outlineRenderScopeId(scopeRootId),
        })
      },
      defaultBinding: {
        keys: 'Shift+g',
      },
    }),
    bindNormal({
      id: 'jump_many_down',
      description: 'Jump down several blocks',
      handler: async ({block, uiStateBlock, renderScopeId, scopeRootId}: BlockShortcutDependencies) => {
        if (!scopeRootId) return

        const target = await jumpVisibleBlocks(block, scopeRootId, JUMP_BLOCK_COUNT, 'down')
        if (target) void focusBlock(uiStateBlock, target.id, {renderScopeId})
      },
      defaultBinding: {
        keys: 'Control+d',
      },
    }),
    bindNormal({
      id: 'jump_many_up',
      description: 'Jump up several blocks',
      handler: async ({block, uiStateBlock, renderScopeId, scopeRootId}: BlockShortcutDependencies) => {
        if (!scopeRootId) return

        const target = await jumpVisibleBlocks(block, scopeRootId, JUMP_BLOCK_COUNT, 'up')
        if (target) void focusBlock(uiStateBlock, target.id, {renderScopeId})
      },
      defaultBinding: {
        keys: 'Control+u',
      },
    }),
    bindNormal({
      id: 'create_block_above_and_edit',
      description: 'Create block above and enter edit mode',
      handler: async ({block, uiStateBlock, renderScopeId}: BlockShortcutDependencies) => {
        const newId = await repo.mutate.createSiblingAbove({siblingId: block.id})
        if (!newId) return
        await focusBlock(uiStateBlock, newId, {edit: true, renderScopeId})
      },
      defaultBinding: {
        keys: 'Shift+o',
      },
    }),
    bindNormal({
      id: 'paste_after',
      description: 'Paste from clipboard after current block',
      handler: async ({block, uiStateBlock, renderScopeId, scopeRootId}: BlockShortcutDependencies) => {
        const pasted = await pasteFromClipboard(block, repo, {
          position: 'after',
          scopeRootId,
        })
        if (pasted[0]) void focusBlock(uiStateBlock, pasted[0].id, {renderScopeId})
      },
      defaultBinding: {
        keys: 'p',
      },
    }),
    bindNormal({
      id: 'paste_before',
      description: 'Paste from clipboard before current block',
      handler: async ({block, uiStateBlock, renderScopeId, scopeRootId}: BlockShortcutDependencies) => {
        const pasted = await pasteFromClipboard(block, repo, {
          position: 'before',
          scopeRootId,
        })
        if (pasted[0]) void focusBlock(uiStateBlock, pasted[0].id, {renderScopeId})
      },
      defaultBinding: {
        keys: 'Shift+p',
      },
    }),
    bindNormal({
      id: 'undo',
      description: 'Undo',
      handler: async () => { await repo.undo() },
      defaultBinding: {
        keys: 'u',
      },
    }),
    bindNormal({
      id: 'redo',
      description: 'Redo',
      handler: async () => { await repo.redo() },
      defaultBinding: {
        keys: 'Control+r',
      },
    }),
    bindNormal({
      id: 'collapse_into_parent',
      description: 'Collapse current block into its parent and focus parent',
      handler: async ({block, uiStateBlock, renderScopeId, scopeRootId}: BlockShortcutDependencies) => {
        if (!scopeRootId || block.id === scopeRootId) return

        await repo.load(block.id, {ancestors: true})
        const parent = block.parent
        if (!parent || parent.id === scopeRootId) return

        await parent.set(isCollapsedProp, true)
        void focusBlock(uiStateBlock, parent.id, {renderScopeId})
      },
      defaultBinding: {
        keys: 'Shift+z',
      },
    }),
  ]
}

export const vimNormalModeActionsExtension = ({repo}: { repo: Repo }): AppExtension =>
  getVimNormalModeActions({repo}).map(action =>
    actionsFacet.of(action as ActionConfig, {source: 'vim-normal-mode'}),
  )

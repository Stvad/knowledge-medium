import { Repo } from '../../data/repo'
import {
  focusBlock,
  isCollapsedProp,
  peekFocusedBlockLocation,
  sameFocusedBlockLocation,
  selectionStateProp,
  uiStateRenderScopeId,
} from '@/data/properties.js'
import {
  lastDrawnStep,
  nextDrawnStep,
  previousDrawnStep,
  scopeRootRenderScope,
} from '@/utils/selection.js'
import { insertDrawnBlock } from '@/data/structuralInsert'
import { actionsFacet } from '@/extensions/core.js'
import { AppExtension } from '@/facets/facet.js'
import { pasteFromClipboard } from '@/paste/operations.js'
import { undoOrTakeBackCut } from '@/paste/armedCut.js'
import {
  bindBlockActionContext,
  createSharedBlockActions,
  enterEditMode,
} from '@/shortcuts/blockActions.js'
import { outlineSurfaceOf, type OutlineSurface } from '@/data/outlineSurface.js'
import type { BlockAction } from '@/shortcuts/blockActions.js'
import {
  ActionConfig,
  ActionContextTypes,
  BlockShortcutDependencies,
} from '@/shortcuts/types.js'

export const JUMP_BLOCK_COUNT = 8

const createAndEdit = async (deps: BlockShortcutDependencies, kind: 'above' | 'below') => {
  const {block, uiStateBlock} = deps
  if (!block || !uiStateBlock) return
  const target = await insertDrawnBlock(block, deps, {kind})
  if (target) await focusBlock(uiStateBlock, target.id, {edit: target.edit ?? true, renderScopeId: target.renderScopeId})
}

/**
 * True when the panel's focus has moved off the row this invocation started
 * from. The model walks below `await` — on an uncached `childIds` that's a DB
 * round-trip — and a click or a second keystroke can land inside that window;
 * writing afterwards would overwrite the newer intent, or make two fast
 * presses land on the same row. The keystroke's premise is gone, so drop it.
 *
 * Only meaningful when `renderScopeId` identifies the rendered row (it always
 * does on a real dispatch); without one there's nothing to compare against and
 * the write proceeds as before.
 */
const focusMovedDuringWalk = (deps: BlockShortcutDependencies): boolean => {
  const {block, uiStateBlock, renderScopeId} = deps
  if (!block || !uiStateBlock || !renderScopeId) return false
  return !sameFocusedBlockLocation(
    peekFocusedBlockLocation(uiStateBlock),
    {blockId: block.id, renderScopeId},
  )
}

/** Count drawn rows until the requested distance or the edge of the walk. */
export const jumpVisibleBlocks = async (
  startBlock: BlockShortcutDependencies['block'],
  surface: OutlineSurface,
  count: number,
  direction: 'up' | 'down',
) => {
  const step = direction === 'up' ? previousDrawnStep : nextDrawnStep
  let location = {block: startBlock, surface}
  for (let i = 0; i < count; i++) {
    const next = await step(location.block, location.surface)
    if (!next.block) break
    location = {block: next.block, surface: next.surface}
  }
  return location.block === startBlock && location.surface === surface ? null : location
}

export function getVimNormalModeActions({repo}: { repo: Repo }): ActionConfig<typeof ActionContextTypes.NORMAL_MODE>[] {
  const {
    indentBlock,
    outdentBlock,
    moveBlockUp,
    moveBlockDown,
    extendSelectionUp,
    extendSelectionDown,
  } = createSharedBlockActions({repo})

  // `delete_block`, `toggle_properties` and `toggle_collapse` used to be
  // defined here. They now live in `getDefaultActionGroups` (with the same
  // NORMAL_MODE context and the same keys) so they are registered on a default
  // install too — the block/swipe menu dispatches them by id and can't reach an
  // action that only an opt-in plugin defines. Same move the copy actions made
  // earlier; see the comment beside them there.
  const indentBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, indentBlock)
  const outdentBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, outdentBlock)
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
        const {block, uiStateBlock} = deps
        const surface = outlineSurfaceOf(deps)
        if (!block || !uiStateBlock || !surface) return

        const {block: next, surface: destination} = await nextDrawnStep(block, surface)
        if (next && !focusMovedDuringWalk(deps)) {
          void focusBlock(uiStateBlock, next.id, {renderScopeId: destination.renderScopeId})
        }
      },
      defaultBinding: {
        keys: ['ArrowDown', 'j'],
      },
    }),
    bindNormal({
      id: 'move_up',
      description: 'Move to previous block',
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock} = deps
        const surface = outlineSurfaceOf(deps)
        if (!block || !uiStateBlock || !surface) return

        const {block: prev, surface: destination} = await previousDrawnStep(block, surface)
        if (prev && !focusMovedDuringWalk(deps)) {
          void focusBlock(uiStateBlock, prev.id, {renderScopeId: destination.renderScopeId})
        }
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
    bindNormal({
      id: 'create_block_below_and_edit',
      description: 'Create block below (or as child) and enter edit mode',
      handler: async (deps: BlockShortcutDependencies) => {
        if (deps.scopeRootId) await createAndEdit(deps, 'below')
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
          renderScopeId: scopeRootRenderScope(repo, scopeRootId, renderScopeId) ?? uiStateRenderScopeId(uiStateBlock, scopeRootId),
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
      handler: async (deps: BlockShortcutDependencies) => {
        const {uiStateBlock} = deps
        const surface = outlineSurfaceOf(deps)
        if (!surface) return

        const {block: lastBlock, surface: destination} = await lastDrawnStep(repo.block(surface.scopeRootId), surface)

        const renderScopeId = lastBlock.id === destination.scopeRootId
          ? scopeRootRenderScope(repo, destination.scopeRootId, destination.renderScopeId)
          : destination.renderScopeId
        void focusBlock(uiStateBlock, lastBlock.id, {
          renderScopeId: renderScopeId ?? uiStateRenderScopeId(uiStateBlock, destination.scopeRootId),
        })
      },
      defaultBinding: {
        keys: 'Shift+g',
      },
    }),
    bindNormal({
      id: 'jump_many_down',
      description: 'Jump down several blocks',
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock} = deps
        const surface = outlineSurfaceOf(deps)
        if (!surface) return

        const target = await jumpVisibleBlocks(block, surface, JUMP_BLOCK_COUNT, 'down')
        if (target) void focusBlock(uiStateBlock, target.block.id, {renderScopeId: target.surface.renderScopeId})
      },
      defaultBinding: {
        keys: 'Control+d',
      },
    }),
    bindNormal({
      id: 'jump_many_up',
      description: 'Jump up several blocks',
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock} = deps
        const surface = outlineSurfaceOf(deps)
        if (!surface) return

        const target = await jumpVisibleBlocks(block, surface, JUMP_BLOCK_COUNT, 'up')
        if (target) void focusBlock(uiStateBlock, target.block.id, {renderScopeId: target.surface.renderScopeId})
      },
      defaultBinding: {
        keys: 'Control+u',
      },
    }),
    bindNormal({
      id: 'create_block_above_and_edit',
      description: 'Create block above (or as child) and enter edit mode',
      handler: (deps: BlockShortcutDependencies) => createAndEdit(deps, 'above'),
      defaultBinding: {
        keys: 'Shift+o',
      },
    }),
    bindNormal({
      id: 'paste_after',
      description: 'Paste from clipboard after current block',
      handler: async ({block, uiStateBlock, renderScopeId, scopeRootId, propertyDisplay}: BlockShortcutDependencies) => {
        const pasted = await pasteFromClipboard(block, repo, {
          position: 'after',
          scopeRootId,
          propertyDisplay,
          renderScopeId,
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
      handler: async ({block, uiStateBlock, renderScopeId, scopeRootId, propertyDisplay}: BlockShortcutDependencies) => {
        const pasted = await pasteFromClipboard(block, repo, {
          position: 'before',
          scopeRootId,
          propertyDisplay,
          renderScopeId,
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
      handler: async () => { await undoOrTakeBackCut(repo) },
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

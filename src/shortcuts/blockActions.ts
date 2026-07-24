import { ArrowDown, ArrowUp, ChevronsDownUp, ClipboardCopy, Copy, IndentDecrease, IndentIncrease, Link, Link2, SlidersHorizontal, Text, Trash2 } from 'lucide-react'
import { Block } from '../data/block'
import { Repo } from '../data/repo'
import { resetBlockSelection } from '@/data/stateBlocks.js'
import { copyBlockToClipboard } from '@/utils/copy.js'
import { absoluteAppUrl, buildAppHash } from '@/utils/routing.js'
import { withMoveTransition } from '@/utils/viewTransition.js'
import { withRowSlide } from '@/utils/flipSlide.js'
import {
  editorSelection,
  isCollapsedProp,
  focusBlock,
  isEditingProp,
  peekFocusedBlockLocation,
  requestEditorFocus,
  selectionStateProp,
  setIsEditing,
  showPropertiesProp,
  topLevelBlockIdProp,
  type EditorSelectionState,
} from '@/data/properties.js'
import { goBackInPanel, panelHistory } from '@/utils/panelHistory.js'
import { deletePanelRow } from '@/utils/panelLayoutProjection.js'
import { PANEL_TYPE } from '@/data/blockTypes.js'
import { isValidSeededDefinition } from '@/data/definitionSeeds.js'
import { structuralEditPolicyForBlock } from '@/data/structuralEditPolicy.js'
import {
  ActionConfig,
  ActionContextType,
  ActionIcon,
  ActionTrigger,
  BlockShortcutDependencies,
  ShortcutBindingDefaults,
} from '@/shortcuts/types.js'
import {
  blockAfterSubtreeRemoval,
  extendSelection,
  nextVisibleBlock,
  previousVisibleBlock,
} from '@/utils/selection'

export interface BlockAction {
  id: string
  description: string
  handler: (dependencies: BlockShortcutDependencies, trigger: ActionTrigger) => void | Promise<void>
  defaultBinding?: ShortcutBindingDefaults
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
  copyBlockContent: BlockAction
  copyBlockLink: BlockAction
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

/** Move `block` one step up (-1) or down (+1) in the visible outline,
 *  crossing parent boundaries Roam/org-style and bounded by the
 *  surface's scope root. Delegates the tree logic to the
 *  `core.moveVertical` mutator (one transaction, undoable as a unit). */
const reorderBlock = async (
  repo: Repo,
  block: Block,
  direction: -1 | 1,
  scopeRootId: string | undefined,
): Promise<boolean> =>
  repo.mutate.moveVertical({id: block.id, direction, scopeRootId})

/** Move a panel off the page it currently shows, so deleting that page
 *  doesn't tombstone the surface. Browser-tab semantics: step back to where
 *  the user came from; with no back-history, close the pane (an empty layout
 *  re-lands on the daily note). Pages are workspace-root blocks
 *  (`parentId: null`) far more often than not, so a "zoom to parent" fallback
 *  would strand most real pages — history/close is the destination that
 *  always resolves.
 *
 *  Returns false when neither is possible: a bare UI-state block (the agent
 *  bridge, headless tests) carries no `PANEL_TYPE` and has no pane to close,
 *  so there is nowhere to send it — the caller then refuses the delete rather
 *  than strand a non-panel surface.
 *
 *  Ordered before the delete so the panel is already off the page: `goBack`
 *  pushes the current page onto the FORWARD stack (never back) and
 *  `deletePanelRow` clears the panel's history, so the Back button can't
 *  return to the just-deleted page. */
const navigatePanelOffPage = async (panelBlock: Block): Promise<boolean> => {
  if (await goBackInPanel(panelBlock)) return true
  await panelBlock.load()
  if (!panelBlock.hasType(PANEL_TYPE)) return false
  await deletePanelRow(panelBlock.repo, panelBlock.id)
  return true
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

/** Extend the block selection to the next visible block. Returns whether a
 *  selection was actually extended — false at the last visible block in the
 *  surface (no next block) or if the range resolved empty. Edit-mode callers
 *  use this to avoid leaving edit mode for nothing, and pass `clearEditing` so
 *  the exit folds into the selection's transaction (see extendSelectionDownEdit). */
/** True when a block selection is already active. The Roam-style first
 *  Shift+Direction selects just the focused block; only once something is
 *  selected do further presses extend to neighbours. */
const hasActiveSelection = (uiStateBlock: Block): boolean =>
  (uiStateBlock.peekProperty(selectionStateProp)?.selectedBlockIds.length ?? 0) > 0

export const extendSelectionDown = async (
  uiStateBlock: Block,
  repo: Repo,
  scopeRootId: string | undefined,
  scopeRootForcesOpen = true,
  clearEditing = false,
): Promise<boolean> => {
  if (!scopeRootId) return false

  const focusedId = peekFocusedBlockLocation(uiStateBlock)?.blockId
  if (!focusedId) return false

  // Roam-style: the first press selects just the focused block (so a single
  // block can be selected/deleted); subsequent presses extend downward. Don't
  // select the surface's own root — acting on the view root within its view is
  // meaningless, so leave the keystroke native (matches the old no-op there).
  if (!hasActiveSelection(uiStateBlock)) {
    if (focusedId === scopeRootId) return false
    return extendSelection(focusedId, uiStateBlock, repo, scopeRootId, scopeRootForcesOpen, clearEditing)
  }

  const nextBlock = await nextVisibleBlock(repo.block(focusedId), scopeRootId, scopeRootForcesOpen)
  if (!nextBlock) return false

  return extendSelection(nextBlock.id, uiStateBlock, repo, scopeRootId, scopeRootForcesOpen, clearEditing)
}

/** Mirror of {@link extendSelectionDown} for the previous visible block.
 *  Returns false at the first visible block in the surface (the focused block
 *  is the scope root) or if the range resolved empty. */
export const extendSelectionUp = async (
  uiStateBlock: Block,
  repo: Repo,
  scopeRootId: string | undefined,
  scopeRootForcesOpen = true,
  clearEditing = false,
): Promise<boolean> => {
  if (!scopeRootId) return false

  const focusedId = peekFocusedBlockLocation(uiStateBlock)?.blockId
  if (!focusedId) return false

  // Roam-style first press — see extendSelectionDown.
  if (!hasActiveSelection(uiStateBlock)) {
    if (focusedId === scopeRootId) return false
    return extendSelection(focusedId, uiStateBlock, repo, scopeRootId, scopeRootForcesOpen, clearEditing)
  }

  const prevBlock = await previousVisibleBlock(repo.block(focusedId), scopeRootId)
  if (!prevBlock) return false

  return extendSelection(prevBlock.id, uiStateBlock, repo, scopeRootId, scopeRootForcesOpen, clearEditing)
}

export const createSharedBlockActions = ({repo}: { repo: Repo }): SharedBlockActions => {
  // In-place structural shifts deliberately run WITHOUT
  // `withMoveTransition`: the root-level crossfade ghosts the shifting
  // content at both old and new positions (text overlaps itself
  // mid-flight, reading as blur), and the per-block view-transition-name
  // attempt had its own artifacts (see DefaultBlockRenderer). The atomic
  // DOM update from the `NotifyBatch` fix stays the substrate; move
  // up/down now layers `withRowSlide` on top — the per-element setup the
  // old note here wished for: element-level FLIP with plain transform
  // transitions, no snapshot overlay, no duplicated text. Indent/outdent
  // stay instant for now: horizontal reflow changes line wrapping, which
  // translation-only FLIP can't express cleanly.
  const indentBlock: BlockAction = {
    id: 'indent_block',
    description: 'Indent block',
    icon: IndentIncrease,
    handler: async (deps: BlockShortcutDependencies) => {
      // No-op on a scope root: indenting it would reparent the visible
      // root under a sibling that lives outside the surface. The
      // mutator separately no-ops when there's no previous sibling.
      const {canIndent} = await structuralEditPolicyForBlock(deps.block, deps.scopeRootId)
      if (!canIndent) return
      await repo.mutate.indent({id: deps.block.id})
      requestEditorFocusIfEditing(deps.uiStateBlock)
    },
    defaultBinding: {
      keys: 'Tab',
      eventOptions: {
        preventDefault: true,
      },
    },
  }

  const outdentBlock: BlockAction = {
    id: 'outdent_block',
    description: 'Outdent block',
    icon: IndentDecrease,
    handler: async ({block, uiStateBlock, scopeRootId}: BlockShortcutDependencies) => {
      if (!scopeRootId) return

      // Don't outdent the scope root itself; the mutator additionally
      // refuses when the block is a direct child of the scope root
      // (outdenting would escape the visible subtree).
      const {canOutdent} = await structuralEditPolicyForBlock(block, scopeRootId)
      if (!canOutdent) return

      await repo.mutate.outdent({id: block.id, scopeRootId})
      requestEditorFocusIfEditing(uiStateBlock)
    },
    defaultBinding: {
      keys: 'Shift+Tab',
      eventOptions: {
        preventDefault: true,
      },
    },
  }
  const moveBlockUp: BlockAction = {
    id: 'move_block_up',
    description: 'Move block up',
    icon: ArrowUp,
    handler: async (deps: BlockShortcutDependencies) => {
      const {block, uiStateBlock, scopeRootId} = deps
      if (!block) return
      await withRowSlide(() => reorderBlock(repo, block, -1, scopeRootId))
      requestEditorFocusIfEditing(uiStateBlock)
    },
    defaultBinding: {
      keys: ['$mod+Shift+ArrowUp', '$mod+Shift+k'],
      eventOptions: {
        preventDefault: true,
      },
    },
  }

  const moveBlockDown: BlockAction = {
    id: 'move_block_down',
    description: 'Move block down',
    icon: ArrowDown,
    handler: async (deps: BlockShortcutDependencies) => {
      const {block, uiStateBlock, scopeRootId} = deps
      if (!block) return
      await withRowSlide(() => reorderBlock(repo, block, 1, scopeRootId))
      requestEditorFocusIfEditing(uiStateBlock)
    },
    defaultBinding: {
      keys: ['$mod+Shift+ArrowDown', '$mod+Shift+j'],
      eventOptions: {
        preventDefault: true,
      },
    },
  }

  const deleteBlock: BlockAction = {
    id: 'delete_block',
    description: 'Delete block',
    icon: Trash2,
    handler: async (deps: BlockShortcutDependencies) => {
      const {block, uiStateBlock, scopeRootId} = deps
      if (!block || !uiStateBlock) return

      const {isScopeRoot} = await structuralEditPolicyForBlock(block, scopeRootId)

      // Deleting the scope root in place would tombstone the rendered surface
      // out from under the panel (see StructuralEditPolicy.canDelete — every
      // other structural handler refuses at this boundary). But the scope
      // root of a panel's *focal* outline IS its current page, and "delete
      // this page" is a first-class gesture — historically the only
      // page-deletion UI. Reconcile the two: move the panel OFF the page
      // first (history back / close the pane), THEN delete, so the surface
      // never renders a tombstone.
      if (isScopeRoot) {
        // Only the panel's focal page render deletes the whole page. The same
        // block embedded/backlinked within its own outline is also a scope
        // root with the same id, but a nested surface — deleting there must
        // not nuke the page. `scopeRootForcesOpen === false` marks nested
        // surfaces (useShortcutSurfaceActivations sets it to !isNestedSurface,
        // exactly useIsFocalRender's second axis); focal roots force-open.
        const isFocalPage =
          uiStateBlock.peekProperty(topLevelBlockIdProp) === block.id &&
          deps.scopeRootForcesOpen !== false
        if (!isFocalPage) return

        // Refuse deletes the data layer would reject anyway — otherwise we move
        // the panel off a page that then survives the (failed) delete. Two
        // sources, both checked BEFORE any panel write:
        //  - read-only workspace: block.delete() is a BlockDefault write, rejected;
        //  - a materialized seed-definition block (a code-owned system page): its
        //    row is undeletable (SeededDefinitionWriteError), even when writable.
        if (block.repo.isReadOnly) return
        await block.load()
        const data = block.peek()
        if (data && isValidSeededDefinition(data)) return

        // Only delete once the panel is safely off the page. If it couldn't be
        // moved (no history AND not a real panel surface — e.g. the headless
        // bridge), refuse rather than tombstone the surface. This is also what
        // keeps defaultActions.fuzz.test.ts's scope-root invariant green: its
        // `uiStateBlock` is a bare block with no PANEL_TYPE, so the focal page
        // stays live.
        if (!(await navigatePanelOffPage(uiStateBlock))) return
        await withMoveTransition(async () => {
          await block.delete()
        })
        // The page is gone: drop it from this pane's history so neither Back nor
        // Forward lands on its tombstone. `goBackInPanel` parks the current page
        // on the FORWARD stack as it steps back, so without this the Forward
        // button would navigate straight to the just-deleted block.
        panelHistory.forget(uiStateBlock.id, block.id)
        return
      }

      // Beyond the scope-root handling above, `scopeRootId` only locates
      // the post-delete focus target; the delete itself doesn't need it.
      // Don't gate the delete on it, so non-React runners that can't
      // inject a scope (the agent-runtime bridge) still delete — they
      // just skip focus recovery.
      // Same-depth next sibling is the natural shift-up target. When
      // `block` has descendants those vanish too, so we can't use
      // `nextVisibleBlock` (which would descend into the doomed
      // subtree). `blockAfterSubtreeRemoval` walks the data tree
      // skipping `block`'s subtree entirely: next sibling → prev
      // sibling → parent. This mirrors what the proactive
      // `PanelFocusRecovery` does on the DOM side, so manual deletes
      // and surprise disappearances both land on the same target.
      const next = scopeRootId ? await blockAfterSubtreeRemoval(block, scopeRootId) : null
      await withMoveTransition(async () => {
        await block.delete()
      })
      if (next) void focusBlock(uiStateBlock, next.id, {renderScopeId: deps.renderScopeId})
    },
    defaultBinding: {
      keys: 'Delete',
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
      await withMoveTransition(async () => {
        await block.set(isCollapsedProp, !isCollapsed)
      })
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
      // Vim "yank" family — all copy variants share a `y` prefix:
      // `y y` block, `y r` reference, `y e` embed (see copyBlockRef /
      // copyBlockEmbed below). `y y` mirrors vim's `yy` (yank line).
      // `$mod+c` stays as the platform-native copy.
      keys: ['$mod+c', 'y y'],
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
    defaultBinding: {
      // `y r` ("yank reference") is the `y`-prefixed copy-family form;
      // `Alt+y` is kept as the original alternate. Plain-letter sequences
      // match on event.key directly (the logical letter the layout
      // produces), so `y r` is correct on every platform AND layout. The
      // `Alt+y` form relies on `withRecoveredLetterKey` in the reconciler
      // restoring event.key from event.keyCode for alt+letter chords, so it
      // too holds across Mac/Linux/Windows × QWERTY/Colemak/Dvorak.
      keys: ['y r', 'Alt+y'],
    },
  }

  const copyBlockEmbed: BlockAction = {
    id: 'copy_block_embed',
    description: 'Copy block embed',
    icon: ClipboardCopy,
    handler: ({block}: BlockShortcutDependencies) => {
      writeToClipboard(`!((${block.id}))`)
    },
    defaultBinding: {
      // `y e` ("yank embed") is the `y`-prefixed copy-family form;
      // `Shift+y` is kept as the original alternate.
      keys: ['y e', 'Shift+y'],
    },
  }

  const copyBlockContent: BlockAction = {
    id: 'copy_block_content',
    description: 'Copy block text only',
    icon: Text,
    // `y c` ("yank content") — just this block's own text, WITHOUT its
    // subtree. `y y` (copy_block) serializes the whole subtree as
    // indented markdown; this is the single-line counterpart.
    handler: async ({block}: BlockShortcutDependencies) => {
      const data = block.peek() ?? await block.load()
      writeToClipboard(data?.content ?? '')
    },
    defaultBinding: {
      keys: 'y c',
    },
  }

  const copyBlockLink: BlockAction = {
    id: 'copy_block_link',
    description: 'Copy link to block',
    icon: Link,
    // `y l` ("yank link") — an absolute, shareable URL that opens this
    // block. Reuses the same routing facilities the in-app `<a href>`
    // links use: `buildAppHash` for the `#<workspaceId>/<blockId>` hash,
    // `absoluteAppUrl` to promote it to an absolute URL (and drop any
    // agent-runtime pairing secret riding in the current hash).
    handler: ({block}: BlockShortcutDependencies) => {
      const workspaceId = repo.activeWorkspaceId
      if (!workspaceId) return
      writeToClipboard(absoluteAppUrl(buildAppHash(workspaceId, block.id)))
    },
    defaultBinding: {
      keys: 'y l',
    },
  }

  const extendSelectionUpAction: BlockAction = {
    id: 'extend_selection_up',
    description: 'Extend selection up',
    handler: async (deps: BlockShortcutDependencies) => {
      await extendSelectionUp(deps.uiStateBlock, repo, deps.scopeRootId, deps.scopeRootForcesOpen)
    },
    defaultBinding: {
      keys: 'Shift+ArrowUp',
      eventOptions: {
        preventDefault: true,
      },
    },
  }

  const extendSelectionDownAction: BlockAction = {
    id: 'extend_selection_down',
    description: 'Extend selection down',
    handler: async (deps: BlockShortcutDependencies) => {
      await extendSelectionDown(deps.uiStateBlock, repo, deps.scopeRootId, deps.scopeRootForcesOpen)
    },
    defaultBinding: {
      keys: 'Shift+ArrowDown',
      eventOptions: {
        preventDefault: true,
      },
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
    copyBlockContent,
    copyBlockLink,
  }
}

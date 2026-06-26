import {
  actionTransformsFacet,
  actionsFacet,
} from '@/extensions/core.js'
import { EXTEND_BLOCK_SELECTION_ACTION_ID } from '@/extensions/blockSelectionAction.js'
import type { AppExtension } from '@/facets/facet.js'
import {
  ActionConfig,
  type BaseShortcutDependencies,
  type ActionTransform,
  ActionContextTypes,
  type BlockPointerDependencies,
  type BlockShortcutDependencies,
} from '@/shortcuts/types.js'
import type { BlockAction } from '@/shortcuts/blockActions.js'
import { bindBlockActionContext } from '@/shortcuts/blockActions.js'
import {
  activePanelIdProp,
  focusedBlockLocationProp,
  focusBlock,
  isEditingProp,
  peekFocusedBlockLocation,
  sameFocusedBlockLocation,
  selectionStateProp,
  type FocusedBlockLocation,
} from '@/data/properties'
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import {
  blockIdsInOrderedSelectionRange,
  commitSelectionRange,
  findBestSelectionAnchorIndex,
} from '@/utils/selection.js'
import {
  horizontalNeighborPanel,
  locationOf,
  panelOf,
  panelInstances,
  resolveCurrentAnchor,
  verticalNeighbor,
} from './walker.ts'

/**
 * Locate the anchor instance to walk from. Prefers the live DOM
 * instance for the focused block; if it's missing (e.g. a backlink
 * was just rescheduled and its entry unmounted while the proactive
 * recovery is still in its debounce window), falls back to the same
 * recovery anchor `PanelFocusRecovery` would pick. Without that
 * fallback, a keystroke during the window would return null →
 * `moveVertical` returns false → vim's data-model walker takes over
 * and may cross panels (see `moveVertical`'s false-return contract).
 */
const currentInstance = (
  deps: BlockShortcutDependencies,
): HTMLElement | null => {
  const {block, uiStateBlock} = deps
  if (!block || !uiStateBlock) return null
  if (typeof document === 'undefined') return null
  const focusedLocation = deps.renderScopeId
    ? {blockId: block.id, renderScopeId: deps.renderScopeId}
    : peekFocusedBlockLocation(uiStateBlock)
  return resolveCurrentAnchor(uiStateBlock.id, focusedLocation)
}

const locationsOf = (instances: readonly HTMLElement[]): FocusedBlockLocation[] | null => {
  const locations = instances.map(locationOf)
  return locations.every((location): location is FocusedBlockLocation => Boolean(location))
    ? locations
    : null
}

export const extendSelectionToSpatialTarget = async (
  deps: BaseShortcutDependencies,
  target: HTMLElement,
): Promise<boolean> => {
  const {uiStateBlock} = deps
  if (!uiStateBlock) return false

  const targetLocation = locationOf(target)
  if (!targetLocation) return false
  const panel = panelOf(target)
  if (!panel || panel.dataset.panelId !== uiStateBlock.id) return true

  const currentState = uiStateBlock.peekProperty(selectionStateProp)
  const currentLocation = peekFocusedBlockLocation(uiStateBlock)
  const anchorBlockId = currentState?.anchorBlockId ?? currentLocation?.blockId
  if (!anchorBlockId) return false

  const instances = panelInstances(panel)
  const orderedLocations = locationsOf(instances)
  if (!orderedLocations) return false
  const targetIndex = instances.indexOf(target)
  const anchorIndex = findBestSelectionAnchorIndex(orderedLocations, {
    anchorBlockId,
    targetIndex,
    selectedBlockIds: currentState?.selectedBlockIds,
    currentLocation,
  })
  if (anchorIndex < 0) return false

  return commitSelectionRange({
    uiStateBlock,
    anchorBlockId,
    targetLocation,
    selectedBlockIds: blockIdsInOrderedSelectionRange(orderedLocations, anchorIndex, targetIndex),
    clearEditing: true,
    description: 'spatial-navigation extend selection',
  })
}

const extendSelectionVertical = async (
  deps: BaseShortcutDependencies,
  direction: 'up' | 'down',
): Promise<boolean> => {
  const {uiStateBlock} = deps
  if (!uiStateBlock) return false
  if (typeof document === 'undefined') return false

  const focusedLocation = peekFocusedBlockLocation(uiStateBlock)
  if (!focusedLocation) return false
  const current = resolveCurrentAnchor(uiStateBlock.id, focusedLocation)
  if (!current) return true

  const currentLocation = locationOf(current)
  if (!currentLocation) return false
  if (!sameFocusedBlockLocation(currentLocation, focusedLocation)) {
    await extendSelectionToSpatialTarget(deps, current)
    return true
  }

  // Roam-style: the first press (no active selection yet) selects just the
  // focused block; only once a selection exists do further presses extend to
  // the neighbour. Mirrors the structural extendSelectionDown/Up path.
  const hasSelection = (uiStateBlock.peekProperty(selectionStateProp)?.selectedBlockIds.length ?? 0) > 0
  if (!hasSelection) {
    await extendSelectionToSpatialTarget(deps, current)
    return true
  }

  const next = verticalNeighbor(current, direction)
  if (!next) return true
  await extendSelectionToSpatialTarget(deps, next)
  return true
}

/**
 * Move spatial focus within a panel. Mirrors vim's `move_down` /
 * `move_up` behavior exactly: write the new focused block id to the
 * panel block via `focusBlock`. No DOM-focus call, no scroll — the
 * kernel `BlockFocusShellDecorator` already drives both
 * (highlight class via `useInFocus`, scroll via its own effect)
 * off the same prop. Adding our own DOM mutations would just race.
 *
 * Return contract (intentionally different from "did we move?"):
 *   - `false` → "no anchor; please fall through to the underlying
 *     vim handler". Only the `!current` early return takes this
 *     path — neither a live focused instance nor a recovery anchor
 *     exists, so vim's data-model walk is a legitimate fallback.
 *   - `true` → "spatial nav handled this keystroke". Includes the
 *     no-neighbor / panel-boundary case. We must NOT fall through
 *     to vim's `nextVisibleBlock` for a panel-boundary block on a
 *     non-outline surface (backlinks, embeds): vim's walker climbs
 *     the data-model parent chain of the source block, which for a
 *     backlink entry lives in some other page entirely. Following
 *     that chain returns a block from elsewhere in the workspace,
 *     and writing it as the panel's `focusedBlockLocation` leaves
 *     `useInFocus(<anyone in this panel>)` returning false →
 *     normal-mode deactivates → all shortcuts go dead until the
 *     user clicks back into a block.
 */
const moveVertical = async (
  deps: BlockShortcutDependencies,
  direction: 'up' | 'down',
): Promise<boolean> => {
  const {block, uiStateBlock} = deps
  if (!block || !uiStateBlock) return false
  const expectedLocation = deps.renderScopeId
    ? {blockId: block.id, renderScopeId: deps.renderScopeId}
    : peekFocusedBlockLocation(uiStateBlock)
  const current = currentInstance(deps)
  if (!current) return Boolean(expectedLocation)

  // Recovery-anchor settle: the focused block instance is gone (e.g. a
  // backlink was just rescheduled away) and `resolveCurrentAnchor`
  // handed us its proactive recovery target instead. Land the user
  // on that target as if recovery had already run; further vertical
  // movement walks normally from there on the next keystroke. Walking past
  // it here would feel like one key press moved two blocks.
  const currentLocation = locationOf(current)
  if (!currentLocation) return false

  if (
    expectedLocation &&
    (
      currentLocation.blockId !== expectedLocation.blockId ||
      currentLocation.renderScopeId !== expectedLocation.renderScopeId
    )
  ) {
    void focusBlock(uiStateBlock, currentLocation.blockId, {renderScopeId: currentLocation.renderScopeId})
    return true
  }

  const next = verticalNeighbor(current, direction)
  if (!next) return true // boundary — handled, no move
  const destPanel = next.closest<HTMLElement>('[data-panel-id]')
  if (!destPanel) return true
  const destPanelId = destPanel.dataset.panelId
  const destLocation = locationOf(next)
  if (!destPanelId || !destLocation) return true

  if (destPanelId === uiStateBlock.id) {
    // Same-panel step — identical to vim's `focusBlock` write.
    void focusBlock(uiStateBlock, destLocation.blockId, {renderScopeId: destLocation.renderScopeId})
    return true
  }

  // Crossed into a stack-sibling panel below/above. Activate the new
  // panel atomically with the focus write so `useShortcutSurfaceActivations`
  // doesn't see a window where source panel is inactive AND
  // destination's focused block hasn't moved yet.
  await crossPanelFocus(uiStateBlock, destPanelId, destLocation)
  return true
}

const moveHorizontal = async (
  deps: BlockShortcutDependencies,
  direction: 'left' | 'right',
): Promise<boolean> => {
  const {block, uiStateBlock} = deps
  if (!block || !uiStateBlock) return false
  const current = currentInstance(deps)
  if (!current) return false
  const destPanel = horizontalNeighborPanel(current, direction)
  if (!destPanel) return false
  const destPanelId = destPanel.dataset.panelId
  if (!destPanelId) return false
  const destPanelBlock = uiStateBlock.repo.block(destPanelId)
  // Sticky-return: read the panel's stored focus, fall back to its
  // top-level (the panel's `topLevelBlockIdProp` aligned to its
  // outline root).
  const destLocation = peekFocusedBlockLocation(destPanelBlock)
    ?? findFirstInstanceLocation(destPanel)
  if (!destLocation) return false
  await crossPanelFocus(uiStateBlock, destPanelId, destLocation)
  return true
}

const findFirstInstanceLocation = (panel: HTMLElement): FocusedBlockLocation | undefined => {
  for (const instance of panelInstances(panel)) {
    const location = locationOf(instance)
    if (location) return location
  }
  return undefined
}

const crossPanelFocus = async (
  sourcePanelBlock: Block,
  destPanelId: string,
  destLocation: FocusedBlockLocation,
): Promise<void> => {
  const repo = sourcePanelBlock.repo
  const destPanelBlock = repo.block(destPanelId)
  // Find the layout session by walking up the DOM — its id is on the
  // outer layout div. Cheap; runs once per cross-panel keystroke.
  const layoutEl = typeof document !== 'undefined'
    ? document.querySelector<HTMLElement>('[data-layout-session-id]')
    : null
  const layoutSessionId = layoutEl?.dataset.layoutSessionId
  // Single tx that flips both ends of the activation gate at once.
  // Same shape as `focusBlock` but adds the activePanelId write on
  // the layout-session block; row deps still resolve identically
  // (same kind:'row' invalidation per touched block).
  await repo.tx(async tx => {
    if (layoutSessionId) {
      await tx.setProperty(layoutSessionId, activePanelIdProp, destPanelId)
    }
    await tx.setProperty(destPanelBlock.id, focusedBlockLocationProp, destLocation)
    if (destPanelBlock.peekProperty(isEditingProp) === true) {
      await tx.setProperty(destPanelBlock.id, isEditingProp, false)
    }
  }, {scope: ChangeScope.UiState, description: 'spatial-navigation cross-panel focus'})
}

export function getSpatialNavigationActions(): ActionConfig<typeof ActionContextTypes.NORMAL_MODE>[] {
  const bindNormal = (action: BlockAction) =>
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, action)

  return [
    bindNormal({
      id: 'move_left',
      description: 'Move focus to the panel on the left',
      handler: async (deps: BlockShortcutDependencies) => {
        await moveHorizontal(deps, 'left')
      },
      defaultBinding: {keys: ['ArrowLeft', 'h']},
    }),
    bindNormal({
      id: 'move_right',
      description: 'Move focus to the panel on the right',
      handler: async (deps: BlockShortcutDependencies) => {
        await moveHorizontal(deps, 'right')
      },
      defaultBinding: {keys: ['ArrowRight', 'l']},
    }),
  ]
}

const verticalDecorator = (
  actionId: 'move_down' | 'move_up',
  direction: 'down' | 'up',
  description: string,
): ActionTransform => ({
  actionId,
  context: ActionContextTypes.NORMAL_MODE,
  apply: action => ({
    ...action,
    description,
    handler: async (deps, trigger, dispatch) => {
      if (await moveVertical(deps as BlockShortcutDependencies, direction)) return
      await action.handler(deps, trigger, dispatch)
    },
  }),
})

const selectionVerticalDecorator = (
  actionId: 'extend_selection_down' | 'extend_selection_up' | 'multi_select.extend_selection_down' | 'multi_select.extend_selection_up',
  context: typeof ActionContextTypes.NORMAL_MODE | typeof ActionContextTypes.MULTI_SELECT_MODE,
  direction: 'down' | 'up',
): ActionTransform => ({
  actionId,
  context,
  apply: action => ({
    ...action,
    handler: async (deps, trigger, dispatch) => {
      if (await extendSelectionVertical(deps, direction)) return
      await action.handler(deps, trigger, dispatch)
    },
  }),
})

/**
 * Shift-click selection in visible DOM order — an `ActionTransform` on the
 * structural `extend_block_selection` action, the mouse-side counterpart of
 * `selectionVerticalDecorator`: anchor → clicked block range across whatever is
 * on screen (backlinks, embeds), not the data tree. Declines back to the
 * structural base when no spatial range resolves (e.g. the clicked instance
 * isn't in this panel / isn't a navigable item).
 *
 * `deps.targetElement` is the block shell the block-pointer dispatch captured —
 * the same element the spatial shell decorator tags with `data-block-nav-item`,
 * so the walker can locate it. Upstream gating (selection-gesture + exact
 * shift-only pointer binding) means this only ever sees a plain shift-click, so
 * it no longer re-checks modifiers or interactive content.
 */
export const spatialSelectionClickTransform: ActionTransform = {
  actionId: EXTEND_BLOCK_SELECTION_ACTION_ID,
  context: ActionContextTypes.BLOCK_POINTER,
  apply: action => ({
    ...action,
    handler: async (deps, trigger, dispatch) => {
      const {uiStateBlock, targetElement} = deps as BlockPointerDependencies
      // Only the clicked block's own panel can resolve a spatial range; for a
      // mismatched panel defer to the structural base rather than swallow it.
      // `extendSelectionToSpatialTarget` reports a mismatch as "handled" for
      // the keyboard contract, so gate on the panel match here.
      if (panelOf(targetElement)?.dataset.panelId === uiStateBlock.id) {
        if (await extendSelectionToSpatialTarget({uiStateBlock}, targetElement)) return
      }
      await action.handler(deps, trigger, dispatch)
    },
  }),
}

export function getSpatialNavigationActionDecorators(): ActionTransform[] {
  return [
    verticalDecorator('move_down', 'down', 'Move focus down (next block, then stack-sibling panel below)'),
    verticalDecorator('move_up', 'up', 'Move focus up (previous block, then stack-sibling panel above)'),
    selectionVerticalDecorator('extend_selection_down', ActionContextTypes.NORMAL_MODE, 'down'),
    selectionVerticalDecorator('extend_selection_up', ActionContextTypes.NORMAL_MODE, 'up'),
    selectionVerticalDecorator('multi_select.extend_selection_down', ActionContextTypes.MULTI_SELECT_MODE, 'down'),
    selectionVerticalDecorator('multi_select.extend_selection_up', ActionContextTypes.MULTI_SELECT_MODE, 'up'),
    spatialSelectionClickTransform,
  ]
}

export const spatialNavigationActionsExtension: AppExtension =
  getSpatialNavigationActions().map(action =>
    actionsFacet.of(action as ActionConfig, {source: 'spatial-navigation'}),
  )

export const spatialNavigationActionDecoratorsExtension: AppExtension =
  getSpatialNavigationActionDecorators().map(decorator =>
    actionTransformsFacet.of(decorator, {source: 'spatial-navigation'}),
  )

import {
  actionTransformsFacet,
  actionsFacet,
} from '@/extensions/core.js'
import {
  actionDispatchWrap,
  type ActionDispatchDecorator,
} from '@/shortcuts/actionDispatch.js'
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
  focusedBlockLocationProp,
  focusBlock,
  isEditingProp,
  peekFocusedBlockLocation,
  sameFocusedBlockLocation,
  selectionStateProp,
  type FocusedBlockLocation,
} from '@/data/properties'
import { ChangeScope } from '@/data/api'
import { outlineSurfaceOf } from '@/data/outlineSurface.js'
import { hasBlockSelection } from '@/data/stateBlocks.js'
import type { Block } from '@/data/block'
import {
  blockIdsInOrderedSelectionRange,
  commitSelectionRange,
  findBestSelectionAnchorIndex,
  nextDrawnStep,
  previousDrawnStep,
  selectionBoundaryOf,
} from '@/utils/selection.js'
import {
  aheadOf,
  closestBlockAncestor,
  firstInstanceIn,
  horizontalNeighborPanel,
  laneEdgeInstance,
  laneOf,
  lateralNeighbor,
  locationOf,
  OWN_CONTENT_LANE,
  panelById,
  panelOf,
  nextRowInScope,
  panelRowsInOrder,
  type PanelRow,
  reservedRowBetween,
  resolveCurrentAnchor,
  rowSlotIn,
  verticalNeighbor,
} from './walker.ts'
import { resolveSpatialNavExclusions } from './exclusionsFacet.ts'
import { activatePanelRowInTx } from '@/utils/panelLayoutProjection'
import { activeLayoutSessionElement } from '@/utils/layoutSessionDom'

/** Resolve the live excluded-surface set once per handler entry, off the
 *  ui-state block's repo — the non-React access path
 *  (`Block['repo']['facetRuntime']`) since these handlers run outside
 *  React and have no `useAppRuntime()`. See `exclusionsFacet.ts`. */
const excludedSurfacesFor = (uiStateBlock: Block): ReadonlySet<string> =>
  resolveSpatialNavExclusions(uiStateBlock.repo.facetRuntime)

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
  return resolveCurrentAnchor(uiStateBlock.id, focusedLocation, excludedSurfacesFor(uiStateBlock))
}

/** For an unnamed reservation or a nested occurrence, the enclosing rendered
 *  scope can identify an isolated member. The row itself must belong to it. */
const boundaryOfRow = async (row: PanelRow, uiStateBlock: Block, panel: HTMLElement): Promise<FocusedBlockLocation | undefined> => {
  const block = uiStateBlock.repo.block(row.blockId)
  let boundary = await selectionBoundaryOf(block, row.renderScopeId)
  let ancestor = closestBlockAncestor(row.element, panel)
  while (!boundary && ancestor) {
    const location = locationOf(ancestor)
    if (location && location.renderScopeId !== row.renderScopeId) {
      boundary = await selectionBoundaryOf(block, location.renderScopeId)
    }
    ancestor = closestBlockAncestor(ancestor, panel)
  }
  return boundary ?? undefined
}

const sameSelectionBoundary = (a: FocusedBlockLocation | undefined, b: FocusedBlockLocation | undefined) =>
  a === b || sameFocusedBlockLocation(a, b)

/** `rangeOrigin` stands in for the focused row as the cursor the range starts
 *  from — see `BlockPointerDependencies.rangeOrigin`. */
export const extendSelectionToSpatialTarget = async (
  deps: BaseShortcutDependencies,
  target: HTMLElement,
  rangeOrigin?: FocusedBlockLocation,
): Promise<boolean> => {
  const {uiStateBlock} = deps
  if (!uiStateBlock) return false

  const targetLocation = locationOf(target)
  if (!targetLocation) return false
  const panel = panelOf(target)
  if (!panel || panel.dataset.panelId !== uiStateBlock.id) return true

  const currentState = uiStateBlock.peekProperty(selectionStateProp)
  const cursorLocation = rangeOrigin ?? peekFocusedBlockLocation(uiStateBlock)
  const anchorBlockId = currentState?.anchorBlockId ?? cursorLocation?.blockId
  if (!anchorBlockId) return false

  const allRows = panelRowsInOrder(panel, excludedSurfacesFor(uiStateBlock))
  // A range stays in one lane of the panel (`laneOf`): an anchor in another
  // starts a new one at the target.
  const lane = laneOf(target)
  const rows = allRows.filter(row => laneOf(row.element) === lane)
  const targetIndex = rows.findIndex(row => row.element === target)
  const targetRow = rows[targetIndex]
  if (!targetRow) return false
  const targetBoundary = await boundaryOfRow(targetRow, uiStateBlock, panel)
  const cursorRow = cursorLocation && allRows.find(row =>
    row.blockId === cursorLocation.blockId && row.renderScopeId === cursorLocation.renderScopeId,
  )
  const cursorBoundary = cursorRow
    ? await boundaryOfRow(cursorRow, uiStateBlock, panel)
    : cursorLocation
      ? (await selectionBoundaryOf(uiStateBlock.repo.block(cursorLocation.blockId), cursorLocation.renderScopeId)) ?? undefined
      : undefined
  if (!sameSelectionBoundary(cursorBoundary, targetBoundary)) return true

  const anchorElsewhere = !rows.some(row => row.blockId === anchorBlockId) &&
    allRows.some(row => row.blockId === anchorBlockId)
  const rangeAnchorId = anchorElsewhere ? targetLocation.blockId : anchorBlockId
  const anchorIndex = anchorElsewhere ? targetIndex : findBestSelectionAnchorIndex(rows, {
    anchorBlockId,
    targetIndex,
    selectedBlockIds: currentState?.selectedBlockIds,
    currentLocation: cursorLocation,
  })
  const anchorRow = rows[anchorIndex]
  if (!anchorRow) return Boolean(targetBoundary)
  const anchorBoundary = await boundaryOfRow(anchorRow, uiStateBlock, panel)
  if (!sameSelectionBoundary(anchorBoundary, targetBoundary)) return true

  // A range must stay on one side of every isolated member boundary, even
  // when it would skip a row from another scope while collecting blocks.
  const span = rows.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)
  for (const row of span.slice(1, -1)) {
    if (!sameSelectionBoundary(await boundaryOfRow(row, uiStateBlock, panel), targetBoundary)) return true
  }
  const spanned = anchorRow.renderScopeId === targetRow.renderScopeId
    ? span.filter(row => row.renderScopeId === targetRow.renderScopeId)
    : span

  return commitSelectionRange({
    uiStateBlock,
    anchorBlockId: rangeAnchorId,
    targetLocation,
    selectedBlockIds: blockIdsInOrderedSelectionRange(spanned, 0, spanned.length - 1),
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

  const excludedSurfaces = excludedSurfacesFor(uiStateBlock)
  const focusedLocation = peekFocusedBlockLocation(uiStateBlock)
  if (!focusedLocation) return false
  const current = resolveCurrentAnchor(uiStateBlock.id, focusedLocation, excludedSurfaces)
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
  if (!hasBlockSelection(uiStateBlock)) {
    await extendSelectionToSpatialTarget(deps, current)
    return true
  }

  const next = nextRowInScope(current, direction, excludedSurfaces)
    ?? verticalNeighbor(current, direction, excludedSurfaces)
  // NOT the same call as `moveVertical`'s boundary, though it looks like it.
  // Declining here doesn't extend the selection by one row: the structural
  // base re-derives the WHOLE range from the model, which sweeps in every
  // unmounted row the spatial (DOM-order) range had skipped — one keystroke
  // silently adding rows the user has never seen, straight into the path of
  // `d` / delete. So the selection edge stays "handled", as the
  // hidden-structural-siblings test above it has always specified. Shift+j
  // therefore still stops at the last mounted row while `j` walks on; making
  // those agree means teaching this path to extend onto a model-resolved row
  // spatially, which is its own change.
  if (!next) return true
  await extendSelectionToSpatialTarget(deps, next)
  return true
}

/** Walk the model for the next drawn row, and the DOM for nested surfaces that
 *  the model cannot enumerate. Normal mode delegates a model-only move to Vim.
 *  An explicit caller can take that fallback here (e.g. exiting grid row mode
 *  past the current row's subtree). */
export const moveVertical = async (
  deps: BlockShortcutDependencies,
  direction: 'up' | 'down',
  {descend = true, modelFallback = false}: {descend?: boolean; modelFallback?: boolean} = {},
): Promise<boolean> => {
  const {block, uiStateBlock} = deps
  if (!block || !uiStateBlock) return false
  const expectedLocation = deps.renderScopeId
    ? {blockId: block.id, renderScopeId: deps.renderScopeId}
    : peekFocusedBlockLocation(uiStateBlock)
  const current = currentInstance(deps)
  if (!current) return !modelFallback && Boolean(expectedLocation)
  const excludedSurfaces = excludedSurfacesFor(uiStateBlock)

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

  const surface = outlineSurfaceOf(deps)
  const modelStep = surface
    ? (direction === 'down'
        ? await nextDrawnStep(block, surface, descend)
        : await previousDrawnStep(block, surface))
    : null
  const modelLocation = modelStep?.block
    ? {blockId: modelStep.block.id, renderScopeId: modelStep.surface.renderScopeId ?? currentLocation.renderScopeId}
    : null

  // A second keystroke or a click can land while that walk waits on an
  // uncached `childIds`. Everything below is computed from a row that no
  // longer holds focus, so hand the panel to whoever moved it rather than
  // writing a move the user has already superseded.
  if (
    expectedLocation &&
    !sameFocusedBlockLocation(peekFocusedBlockLocation(uiStateBlock), expectedLocation)
  ) return true

  // The anchor itself can be torn out while the walk waits (a re-render, a
  // recycled lazy row, the panel unmounting under it). Everything below reads
  // the DOM through it, and a detached element still answers — from the dead
  // tree. Load-bearing where the two lookups disagree: `rowSlotIn` goes through
  // `panelById`, which queries the live document, while `reservedRowBetween`
  // goes through `panelOf(current)`, which in a detached subtree returns the
  // DEAD panel — so the scope edge would find a dead slot and write focus to a
  // row that no longer exists. Declining here is what keeps both on one DOM.
  if (!current.isConnected) return false

  // Read the neighbour AFTER the walk, never before: resolving the `childIds`
  // that walk awaits is itself what mounts the rows under this one, so a
  // neighbour read earlier can be a row that is no longer adjacent — and every
  // test below is about adjacency. Taking that stale row while the mounted set
  // says the model's row has since arrived would skip exactly the row that
  // just mounted.
  const next = verticalNeighbor(current, direction, excludedSurfaces, descend)
  const nextLocation = next ? locationOf(next) : null
  const nextPanelId = next ? panelOf(next)?.dataset.panelId : undefined

  if (modelLocation) {
    // A rendered neighbour can take precedence only if it comes before the
    // model row in this panel. Rows in either of the scopes the walk names
    // must match the model row exactly, since React may still be showing
    // rows that the model has collapsed, moved or deleted.
    const modelRowSlot = rowSlotIn(uiStateBlock.id, modelLocation, excludedSurfaces)
    const mountedBeforeModel = Boolean(
      next && nextLocation && modelRowSlot &&
      nextPanelId === uiStateBlock.id &&
      nextLocation.renderScopeId !== currentLocation.renderScopeId &&
      nextLocation.renderScopeId !== modelLocation.renderScopeId &&
      aheadOf(next, modelRowSlot, direction),
    )
    if (modelRowSlot) {
      const reserved = reservedRowBetween(
        current, mountedBeforeModel ? next : modelRowSlot, direction,
        excludedSurfaces, {modelScope: modelLocation.renderScopeId, descend},
      )
      if (reserved) {
        void focusBlock(uiStateBlock, reserved.blockId, {renderScopeId: reserved.renderScopeId})
        return true
      }
    }

    if (!mountedBeforeModel && (!next || next !== modelRowSlot)) {
      if (!modelFallback) return false
      void focusBlock(uiStateBlock, modelLocation.blockId, {renderScopeId: modelLocation.renderScopeId})
      return true
    }
  } else if (surface) {
    // At the model boundary, another scope may reserve or mount the next row.
    const reserved = reservedRowBetween(current, next, direction, excludedSurfaces, {descend})
    if (reserved) {
      void focusBlock(uiStateBlock, reserved.blockId, {renderScopeId: reserved.renderScopeId})
      return true
    }
    if (nextLocation?.renderScopeId === currentLocation.renderScopeId) return false
  }

  // Nothing in the model and nothing in the DOM — a real edge.
  if (!next || !nextLocation || !nextPanelId) return true
  const destPanelId = nextPanelId
  const destLocation = nextLocation

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
  const excludedSurfaces = excludedSurfacesFor(uiStateBlock)
  const beside = lateralNeighbor(current, direction, excludedSurfaces)
  const besideLocation = beside ? locationOf(beside) : null
  if (besideLocation) {
    await focusBlock(uiStateBlock, besideLocation.blockId, {renderScopeId: besideLocation.renderScopeId})
    return true
  }
  // Scope the column walk to the ACTIVE layout session: with the
  // session host mounted, N warm sessions each carry their own
  // `[data-layout-column-id]` columns, so an unscoped document-wide query
  // could resolve the column AFTER the active session's last one as
  // belonging to a hidden session — landing moveHorizontal on a column
  // that isn't really adjacent and aborting the tx in
  // activatePanelRowInTx. Scoping to the active session's root restores
  // the correct null-at-the-edge result (see layoutSessionDom.ts).
  const destPanel = horizontalNeighborPanel(current, direction, activeLayoutSessionElement() ?? document)
  if (!destPanel) return false
  const destPanelId = destPanel.dataset.panelId
  if (!destPanelId) return false
  const destPanelBlock = uiStateBlock.repo.block(destPanelId)
  // Sticky-return: read the panel's stored focus, fall back to its
  // top-level (the panel's `topLevelBlockIdProp` aligned to its
  // outline root).
  const destLocation = peekFocusedBlockLocation(destPanelBlock)
    ?? findFirstInstanceLocation(destPanel, excludedSurfaces)
  if (!destLocation) return false
  await crossPanelFocus(uiStateBlock, destPanelId, destLocation)
  return true
}

const findFirstInstanceLocation = (
  panel: HTMLElement,
  excludedSurfaces: ReadonlySet<string>,
): FocusedBlockLocation | undefined => {
  const first = firstInstanceIn(panel, excludedSurfaces)
  return (first && locationOf(first)) ?? undefined
}

/** Focus a row in another panel and make that panel the active one, in one transaction. */
export const crossPanelFocus = async (
  sourcePanelBlock: Block,
  destPanelId: string,
  destLocation: FocusedBlockLocation,
): Promise<void> => {
  const repo = sourcePanelBlock.repo
  const destPanelBlock = repo.block(destPanelId)
  // Resolve the ACTIVE layout session from the DOM — with the session host
  // mounted, N warm sessions each carry data-layout-session-id, so a bare
  // first-match query could grab a hidden one; the helper prefers the
  // active marker and degrades to the old single-session match. Cheap;
  // runs once per cross-panel keystroke.
  const layoutSessionId = activeLayoutSessionElement()?.dataset.layoutSessionId
  // Single tx that flips both ends of the activation gate at once.
  // Same shape as `focusBlock` but validates and activates the destination
  // panel on the layout-session block first; row deps still resolve
  // identically (same kind:'row' invalidation per touched block).
  await repo.tx(async tx => {
    if (layoutSessionId) {
      const activated = await activatePanelRowInTx(tx, layoutSessionId, destPanelId)
      if (!activated) return
    }
    await tx.setProperty(destPanelBlock.id, focusedBlockLocationProp, destLocation)
    if (destPanelBlock.peekProperty(isEditingProp) === true) {
      await tx.setProperty(destPanelBlock.id, isEditingProp, false)
    }
  }, {scope: ChangeScope.UiState, description: 'spatial-navigation cross-panel focus'})
}

/**
 * Jump focus to the first / last navigable instance in the focused row's lane
 * of the panel (its own content, unless focus is in a lane beside it), in
 * visible DOM order. This is the `gg` / `Shift+G` counterpart to
 * `moveVertical`: since spatial nav steps `j`/`k` through the rendered
 * DOM (outline bullets *and* trailing surfaces like backlinks/embeds),
 * the edges must bound that same sequence — otherwise `Shift+G` would
 * stop at the last data-tree descendant and skip the backlinks the user
 * can still `j` into. Same return contract as `moveVertical`: `false`
 * means "no live panel DOM — fall through to vim's data-model handler"
 * (SSR/headless, or the panel hasn't mounted); `true` means handled.
 *
 * Known divergence from `moveVertical`: the sequence this bounds is the
 * MOUNTED one, so `Shift+G` lands on the last mounted row rather than the
 * last row of the page, while `j` now walks past it via the model. Left
 * as-is deliberately — declining here would hand the edges to a data-tree
 * walk that skips the trailing surfaces this exists to include, and picking
 * the right answer per surface needs its own change and tests.
 */
const jumpToPanelEdge = async (
  deps: BlockShortcutDependencies,
  edge: 'first' | 'last',
): Promise<boolean> => {
  const {uiStateBlock} = deps
  if (!uiStateBlock) return false
  if (typeof document === 'undefined') return false
  const panel = panelById(uiStateBlock.id)
  if (!panel) return false
  const current = currentInstance(deps)
  const lane = current ? laneOf(current) : OWN_CONTENT_LANE
  const target = laneEdgeInstance(panel, lane, edge, excludedSurfacesFor(uiStateBlock))
  if (!target) return false
  const location = locationOf(target)
  if (!location) return false
  await focusBlock(uiStateBlock, location.blockId, {renderScopeId: location.renderScopeId})
  return true
}

export function getSpatialNavigationActions(): ActionConfig<typeof ActionContextTypes.NORMAL_MODE>[] {
  const bindNormal = (action: BlockAction) =>
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, action)

  return [
    bindNormal({
      id: 'move_left',
      description: 'Move focus left (beside it in the panel, else the panel on the left)',
      handler: async (deps: BlockShortcutDependencies) => {
        await moveHorizontal(deps, 'left')
      },
      defaultBinding: {keys: ['ArrowLeft', 'h']},
    }),
    bindNormal({
      id: 'move_right',
      description: 'Move focus right (beside it in the panel, else the panel on the right)',
      handler: async (deps: BlockShortcutDependencies) => {
        await moveHorizontal(deps, 'right')
      },
      defaultBinding: {keys: ['ArrowRight', 'l']},
    }),
  ]
}

// The vertical-move actions get a label (description) from spatial nav — that's
// presentational METADATA, so it stays on the definition-transform seam. The
// movement BEHAVIOUR is the dispatch decorator below; the old combined
// `verticalDecorator` (which changed both at once) is split along that line.
const verticalDescriptionTransform = (
  actionId: 'move_down' | 'move_up',
  description: string,
): ActionTransform => ({
  actionId,
  context: ActionContextTypes.NORMAL_MODE,
  apply: action => ({...action, description}),
})

// Each wrap below does `await next(...)` rather than `return next(...)`: an
// async wrap can't propagate the inner sync `false` decline sentinel
// (`ActionHandlerResult` forbids `Promise<false>`), so awaiting discards it and
// the wrap resolves to `Promise<void>` — exactly what the old transform's
// `await action.handler(...)` did, so the candidate still counts as handled.
const verticalDispatchDecorator = (
  actionId: 'move_down' | 'move_up',
  direction: 'down' | 'up',
): ActionDispatchDecorator => ({
  actionId,
  context: ActionContextTypes.NORMAL_MODE,
  wrap: async (deps, trigger, next, dispatch) => {
    if (await moveVertical(deps as BlockShortcutDependencies, direction)) return
    await next(deps, trigger, dispatch)
  },
})

const jumpEdgeDispatchDecorator = (
  actionId: 'jump_to_first_visible_block' | 'jump_to_last_visible_block',
  edge: 'first' | 'last',
): ActionDispatchDecorator => ({
  actionId,
  context: ActionContextTypes.NORMAL_MODE,
  wrap: async (deps, trigger, next, dispatch) => {
    if (await jumpToPanelEdge(deps as BlockShortcutDependencies, edge)) return
    await next(deps, trigger, dispatch)
  },
})

const selectionVerticalDispatchDecorator = (
  actionId: 'extend_selection_down' | 'extend_selection_up' | 'multi_select.extend_selection_down' | 'multi_select.extend_selection_up',
  context: typeof ActionContextTypes.NORMAL_MODE | typeof ActionContextTypes.MULTI_SELECT_MODE,
  direction: 'down' | 'up',
): ActionDispatchDecorator => ({
  actionId,
  context,
  wrap: async (deps, trigger, next, dispatch) => {
    if (await extendSelectionVertical(deps, direction)) return
    await next(deps, trigger, dispatch)
  },
})

/**
 * Shift-click selection in visible DOM order — a DISPATCH decorator on the
 * structural `extend_block_selection` action, the mouse-side counterpart of
 * `selectionVerticalDispatchDecorator`: anchor → clicked block range across
 * whatever is on screen (backlinks, embeds), not the data tree. Declines back to
 * the structural base (via `next`) when no spatial range resolves (e.g. the
 * clicked instance isn't in this panel / isn't a navigable item).
 *
 * `deps.targetElement` is the block shell the block-pointer dispatch captured —
 * the same element the spatial shell decorator tags with `data-block-nav-item`,
 * so the walker can locate it. Upstream gating (selection-gesture + exact
 * shift-only pointer binding) means this only ever sees a plain shift-click, so
 * it no longer re-checks modifiers or interactive content.
 */
export const spatialSelectionClickDecorator: ActionDispatchDecorator = {
  actionId: EXTEND_BLOCK_SELECTION_ACTION_ID,
  context: ActionContextTypes.BLOCK_POINTER,
  wrap: async (deps, trigger, next, dispatch) => {
    const {uiStateBlock, targetElement, rangeOrigin} = deps as BlockPointerDependencies
    // Only the clicked block's own panel can resolve a spatial range; for a
    // mismatched panel defer to the structural base rather than swallow it.
    // `extendSelectionToSpatialTarget` reports a mismatch as "handled" for
    // the keyboard contract, so gate on the panel match here.
    if (panelOf(targetElement)?.dataset.panelId === uiStateBlock.id) {
      if (await extendSelectionToSpatialTarget({uiStateBlock}, targetElement, rangeOrigin)) return
    }
    await next(deps, trigger, dispatch)
  },
}

/** Presentational labels for the vertical-move actions — stays on the
 *  definition-transform seam (binding/metadata shaping). */
export function getSpatialNavigationActionTransforms(): ActionTransform[] {
  return [
    verticalDescriptionTransform('move_down', 'Move focus down (next block, then stack-sibling panel below)'),
    verticalDescriptionTransform('move_up', 'Move focus up (previous block, then stack-sibling panel above)'),
  ]
}

/** Behaviour wraps (move-then-fall-through, jump-to-edge, selection-extend,
 *  shift-click range) on the action-dispatch seam — migrated off
 *  `actionTransformsFacet`. */
export function getSpatialNavigationDispatchDecorators(): ActionDispatchDecorator[] {
  return [
    verticalDispatchDecorator('move_down', 'down'),
    verticalDispatchDecorator('move_up', 'up'),
    jumpEdgeDispatchDecorator('jump_to_first_visible_block', 'first'),
    jumpEdgeDispatchDecorator('jump_to_last_visible_block', 'last'),
    selectionVerticalDispatchDecorator('extend_selection_down', ActionContextTypes.NORMAL_MODE, 'down'),
    selectionVerticalDispatchDecorator('extend_selection_up', ActionContextTypes.NORMAL_MODE, 'up'),
    selectionVerticalDispatchDecorator('multi_select.extend_selection_down', ActionContextTypes.MULTI_SELECT_MODE, 'down'),
    selectionVerticalDispatchDecorator('multi_select.extend_selection_up', ActionContextTypes.MULTI_SELECT_MODE, 'up'),
    spatialSelectionClickDecorator,
  ]
}

export const spatialNavigationActionsExtension: AppExtension =
  getSpatialNavigationActions().map(action =>
    actionsFacet.of(action as ActionConfig, {source: 'spatial-navigation'}),
  )

export const spatialNavigationActionDecoratorsExtension: AppExtension = [
  ...getSpatialNavigationActionTransforms().map(transform =>
    actionTransformsFacet.of(transform, {source: 'spatial-navigation'}),
  ),
  ...getSpatialNavigationDispatchDecorators().map(decorator =>
    actionDispatchWrap(decorator, {source: 'spatial-navigation'}),
  ),
]

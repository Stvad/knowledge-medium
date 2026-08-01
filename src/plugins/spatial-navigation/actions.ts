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
import type { Block } from '@/data/block'
import {
  blockIdsInOrderedSelectionRange,
  commitSelectionRange,
  findBestSelectionAnchorIndex,
  nextVisibleBlock,
  previousVisibleBlock,
} from '@/utils/selection.js'
import {
  aheadOf,
  horizontalNeighborPanel,
  locationOf,
  panelById,
  panelOf,
  panelInstances,
  reservedRowBetween,
  resolveCurrentAnchor,
  rowSlotIn,
  verticalNeighbor,
} from './walker.ts'
import { resolveSpatialNavExclusions } from './exclusionsFacet.ts'
import { activatePanelRowInTx } from '@/utils/panelLayoutProjection'

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

  const instances = panelInstances(panel, excludedSurfacesFor(uiStateBlock))
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
  const hasSelection = (uiStateBlock.peekProperty(selectionStateProp)?.selectedBlockIds.length ?? 0) > 0
  if (!hasSelection) {
    await extendSelectionToSpatialTarget(deps, current)
    return true
  }

  const next = verticalNeighbor(current, direction, excludedSurfaces)
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

/**
 * Move spatial focus within a panel. Mirrors vim's `move_down` /
 * `move_up` behavior exactly: write the new focused block id to the
 * panel block via `focusBlock`. No DOM-focus call, no scroll — the
 * kernel `BlockFocusShellDecorator` already drives both
 * (highlight class via `useInFocus`, scroll via its own effect)
 * off the same prop. Adding our own DOM mutations would just race.
 *
 * Return contract (intentionally different from "did we move?"):
 *   - `false` → "spatial nav declines; the model walk is the better
 *     answer here". Two cases: (a) no usable anchor — no live focused
 *     instance, no recovery anchor, and no expected location to keep
 *     us in this panel; (b) taking the rendered neighbour would SKIP
 *     the model's next row in this scope — the neighbour sits past
 *     that row's place in the document, or the DOM has no place for
 *     it yet to compare against.
 *   - `true` → "spatial nav handled this keystroke", including the
 *     genuine edge where neither the model nor the DOM has anywhere
 *     left to go.
 *
 * Which SURFACE the row sits on doesn't enter into it. What matters is
 * the scope, and every surface supplies its own `scopeRootId` (a
 * backlink entry's is its shown block, not the page), so the model
 * walk is always scope-local and cannot wander into another page.
 * Rows inside a backlink entry are lazily mounted under the ordinary
 * `block:<id>` key like any other row, so a model-resolved target
 * there is mountable too.
 *
 * Equally: the model walk names only the rows of ONE scope, while the
 * rendered order interleaves the nested surfaces those rows contain —
 * an embed inside the content, an embed inside a property value, a
 * trailing backlink list. Those rows are navigable and the user can
 * see them, so a DOM neighbour that the model can't name is the normal
 * case, not evidence of a missing row. See the rule at the check.
 *
 * The one thing this cannot reach is a scope whose WRAPPER is still
 * deferred: an unmounted backlink entry keys itself
 * `backlink:<scope>:<id>`, invisible to both the walker and
 * `lazyBlockCacheKey`. Reserved rows don't rescue it either — such a
 * wrapper mints its scope inside itself, so it reserves an ANONYMOUS
 * slot, which `reservedRowBetween` skips by design. Moving between entries is a scope transition,
 * which no model walk expresses either — it needs the list that owns
 * that ordering to say what comes next. Unsolved here, and it was
 * never solved by treating non-outline surfaces as a special case.
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

  // The model knows rows the DOM doesn't, because rows mount lazily. "The next
  // MOUNTED row" and "the next row" diverge in several ways — running out at
  // the bottom of the mounted window, a scrollbar drag leaving two mounted
  // islands with a hole between them, a just-mounted row whose children arrive
  // only when its `childIds` handle resolves while a later sibling is still
  // mounted from before. In all of them the DOM's neighbour is a real row, just
  // hundreds of rows past what the user expects.
  //
  // But the DOM order is a SUPERSET of this scope's model order, not a
  // different ordering of the same rows: nested surfaces (an embed in the
  // content, an embed in a property value, a trailing backlink list) render
  // rows of their OWN scope in between, and no walk of this scope can name
  // them. So "the DOM's neighbour isn't the model's next row" doesn't mean the
  // DOM is wrong — it usually means the DOM has MORE.
  //
  // What actually matters is only this: can we take the DOM's neighbour without
  // SKIPPING the model's next row? That is a question about POSITION, and the
  // DOM answers it even for a row that hasn't mounted — see the check below.
  //
  // Costs one O(depth) walk per keystroke over handle-cached rows — the same
  // walk the model handler does on its own when spatial nav is off.
  const modelNext = deps.scopeRootId
    ? (direction === 'down'
        ? await nextVisibleBlock(block, deps.scopeRootId, deps.scopeRootForcesOpen)
        : await previousVisibleBlock(block, deps.scopeRootId))
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
  const next = verticalNeighbor(current, direction, excludedSurfaces)
  const nextLocation = next ? locationOf(next) : null
  const nextPanelId = next ? panelOf(next)?.dataset.panelId : undefined

  if (modelNext) {
    // Where the model's row sits in the rendered panel — its own nav item if
    // mounted, else the placeholder holding its place (`rowSlotIn`). Asking for
    // the POSITION rather than "is it mounted" is what makes one test cover
    // every surface: a nested surface's rows, a trailing footer list, and a
    // hole left by lazy mounting differ only in where they fall relative to it.
    const modelRowSlot = rowSlotIn(
      uiStateBlock.id,
      {blockId: modelNext.id, renderScopeId: currentLocation.renderScopeId},
      excludedSurfaces,
    )

    // Within this scope, document order IS model order, so the only same-scope
    // row that can come next is the model's own. Anything else is DOM the model
    // has already moved past and React hasn't caught up with — a collapsed
    // row's descendants, a deleted or reordered row's node — and every one of
    // those reads as "on the near side" of whatever follows.
    const takesTheModelRow = next !== null && next === modelRowSlot

    // The relaxation is for nested surfaces and reaches no further. Their rows
    // belong to their OWN scope, so no walk of this one can name them, and
    // position is the only thing left to judge them by: fine as long as taking
    // one can't skip the model's row — at, or on the near side of, its slot. On
    // the far side the rows between are missing from the DOM, so we decline and
    // let the model handler resolve the row and `FocusedRowLazyMount` mount it.
    //
    // No slot at all means the DOM can't answer — the row's parent hasn't
    // rendered its children yet — which is also a decline.
    const stepsIntoANestedSurface = Boolean(
      next && modelRowSlot &&
      nextLocation?.renderScopeId !== currentLocation.renderScopeId &&
      aheadOf(next, modelRowSlot, direction),
    )

    const canTakeTheNeighbour = Boolean(
      nextLocation &&
      // Defence in depth, not load-bearing: no test can falsify it, because the
      // slot is looked up INSIDE this panel and a stack sibling's rows sit
      // wholly before or after it — so the position test above already declines
      // every cross-panel step the model still has rows ahead of.
      nextPanelId === uiStateBlock.id &&
      (takesTheModelRow || stepsIntoANestedSurface),
    )
    if (!canTakeTheNeighbour) return false
  }

  // Scope edge: this scope's model has nothing more, so the rendered order
  // decides — and a row with a place RESERVED is part of that order. Without
  // this, stepping out of an embed whose owner's next rows are still deferred
  // jumps to whatever happens to be mounted, which is the same skip one level
  // out. Focusing the reserved row instead mounts it (`FocusedRowLazyMount`),
  // where declining could not: the model handler is bounded by the same
  // exhausted scope and would swallow the keystroke.
  //
  // What the rendered order does NOT get to decide is a row of THIS scope. A
  // same-scope row is checked against the model wherever it turns up, and here
  // there is no model row for one to be — so a same-scope neighbour at an edge
  // is stale DOM by definition: a deleted sibling's node, a collapsed parent's
  // surviving child. Only another scope's rows are genuinely unnameable by this
  // walk, so only they can be taken on an edge. (`reservedRowBetween` applies
  // the same rule to slots.)
  if (deps.scopeRootId && !modelNext) {
    const reserved = reservedRowBetween(current, next, direction, excludedSurfaces)
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
  const destPanel = horizontalNeighborPanel(current, direction)
  if (!destPanel) return false
  const destPanelId = destPanel.dataset.panelId
  if (!destPanelId) return false
  const destPanelBlock = uiStateBlock.repo.block(destPanelId)
  // Sticky-return: read the panel's stored focus, fall back to its
  // top-level (the panel's `topLevelBlockIdProp` aligned to its
  // outline root).
  const destLocation = peekFocusedBlockLocation(destPanelBlock)
    ?? findFirstInstanceLocation(destPanel, excludedSurfacesFor(uiStateBlock))
  if (!destLocation) return false
  await crossPanelFocus(uiStateBlock, destPanelId, destLocation)
  return true
}

const findFirstInstanceLocation = (
  panel: HTMLElement,
  excludedSurfaces: ReadonlySet<string>,
): FocusedBlockLocation | undefined => {
  for (const instance of panelInstances(panel, excludedSurfaces)) {
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
 * Jump focus to the first / last navigable instance in the panel, in
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
  const instances = panelInstances(panel, excludedSurfacesFor(uiStateBlock))
  if (instances.length === 0) return false
  const target = edge === 'first' ? instances[0] : instances[instances.length - 1]
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
    const {uiStateBlock, targetElement} = deps as BlockPointerDependencies
    // Only the clicked block's own panel can resolve a spatial range; for a
    // mismatched panel defer to the structural base rather than swallow it.
    // `extendSelectionToSpatialTarget` reports a mismatch as "handled" for
    // the keyboard contract, so gate on the panel match here.
    if (panelOf(targetElement)?.dataset.panelId === uiStateBlock.id) {
      if (await extendSelectionToSpatialTarget({uiStateBlock}, targetElement)) return
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

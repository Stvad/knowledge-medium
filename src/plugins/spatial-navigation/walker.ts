import { isElementProperlyVisible } from '@/utils/dom.js'
import {
  type FocusedBlockLocation,
  sameFocusedBlockLocation,
} from '@/data/properties.js'

/**
 * Spatial-navigation walker — pure DOM queries, no in-memory registry.
 *
 * The DOM is the source of truth. At keypress time we query the relevant
 * subtree for tagged nav items and walk in document order. This avoids
 * registry-churn, re-render invisibility, and stale-ref problems.
 *
 * Tagging contract (set by the shell decorator + layout renderer):
 *
 *   Layout column wrapper: `data-layout-column-id="..."`
 *   Panel wrapper:         `data-panel-id="..."`
 *   Block shell:           `data-block-nav-item="true"`
 *                          `data-block-id="<block.id>"`
 *                          `data-render-scope-id="<render scope>"`
 *                          `data-block-surface="outline|backlink|breadcrumb|embedded"`
 *   Block content target:  `data-block-focus-target="true"`
 *
 * Direction model:
 *
 *   `up`/`down`: walk block instances within the current panel in
 *     DOM order; on exhaustion, fall through to the panel that is the
 *     direct stack-sibling above/below in the same layout column.
 *   `left`/`right`: walk top-level layout columns; never moves
 *     within a panel.
 *
 * Recovery: two entry points share the same neighbor map.
 *   `locateInstance` (keystroke-time) keeps its tier 1+2 identity-match
 *   semantics, with a positional clamp as a last-resort tier.
 *   `findRecoveryAnchor` (proactive disappear-handler) is richer: it
 *   walks the stored sibling links first ("block previously below",
 *   else "block previously above"), then the ancestor chain (so a
 *   collapsed parent becomes the natural recovery target when every
 *   child of the focused block's parent unmounts together), then
 *   positional clamp as a final fallback. Recovery is surface-local
 *   and only returns candidates whose focus target is on screen; a
 *   stale hint for some unrelated previous focus is ignored, so panels
 *   the user has never sat in won't get a misfired recovery jump.
 */

const NAV_ITEM_SELECTOR = '[data-block-nav-item="true"]'
const PANEL_SELECTOR = '[data-panel-id]'
const COLUMN_SELECTOR = '[data-layout-column-id]'
const FOCUS_TARGET_SELECTOR = '[data-block-focus-target="true"]'

const NON_NAVIGABLE_SURFACES = new Set(['breadcrumb'])

/**
 * Session-only per-panel hint about the focused block's neighborhood.
 * Stored on every confirmed sighting (`rememberInstancePosition`):
 *
 *   - focused location + whole-panel and same-surface indexes for the
 *     positional fallback + the stale-hint location-match guard
 *   - `prevLocation` / `nextLocation` for the sibling-walk recovery
 *     ("block previously below/above")
 *   - `ancestorLocations` (closest first) for the collapse-detection
 *     recovery — when both sibling links no longer resolve, the
 *     focused block's ancestors are the only nearby reference frame
 *     still standing, and the closest surviving one is the natural
 *     place to put focus
 *
 * Module-level, never persisted: the DOM order that gave any of
 * these meaning is gone after a reload, so persisting would mislead.
 */
interface PanelPositionHint {
  location: FocusedBlockLocation
  index: number
  surfaceIndex: number
  surface: string | undefined
  prevLocation: FocusedBlockLocation | undefined
  nextLocation: FocusedBlockLocation | undefined
  ancestorLocations: readonly FocusedBlockLocation[]
}

const surfaceOf = (el: HTMLElement): string | undefined =>
  el.dataset.blockSurface

const focusTargetFor = (el: HTMLElement): HTMLElement =>
  el.querySelector<HTMLElement>(FOCUS_TARGET_SELECTOR) ?? el

const isRecoveryTargetVisible = (el: HTMLElement): boolean =>
  isElementProperlyVisible(focusTargetFor(el))

const pickViewportFallback = (
  instances: readonly HTMLElement[],
  positionalChoice: HTMLElement | null,
): HTMLElement | null => {
  if (positionalChoice && isRecoveryTargetVisible(positionalChoice)) return positionalChoice
  return instances.find(isRecoveryTargetVisible) ?? null
}

const sameSurfaceInstances = (
  instances: readonly HTMLElement[],
  surface: string | undefined,
): HTMLElement[] => {
  return instances.filter(el => surfaceOf(el) === surface)
}

const lastPositionByPanel = new Map<string, PanelPositionHint>()

export const locationOf = (el: HTMLElement): FocusedBlockLocation | null => {
  const {blockId, renderScopeId} = el.dataset
  return blockId && renderScopeId ? {blockId, renderScopeId} : null
}

const isNavigable = (el: HTMLElement): boolean => {
  const surface = surfaceOf(el)
  if (surface && NON_NAVIGABLE_SURFACES.has(surface)) return false
  return true
}

export const panelInstances = (panel: HTMLElement): HTMLElement[] => {
  const all = Array.from(panel.querySelectorAll<HTMLElement>(NAV_ITEM_SELECTOR))
  // Filter to instances actually inside this panel (not inside a nested
  // panel that might appear in the DOM tree — defensive; layout doesn't
  // currently nest panels, but the selector match alone wouldn't catch
  // it).
  return all.filter(el => {
    if (!isNavigable(el)) return false
    if (!locationOf(el)) return false
    const ownPanel = el.closest<HTMLElement>(PANEL_SELECTOR)
    return ownPanel === panel
  })
}

export const panelOf = (el: HTMLElement): HTMLElement | null =>
  el.closest<HTMLElement>(PANEL_SELECTOR)

export const panelById = (
  panelId: string,
  root: ParentNode = document,
): HTMLElement | null => root.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(panelId)}"]`)

export const columnOf = (el: HTMLElement): HTMLElement | null =>
  el.closest<HTMLElement>(COLUMN_SELECTOR)

const orderedColumns = (root: ParentNode = document): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(COLUMN_SELECTOR))

const panelsInColumn = (column: HTMLElement): HTMLElement[] =>
  Array.from(column.querySelectorAll<HTMLElement>(PANEL_SELECTOR))

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n))

/**
 * Walk up from `instanceEl` to find the closest block nav item
 * ancestor inside `panel`. Returns null when `instanceEl` is a
 * top-level instance in the panel (no block nav item ancestor above it).
 *
 * Used by the sibling-lookup logic: two instances are "same-depth
 * siblings" iff they share a `closestBlockAncestor`. That matches the
 * data-tree structure (both are children of the same data-block) even
 * across renderer-specific DOM wrappers (block-body divs, lazy mounts,
 * backlink entry containers) because we only check for the nearest
 * shell, ignoring any wrapper chrome in between.
 */
const closestBlockAncestor = (
  instanceEl: HTMLElement,
  panel: HTMLElement,
): HTMLElement | null => {
  let el: HTMLElement | null = instanceEl.parentElement
  while (el && el !== panel) {
    if (el.dataset.blockNavItem === 'true' && el.dataset.blockId) return el
    el = el.parentElement
  }
  return null
}

const collectAncestorLocations = (
  instanceEl: HTMLElement,
  panel: HTMLElement,
): FocusedBlockLocation[] => {
  const ancestors: FocusedBlockLocation[] = []
  let el = closestBlockAncestor(instanceEl, panel)
  while (el) {
    const location = locationOf(el)
    if (location) ancestors.push(location)
    el = closestBlockAncestor(el, panel)
  }
  return ancestors
}

/**
 * Find the previous or next data-tree-sibling of `instanceEl` inside
 * `panel` — i.e. the nearest panel-instance in DOM order that shares
 * the same closest block nav item ancestor.
 *
 * This is what makes recovery match the user's mental model in the
 * tricky cases:
 *
 *   - Deleting `parent` from `[above, parent>[child, c2], below]`
 *     puts focus on `below` (parent's same-depth next) rather than
 *     stumbling onto `child` (DOM-flat next, which also disappeared).
 *   - Collapsing a parent whose focused child is the only child
 *     gives same-depth-prev/next = undefined, so the ancestor walk
 *     wins and we land on the parent — same outcome as the multi-
 *     child collapse case.
 */
const findSameDepthSibling = (
  instanceEl: HTMLElement,
  instances: readonly HTMLElement[],
  panel: HTMLElement,
  direction: 'prev' | 'next',
): FocusedBlockLocation | undefined => {
  const idx = instances.indexOf(instanceEl)
  if (idx < 0) return undefined
  const own = closestBlockAncestor(instanceEl, panel)
  if (direction === 'prev') {
    for (let i = idx - 1; i >= 0; i--) {
      if (closestBlockAncestor(instances[i], panel) === own) {
        return locationOf(instances[i]) ?? undefined
      }
    }
  } else {
    for (let i = idx + 1; i < instances.length; i++) {
      if (closestBlockAncestor(instances[i], panel) === own) {
        return locationOf(instances[i]) ?? undefined
      }
    }
  }
  return undefined
}

/**
 * Record the focused instance's neighborhood (siblings + ancestors +
 * positional index) inside its panel. Called whenever spatial
 * navigation (or the proactive focus-recovery watcher) confirms that
 * the focused block has a live DOM instance. The hint is consumed by
 * `findRecoveryAnchor` (and `locateInstance`'s positional tier) when
 * that block later disappears.
 */
export const rememberInstancePosition = (
  panelId: string,
  instanceEl: HTMLElement,
): void => {
  const panel = panelById(panelId)
  if (!panel) return
  const instances = panelInstances(panel)
  const idx = instances.indexOf(instanceEl)
  if (idx < 0) return
  const location = locationOf(instanceEl)
  if (!location) return
  const surface = surfaceOf(instanceEl)
  const surfacePeers = sameSurfaceInstances(instances, surface)
  lastPositionByPanel.set(panelId, {
    location,
    index: idx,
    surfaceIndex: surfacePeers.indexOf(instanceEl),
    surface,
    prevLocation: findSameDepthSibling(instanceEl, instances, panel, 'prev'),
    nextLocation: findSameDepthSibling(instanceEl, instances, panel, 'next'),
    ancestorLocations: collectAncestorLocations(instanceEl, panel),
  })
}

/**
 * Resolve a recovery target for `forLocation` when its instance is no
 * longer in the panel DOM. Walks the stored neighbor map in this order:
 *
 *   1. The block that was immediately AFTER it ("block previously
 *      below") — the natural baseline when one entry is removed from
 *      a list and the remaining list shifts up: the user lands on
 *      what visually replaced their previous position.
 *   2. The block that was immediately BEFORE it. Engaged when the
 *      next sibling is also gone (focused block was last in the list,
 *      or the next sibling unmounted alongside).
 *   3. The closest ancestor that's still rendered. Handles collapse:
 *      when a parent collapses, every descendant unmounts together
 *      so neither sibling survives — but the parent itself does, and
 *      it's the natural place to land. Walks closest-first so the
 *      lowest surviving container wins. This tier is surface-local:
 *      backlink DOM ancestry is layout containment, not data-tree
 *      ancestry, so backlink recovery never climbs to the enclosing
 *      outline block.
 *   4. Same-surface positional clamp (last resort) — safety net for
 *      hints with no recoverable neighbors and no surviving same-surface
 *      ancestor.
 *
 * Every tier is viewport-aware. The `BlockFocusShellDecorator` reacts
 * to a recovery write by calling `scrollIntoView` on the block content
 * target when it is off-screen; recovery must therefore only return
 * candidates whose focus target is already on screen.
 *
 * Returns null when there's no stored hint about this rendered location, or when
 * the panel has no instances at all. The caller (proactive recovery)
 * MUST be gated on a non-null return: an absent hint usually means
 * the focused block has never been visible in this panel (initial
 * mount during async hydration) — quietly leaving the panel alone is
 * the right move there.
 */
export const findRecoveryAnchor = (
  panelId: string,
  forLocation: FocusedBlockLocation,
): HTMLElement | null => {
  const panel = panelById(panelId)
  if (!panel) return null
  const instances = panelInstances(panel)
  if (instances.length === 0) return null

  const hint = lastPositionByPanel.get(panelId)
  if (!hint || !sameFocusedBlockLocation(hint.location, forLocation)) return null
  const candidates = sameSurfaceInstances(instances, hint.surface)
  if (candidates.length === 0) return null

  const findByLocation = (location: FocusedBlockLocation | undefined): HTMLElement | undefined =>
    location
      ? candidates.find(el => sameFocusedBlockLocation(locationOf(el) ?? undefined, location))
      : undefined

  const visibleByLocation = (location: FocusedBlockLocation | undefined): HTMLElement | undefined => {
    const candidate = findByLocation(location)
    return candidate && isRecoveryTargetVisible(candidate) ? candidate : undefined
  }

  const next = visibleByLocation(hint.nextLocation)
  if (next) return next

  const prev = visibleByLocation(hint.prevLocation)
  if (prev) return prev

  for (const ancestorLocation of hint.ancestorLocations) {
    const ancestor = visibleByLocation(ancestorLocation)
    if (ancestor) return ancestor
  }

  const positionalIndex = hint.surfaceIndex >= 0 ? hint.surfaceIndex : hint.index
  const positionalChoice = candidates[clamp(positionalIndex, 0, candidates.length - 1)] ?? null
  return pickViewportFallback(candidates, positionalChoice)
}

/**
 * Anchor lookup used by spatial-nav keystroke handlers. Returns the
 * live DOM instance for `focusedLocation` when it's still mounted in
 * the panel; otherwise falls back to `findRecoveryAnchor` so vertical
 * movement can walk from a sensible position even while the proactive recovery
 * timer is still in its debounce window. Without this fallback, a
 * keystroke during the window leaks through to vim's data-model
 * walker, which can land on a block from another panel entirely
 * (see the comment on `moveVertical`'s false-return contract).
 */
export const resolveCurrentAnchor = (
  panelId: string,
  focusedLocation: FocusedBlockLocation | undefined,
): HTMLElement | null => {
  if (!focusedLocation) return null
  const panel = panelById(panelId)
  if (!panel) return null
  const instances = panelInstances(panel)
  if (instances.length === 0) return null
  const live = instances.find(el => sameFocusedBlockLocation(locationOf(el) ?? undefined, focusedLocation))
  if (live) return live
  return findRecoveryAnchor(panelId, focusedLocation)
}

/**
 * Resolve which instance inside `panelId` should hold focus, given the
 * persisted hints from the panel block. Falls back through tiers:
 *
 *   1. exact match on focused location (`data-block-id` + `data-render-scope-id`)
 *   2. positional clamp into the current list — pulls "the block that
 *      now occupies the index where the focused one used to sit", i.e.
 *      "block previously below" once the list shifts up to fill the
 *      gap. Only fires when the stored hint is actually about the same
 *      focused location; a stale hint for some unrelated previously-
 *      focused location is ignored.
 *   3. first instance in the panel (last-resort default).
 *
 * For the proactive disappear-handler, prefer `findRecoveryAnchor` —
 * it shares the same neighbor map but adds sibling- and ancestor-
 * aware recovery, which gives a much better answer when a collapse
 * unmounts a whole subtree at once.
 */
export const locateInstance = (
  panelId: string,
  hints: {
    focusedLocation?: FocusedBlockLocation
  },
  root: ParentNode = document,
): HTMLElement | null => {
  const panel = panelById(panelId, root)
  if (!panel) return null
  const instances = panelInstances(panel)
  if (instances.length === 0) return null

  if (hints.focusedLocation) {
    const exact = instances.find(el => sameFocusedBlockLocation(locationOf(el) ?? undefined, hints.focusedLocation))
    if (exact) return exact
  }

  const stored = lastPositionByPanel.get(panelId)
  if (stored && (!hints.focusedLocation || sameFocusedBlockLocation(stored.location, hints.focusedLocation))) {
    return instances[clamp(stored.index, 0, instances.length - 1)] ?? null
  }

  return instances[0] ?? null
}

export const firstInstanceIn = (panel: HTMLElement): HTMLElement | null =>
  panelInstances(panel)[0] ?? null

export const lastInstanceIn = (panel: HTMLElement): HTMLElement | null => {
  const all = panelInstances(panel)
  return all.length > 0 ? all[all.length - 1] : null
}

/**
 * Within-panel + stack-sibling fall-through for h/k.
 *
 * 1. If there's a next/prev instance in the same panel in DOM order,
 *    return it.
 * 2. Else, if the panel sits inside a column that stacks multiple
 *    panels, fall through to the first/last instance of the
 *    immediately adjacent stack-sibling panel.
 * 3. Else, null (never crosses columns horizontally for h/k).
 */
export const verticalNeighbor = (
  current: HTMLElement,
  direction: 'up' | 'down',
): HTMLElement | null => {
  const panel = panelOf(current)
  if (!panel) return null
  const instances = panelInstances(panel)
  const idx = instances.indexOf(current)
  if (idx === -1) return null

  if (direction === 'down') {
    if (idx + 1 < instances.length) return instances[idx + 1]
  } else {
    if (idx - 1 >= 0) return instances[idx - 1]
  }

  // Exhausted in-panel — try stack-sibling.
  const sibling = stackSiblingPanel(panel, direction)
  if (!sibling) return null
  return direction === 'down' ? firstInstanceIn(sibling) : lastInstanceIn(sibling)
}

/**
 * Returns the panel one stack-step above/below `panel` in the *same*
 * layout column. Null when the column hosts only `panel` (single-panel
 * column) or `panel` sits at the column boundary.
 */
export const stackSiblingPanel = (
  panel: HTMLElement,
  direction: 'up' | 'down',
): HTMLElement | null => {
  const column = columnOf(panel)
  if (!column) return null
  const panels = panelsInColumn(column)
  if (panels.length <= 1) return null
  const idx = panels.indexOf(panel)
  if (idx === -1) return null
  const target = direction === 'down' ? idx + 1 : idx - 1
  return panels[target] ?? null
}

/**
 * Column-walker for j/l. Returns the *panel* to focus in the previous
 * or next layout column. For stacked columns it returns the column's
 * first panel; the caller can then apply sticky-return logic to pick
 * a different stack member (e.g. the last one the user focused in
 * that column).
 */
export const horizontalNeighborPanel = (
  current: HTMLElement,
  direction: 'left' | 'right',
  root: ParentNode = document,
): HTMLElement | null => {
  const column = columnOf(current)
  if (!column) return null
  const columns = orderedColumns(root)
  const idx = columns.indexOf(column)
  if (idx === -1) return null
  const target = direction === 'right' ? idx + 1 : idx - 1
  const nextColumn = columns[target]
  if (!nextColumn) return null
  return panelsInColumn(nextColumn)[0] ?? null
}

/** Test-only: drop the positional-index hints. */
export const __resetSpatialNavigationForTesting = (): void => {
  lastPositionByPanel.clear()
}

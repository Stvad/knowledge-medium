import { clamp } from 'lodash-es'
import { getElementScrollportBounds, isElementProperlyVisible } from '@/utils/dom.js'
import { BLOCK_CONTENT_VIEW_ATTRIBUTE } from '@/extensions/blockInteraction.js'
import {
  PANEL_LANE_ANCHOR_BLOCK_ATTRIBUTE,
  PANEL_LANE_ANCHOR_SCOPE_ATTRIBUTE,
  PANEL_LANE_ATTRIBUTE,
} from '@/utils/panelLanes.js'
import {
  type FocusedBlockLocation,
  sameFocusedBlockLocation,
} from '@/data/properties.js'
import type { SelectionRangeRow } from '@/utils/selection.js'

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
 *   Block visibility target: `data-block-visibility-target="true"`
 *   Lane beside the panel's content: `data-panel-lane="<name>"`
 *                          (`PANEL_LANE_ATTRIBUTE`, on a panel mount's root)
 *   In a lane, beside a content row: `data-lane-anchor-block-id`,
 *                          `data-lane-anchor-render-scope-id`
 *   Deferred row's slot:   `data-lazy-block-id="<block.id>"` (set by
 *                          `LazyViewportMount` while it shows a placeholder —
 *                          the row's reserved place in document order)
 *                          `data-lazy-render-scope-id="<render scope>"` — the
 *                          scope the row WILL have. Its absence is meaningful:
 *                          a wrapper that mints its own scope inside itself
 *                          can't name it out here, and an unnamed slot is
 *                          ignored rather than attributed to its neighbours.
 *
 * Excluded surfaces: which `data-block-surface` values the walker skips
 * (core excludes `breadcrumb` only — see `DEFAULT_NON_NAVIGABLE_SURFACES`
 * and `exclusionsFacet.ts`). The walker itself stays facet-agnostic (pure
 * DOM + a plain `ReadonlySet<string>` parameter, matching `root: ParentNode
 * = document` below) — callers resolve the live set once per entry and
 * thread it down, rather than the walker reaching into module/global state.
 *
 * Direction model:
 *
 *   `up`/`down`: walk block instances within the current panel's lane in
 *     DOM order; on exhaustion, fall through to the panel that is the
 *     direct stack-sibling above/below in the same layout column, at its
 *     own content.
 *   `left`/`right`: move to a row in another lane of the panel: the one
 *     paired with this one (a card and the row it stands beside), else the
 *     one level with it; failing that, walk top-level layout columns.
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
 *   and only returns candidates whose visibility target is on screen; a
 *   stale hint for some unrelated previous focus is ignored, so panels
 *   the user has never sat in won't get a misfired recovery jump.
 */

const NAV_ITEM_SELECTOR = '[data-block-nav-item="true"]'
const PANEL_SELECTOR = '[data-panel-id]'
const LANE_SELECTOR = `[${PANEL_LANE_ATTRIBUTE}]`
const LANE_ANCHOR_SELECTOR = `[${PANEL_LANE_ANCHOR_BLOCK_ATTRIBUTE}][${PANEL_LANE_ANCHOR_SCOPE_ATTRIBUTE}]`
const COLUMN_SELECTOR = '[data-layout-column-id]'
const VISIBILITY_TARGET_SELECTOR = '[data-block-visibility-target="true"]'
/** A deferred row's slot, and one that also names the occurrence it holds a
 *  place for. */
const SLOT_SELECTOR = '[data-lazy-block-id]'
const LABELLED_SLOT_SELECTOR = '[data-lazy-block-id][data-lazy-render-scope-id]'

/** Default exclusion set used whenever a caller doesn't thread a resolved
 *  one through (e.g. a direct unit-test call, or the early-boot path with
 *  no facet runtime yet) — preserves the pre-facet behavior exactly.
 *  `exclusionsFacet.ts`'s core contribution seeds the live facet with the
 *  same single value, so normal app usage (which always resolves and
 *  threads a facet-backed set) sees identical output with zero extra
 *  contributions. */
export const DEFAULT_NON_NAVIGABLE_SURFACES: ReadonlySet<string> = new Set(['breadcrumb'])

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
  /** The content row the focused block's card stood beside, if it sat in one. */
  laneAnchor: FocusedBlockLocation | null
}

const surfaceOf = (el: HTMLElement): string | undefined =>
  el.dataset.blockSurface

/** The element whose rect decides whether a nav item counts as on screen: its
 *  own content row, not the shell (a shell spans its whole subtree, so a parent
 *  whose children fill the viewport would read as visible while its own row is
 *  far above). The first match in document order is the item's own, since
 *  content renders before children. This is the SAME element
 *  `BlockFocusShellDecorator` measures through `contentRef`, which is what lets
 *  a caller pick a row the decorator will then agree needs no scrolling. */
export const visibilityTargetFor = (el: HTMLElement): HTMLElement =>
  el.querySelector<HTMLElement>(VISIBILITY_TARGET_SELECTOR) ?? el

/** Does this row show a VIEW rather than the block's own text?
 *
 *  A renderer may fill a content slot with a review backlog, a review deck, a
 *  recents list. That row's rect then describes everything it shows instead of
 *  the block — so it reads as on screen at every scroll position, and comes
 *  first in document order. Callers picking a row BY GEOMETRY need to tell it
 *  from an ordinary row; walking (j/k) does not, and still treats it as one.
 *
 *  Read from what the content slot DECLARED (`BLOCK_CONTENT_VIEW_ATTRIBUTE`),
 *  never inferred from the DOM underneath. "Holds other blocks' rows" is the
 *  inference, and it is wrong both ways: also true of a paragraph containing an
 *  embed, and false for a backlog whose rows are all still lazy placeholders. */
export const isRowAContentView = (el: HTMLElement): boolean =>
  visibilityTargetFor(el).hasAttribute(BLOCK_CONTENT_VIEW_ATTRIBUTE)

const isRecoveryTargetVisible = (el: HTMLElement): boolean =>
  isElementProperlyVisible(visibilityTargetFor(el))

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

/** Does this element render `location`? For callers already holding the
 *  instance array and walking it for more than one reason — the ones that
 *  can't go through `instanceIn` without a second pass. */
export const isInstanceAt = (el: HTMLElement, location: FocusedBlockLocation): boolean =>
  sameFocusedBlockLocation(locationOf(el) ?? undefined, location)

const isNavigable = (el: HTMLElement, excludedSurfaces: ReadonlySet<string>): boolean => {
  const surface = surfaceOf(el)
  if (surface && excludedSurfaces.has(surface)) return false
  return true
}

/** The occurrence a deferred row's slot holds a place for, or null when the
 *  element isn't a fully-labelled slot. */
const slotLocationOf = (slot: HTMLElement): FocusedBlockLocation | null => {
  const {lazyBlockId, lazyRenderScopeId} = slot.dataset
  return lazyBlockId && lazyRenderScopeId
    ? {blockId: lazyBlockId, renderScopeId: lazyRenderScopeId}
    : null
}

/** Does `el` sit inside a row on an excluded surface? A not-yet-mounted row
 *  carries no surface of its own, so the enclosing one is all there is to go
 *  on. Deliberately conservative: an excluded surface's own subtree is the
 *  thing being skipped, and a false skip costs only the fallback to whatever is
 *  mounted, while a false include lands focus where nothing can walk from. */
const isInExcludedSurface = (
  el: HTMLElement,
  excludedSurfaces: ReadonlySet<string>,
): boolean => {
  const owner = el.closest<HTMLElement>(NAV_ITEM_SELECTOR)
  return owner ? !isNavigable(owner, excludedSurfaces) : false
}

export const panelInstances = (
  panel: HTMLElement,
  excludedSurfaces: ReadonlySet<string> = DEFAULT_NON_NAVIGABLE_SURFACES,
): HTMLElement[] => {
  const all = Array.from(panel.querySelectorAll<HTMLElement>(NAV_ITEM_SELECTOR))
  // Filter to instances actually inside this panel (not inside a nested
  // panel that might appear in the DOM tree — defensive; layout doesn't
  // currently nest panels, but the selector match alone wouldn't catch
  // it).
  return all.filter(el => {
    if (!isNavigable(el, excludedSurfaces)) return false
    if (!locationOf(el)) return false
    const ownPanel = el.closest<HTMLElement>(PANEL_SELECTOR)
    return ownPanel === panel
  })
}

/** `laneOf` the panel's own content. */
export const OWN_CONTENT_LANE = ''

/** The lane `el` sits in: its marked root's name, or `OWN_CONTENT_LANE`. */
export const laneOf = (el: HTMLElement): string =>
  el.closest<HTMLElement>(LANE_SELECTOR)?.getAttribute(PANEL_LANE_ATTRIBUTE) ?? OWN_CONTENT_LANE

const laneInstances = (
  panel: HTMLElement,
  lane: string,
  excludedSurfaces: ReadonlySet<string>,
): HTMLElement[] => panelInstances(panel, excludedSurfaces).filter(el => laneOf(el) === lane)

/** The content row a lane row stands beside (`PANEL_LANE_ANCHOR_BLOCK_ATTRIBUTE`),
 *  or null. */
const laneAnchorOf = (el: HTMLElement): FocusedBlockLocation | null => {
  const anchor = el.closest<HTMLElement>(LANE_ANCHOR_SELECTOR)
  const blockId = anchor?.getAttribute(PANEL_LANE_ANCHOR_BLOCK_ATTRIBUTE)
  const renderScopeId = anchor?.getAttribute(PANEL_LANE_ANCHOR_SCOPE_ATTRIBUTE)
  return blockId && renderScopeId ? {blockId, renderScopeId} : null
}

export interface PanelRow extends SelectionRangeRow {
  element: HTMLElement
}

/**
 * Every row the panel holds a place for, in document order: the mounted rows
 * `panelInstances` returns, plus the slots of rows still deferred. What a RANGE
 * between two rows spans — which rows happen to have mounted is not something
 * the user chose, and a range over mounted rows alone has holes wherever a
 * scroll jumped past rows without mounting them.
 *
 * Unlike navigation, a range takes a slot that names no scope (a backlink
 * entry's, a recents row's): it needs the block, not the occurrence, so it
 * reads the block id and guesses nothing about the scope.
 *
 * Rows nested under a still-deferred row have no slot of their own; they are
 * part of the range through that row, whose selection takes its subtree.
 */
export const panelRowsInOrder = (
  panel: HTMLElement,
  excludedSurfaces: ReadonlySet<string> = DEFAULT_NON_NAVIGABLE_SURFACES,
): PanelRow[] => {
  const mounted = new Set(panelInstances(panel, excludedSurfaces))
  // The same two filters `panelInstances` applies to mounted rows.
  const isOwnSlot = (slot: HTMLElement): boolean =>
    slot.closest<HTMLElement>(PANEL_SELECTOR) === panel && !isInExcludedSurface(slot, excludedSurfaces)
  const rows: PanelRow[] = []
  for (const element of panel.querySelectorAll<HTMLElement>(`${NAV_ITEM_SELECTOR}, ${SLOT_SELECTOR}`)) {
    if (element.matches(NAV_ITEM_SELECTOR)) {
      const location = mounted.has(element) ? locationOf(element) : null
      if (location) rows.push({element, ...location})
      continue
    }
    const {lazyBlockId, lazyRenderScopeId} = element.dataset
    if (lazyBlockId && isOwnSlot(element)) {
      rows.push({element, blockId: lazyBlockId, renderScopeId: lazyRenderScopeId})
    }
  }
  return rows
}

export const panelOf = (el: HTMLElement): HTMLElement | null =>
  el.closest<HTMLElement>(PANEL_SELECTOR)

/** Is `other` ahead of `anchor` in the direction of travel? The one place the
 *  document-position masks are named: every caller that spelled this itself had
 *  to flip the mask AND swap the arguments, and getting either backwards fails
 *  silently — as a move that skips rows instead of declining. */
export const aheadOf = (
  anchor: HTMLElement,
  other: HTMLElement,
  direction: 'up' | 'down',
): boolean =>
  Boolean(anchor.compareDocumentPosition(other) & (direction === 'down'
    ? anchor.DOCUMENT_POSITION_FOLLOWING
    : anchor.DOCUMENT_POSITION_PRECEDING))

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
    // Defence in depth: `findByLocation` treats a missing location as no
    // match anyway, so a pushed null would change nothing.
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
  // Defence in depth: the only caller already returned if `indexOf` on this
  // same array was negative.
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
 * positional index) inside its panel. Called by the proactive focus-recovery
 * watcher whenever it confirms that the focused block has a live DOM
 * instance. The hint is consumed by
 * `findRecoveryAnchor` (and `locateInstance`'s positional tier) when
 * that block later disappears.
 */
export const rememberInstancePosition = (
  panelId: string,
  instanceEl: HTMLElement,
  excludedSurfaces: ReadonlySet<string> = DEFAULT_NON_NAVIGABLE_SURFACES,
): void => {
  const panel = panelById(panelId)
  if (!panel) return
  const instances = panelInstances(panel, excludedSurfaces)
  const idx = instances.indexOf(instanceEl)
  // Defence in depth, unreached by any test: every in-repo caller passes an
  // element it just found in this panel. `index.ts` re-exports this, so an
  // extension is the real blast radius — without the guard a hint lands with
  // BOTH indexes at -1, which either clamp reads as 0: a wrong recovery
  // target, not none.
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
    laneAnchor: laneAnchorOf(instanceEl),
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
 * candidates whose visibility target is already on screen.
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
  excludedSurfaces: ReadonlySet<string> = DEFAULT_NON_NAVIGABLE_SURFACES,
): HTMLElement | null => {
  const panel = panelById(panelId)
  if (!panel) return null
  const instances = panelInstances(panel, excludedSurfaces)
  const hint = lastPositionByPanel.get(panelId)
  if (!hint || !sameFocusedBlockLocation(hint.location, forLocation)) return null
  const candidates = sameSurfaceInstances(instances, hint.surface)

  const findByLocation = (location: FocusedBlockLocation | undefined): HTMLElement | undefined =>
    location
      ? candidates.find(el => isInstanceAt(el, location))
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

  // A card's rows all go with it, so its siblings and ancestors are gone too;
  // the row it stood beside, on another surface, is not.
  const laneAnchor = hint.laneAnchor
  const anchorRow = laneAnchor && instances.find(el => isInstanceAt(el, laneAnchor))
  if (anchorRow && isRecoveryTargetVisible(anchorRow)) return anchorRow

  const positionalChoice = candidates[clamp(hint.surfaceIndex, 0, candidates.length - 1)] ?? null
  return pickViewportFallback(candidates, positionalChoice)
}

/**
 * The live navigable instance for `location` in `panel`, or null when that row
 * isn't mounted there (rows mount lazily, so "not in the DOM" is the normal
 * state for most of a page). The one definition of that lookup — every caller
 * that had its own was matching the same two dataset fields by hand.
 */
export const instanceIn = (
  panel: HTMLElement,
  location: FocusedBlockLocation,
  excludedSurfaces: ReadonlySet<string> = DEFAULT_NON_NAVIGABLE_SURFACES,
): HTMLElement | null =>
  panelInstances(panel, excludedSurfaces).find(el => isInstanceAt(el, location)) ?? null

/** `instanceIn` for callers holding a panel id rather than its element. */
export const instanceAt = (
  panelId: string,
  location: FocusedBlockLocation,
  excludedSurfaces: ReadonlySet<string> = DEFAULT_NON_NAVIGABLE_SURFACES,
): HTMLElement | null => {
  const panel = panelById(panelId)
  return panel ? instanceIn(panel, location, excludedSurfaces) : null
}

/**
 * WHERE a row sits in the rendered panel — which is a different question from
 * "is it mounted", and the one a caller comparing DOM order needs. Returns its
 * live nav item when mounted, and otherwise the placeholder `LazyViewportMount`
 * reserves for it (`data-lazy-block-id`), which holds the row's place in
 * document order long before the row itself exists.
 *
 * A slot names the occurrence it holds a place for, both block AND scope, so
 * an embed's deferred copy of a block never answers for the outline's. The
 * scope is NOT inferred from the surrounding DOM: a backlink entry and a
 * recents row reserve their slot inside an outline row while the row that
 * eventually mounts there belongs to a scope of their own, so "the nearest
 * enclosing row's scope" would confidently mislabel exactly those.
 *
 * Null when the DOM has no place for the row: its parent's `childIds` hasn't
 * resolved yet (nothing has rendered a slot), or its surface reserves the slot
 * without naming a scope. Callers must treat that as "the DOM can't tell me",
 * not as "the row isn't there".
 */
export const rowSlotIn = (
  panelId: string,
  location: FocusedBlockLocation,
  excludedSurfaces: ReadonlySet<string> = DEFAULT_NON_NAVIGABLE_SURFACES,
): HTMLElement | null => {
  const mounted = instanceAt(panelId, location, excludedSurfaces)
  if (mounted) return mounted
  const panel = panelById(panelId)
  if (!panel) return null
  return panel.querySelector<HTMLElement>(
    `[data-lazy-block-id="${CSS.escape(location.blockId)}"]` +
    `[data-lazy-render-scope-id="${CSS.escape(location.renderScopeId)}"]`,
  )
}

/**
 * The nearest row that is RESERVED but not yet mounted between `from` and the
 * mounted neighbour `to` (or anywhere beyond `from`, when nothing is mounted
 * that way). Document order, so "nearest" is the first one in the direction of
 * travel.
 *
 * This is what a caller needs at a boundary its model can't see past: within a
 * scope the model names the next row, but at the EDGE of one — stepping out of
 * an embed, out of a backlink entry — the rendered order decides, and a row
 * that has a place reserved is part of that order even though no walk names it
 * and no query for mounted rows finds it.
 *
 * Two kinds of reserved row are NOT part of that order, and both would be a
 * focus write onto a row the user can't reach or see:
 *
 *   - anything in `from`'s OWN scope. A caller only asks at an edge, which
 *     means the model found no next row in this scope — so a slot claiming to
 *     be one is stale: a just-collapsed subtree's child, a deleted sibling's
 *     reservation. The model is what validates a row of this scope, everywhere,
 *     and at an edge it has already said there is none. (A NESTED surface's
 *     slot carries a different scope, and stepping into that is the point.)
 *   - anything inside an excluded surface. Its rows are not navigable, so
 *     landing there leaves the next keystroke with no anchor at all.
 */
export const reservedRowBetween = (
  from: HTMLElement,
  to: HTMLElement | null,
  direction: 'up' | 'down',
  excludedSurfaces: ReadonlySet<string> = DEFAULT_NON_NAVIGABLE_SURFACES,
): FocusedBlockLocation | null => {
  const panel = panelOf(from)
  if (!panel) return null
  const fromScope = from.dataset.renderScopeId
  const fromLane = laneOf(from)
  const slots = Array.from(panel.querySelectorAll<HTMLElement>(LABELLED_SLOT_SELECTOR)).filter(slot =>
    aheadOf(from, slot, direction) &&
    // Past the mounted neighbour it isn't "between" — the neighbour is then the
    // nearer answer and nothing is missing before it.
    (!to || aheadOf(slot, to, direction)) &&
    slot.dataset.lazyRenderScopeId !== fromScope &&
    laneOf(slot) === fromLane &&
    !isInExcludedSurface(slot, excludedSurfaces) &&
    // Never picks a half-labelled slot and then gives up on it, which would
    // silently drop a valid one further along.
    slotLocationOf(slot) !== null,
  )
  const nearest = direction === 'down' ? slots[0] : slots[slots.length - 1]
  return nearest ? slotLocationOf(nearest) : null
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
  excludedSurfaces: ReadonlySet<string> = DEFAULT_NON_NAVIGABLE_SURFACES,
): HTMLElement | null => {
  if (!focusedLocation) return null
  return instanceAt(panelId, focusedLocation, excludedSurfaces)
    ?? findRecoveryAnchor(panelId, focusedLocation, excludedSurfaces)
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
  excludedSurfaces: ReadonlySet<string> = DEFAULT_NON_NAVIGABLE_SURFACES,
): HTMLElement | null => {
  const panel = panelById(panelId, root)
  if (!panel) return null
  const instances = panelInstances(panel, excludedSurfaces)
  if (instances.length === 0) return null

  if (hints.focusedLocation) {
    const focused = hints.focusedLocation
    const exact = instances.find(el => isInstanceAt(el, focused))
    if (exact) return exact
  }

  const stored = lastPositionByPanel.get(panelId)
  if (stored && (!hints.focusedLocation || sameFocusedBlockLocation(stored.location, hints.focusedLocation))) {
    return instances[clamp(stored.index, 0, instances.length - 1)] ?? null
  }

  return instances[0] ?? null
}

/** The first or last row of one lane of `panel`. */
export const laneEdgeInstance = (
  panel: HTMLElement,
  lane: string,
  edge: 'first' | 'last',
  excludedSurfaces: ReadonlySet<string> = DEFAULT_NON_NAVIGABLE_SURFACES,
): HTMLElement | null => {
  const instances = laneInstances(panel, lane, excludedSurfaces)
  return (edge === 'first' ? instances[0] : instances.at(-1)) ?? null
}

/** The first and last rows of a panel's own content, where a move into the
 *  panel from above or below lands. */
export const firstInstanceIn = (
  panel: HTMLElement,
  excludedSurfaces: ReadonlySet<string> = DEFAULT_NON_NAVIGABLE_SURFACES,
): HTMLElement | null => laneEdgeInstance(panel, OWN_CONTENT_LANE, 'first', excludedSurfaces)

export const lastInstanceIn = (
  panel: HTMLElement,
  excludedSurfaces: ReadonlySet<string> = DEFAULT_NON_NAVIGABLE_SURFACES,
): HTMLElement | null => laneEdgeInstance(panel, OWN_CONTENT_LANE, 'last', excludedSurfaces)

/**
 * Within-lane + stack-sibling fall-through for j/k.
 *
 * 1. If there's a next/prev instance in the same lane of the panel in DOM
 *    order, return it.
 * 2. Else, from the panel's own content, if the panel sits inside a column
 *    that stacks multiple panels, fall through to the first/last instance
 *    of the immediately adjacent stack-sibling panel.
 * 3. Else, null (never crosses columns horizontally for h/k).
 */
export const verticalNeighbor = (
  current: HTMLElement,
  direction: 'up' | 'down',
  excludedSurfaces: ReadonlySet<string> = DEFAULT_NON_NAVIGABLE_SURFACES,
): HTMLElement | null => {
  const panel = panelOf(current)
  if (!panel) return null
  const instances = laneInstances(panel, laneOf(current), excludedSurfaces)
  const idx = instances.indexOf(current)
  if (idx === -1) return null

  if (direction === 'down') {
    if (idx + 1 < instances.length) return instances[idx + 1]
  } else {
    if (idx - 1 >= 0) return instances[idx - 1]
  }

  // Exhausted in-panel — try stack-sibling. A lane beside the content ends at
  // its own edges: the panel's content continues above and below it.
  if (laneOf(current) !== OWN_CONTENT_LANE) return null
  const sibling = stackSiblingPanel(panel, direction)
  if (!sibling) return null
  return direction === 'down'
    ? firstInstanceIn(sibling, excludedSurfaces)
    : lastInstanceIn(sibling, excludedSurfaces)
}

/** The nearest mounted row of `current`'s own scope in this panel, past any
 *  nested surface rendered in between. */
export const nextRowInScope = (
  current: HTMLElement,
  direction: 'up' | 'down',
  excludedSurfaces: ReadonlySet<string> = DEFAULT_NON_NAVIGABLE_SURFACES,
): HTMLElement | null => {
  const panel = panelOf(current)
  const scope = locationOf(current)?.renderScopeId
  if (!panel || scope === undefined) return null
  const instances = panelInstances(panel, excludedSurfaces)
  const from = instances.indexOf(current)
  if (from === -1) return null
  const ahead = direction === 'down' ? instances.slice(from + 1) : instances.slice(0, from).reverse()
  return ahead.find(el => locationOf(el)?.renderScopeId === scope) ?? null
}

/** Can the user see this lane row: shown, and on screen within both its
 *  scrollports and its lane's root, which a mount may clip to. */
const isLaneRowOnScreen = (el: HTMLElement): boolean => {
  const target = visibilityTargetFor(el)
  if (getComputedStyle(target).visibility === 'hidden') return false
  const bounds = getElementScrollportBounds(target)
  const laneRoot = el.closest<HTMLElement>(LANE_SELECTOR)
  if (!laneRoot) return isElementProperlyVisible(target, bounds)
  const clip = laneRoot.getBoundingClientRect()
  return isElementProperlyVisible(target, {
    top: Math.max(bounds.top, clip.top),
    bottom: Math.min(bounds.bottom, clip.bottom),
  })
}


/**
 * The row beside `current` in another lane of its panel, `direction` of it,
 * of the rows on screen that way: one paired with it if any (a card and the
 * row it stands beside), else any. Of those, the nearest to `current`'s own
 * row (one level with it, if any), with ties to the nearest to its top line,
 * whatever the document order. Rows showing a view (`isRowAContentView`) are
 * out: their rect is the view's. Null when no other lane has such a row, and
 * the move leaves the panel.
 */
export const lateralNeighbor = (
  current: HTMLElement,
  direction: 'left' | 'right',
  excludedSurfaces: ReadonlySet<string> = DEFAULT_NON_NAVIGABLE_SURFACES,
): HTMLElement | null => {
  const panel = panelOf(current)
  if (!panel?.querySelector(LANE_SELECTOR)) return null
  const lane = laneOf(current)
  const currentAnchor = laneAnchorOf(current)
  const from = visibilityTargetFor(current).getBoundingClientRect()
  const fromCentre = (from.left + from.right) / 2
  let best: {el: HTMLElement; paired: boolean; gap: number; topLineGap: number} | null = null
  for (const el of panelInstances(panel, excludedSurfaces)) {
    if (laneOf(el) === lane || isRowAContentView(el)) continue
    const rect = visibilityTargetFor(el).getBoundingClientRect()
    const centre = (rect.left + rect.right) / 2
    if (direction === 'right' ? centre <= fromCentre : centre >= fromCentre) continue
    // Outside the window it can't be on screen: skips the style reads below.
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) continue
    const elAnchor = laneAnchorOf(el)
    const paired = (currentAnchor !== null && isInstanceAt(el, currentAnchor)) ||
      (elAnchor !== null && isInstanceAt(current, elAnchor))
    const gap = Math.max(0, rect.top - from.bottom, from.top - rect.bottom)
    const topLineGap = Math.max(0, rect.top - from.top, from.top - rect.bottom)
    const better = !best ||
      (paired !== best.paired ? paired : gap < best.gap || (gap === best.gap && topLineGap < best.topLineGap))
    if (better && isLaneRowOnScreen(el)) best = {el, paired, gap, topLineGap}
  }
  return best?.el ?? null
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
 * Column-walker for h/l, after `lateralNeighbor` finds nothing in the
 * panel. Returns the *panel* to focus in the previous
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

import { getElementScrollportBounds, isElementProperlyVisible } from '@/utils/dom.js'
import {
  locationOf,
  panelInstances,
  visibilityTargetFor,
} from '@/plugins/spatial-navigation/walker.js'
import {
  sameFocusedBlockLocation,
  type FocusedBlockLocation,
} from '@/data/properties.js'

/**
 * Is this row on screen by the SAME measure `BlockFocusShellDecorator` uses to
 * decide whether a focused row needs scrolling into view?
 *
 * That agreement is the whole reason re-anchoring doesn't kick off a scroll:
 * the decorator reacts to every focus change by measuring the new row, so a
 * pick it would disagree with becomes a scroll the user never asked for. Bounds
 * are resolved per row rather than once per panel so a row inside a nested
 * scrollport is judged against its own port.
 */
export const isRowInViewport = (instance: HTMLElement): boolean => {
  const target = visibilityTargetFor(instance)
  return isElementProperlyVisible(target, getElementScrollportBounds(target))
}

export const findInstance = (
  panelEl: HTMLElement,
  location: FocusedBlockLocation,
  excludedSurfaces: ReadonlySet<string>,
): HTMLElement | null =>
  panelInstances(panelEl, excludedSurfaces)
    .find(el => sameFocusedBlockLocation(locationOf(el) ?? undefined, location)) ?? null

/**
 * Where the cursor should go when the user has scrolled it out of the panel's
 * viewport: the topmost row still on screen. Null means leave it alone.
 *
 * TOPMOST, always — not "whichever edge the cursor left through", which is what
 * Emacs does (scrolling past point drags point to the nearest visible line) and
 * what would move the cursor the least. The anchor here does double duty: it's
 * the cursor AND the thing a later restore scrolls back to
 * (`panelScrollAnchor`), and "the row at the top of the view" is the only pick
 * where those two agree. Anchoring to the bottom edge would restore a viewport
 * too far down.
 *
 * Surface-agnostic on purpose: `panelInstances` walks the panel in DOM order
 * across outline, backlinks and embeds alike (minus the excluded surfaces), so
 * scrolling from the outline down into the backlinks moves the cursor into the
 * backlinks — the same places `j`/`k` already travel.
 */
export const resolveViewportAnchor = (
  panelEl: HTMLElement,
  focusedLocation: FocusedBlockLocation,
  excludedSurfaces: ReadonlySet<string>,
): FocusedBlockLocation | null => {
  const instances = panelInstances(panelEl, excludedSurfaces)
  const focused = instances.find(
    el => sameFocusedBlockLocation(locationOf(el) ?? undefined, focusedLocation),
  )
  // No row for the cursor in this panel at all. That's a disappearance, not a
  // scroll — `PanelFocusRecovery` owns it, and it picks by data-tree
  // neighbourhood rather than by geometry.
  if (!focused) return null
  if (isRowInViewport(focused)) return null

  const anchor = instances.find(isRowInViewport)
  if (!anchor) return null
  const location = locationOf(anchor)
  if (!location || sameFocusedBlockLocation(location, focusedLocation)) return null
  return location
}

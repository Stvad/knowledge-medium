import {
  getElementScrollportBounds,
  isElementProperlyVisible,
  nearestScrollableAncestor,
} from '@/utils/dom.js'
import {
  isInstanceAt,
  locationOf,
  panelInstances,
  isRowAContentView,
  visibilityTargetFor,
} from '@/plugins/spatial-navigation/walker.js'
import {
  sameFocusedBlockLocation,
  type FocusedBlockLocation,
} from '@/data/properties.js'

/**
 * Is this row's own content on screen?
 *
 * This is what makes re-anchoring safe from starting a scroll: the decorator
 * reacts to every focus change by measuring the new row, so a pick it would
 * disagree with becomes a scroll the user never asked for. The relationship is
 * one of IMPLICATION, not equality — `shouldScrollFocusedBlockIntoView` declines
 * to scroll when this predicate holds OR when a row taller than the viewport
 * still shows about a line of its wrapper, so it is strictly the more permissive
 * of the two. Every row this accepts, it accepts; that direction is the one the
 * guarantee needs, and it holds without the two having to stay identical.
 *
 * The gap runs the other way: a focused block whose PROPERTY PANEL is taller
 * than the viewport can have its content row scrolled off while the decorator
 * still counts it as meaningfully visible, and this reports it off screen — so
 * the cursor moves on while the user is still looking at that block's
 * properties. Deliberately not matched, because the fix would make the cursor
 * stickier on exactly the tall rows where a restore already can't recover the
 * reader's position within the row (see `panelScrollAnchor`'s known limit), and
 * a cursor that lags what is on screen is the drift this whole plugin exists to
 * remove.
 *
 * Bounds are resolved per row rather than once per panel so a row inside a
 * nested scrollport is judged against its own port.
 */
export const isRowInViewport = (instance: HTMLElement): boolean => {
  const target = visibilityTargetFor(instance)
  return isElementProperlyVisible(target, getElementScrollportBounds(target))
}

/**
 * Is this a row geometry can speak for at all? A row showing a VIEW rather than
 * the block's own text (see `isRowAContentView`) is on screen at every scroll
 * position and comes first in document order, so it would win every pick.
 *
 * Excluded from both sides of the decision, not just from the candidates: asking
 * "is the cursor's row still visible" of such a view always answers yes, so
 * leaving it on the focused side would pin the cursor there for as long as it
 * held it — the same cursor/viewport disagreement this plugin exists to remove,
 * one level up.
 */
const isGeometricRow = (instance: HTMLElement): boolean => !isRowAContentView(instance)

/**
 * Is the CURSOR's own row settled where the user is looking — i.e. is there
 * nothing to re-anchor? The question every caller here asks of the focused row,
 * shared so the container exception can't be applied in one place and forgotten
 * in another: a container answers "yes, always" to `isRowInViewport` alone, and
 * a caller that took that answer would refuse the very work this plugin exists
 * to do (`PanelCursorFollowsScroll`'s lazy-mount retry did).
 */
export const isCursorRowSettled = (instance: HTMLElement): boolean =>
  isGeometricRow(instance) && isRowInViewport(instance)

/** The thing that actually scrolls this row. Null = the page itself, and two
 *  nulls compare equal, which is what makes the filter below work for a panel
 *  with no inner scroll container at all. */
const scrollportOf = (instance: HTMLElement): HTMLElement | null =>
  nearestScrollableAncestor(visibilityTargetFor(instance))

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
 *
 * SCROLLPORT-local, though. A panel can hold more than one: the video-notes
 * layout renders the notes in an `overflow-y-auto` aside while the video
 * block's own row sits in a section that never scrolls. That row is the first
 * nav item in the panel and is permanently on screen, so an unfiltered search
 * would hand it the cursor every time a note scrolled out of the aside.
 * Candidates are therefore restricted to rows that move when the focused one
 * moves.
 */
export const resolveViewportAnchor = (
  panelEl: HTMLElement,
  focusedLocation: FocusedBlockLocation,
  excludedSurfaces: ReadonlySet<string>,
): FocusedBlockLocation | null => {
  const instances = panelInstances(panelEl, excludedSurfaces)
  const focused = instances.find(
    el => isInstanceAt(el, focusedLocation),
  )
  // No row for the cursor in this panel at all. That's a disappearance, not a
  // scroll — `PanelFocusRecovery` owns it, and it picks by data-tree
  // neighbourhood rather than by geometry.
  if (!focused) return null
  if (isCursorRowSettled(focused)) return null

  const port = scrollportOf(focused)
  const anchor = instances.find(
    el => scrollportOf(el) === port && isGeometricRow(el) && isRowInViewport(el),
  )
  if (!anchor) return null
  const location = locationOf(anchor)
  if (!location || sameFocusedBlockLocation(location, focusedLocation)) return null
  return location
}

/**
 * The whole decision a settled scroll makes, as one pure call: geometry plus
 * the two reasons not to act on it.
 *
 * Extracted from the timer callback so both refusals are reachable from a test.
 * The staleness one in particular cannot be pinned through the component — the
 * effect cleanup cancels the timer first in every ordering a test can stage —
 * yet it is the only thing standing between an already-due timer and
 * overwriting a cursor move the user just made.
 */
export const resolveSettledAnchor = ({
  panelEl,
  armedFor,
  currentLocation,
  isEditing,
  excludedSurfaces,
}: {
  panelEl: HTMLElement
  /** The cursor the settle timer was armed for. */
  armedFor: FocusedBlockLocation
  /** The panel's cursor right now, read at the moment of the write. */
  currentLocation: FocusedBlockLocation | undefined
  isEditing: boolean
  excludedSurfaces: ReadonlySet<string>
}): FocusedBlockLocation | null => {
  // Superseded: something moved the cursor between arming and firing.
  if (!sameFocusedBlockLocation(currentLocation, armedFor)) return null
  // Moving focus clears edit mode (`focusBlock` preserves it only for an
  // unchanged location), so re-anchoring mid-edit closes the editor under the
  // user — and scrolling with the on-screen keyboard up is exactly how that
  // happens on a phone.
  if (isEditing) return null
  return resolveViewportAnchor(panelEl, armedFor, excludedSurfaces)
}

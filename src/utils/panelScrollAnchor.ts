import { nearestScrollableAncestor } from '@/utils/dom.js'
import type { FocusedBlockLocation } from '@/data/properties.js'

/**
 * Restore a panel's scroll position by putting its CURSOR back where it was,
 * rather than replaying a pixel offset.
 *
 * A stored `scrollTop` is not a position in this app: rows mount lazily and
 * `measuredHeights` is module state that dies with the page, so after a reload
 * every row the user hasn't scrolled past reserves an estimate instead of its
 * real height (measured: 2869px of document at load vs 4655px fully mounted).
 * The same offset therefore points somewhere else entirely. A block id doesn't
 * drift — and with `cursor-follows-scroll` enabled the focused block IS the row
 * the user was looking at, so anchoring to it reproduces the view.
 *
 * Two things make this more than one `scrollTop` assignment:
 *
 *   - The anchor row usually isn't in the DOM yet. It's a lazy placeholder (or
 *     has no wrapper at all, under a deferred ancestor) until
 *     `FocusedRowLazyMount` forces it; that resolves over a few commits, so we
 *     wait for it instead of measuring an empty tree.
 *   - Once aligned, rows that were briefly on screen at the pre-restore
 *     position keep mounting and growing the document ABOVE the anchor, which
 *     slides it back down. So the alignment is re-applied for a short window
 *     rather than once.
 */

/** Give up waiting for the anchor row after this. Long enough for a cold load
 *  (rows arrive as their data hydrates), short enough that a row which will
 *  never render doesn't leave an observer attached for the session. */
const ROW_WAIT_MS = 2000

/** Keep correcting for this long after the first successful alignment — see
 *  the second bullet above. Short enough that the user is unlikely to be
 *  scrolling yet, and any gesture cancels it anyway. */
const REALIGN_WINDOW_MS = 250

/** How often to re-measure during that window. Mutations are the main signal,
 *  but not every shift is one: an image above the anchor that was already in
 *  the DOM at zero height pushes everything down when it decodes, with no
 *  childList record to react to. */
const REALIGN_SAMPLE_MS = 50

/** A scroll this soon after a DOM change is the layout moving, not the user.
 *  Both of the ways a pane's own content shifts its offset — Chromium's scroll
 *  anchoring swapping an estimated height for a measured one above the fold,
 *  and the browser clamping `scrollTop` as outgoing content shrinks the
 *  document on a back/forward swap — land in the same frame as the mutation
 *  that caused them. A hand on the scrollbar does not. */
const LAYOUT_SCROLL_GRACE_MS = 120

const inSameScrollport = (scrollEl: HTMLElement) => (el: HTMLElement): boolean =>
  el.closest<HTMLElement>('[data-panel-id]') === scrollEl.closest<HTMLElement>('[data-panel-id]')

/**
 * The row inside `scrollEl` that holds `location`.
 *
 * Matches on the CORE shell attributes (`DefaultBlockRenderer` writes both), not
 * on `data-block-nav-item` — that tag comes from the spatial-navigation plugin,
 * and restoring a scroll position must not stop working because a plugin is off.
 *
 * The render scope is tried first and the block id alone second: a scope id can
 * shift under a stored location (the legacy `outline:` rewrite does exactly
 * that, asynchronously, on this same mount), and landing on the right block in
 * the wrong-named scope beats not restoring at all.
 */
export const findAnchorRow = (
  scrollEl: HTMLElement,
  location: FocusedBlockLocation,
): {row: HTMLElement; exact: boolean} | null => {
  const blockSelector = `[data-block-id="${CSS.escape(location.blockId)}"]`
  const belongsHere = inSameScrollport(scrollEl)
  const exact = Array.from(scrollEl.querySelectorAll<HTMLElement>(
    `${blockSelector}[data-render-scope-id="${CSS.escape(location.renderScopeId)}"]`,
  )).find(belongsHere)
  if (exact) return {row: exact, exact: true}
  const anyScope = Array.from(scrollEl.querySelectorAll<HTMLElement>(
    `${blockSelector}[data-render-scope-id]`,
  )).find(belongsHere)
  return anyScope ? {row: anyScope, exact: false} : null
}

/**
 * Put `rowEl`'s top edge at the top of whatever actually scrolls it, and
 * return that scrollport — so a caller re-applying this can tell its own
 * scrolling apart from the user's by watching the port it moved. Null when the
 * page itself is the scrollport (nothing to watch that way).
 *
 * Resolved from the ROW rather than from a known container so a row inside a
 * nested scrollport (video notes, a scrollable embed) moves its own port.
 */
export const alignRowToScrollportTop = (rowEl: HTMLElement): HTMLElement | null => {
  const rowTop = rowEl.getBoundingClientRect().top
  const port = nearestScrollableAncestor(rowEl)
  if (!port) {
    if (rowTop) window.scrollBy(0, rowTop)
    return null
  }
  const delta = rowTop - port.getBoundingClientRect().top
  if (delta) port.scrollTop += delta
  return port
}

/**
 * The scrollport `rowEl` moves, but only when it belongs to this pane.
 *
 * A STACKED panel doesn't own one: `LayoutRenderer` gives the whole stack a
 * single `overflow-y-auto` and each stacked pane's own container is
 * `overflow-visible`, so every pane in the stack resolves the SAME shared port.
 * Letting each align it to its own cursor makes the stack's final position
 * whichever pane restored last, and their scroll-cancellation listeners read
 * each other's alignments as the user taking over. One shared scroll position
 * isn't any single pane's to restore, so a stacked pane restores nothing —
 * which is also what it did before this existed, since assigning `scrollTop` to
 * its `overflow-visible` container was a no-op.
 *
 * Ports NESTED inside the pane (the video-notes aside) are its own and are
 * handled here.
 */
const ownScrollportFor = (rowEl: HTMLElement, scrollEl: HTMLElement): HTMLElement | null => {
  const port = nearestScrollableAncestor(rowEl)
  if (!port) return null
  return port === scrollEl || scrollEl.contains(port) ? port : null
}

export interface AlignScrollportOptions {
  waitMs?: number
  realignWindowMs?: number
  /**
   * Where to land if the anchor row never appears. Restoring by cursor assumes
   * the cursor's row can be re-resolved after a remount, and there are surfaces
   * where it can't: a target inside a block embed (its wrapper exists only once
   * the embed's SOURCE row mounts, which the ancestor walk can't reach because
   * it follows data parents), a video-notes layout root that renders no shell
   * at all, a backlink entry showing a promoted ancestor held in local state.
   *
   * Enumerating those one at a time is a losing game, and each one that is
   * missed strands the pane at the TOP — strictly worse than the pixel restore
   * this replaced. So the pixel offset stays as the floor: a cursor that can be
   * found gives an exact position, and one that can't gives roughly the old
   * behaviour instead of nothing.
   */
  fallbackScrollTop?: number
}

/**
 * Scroll `scrollEl`'s panel so `location`'s row sits at the top, as soon as
 * that row exists, and hold it there for a beat while the rest of the page
 * settles. Returns a cancel function — call it on unmount or on a competing
 * navigation.
 *
 * Cancelled by the first user gesture too. The correction window is short, but
 * a cold load can push it past the point where the user has taken over, and
 * yanking someone who is already scrolling is worse than an anchor a few
 * hundred pixels off.
 *
 * KNOWN LIMIT: this restores to the top of the anchor row, so a cursor sitting
 * on a row TALLER than the viewport loses the reader's position within it. The
 * cursor doesn't move while such a row is being scrolled through (part of it
 * stays visible, so `cursor-follows-scroll` has nothing to re-anchor to), and a
 * block id alone can't say how far into it the user had read. Closing that
 * needs an intra-row offset captured alongside the location; the error is
 * bounded by one block's height, which is why it isn't captured today.
 */
export const alignScrollportToRow = (
  scrollEl: HTMLElement,
  location: FocusedBlockLocation,
  options: AlignScrollportOptions = {},
): (() => void) => {
  const {waitMs = ROW_WAIT_MS, realignWindowMs = REALIGN_WINDOW_MS, fallbackScrollTop} = options

  let done = false
  let realignTimer: ReturnType<typeof setTimeout> | null = null
  let sampler: ReturnType<typeof setInterval> | null = null
  /** The port we last aligned, and the offset we left it at. Anything that
   *  moves it off that value afterwards is someone else scrolling. */
  let aligned: {port: HTMLElement; scrollTop: number} | null = null
  /** The port the takeover listener is currently attached to. */
  let watchedPort: HTMLElement | null = null
  /** When this pane's DOM last changed — see `onScrollWhileWaiting`. Seeded to
   *  now, because the mount that starts this restore IS a content change. */
  let lastMutationAt = Date.now()

  const finish = () => {
    if (done) return
    done = true
    observer.disconnect()
    clearTimeout(deadline)
    if (realignTimer) clearTimeout(realignTimer)
    if (sampler) clearInterval(sampler)
    scrollEl.removeEventListener('wheel', finish)
    scrollEl.removeEventListener('touchmove', finish)
    scrollEl.removeEventListener('keydown', finish)
    watchedPort?.removeEventListener('scroll', onScroll)
    watchedPort = null
    scrollEl.removeEventListener('scroll', onScrollWhileWaiting, {capture: true})
  }

  /** A scroll of the port we aligned that didn't come from us. Covers the ways
   *  a user takes over that no input event announces — dragging the native
   *  scrollbar is the one that matters, since it emits neither `wheel` nor
   *  `touchmove`. Only armed after the first alignment: before that, the scroll
   *  we'd see is the focus decorator bringing the restored cursor into view,
   *  which is the app catching up rather than the user overriding. */
  const onScroll = () => {
    if (!aligned) return
    if (Math.abs(aligned.port.scrollTop - aligned.scrollTop) <= 1) return
    finish()
  }

  /** Takeover during the WAIT, before anything has been aligned — a native
   *  scrollbar drag while the anchor row is still hydrating, which emits none
   *  of the gestures below.
   *
   *  There is no expected value to compare against yet, so the discriminator is
   *  TIME SINCE THE LAST MUTATION instead. Two mechanisms move a pane's offset
   *  with no user involved and would otherwise read as takeover: the browser
   *  clamping `scrollTop` as outgoing content shrinks the document on a
   *  back/forward swap, and Chromium's scroll anchoring adjusting it as rows
   *  above the fold swap estimated heights for measured ones. Cancelling on
   *  either abandons the restore AND its fallback — losing the position rather
   *  than being imprecise about it.
   *
   *  Both are DEFENCE: neither has been observed breaking a restore. The
   *  back/forward path was measured with this guard removed and still restored
   *  correctly (cursor at offset 0), so this is not a fix for a known failure —
   *  it is a cheap way to keep an unguarded window from depending on layout
   *  timing that varies by engine and by how much content is in flight.
   *
   *  Cost of the grace window: a drag during heavy hydration is missed, and the
   *  pane snaps back when the anchor lands. That is the rarer case and the
   *  gentler failure.
   *
   *  Capturing, so a nested port (the video-notes aside) is covered too: scroll
   *  does not bubble but does capture. */
  const onScrollWhileWaiting = () => {
    if (aligned) return
    if (Date.now() - lastMutationAt < LAYOUT_SCROLL_GRACE_MS) return
    finish()
  }

  /** Arm takeover detection on the port we just moved. Separate from the
   *  correction window below because the two answer different questions: this
   *  one is "has the user taken over from us", and it becomes true the moment
   *  we have moved anything at all — including a fallback alignment during a
   *  wait that may never end (a legacy `outline:` scope is rewritten out from
   *  under the stored location, so the exact row can never arrive). Leaving it
   *  to the window meant a scrollbar drag went unnoticed for the rest of that
   *  wait and the next mutation snapped the pane back.
   *
   *  Tracked by PORT rather than as a one-shot flag: successive alignments can
   *  land in different ports (a block-id fallback in the pane's own container,
   *  then the exact copy inside a nested aside), and a flag would leave the
   *  listener on the port we are no longer moving — unwatched where it matters
   *  and leaked where it doesn't. */
  const watchForTakeover = (port: HTMLElement) => {
    if (watchedPort === port) return
    watchedPort?.removeEventListener('scroll', onScroll)
    port.addEventListener('scroll', onScroll, {passive: true})
    watchedPort = port
    // The value-comparing watcher takes over from here.
    scrollEl.removeEventListener('scroll', onScrollWhileWaiting, {capture: true})
  }

  const beginCorrectionWindow = () => {
    if (realignTimer) return
    realignTimer = setTimeout(finish, realignWindowMs)
    sampler = setInterval(attempt, REALIGN_SAMPLE_MS)
  }

  const attempt = () => {
    if (done) return
    const found = findAnchorRow(scrollEl, location)
    if (!found) return
    const port = ownScrollportFor(found.row, scrollEl)
    if (!port) return
    alignRowToScrollportTop(found.row)
    watchForTakeover(port)
    // A scope-drift fallback is a guess, and acting on it must not END the
    // search: the exact row can be a lazy copy in another surface that is still
    // hydrating, and closing the correction window here would leave the pane
    // anchored to the wrong copy for good. Align to the guess (better than the
    // top of the page) but keep waiting for the real one.
    if (found.exact) beginCorrectionWindow()
    aligned = {port, scrollTop: port.scrollTop}
  }

  /** The wait ran out. Distinct from `finish`, which is also how a user gesture
   *  ends this — someone who has already taken over must not be moved. */
  const giveUp = () => {
    if (done) return
    if (!aligned && fallbackScrollTop != null) scrollEl.scrollTop = fallbackScrollTop
    finish()
  }

  const observer = new MutationObserver(() => {
    lastMutationAt = Date.now()
    attempt()
  })
  const deadline = setTimeout(giveUp, waitMs)

  // Gestures the user aims at THIS panel. Scoped to the scroll container, not
  // the document: `keydown` bubbles from whatever inside the panel has focus,
  // so a PageDown/Space aimed here cancels here — while a keystroke in another
  // pane leaves this pane's pending restore alone, which a document-level
  // listener could not distinguish.
  scrollEl.addEventListener('wheel', finish, {passive: true})
  scrollEl.addEventListener('touchmove', finish, {passive: true})
  scrollEl.addEventListener('keydown', finish)
  scrollEl.addEventListener('scroll', onScrollWhileWaiting, {capture: true, passive: true})

  attempt()
  observer.observe(scrollEl, {childList: true, subtree: true})

  return finish
}

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
): HTMLElement | null => {
  const blockSelector = `[data-block-id="${CSS.escape(location.blockId)}"]`
  const belongsHere = inSameScrollport(scrollEl)
  const exact = Array.from(scrollEl.querySelectorAll<HTMLElement>(
    `${blockSelector}[data-render-scope-id="${CSS.escape(location.renderScopeId)}"]`,
  )).find(belongsHere)
  if (exact) return exact
  return Array.from(scrollEl.querySelectorAll<HTMLElement>(
    `${blockSelector}[data-render-scope-id]`,
  )).find(belongsHere) ?? null
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

export interface AlignScrollportOptions {
  waitMs?: number
  realignWindowMs?: number
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
  const {waitMs = ROW_WAIT_MS, realignWindowMs = REALIGN_WINDOW_MS} = options

  let done = false
  let realignTimer: ReturnType<typeof setTimeout> | null = null
  let sampler: ReturnType<typeof setInterval> | null = null
  /** The port we last aligned, and the offset we left it at. Anything that
   *  moves it off that value afterwards is someone else scrolling. */
  let aligned: {port: HTMLElement; scrollTop: number} | null = null

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
    aligned?.port.removeEventListener('scroll', onScroll)
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

  const beginCorrectionWindow = (port: HTMLElement | null) => {
    if (realignTimer) return
    realignTimer = setTimeout(finish, realignWindowMs)
    sampler = setInterval(attempt, REALIGN_SAMPLE_MS)
    port?.addEventListener('scroll', onScroll, {passive: true})
  }

  const attempt = () => {
    if (done) return
    const row = findAnchorRow(scrollEl, location)
    if (!row) return
    const port = alignRowToScrollportTop(row)
    if (port) {
      beginCorrectionWindow(aligned ? null : port)
      aligned = {port, scrollTop: port.scrollTop}
    }
  }

  const observer = new MutationObserver(attempt)
  const deadline = setTimeout(finish, waitMs)

  // Gestures the user aims at THIS panel. Scoped to the scroll container, not
  // the document: `keydown` bubbles from whatever inside the panel has focus,
  // so a PageDown/Space aimed here cancels here — while a keystroke in another
  // pane leaves this pane's pending restore alone, which a document-level
  // listener could not distinguish.
  scrollEl.addEventListener('wheel', finish, {passive: true})
  scrollEl.addEventListener('touchmove', finish, {passive: true})
  scrollEl.addEventListener('keydown', finish)

  attempt()
  observer.observe(scrollEl, {childList: true, subtree: true})

  return finish
}

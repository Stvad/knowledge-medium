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
 * return how far it had to move (0 when it was already there, so callers can
 * tell a correction from a no-op).
 *
 * Resolved from the ROW rather than from a known container so a row inside a
 * nested scrollport (video notes, a scrollable embed) moves its own port.
 */
export const alignRowToScrollportTop = (rowEl: HTMLElement): number => {
  const rowTop = rowEl.getBoundingClientRect().top
  const port = nearestScrollableAncestor(rowEl)
  if (!port) {
    if (rowTop) window.scrollBy(0, rowTop)
    return rowTop
  }
  const delta = rowTop - port.getBoundingClientRect().top
  if (delta) port.scrollTop += delta
  return delta
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
 */
export const alignScrollportToRow = (
  scrollEl: HTMLElement,
  location: FocusedBlockLocation,
  options: AlignScrollportOptions = {},
): (() => void) => {
  const {waitMs = ROW_WAIT_MS, realignWindowMs = REALIGN_WINDOW_MS} = options

  let done = false
  let realignTimer: ReturnType<typeof setTimeout> | null = null

  const finish = () => {
    if (done) return
    done = true
    observer.disconnect()
    clearTimeout(deadline)
    if (realignTimer) clearTimeout(realignTimer)
    scrollEl.removeEventListener('wheel', finish)
    scrollEl.removeEventListener('touchmove', finish)
    document.removeEventListener('keydown', finish)
  }

  const attempt = () => {
    if (done) return
    const row = findAnchorRow(scrollEl, location)
    if (!row) return
    alignRowToScrollportTop(row)
    // First hit starts the correction window; later mutations keep re-applying
    // until it closes.
    if (!realignTimer) realignTimer = setTimeout(finish, realignWindowMs)
  }

  const observer = new MutationObserver(attempt)
  const deadline = setTimeout(finish, waitMs)

  scrollEl.addEventListener('wheel', finish, {passive: true})
  scrollEl.addEventListener('touchmove', finish, {passive: true})
  document.addEventListener('keydown', finish)

  attempt()
  observer.observe(scrollEl, {childList: true, subtree: true})

  return finish
}

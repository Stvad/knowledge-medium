/*
  FLIP slide for structural block moves.

  History: in-place structural shifts deliberately ran without animation.
  The root-level `withMoveTransition` crossfade ghosts the shifting
  content at both old and new positions (text overlaps itself mid-flight),
  and the per-block `view-transition-name` attempt was reverted for two
  artifacts of its own (see the note in DefaultBlockRenderer): per-block
  snapshots lift into the document-root overlay and paint over the in-flow
  header, and the default group animation crossfades old/new copies in
  parallel with the position morph.

  Element-level FLIP has neither failure mode: rows animate with plain
  transform transitions in their own stacking contexts — no snapshot
  overlay, no duplicated text — and it composes with the atomic DOM update
  (the `NotifyBatch` fix) that killed the original flicker.

  Mechanics: snapshot every row's VISUAL top before the mutation runs, arm
  a one-shot MutationObserver BEFORE invoking it (React may commit inside
  the awaited mutation), and in the observer callback — after the DOM
  update, before paint — give each row whose natural position changed an
  inverse translateY with transitions disabled, then release it to animate
  into place. Because the inverse lands pre-paint, the end state never
  flashes.

  Two details that took real debugging to learn (this shipped and was
  daily-driven as an extension first):

  - TRANSFORM-COMPENSATED measurement. A row's natural position is
    rect.top MINUS its current interpolated translateY (DOMMatrix m42,
    sampled the same frame — the interpolation cancels exactly).
    Interrupting an in-flight slide with another move otherwise measures
    mid-animation geometry; and the tempting alternative — reset the
    transform, then measure — reads a mid-transition lie whenever a
    transform transition is attached, and under-corrects forever.

  - OWNERSHIP. Rows animated by this helper are tagged `data-flip-slide`
    while in flight; rows carrying a FOREIGN inline transform (e.g. an
    extension nudging margin annotations into a rail) are skipped
    entirely, so two transform writers never fight over one element.

  Snapshots are keyed by the row's stable identity (render scope + block
  id), not by element: `moveVertical`'s edge-of-sibling-list path changes
  the block's parentId, so React unmounts the old keyed row and mounts a
  fresh element under the new parent — an element-keyed snapshot would
  skip exactly the row being moved. The scope id is per-pane (the
  outline's top level), so it survives the re-parent; the same block
  visible in two panes stays two distinct keys.
*/

const FLIP_MS = 180
const SETTLE_TIMEOUT_MS = 400
const ROW_SELECTOR = '.tm-block'
const OWNED_ATTR = 'data-flip-slide'

/** Cleanup timers per element — a second move inside the previous
 *  animation window must cancel the pending cleanup, or it would strip
 *  the transition property mid-slide and snap the row. */
const cleanupTimers = new WeakMap<HTMLElement, number>()

const currentTranslateY = (el: Element): number => {
  const t = getComputedStyle(el).transform
  return t && t !== 'none' ? new DOMMatrixReadOnly(t).m42 : 0
}

/** A row is ours to animate unless someone else already holds an inline
 *  transform on it (our own in-flight rows carry the ownership tag). */
const ownable = (el: HTMLElement): boolean =>
  !el.style.transform || el.hasAttribute(OWNED_ATTR)

/** Stable row identity across React remounts (see the header note). */
const rowKey = (el: HTMLElement): string | null => {
  const blockId = el.getAttribute('data-block-id')
  if (!blockId) return null
  return `${el.getAttribute('data-render-scope-id') ?? ''}::${blockId}`
}

const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Run a structural mutation and FLIP-slide the rows it displaced.
 *  A mutation that reports it did nothing (resolves `false`) skips the
 *  settle wait: no DOM change is coming, so the caller isn't held for
 *  the observer's timeout. */
export const withRowSlide = async (
  run: () => Promise<boolean | void>,
): Promise<boolean | void> => {
  if (typeof document === 'undefined' || prefersReducedMotion()) {
    return run()
  }

  const pre = new Map<string, number>()
  const duplicates = new Set<string>()
  for (const el of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    if (!ownable(el)) continue
    const key = rowKey(el)
    if (!key) continue
    // Two elements with one identity (e.g. a block embedded next to its
    // own outline row) would fight over a single snapshot — animate
    // neither rather than slide one to the other's origin.
    if (pre.has(key)) {
      duplicates.add(key)
      continue
    }
    pre.set(key, el.getBoundingClientRect().top - currentTranslateY(el))
  }

  // Armed before the mutation: the React commit may happen inside the
  // awaited `run`, and the observer callback (post-DOM-update, pre-paint)
  // plus the microtask continuation below are what let the inverse
  // transforms land before the new layout ever paints.
  const settled = new Promise<void>(resolve => {
    const timeout = window.setTimeout(() => {
      observer.disconnect()
      resolve()
    }, SETTLE_TIMEOUT_MS)
    const observer = new MutationObserver(() => {
      window.clearTimeout(timeout)
      observer.disconnect()
      resolve()
    })
    observer.observe(document.body, {childList: true, subtree: true})
  })

  const outcome = await run()
  if (outcome === false) return outcome
  await settled

  const post = new Map<string, HTMLElement | null>()
  for (const el of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    if (!ownable(el)) continue
    const key = rowKey(el)
    if (!key || duplicates.has(key)) continue
    post.set(key, post.has(key) ? null : el)
  }

  // APPLY-THEN-MEASURE IN DOCUMENT ORDER is load-bearing for nested rows.
  // A moved block's descendants changed natural position by the same delta
  // as their ancestor — but ancestors precede descendants here (querySelectorAll
  // document order, preserved by the map), so by the time a descendant is
  // measured its ancestor's inverse transform is already applied: the
  // descendant reads back at its pre-move position, computes delta ≈ 0, and
  // correctly rides the ancestor's single transform. Batching all
  // measurements before applying any transforms would double-animate every
  // descendant.
  for (const [key, el] of post) {
    if (!el) continue
    const preTop = pre.get(key)
    if (preTop === undefined) continue
    const naturalTop = el.getBoundingClientRect().top - currentTranslateY(el)
    const delta = preTop - naturalTop
    if (Math.abs(delta) < 2) continue

    const pending = cleanupTimers.get(el)
    if (pending) window.clearTimeout(pending)

    el.setAttribute(OWNED_ATTR, '')
    el.style.transition = 'none'
    el.style.transform = `translateY(${delta}px)`
    // Force style recalc so the inverse position is the transition's
    // starting point rather than being batched away with the release.
    void el.offsetHeight
    el.style.transition = `transform ${FLIP_MS}ms ease`
    el.style.transform = ''
    cleanupTimers.set(
      el,
      window.setTimeout(() => {
        el.style.removeProperty('transition')
        if (!el.style.transform) el.style.removeProperty('transform')
        el.removeAttribute(OWNED_ATTR)
        cleanupTimers.delete(el)
      }, FLIP_MS + 40),
    )
  }

  return outcome
}

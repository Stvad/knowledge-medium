export type Direction = 'up' | 'down' | 'left' | 'right'

export interface Rect {
  top: number
  bottom: number
  left: number
  right: number
}

const PERPENDICULAR_PENALTY = 3

/** Score a candidate rect for spatial-nav from `anchor` toward `dir`.
 *  Lower = better. Returns null if the candidate doesn't make progress
 *  past the anchor in that direction.
 *
 *  Shape: travel-axis distance + α × perpendicular gap. The
 *  perpendicular gap is 0 whenever the perpendicular ranges overlap
 *  (anchor's y-range overlaps candidate's y-range, for h/l); when they
 *  don't overlap it's the size of the gap between them. So overlapping
 *  candidates sort by raw travel distance and non-overlapping ones pay
 *  a perpendicular-distance penalty. */
export const scoreCandidate = (
  anchor: Rect,
  candidate: Rect,
  dir: Direction,
): number | null => {
  const travelDistance =
    dir === 'right' ? candidate.left - anchor.right :
    dir === 'left' ? anchor.left - candidate.right :
    dir === 'down' ? candidate.top - anchor.bottom :
    /* up */         anchor.top - candidate.bottom

  // < 0 means the candidate is either in the opposite direction or
  // contains the anchor (ancestor block); both should be rejected.
  // Edge-touching (travel === 0) is fine — that's the adjacent-sibling
  // case, very common in outliner bullets where each block's bottom
  // borders the next block's top.
  if (travelDistance < 0) return null

  const [anchorPerpStart, anchorPerpEnd, candPerpStart, candPerpEnd] =
    dir === 'left' || dir === 'right'
      ? [anchor.top, anchor.bottom, candidate.top, candidate.bottom]
      : [anchor.left, anchor.right, candidate.left, candidate.right]

  const perpGap = Math.max(
    0,
    anchorPerpStart - candPerpEnd,
    candPerpStart - anchorPerpEnd,
  )

  return travelDistance + PERPENDICULAR_PENALTY * perpGap
}

export interface BestCandidate<T> {
  target: T
  score: number
}

export const pickBestInDirection = <T>(
  anchor: Rect,
  candidates: ReadonlyArray<{target: T; rect: Rect}>,
  dir: Direction,
): BestCandidate<T> | null => {
  let best: BestCandidate<T> | null = null
  for (const {target, rect} of candidates) {
    const score = scoreCandidate(anchor, rect, dir)
    if (score === null) continue
    if (best === null || score < best.score) best = {target, score}
  }
  return best
}

// ──── DOM glue ────

const VIEWPORT_OVERSCAN_PX = 2000

const isCandidateVisible = (rect: DOMRect, viewportH: number, viewportW: number): boolean => {
  if (rect.width === 0 && rect.height === 0) return false
  if (rect.bottom < -VIEWPORT_OVERSCAN_PX) return false
  if (rect.top > viewportH + VIEWPORT_OVERSCAN_PX) return false
  if (rect.right < -VIEWPORT_OVERSCAN_PX) return false
  if (rect.left > viewportW + VIEWPORT_OVERSCAN_PX) return false
  return true
}

export interface BlockTarget {
  element: HTMLElement
  blockId: string
  panelId: string | null
}

/** Collect every `[data-block-id]` element in the document along with
 *  the panel it lives in (nearest `[data-panel-id]` ancestor) and its
 *  bounding rect. Filters out elements that are far outside the
 *  viewport so the candidate set stays tractable for large workspaces. */
export const collectBlockTargets = (
  doc: Document,
): Array<{target: BlockTarget; rect: DOMRect}> => {
  const viewportH = doc.defaultView?.innerHeight ?? 0
  const viewportW = doc.defaultView?.innerWidth ?? 0
  const results: Array<{target: BlockTarget; rect: DOMRect}> = []
  const nodes = doc.querySelectorAll<HTMLElement>('[data-block-id]')
  for (const element of nodes) {
    const blockId = element.dataset.blockId
    if (!blockId) continue
    const rect = element.getBoundingClientRect()
    if (!isCandidateVisible(rect, viewportH, viewportW)) continue
    const panelEl = element.closest<HTMLElement>('[data-panel-id]')
    results.push({
      target: {
        element,
        blockId,
        panelId: panelEl?.dataset.panelId ?? null,
      },
      rect,
    })
  }
  return results
}

/** Return the DOM element that should anchor a spatial-nav step. Prefer
 *  `document.activeElement` if it lives inside a block, otherwise fall
 *  back to the first `[data-block-id]` matching `(panelId, blockId)`.
 *  Returns null if nothing usable is on screen. */
export const findAnchorElement = (
  doc: Document,
  fallback: {panelId: string; blockId: string} | null,
): HTMLElement | null => {
  const active = doc.activeElement
  if (active instanceof HTMLElement) {
    const anchor = active.closest<HTMLElement>('[data-block-id]')
    if (anchor) return anchor
  }
  if (!fallback) return null
  const panel = doc.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(fallback.panelId)}"]`)
  const scope = panel ?? doc
  return scope.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(fallback.blockId)}"]`)
}

export interface DirectionalStepResult {
  element: HTMLElement
  blockId: string
  panelId: string | null
}

/** End-to-end DOM step: find the anchor, collect candidates, score
 *  them, and return the winning element/ids. Returns null if there's
 *  no anchor or no candidate in `dir`. Pure read of the DOM — callers
 *  decide what to do with the result (commit focus state, scroll, etc.). */
export const stepInDirection = (
  doc: Document,
  dir: Direction,
  fallback: {panelId: string; blockId: string} | null,
): DirectionalStepResult | null => {
  const anchor = findAnchorElement(doc, fallback)
  if (!anchor) return null
  const anchorRect = anchor.getBoundingClientRect()
  const all = collectBlockTargets(doc)
  const candidates = all.filter(({target}) => target.element !== anchor)
  const best = pickBestInDirection(anchorRect, candidates, dir)
  if (!best) return null
  return {
    element: best.target.element,
    blockId: best.target.blockId,
    panelId: best.target.panelId,
  }
}

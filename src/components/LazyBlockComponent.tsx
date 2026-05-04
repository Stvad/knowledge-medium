/**
 * Renders a bullet-shaped placeholder until the block scrolls into (or
 * near) the viewport, then swaps in the real `<BlockComponent>`.
 *
 * The recursive block tree is the natural rendering shape for an
 * outliner, but mounting every descendant up-front is too expensive
 * for large pages (each `BlockComponent` carries ~10 `useHandle`
 * subscriptions through its renderer chain). This wrapper defers the
 * heavy work to the moment a block is about to be seen, while keeping
 * the recursive structure intact — backlinks, footers, and indentation
 * all still come from the regular renderer path.
 *
 * Once mounted, a block stays mounted; we don't tear it back down on
 * scroll-away. Re-mount churn would dominate any RAM win for a few
 * hundred idle subscriptions.
 *
 * Layout stability is handled by the shared lazy viewport wrapper and
 * block-shaped placeholder: each mounted block records its rendered
 * height, and future placeholders for the same block reserve that size.
 *
 * Test/SSR fallback: the shared wrapper mounts immediately if
 * `IntersectionObserver` isn't available.
 */

import { BlockComponent } from './BlockComponent.tsx'
import { BlockLoadingPlaceholder } from './BlockLoadingPlaceholder.tsx'
import { LazyViewportMount } from './util/LazyViewportMount.tsx'

/** Reserved height for a not-yet-measured block. Picked to roughly
 *  match a single-line bullet so the initial scrollHeight estimate is
 *  close to reality; once a placeholder mounts, layout recomputes. */
const ESTIMATED_HEIGHT_PX = 32

/** How far outside the viewport (in pixels, top + bottom) a block
 *  should be before we mount it. Wider = more work pre-loaded; narrower
 *  = more chance of seeing an empty placeholder during fast scrolls. */
const OVERSCAN_PX = 600

interface LazyBlockComponentProps {
  blockId: string
}

export function LazyBlockComponent({ blockId }: LazyBlockComponentProps) {
  return (
    <LazyViewportMount
      cacheKey={`block:${blockId}`}
      estimatedHeightPx={ESTIMATED_HEIGHT_PX}
      overscanPx={OVERSCAN_PX}
      renderPlaceholder={({reservedHeight}) => (
        <BlockLoadingPlaceholder reservedHeight={reservedHeight} />
      )}
    >
      <BlockComponent blockId={blockId} />
    </LazyViewportMount>
  )
}

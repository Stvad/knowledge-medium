/**
 * Renders an empty placeholder until the block scrolls into (or near)
 * the viewport, then swaps in the real `<BlockComponent>`.
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
 * Test/SSR fallback: if `IntersectionObserver` isn't available, we
 * mount immediately so callers don't have to special-case those
 * environments.
 */

import { useEffect, useRef, useState } from 'react'
import { BlockComponent } from './BlockComponent.tsx'

/** Reserved height for a not-yet-mounted block. Picked to roughly match
 *  a single-line bullet so the initial scrollHeight estimate is close
 *  to reality; once a placeholder mounts, layout recomputes. */
const ESTIMATED_HEIGHT_PX = 32

/** How far outside the viewport (in pixels, top + bottom) a block
 *  should be before we mount it. Wider = more work pre-loaded; narrower
 *  = more chance of seeing an empty placeholder during fast scrolls. */
const OVERSCAN_PX = 600

interface LazyBlockComponentProps {
  blockId: string
}

export function LazyBlockComponent({ blockId }: LazyBlockComponentProps) {
  const [mounted, setMounted] = useState(
    // jsdom (used in unit tests) and very old browsers don't have
    // IntersectionObserver. In those environments we mount immediately
    // so callers behave identically to a non-lazy renderer.
    () => typeof IntersectionObserver === 'undefined',
  )
  const placeholderRef = useRef<HTMLDivElement | null>(null)

  // Set up the observer once on mount with no deps so it isn't torn
  // down + recreated on every render. The observer itself flips the
  // `mounted` state when the placeholder enters the overscan box.
  useEffect(() => {
    if (mounted) return
    const el = placeholderRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setMounted(true)
      },
      { rootMargin: `${OVERSCAN_PX}px 0px` },
    )
    observer.observe(el)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (mounted) return <BlockComponent blockId={blockId} />
  return (
    <div
      ref={placeholderRef}
      style={{ minHeight: ESTIMATED_HEIGHT_PX }}
      aria-hidden
    />
  )
}

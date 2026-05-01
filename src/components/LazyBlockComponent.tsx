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
 * Layout-stability tactics:
 *  - The placeholder mirrors the real block shape (bullet on the left,
 *    content slot on the right) so mounted content slots into the same
 *    visual frame instead of materializing from nothing.
 *  - We measure each block's rendered height once mounted and cache it
 *    in a session-scoped Map. The next time the same block scrolls
 *    into a placeholder slot, we reserve the cached height instead of
 *    the rough single-line estimate, so the page doesn't shuffle as
 *    placeholders settle.
 *
 * Test/SSR fallback: if `IntersectionObserver` isn't available, we
 * mount immediately so callers don't have to special-case those
 * environments.
 */

import { useEffect, useRef, useState } from 'react'
import { BlockComponent } from './BlockComponent.tsx'
import { BulletDot } from './renderer/DefaultBlockRenderer.tsx'
import { useIsMobile } from '@/utils/react.tsx'

/** Reserved height for a not-yet-measured block. Picked to roughly
 *  match a single-line bullet so the initial scrollHeight estimate is
 *  close to reality; once a placeholder mounts, layout recomputes. */
const ESTIMATED_HEIGHT_PX = 32

/** How far outside the viewport (in pixels, top + bottom) a block
 *  should be before we mount it. Wider = more work pre-loaded; narrower
 *  = more chance of seeing an empty placeholder during fast scrolls. */
const OVERSCAN_PX = 600

/** Session-scoped cache of measured block heights, keyed by blockId.
 *  Lets a block that scrolls out and then back keep its slot the right
 *  size, so neighbours don't shuffle as content slots back in. Heights
 *  self-correct on the next mount if the block resizes (collapse,
 *  edit, etc.). Lost on reload. Grows unbounded across long sessions,
 *  but at one number per block id this is negligible. */
const measuredHeights = new Map<string, number>()

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
  const containerRef = useRef<HTMLDivElement | null>(null)
  const isMobile = useIsMobile()

  // Set up the observer once on mount with no deps so it isn't torn
  // down + recreated on every render. The observer itself flips the
  // `mounted` state when the placeholder enters the overscan box.
  useEffect(() => {
    if (mounted) return
    const el = containerRef.current
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

  // Once mounted, track the rendered height so future placeholder
  // appearances of the same block reserve the right space. Dynamic
  // resizes (children expand/collapse, edits) are picked up by
  // ResizeObserver, so the cache stays roughly current.
  useEffect(() => {
    if (!mounted) return
    const el = containerRef.current
    if (!el) return
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const h = el.offsetHeight
      if (h > 0) measuredHeights.set(blockId, h)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [mounted, blockId])

  if (mounted) {
    return (
      <div ref={containerRef}>
        <BlockComponent blockId={blockId} />
      </div>
    )
  }

  const reservedHeight = measuredHeights.get(blockId) ?? ESTIMATED_HEIGHT_PX

  // Mirror the `tm-block` flex shape so the real bullet lands in the
  // exact spot the placeholder bullet occupied. The desktop spacer
  // reserves the width of the (hover-only) ExpandButton from the real
  // block-controls, keeping horizontal alignment consistent on mount.
  return (
    <div
      ref={containerRef}
      className="tm-block relative flex items-start gap-1"
      style={{ minHeight: reservedHeight }}
      aria-hidden
    >
      <div className="block-controls flex items-center">
        {!isMobile && <span className="h-6 w-3" />}
        <span className="bullet-link flex items-center justify-center h-6 w-5">
          <BulletDot />
        </span>
      </div>
      <div className="block-body flex-grow" />
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { nearestScrollableAncestor } from '@/utils/dom.js'
import { registerPendingLazyMount } from './lazyMountRegistry.js'

/** Session-scoped cache of measured lazy-rendered heights, keyed by the
 *  caller's stable cache key. It lets remounted placeholders reserve the
 *  last known size for the same item, reducing layout shuffle. */
const measuredHeights = new Map<string, number>()
const mountedCacheKeys = new Set<string>()

/**
 * Cap on how far ABOVE the scrollport we pre-mount, regardless of the
 * caller's `overscanPx`.
 *
 * Overscan exists so scrolling (and keyboard navigation) doesn't run into
 * placeholders, and both of those overwhelmingly move DOWN — upward rows are
 * usually mounted already, since mounting is sticky. (Not after a scroll
 * restore, where nothing above the landing point has ever mounted — and the
 * boundary fall-through does NOT rescue that direction, because the panel's
 * top-level row is always mounted, so the upward walker always finds *a*
 * neighbour. Moving up across a never-mounted region jumps to that row.
 * Pre-existing, and the reason to keep some upward overscan rather than
 * none.) Pre-mounting far above
 * costs on both sides: it roughly doubles the mounted set at rest, and each
 * row that mounts above the fold swaps its height estimate for its real
 * height, pushing visible content down on engines without scroll anchoring
 * (WebKit doesn't support `overflow-anchor`, so iOS/Safari take the jump).
 *
 * Callers' `overscanPx` therefore sets the downward distance, which is the
 * one that has to cover a keystroke; upward is clamped to this.
 */
const UPWARD_OVERSCAN_CAP_PX = 200

export interface LazyViewportPlaceholderProps {
  reservedHeight: number
}

interface LazyViewportMountProps {
  cacheKey: string
  estimatedHeightPx: number
  overscanPx: number
  children: ReactNode
  renderPlaceholder: (props: LazyViewportPlaceholderProps) => ReactNode
  /** The block this row renders. Only needed when `cacheKey` is a surface's
   *  own key rather than `lazyBlockCacheKey(blockId)`; it keeps the row
   *  reachable by block id — see `lazyMountRegistry`. */
  blockId?: string
}

/**
 * Defers mounting expensive content until its placeholder approaches the
 * viewport. Once mounted, content stays mounted; teardown churn is more
 * expensive than keeping a few idle subscriptions alive.
 *
 * Test/SSR fallback: if IntersectionObserver is unavailable, mounts
 * immediately so callers behave like their non-lazy equivalents.
 */
export function LazyViewportMount({
  cacheKey,
  estimatedHeightPx,
  overscanPx,
  children,
  renderPlaceholder,
  blockId,
}: LazyViewportMountProps) {
  const [mounted, setMounted] = useState(
    () => typeof IntersectionObserver === 'undefined' || mountedCacheKeys.has(cacheKey),
  )
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (mounted) mountedCacheKeys.add(cacheKey)
  }, [mounted, cacheKey])

  useEffect(() => {
    if (mounted) return
    const el = containerRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setMounted(true)
      },
      // Root at the scrolling ancestor, not the viewport: `rootMargin`
      // expands only the ROOT's rect, while the clip rect of every scrolling
      // ancestor in between is applied unexpanded. Rooted at the viewport
      // (the default) our overscan was therefore worth nothing inside a
      // scrolling panel — rows mounted only once they were literally on
      // screen, so "the next row" was routinely absent from the DOM.
      //
      // Accepted cost of rooting here: clips ABOVE the root no longer apply
      // either, so rows in a panel that is itself scrolled out of view
      // horizontally (≥4 open columns in `.layout`) mount anyway. Bounded by
      // that panel's own scrollport, and mounting is sticky, so it's a
      // one-off per column. Don't "fix" it by AND-ing a viewport-rooted
      // observer: that reimposes the unexpanded panel clip and takes the
      // overscan back to zero.
      {
        root: nearestScrollableAncestor(el),
        rootMargin: `${Math.min(overscanPx, UPWARD_OVERSCAN_CAP_PX)}px 0px ${overscanPx}px 0px`,
      },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [mounted, overscanPx])

  // While showing a placeholder, stay reachable by key so a focus write can
  // pull this row into existence — rationale in `lazyMountRegistry`.
  useEffect(() => {
    if (mounted) return
    return registerPendingLazyMount(cacheKey, () => setMounted(true), blockId)
  }, [mounted, cacheKey, blockId])

  useEffect(() => {
    if (!mounted) return
    const el = containerRef.current
    if (!el) return
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const h = el.offsetHeight
      if (h > 0) measuredHeights.set(cacheKey, h)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [mounted, cacheKey])

  if (mounted) {
    return (
      <div ref={containerRef}>
        {children}
      </div>
    )
  }

  return (
    <div ref={containerRef}>
      {renderPlaceholder({
        reservedHeight: measuredHeights.get(cacheKey) ?? estimatedHeightPx,
      })}
    </div>
  )
}

/** Test-only: drop the session caches. Without this, a cache key that mounted
 *  in an earlier test starts the next one already mounted. */
export const __resetLazyMountCachesForTesting = (): void => {
  mountedCacheKeys.clear()
  measuredHeights.clear()
}

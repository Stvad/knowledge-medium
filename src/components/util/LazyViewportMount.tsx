import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/** Session-scoped cache of measured lazy-rendered heights, keyed by the
 *  caller's stable cache key. It lets remounted placeholders reserve the
 *  last known size for the same item, reducing layout shuffle. */
const measuredHeights = new Map<string, number>()

export interface LazyViewportPlaceholderProps {
  reservedHeight: number
}

interface LazyViewportMountProps {
  cacheKey: string
  estimatedHeightPx: number
  overscanPx: number
  children: ReactNode
  renderPlaceholder: (props: LazyViewportPlaceholderProps) => ReactNode
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
}: LazyViewportMountProps) {
  const [mounted, setMounted] = useState(
    () => typeof IntersectionObserver === 'undefined',
  )
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (mounted) return
    const el = containerRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setMounted(true)
      },
      {rootMargin: `${overscanPx}px 0px`},
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [mounted, overscanPx])

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

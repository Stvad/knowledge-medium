/* eslint-disable react-compiler/react-compiler */
'use no memo'
/**
 * Renders a lightweight placeholder until the block scrolls into (or
 * near) the viewport, then mounts the real `<BlockComponent>`.
 *
 * Why this exists: mounting a real BlockComponent costs ~10 useHandle
 * subscriptions + downstream renderer chain. For trees of thousands of
 * blocks, mounting them all up-front (the recursive default) freezes
 * the page. This wrapper lets us keep the natural recursive tree
 * structure (no flat-list flatten, no `suppressChildren`, no manual
 * positioning, backlinks render in the right place) while still
 * deferring the heavy work to the moment a block is actually about to
 * be seen.
 *
 * Once mounted, a block stays mounted — we don't tear it back down
 * when it scrolls away. (Could add that later via the same observer,
 * watching for `!isIntersecting`. The trade-off is whether the cost
 * of unmount/remount cycles outweighs the memory of a few hundred
 * idle subscriptions.)
 *
 * The `'use no memo'` directive matches `VirtualizedBlockTree` — the
 * IntersectionObserver→setState→re-render path can be defeated by
 * React Compiler's aggressive memoization, leaving the placeholder
 * frozen.
 */

import { useEffect, useRef, useState } from 'react'
import { BlockComponent } from './BlockComponent.tsx'

const ESTIMATED_HEIGHT_PX = 32
const OVERSCAN_PX = 600

interface LazyBlockComponentProps {
  blockId: string
}

export function LazyBlockComponent({ blockId }: LazyBlockComponentProps) {
  const placeholderRef = useRef<HTMLDivElement | null>(null)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    if (mounted) return
    const el = placeholderRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setMounted(true)
      },
      { rootMargin: `${OVERSCAN_PX}px 0px` },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [mounted])

  if (mounted) return <BlockComponent blockId={blockId} />
  return (
    <div
      ref={placeholderRef}
      style={{ minHeight: ESTIMATED_HEIGHT_PX }}
      aria-hidden
    />
  )
}

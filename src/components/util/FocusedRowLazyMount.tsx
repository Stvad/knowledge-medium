import { useEffect } from 'react'
import { usePropertyValue } from '@/hooks/block.js'
import { focusedBlockLocationProp } from '@/data/properties.js'
import type { Block } from '@/data/block.js'
import { lazyBlockCacheKey, requestLazyMount } from './lazyMountRegistry.js'

/**
 * Keeps the invariant "the panel's focused row is mounted".
 *
 * Focus targets come from the block model — `nextVisibleBlock` for the
 * keyboard, a search hit, a restored panel — and the model doesn't know or
 * care which rows are currently lazily deferred. Landing focus on a row that
 * is still a placeholder is a dead end: no shell means no highlight, no DOM
 * focus, no scroll-into-view, and no `useInFocus`, so normal mode deactivates
 * and the next keystroke has nothing to walk from.
 *
 * One instance per panel (rendered by `PanelRenderer`), subscribed to that
 * panel's focused location only — a single subscription per panel rather than
 * one per row. Renders nothing; the request is O(1) and a no-op whenever the
 * row is already mounted or isn't rendered at all.
 */
export function FocusedRowLazyMount({block}: {block: Block}) {
  const [focusedLocation] = usePropertyValue(block, focusedBlockLocationProp)
  const focusedBlockId = focusedLocation?.blockId

  useEffect(() => {
    if (!focusedBlockId) return
    requestLazyMount(lazyBlockCacheKey(focusedBlockId))
  }, [focusedBlockId])

  return null
}

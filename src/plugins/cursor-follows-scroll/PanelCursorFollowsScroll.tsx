import { useEffect } from 'react'
import { usePropertyValue } from '@/hooks/block.js'
import {
  focusBlock,
  focusedBlockLocationProp,
  isEditingProp,
} from '@/data/properties.js'
import type { Block } from '@/data/block.js'
import { panelById } from '@/plugins/spatial-navigation/walker.js'
import { resolveSpatialNavExclusions } from '@/plugins/spatial-navigation/exclusionsFacet.js'
import { findInstance, isRowInViewport, resolveViewportAnchor } from './viewportAnchor.ts'

/** Re-anchor once scrolling has stopped, not while it's happening. Two reasons:
 *  a fling would otherwise write a focus location per frame, and the row we
 *  pick mid-flight is off screen again a moment later — which is the one thing
 *  that makes the focus decorator scroll and fight the user. 150ms clears the
 *  gaps between momentum events without being perceptible. */
const SCROLL_SETTLE_MS = 150

/**
 * Emacs's rule, per panel: scrolling the cursor out of the window moves the
 * cursor rather than leaving it behind. Without it the cursor and the viewport
 * drift apart, and the next `j` teleports the view back to wherever the cursor
 * was sitting.
 *
 * Two things keep this from turning into a scroll fight:
 *
 *   - The row it picks is on screen by the SAME measure
 *     `BlockFocusShellDecorator` applies to every focus change
 *     (`isRowInViewport`), so the decorator agrees no scrolling is needed and
 *     does nothing. Picking a row the decorator disagreed with would scroll the
 *     panel out from under the user on every re-anchor.
 *   - It only fires for a cursor it has SEEN on screen since focus landed
 *     there. A focus write whose row starts off screen is a move the app is
 *     still catching up to — keyboard navigation to a row below the fold, or a
 *     restore aligning the panel to its stored cursor — and both scroll the
 *     row in. Reacting to those would cancel the very navigation that caused
 *     them; `seenOnScreen` is what tells the two apart.
 *
 * Mounted per panel via `panelMountsFacet`. Toggleable: with the plugin off,
 * the cursor stays where it was put and the app behaves like vim (the view
 * snaps back to the cursor on the next motion) instead of like Emacs.
 */
export function PanelCursorFollowsScroll({block}: {block: Block}) {
  const [focusedLocation] = usePropertyValue(block, focusedBlockLocationProp)
  const focusedBlockId = focusedLocation?.blockId
  const renderScopeId = focusedLocation?.renderScopeId

  // Depend on the two primitives, not the decoded object: a fresh identity on
  // an unrelated re-render would re-run the effect and clear `seenOnScreen`
  // mid-scroll, which reads as "the cursor was never on screen" and silently
  // switches the behaviour off until the next focus change.
  useEffect(() => {
    if (!focusedBlockId || !renderScopeId) return
    const panelEl = panelById(block.id)
    if (!panelEl) return
    const location = {blockId: focusedBlockId, renderScopeId}

    let settleTimer: ReturnType<typeof setTimeout> | null = null
    let seenOnScreen = false

    // Re-resolved per use rather than captured: the facet runtime can be
    // swapped (a plugin toggled) while this effect is alive, same as
    // `PanelFocusRecovery` does.
    const excluded = () => resolveSpatialNavExclusions(block.repo.facetRuntime)

    const sample = () => {
      if (seenOnScreen) return
      const row = findInstance(panelEl, location, excluded())
      if (row && isRowInViewport(row)) seenOnScreen = true
    }

    const settle = () => {
      settleTimer = null
      // Moving focus clears edit mode (`focusBlock` only preserves it for an
      // unchanged location), so re-anchoring mid-edit would close the editor
      // under the user — and scrolling while the on-screen keyboard is up is
      // exactly how that happens on a phone.
      if (block.peekProperty(isEditingProp)) return
      const next = resolveViewportAnchor(panelEl, location, excluded())
      if (!next) return
      void focusBlock(block, next.blockId, {renderScopeId: next.renderScopeId})
    }

    const onScroll = () => {
      sample()
      if (!seenOnScreen) return
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(settle, SCROLL_SETTLE_MS)
    }

    sample()
    // Capture at the document: scroll doesn't bubble, and which element
    // actually scrolls varies (the panel's own overflow container normally, an
    // ancestor for a stacked panel, a nested port inside a mode renderer).
    // Scrolls belonging to other panels reach us too and cost a settle check
    // that finds this cursor still on screen.
    document.addEventListener('scroll', onScroll, {capture: true, passive: true})
    return () => {
      document.removeEventListener('scroll', onScroll, {capture: true})
      if (settleTimer) clearTimeout(settleTimer)
    }
  }, [block, focusedBlockId, renderScopeId])

  return null
}
